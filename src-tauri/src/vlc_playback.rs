//! Direct libVLC playback. No transcoder, generated movie or engine downloader.
//! A bounded latest-frame mailbox feeds WebGL through binary IPC; the browser
//! owns controls/overlays, so native child windows cannot cover dialogs or input.
use crate::{catalog, db::AppState};
use serde::{Deserialize, Serialize};
use std::{
    alloc::{Layout, alloc_zeroed, dealloc},
    collections::HashMap,
    ffi::{CString, c_char, c_int, c_uint, c_void},
    path::Path,
    ptr,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

type Handle = *mut c_void;
type LockCb = unsafe extern "C" fn(Handle, *mut Handle) -> Handle;
type DisplayCb = unsafe extern "C" fn(Handle, Handle);
type FormatCb = unsafe extern "C" fn(
    *mut Handle,
    *mut c_char,
    *mut c_uint,
    *mut c_uint,
    *mut c_uint,
    *mut c_uint,
) -> c_uint;
type AudioCb = unsafe extern "C" fn(Handle, *const c_void, c_uint, i64);

struct Api {
    new: unsafe extern "C" fn(c_int, *const *const c_char) -> Handle,
    media_new_path: unsafe extern "C" fn(Handle, *const c_char) -> Handle,
    media_add_option: unsafe extern "C" fn(Handle, *const c_char),
    media_release: unsafe extern "C" fn(Handle),
    player_new: unsafe extern "C" fn(Handle) -> Handle,
    player_release: unsafe extern "C" fn(Handle),
    set_media: unsafe extern "C" fn(Handle, Handle),
    play: unsafe extern "C" fn(Handle) -> c_int,
    stop: unsafe extern "C" fn(Handle),
    pause: unsafe extern "C" fn(Handle, c_int),
    set_time: unsafe extern "C" fn(Handle, i64),
    get_time: unsafe extern "C" fn(Handle) -> i64,
    get_length: unsafe extern "C" fn(Handle) -> i64,
    get_state: unsafe extern "C" fn(Handle) -> c_int,
    set_volume: unsafe extern "C" fn(Handle, c_int) -> c_int,
    set_mute: unsafe extern "C" fn(Handle, c_int),
    video_callbacks: unsafe extern "C" fn(
        Handle,
        Option<LockCb>,
        Option<unsafe extern "C" fn(Handle, Handle, *const Handle)>,
        Option<DisplayCb>,
        Handle,
    ),
    video_format:
        unsafe extern "C" fn(Handle, Option<FormatCb>, Option<unsafe extern "C" fn(Handle)>),
    audio_callbacks: unsafe extern "C" fn(
        Handle,
        Option<AudioCb>,
        Option<unsafe extern "C" fn(Handle, i64)>,
        Option<unsafe extern "C" fn(Handle, i64)>,
        Option<unsafe extern "C" fn(Handle, i64)>,
        Option<unsafe extern "C" fn(Handle)>,
        Handle,
    ),
    audio_format: unsafe extern "C" fn(Handle, *const c_char, c_uint, c_uint),
    instance: usize,
}

impl Api {
    fn load(directory: &Path) -> Result<Self, String> {
        #[cfg(not(windows))]
        {
            let _ = directory;
            Err("libVLC再生はWindows版で利用できます。".into())
        }
        #[cfg(windows)]
        unsafe {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::System::LibraryLoader::*;
            // Keep the verified bundled libraries loaded for the process lifetime.
            // Never look in the current directory or change the global DLL path.
            let load = |name: &str| {
                let wide: Vec<u16> = directory
                    .join(name)
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                LoadLibraryExW(
                    wide.as_ptr(),
                    ptr::null_mut(),
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                )
            };
            if load("libvlccore.dll").is_null() {
                return Err("libVLCが見つかりません。インストーラーで修復してください。".into());
            }
            let library = load("libvlc.dll");
            if library.is_null() {
                return Err("libVLCを読み込めません。インストーラーで修復してください。".into());
            }
            macro_rules! symbol {
                ($name:literal) => {{
                    let symbol = GetProcAddress(library, concat!($name, "\0").as_ptr())
                        .ok_or(concat!("libVLC API missing: ", $name))?;
                    std::mem::transmute(symbol)
                }};
            }
            let mut api = Self {
                new: symbol!("libvlc_new"),
                media_new_path: symbol!("libvlc_media_new_path"),
                media_add_option: symbol!("libvlc_media_add_option"),
                media_release: symbol!("libvlc_media_release"),
                player_new: symbol!("libvlc_media_player_new"),
                player_release: symbol!("libvlc_media_player_release"),
                set_media: symbol!("libvlc_media_player_set_media"),
                play: symbol!("libvlc_media_player_play"),
                stop: symbol!("libvlc_media_player_stop"),
                pause: symbol!("libvlc_media_player_set_pause"),
                set_time: symbol!("libvlc_media_player_set_time"),
                get_time: symbol!("libvlc_media_player_get_time"),
                get_length: symbol!("libvlc_media_player_get_length"),
                get_state: symbol!("libvlc_media_player_get_state"),
                set_volume: symbol!("libvlc_audio_set_volume"),
                set_mute: symbol!("libvlc_audio_set_mute"),
                video_callbacks: symbol!("libvlc_video_set_callbacks"),
                video_format: symbol!("libvlc_video_set_format_callbacks"),
                audio_callbacks: symbol!("libvlc_audio_set_callbacks"),
                audio_format: symbol!("libvlc_audio_set_format"),
                instance: 0,
            };
            let options = [
                "--intf=dummy",
                "--ignore-config",
                "--no-lua",
                "--no-osd",
                "--no-video-title-show",
                "--no-media-library",
                "--no-snapshot-preview",
                "--quiet",
                "--avcodec-threads=2",
                "--file-caching=300",
            ];
            let args: Vec<CString> = options
                .iter()
                .copied()
                // Native tests must neither open a window nor output sound.
                .chain(cfg!(test).then_some("--aout=dummy"))
                .map(|s| CString::new(s).unwrap())
                .collect();
            let pointers: Vec<_> = args.iter().map(|s| s.as_ptr()).collect();
            api.instance = (api.new)(pointers.len() as c_int, pointers.as_ptr()) as usize;
            if api.instance == 0 {
                return Err("libVLCの初期化に失敗しました。".into());
            }
            Ok(api)
        }
    }
}

static API: OnceLock<Result<Arc<Api>, String>> = OnceLock::new();
fn engine(path: &Path) -> Result<Arc<Api>, String> {
    API.get_or_init(|| Api::load(path).map(Arc::new)).clone()
}

// libVLC requires 32-byte aligned planes. Buffers return to the small pool only
// after its presentation-clock callback; a slow renderer drops old frames, never
// queues them. Original pixels and display pixels have distinct dimensions.
struct Picture {
    data: *mut u8,
    layout: Layout,
    width: u32,
    height: u32,
    pitch: u32,
}
unsafe impl Send for Picture {}
impl Picture {
    fn new(width: u32, height: u32) -> Option<Self> {
        let pitch = (width * 4).div_ceil(32) * 32;
        let bytes = pitch as usize * height.div_ceil(32) as usize * 32;
        let layout = Layout::from_size_align(bytes, 32).ok()?;
        let data = unsafe { alloc_zeroed(layout) };
        if data.is_null() {
            return None;
        }
        Some(Self {
            data,
            layout,
            width,
            height,
            pitch,
        })
    }
}
impl Drop for Picture {
    fn drop(&mut self) {
        unsafe {
            dealloc(self.data, self.layout);
        }
    }
}
#[derive(Default)]
struct Frames {
    dimensions: (u32, u32),
    original: (u32, u32),
    latest: Option<Picture>,
    pool: Vec<Picture>,
    in_flight: HashMap<usize, Box<Picture>>,
    sequence: u32,
}
#[derive(Default)]
struct Sink {
    frames: Mutex<Frames>,
}
fn display_dimensions(width: u32, height: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 || width > 32_768 || height > 32_768 {
        return None;
    }
    let scale = (1920.0 / width as f64).min(1080.0 / height as f64).min(1.0);
    Some((
        (width as f64 * scale).round().max(1.0) as u32,
        (height as f64 * scale).round().max(1.0) as u32,
    ))
}
unsafe extern "C" fn format(
    opaque: *mut Handle,
    chroma: *mut c_char,
    width: *mut u32,
    height: *mut u32,
    pitches: *mut u32,
    lines: *mut u32,
) -> u32 {
    unsafe {
        let sink = &*(*opaque as *const Sink);
        let Some((w, h)) = display_dimensions(*width, *height) else {
            return 0;
        };
        let Ok(mut frames) = sink.frames.lock() else {
            return 0;
        };
        frames.original = (*width, *height);
        frames.dimensions = (w, h);
        frames
            .pool
            .retain(|picture| picture.width == w && picture.height == h);
        ptr::copy_nonoverlapping(b"RV32".as_ptr(), chroma as *mut u8, 4);
        *width = w;
        *height = h;
        *pitches = (w * 4).div_ceil(32) * 32;
        *lines = h.div_ceil(32) * 32;
        3
    }
}
unsafe extern "C" fn lock(opaque: Handle, planes: *mut Handle) -> Handle {
    unsafe {
        let sink = &*(opaque as *const Sink);
        let Ok(mut frames) = sink.frames.lock() else {
            return ptr::null_mut();
        };
        let (w, h) = frames.dimensions;
        let picture = frames
            .pool
            .iter()
            .position(|p| p.width == w && p.height == h)
            .map(|index| frames.pool.swap_remove(index))
            .or_else(|| Picture::new(w, h));
        let Some(picture) = picture else {
            return ptr::null_mut();
        };
        let mut picture = Box::new(picture);
        *planes = picture.data as Handle;
        let id = &mut *picture as *mut Picture as usize;
        // Own even prepared-but-not-presented frames: stopping between lock
        // and display must not leak an entire image on each viewer switch.
        frames.in_flight.insert(id, picture);
        id as Handle
    }
}
unsafe extern "C" fn display(opaque: Handle, picture: Handle) {
    if picture.is_null() {
        return;
    }
    unsafe {
        let sink = &*(opaque as *const Sink);
        if let Ok(mut frames) = sink.frames.lock() {
            let Some(picture) = frames.in_flight.remove(&(picture as usize)) else {
                return;
            };
            if let Some(previous) = frames.latest.replace(*picture) {
                if frames.pool.len() < 3 {
                    frames.pool.push(previous);
                }
            }
            frames.sequence = frames.sequence.wrapping_add(1).max(1);
        }
    }
}
fn frame_packet(sink: &Sink, after: u32) -> Vec<u8> {
    let Ok(frames) = sink.frames.lock() else {
        return Vec::new();
    };
    let Some(picture) = frames.latest.as_ref().filter(|_| frames.sequence != after) else {
        return Vec::new();
    };
    let length = picture.pitch as usize * picture.height as usize;
    let mut result = Vec::with_capacity(24 + length);
    for value in [
        picture.width,
        picture.height,
        picture.pitch,
        frames.sequence,
        frames.original.0,
        frames.original.1,
    ] {
        result.extend(value.to_le_bytes());
    }
    result.extend_from_slice(unsafe { std::slice::from_raw_parts(picture.data, length) });
    result
}

#[derive(Default)]
struct AudioLevel {
    squares: f64,
    peak: f32,
    samples: u64,
}
impl AudioLevel {
    fn loud(&self) -> bool {
        let rms = (self.squares / self.samples.max(1) as f64).sqrt();
        rms >= 0.22 || (self.peak >= 0.98 && rms >= 0.12)
    }
}
unsafe extern "C" fn audio_sample(opaque: Handle, samples: *const c_void, count: u32, _: i64) {
    unsafe {
        let level = &*(opaque as *const Mutex<AudioLevel>);
        if let Ok(mut level) = level.lock() {
            if level.samples >= 384_000 || samples.is_null() {
                return;
            }
            let remaining = 384_000 - level.samples as u32;
            for &sample in
                std::slice::from_raw_parts(samples as *const f32, count.min(remaining) as usize)
            {
                if !sample.is_finite() {
                    continue;
                }
                let value = sample.clamp(-1.0, 1.0);
                level.squares += (value as f64).powi(2);
                level.peak = level.peak.max(value.abs());
                level.samples += 1;
            }
        }
    }
}
struct Player {
    api: Arc<Api>,
    raw: Handle,
    _sink: Option<Arc<Sink>>,
    _audio: Option<Box<Mutex<AudioLevel>>>,
}
fn vlc_path(source: &Path) -> Result<CString, String> {
    let value = source
        .to_str()
        .ok_or("Unicodeではない動画パスは開けません。")?;
    // libvlc_media_new_path turns the verbatim prefix returned by Windows
    // canonicalize into an invalid file://?/ URL. Preserve UNC shares instead
    // of dropping their leading slashes. Catalog authorization happens first.
    let compatible = if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(value).to_owned()
    };
    CString::new(compatible).map_err(|e| e.to_string())
}
impl Player {
    fn open(
        api: Arc<Api>,
        source: &Path,
        sink: Option<Arc<Sink>>,
        silent: bool,
    ) -> Result<Self, String> {
        let path = vlc_path(source)?;
        unsafe {
            let media = (api.media_new_path)(api.instance as Handle, path.as_ptr());
            if media.is_null() {
                return Err("動画ファイルを開けません。".into());
            }
            let raw = (api.player_new)(api.instance as Handle);
            if raw.is_null() {
                (api.media_release)(media);
                return Err("動画プレイヤーを作成できません。".into());
            }
            // Disable metadata retrieval and sibling autodiscovery. The path
            // was resolved from the local catalog, not supplied as a URL.
            for option in [
                ":demux-filter=",
                ":no-metadata-network-access",
                ":no-sub-autodetect-file",
            ] {
                (api.media_add_option)(media, CString::new(option).unwrap().as_ptr());
            }
            if silent {
                (api.media_add_option)(media, c":no-audio".as_ptr());
            }
            let mut player = Self {
                api: api.clone(),
                raw,
                _sink: sink,
                _audio: None,
            };
            if let Some(sink) = &player._sink {
                (api.video_callbacks)(
                    raw,
                    Some(lock),
                    None,
                    Some(display),
                    Arc::as_ptr(sink) as Handle,
                );
                (api.video_format)(raw, Some(format), None);
            } else {
                (api.media_add_option)(media, c":no-video".as_ptr());
                let audio = Box::new(Mutex::new(AudioLevel::default()));
                (api.audio_callbacks)(
                    raw,
                    Some(audio_sample),
                    None,
                    None,
                    None,
                    None,
                    &*audio as *const _ as Handle,
                );
                (api.audio_format)(raw, c"FL32".as_ptr(), 48_000, 1);
                player._audio = Some(audio);
            }
            (api.set_media)(raw, media);
            (api.media_release)(media);
            Ok(player)
        }
    }
    fn play(&self) -> Result<(), String> {
        if unsafe { (self.api.play)(self.raw) } == 0 {
            Ok(())
        } else {
            Err("libVLCで再生を開始できませんでした。".into())
        }
    }
    fn volume(&self, volume: f64, muted: bool) {
        unsafe {
            (self.api.set_volume)(self.raw, (volume.clamp(0.0, 1.0) * 100.0).round() as i32);
            (self.api.set_mute)(self.raw, muted as i32);
        }
    }
}
impl Drop for Player {
    fn drop(&mut self) {
        unsafe {
            (self.api.stop)(self.raw);
            (self.api.player_release)(self.raw);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    state: String,
    message: String,
    time: f64,
    duration: f64,
    width: u32,
    height: u32,
    volume: f64,
    muted: bool,
    auto_reduced: bool,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            state: "loading".into(),
            message: "libVLCで動画を読み込み中…".into(),
            time: 0.0,
            duration: 0.0,
            width: 0,
            height: 0,
            volume: 0.5,
            muted: false,
            auto_reduced: false,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Control {
    Play,
    Pause,
    Seek { time: f64 },
    Volume { volume: f64, muted: bool },
    InitialVolume { volume: f64 },
    Loop { enabled: bool },
}
struct Session {
    cancelled: AtomicBool,
    finished: AtomicBool,
    status: Mutex<Status>,
    sink: Arc<Sink>,
    sender: mpsc::Sender<Control>,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    SESSIONS.get_or_init(Mutex::default)
}
fn session(id: &str) -> Result<Arc<Session>, String> {
    sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("再生セッションは終了しています。".into())
}

#[tauri::command]
pub fn open_vlc_player(
    app: tauri::AppHandle,
    media_id: String,
    volume: f64,
    muted: bool,
    looped: bool,
) -> Result<String, String> {
    if !volume.is_finite() {
        return Err("音量が不正です。".into());
    }
    let directory = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("vlc");
    let (sender, receiver) = mpsc::channel();
    let session = Arc::new(Session {
        cancelled: AtomicBool::new(false),
        finished: AtomicBool::new(false),
        status: Mutex::new(Status::default()),
        sink: Arc::new(Sink::default()),
        sender,
    });
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut active = sessions().lock().map_err(|e| e.to_string())?;
        for old in active.values() {
            old.cancelled.store(true, Ordering::Relaxed);
        }
        // Keep draining sessions addressable until close can await their file
        // handles. A delayed close must not accidentally close a newer session.
        active.retain(|_, old| !old.finished.load(Ordering::Acquire));
        active.insert(id.clone(), session.clone());
    }
    std::thread::spawn(move || {
        let result = (|| {
            let state = app.state::<AppState>();
            let (_, path) = catalog::resolve_media_path_for_recycle(&state, &media_id)?;
            if !catalog::classify_media(&path).is_some_and(|(kind, _, _)| kind == "video") {
                return Err("動画ファイルではありません。".into());
            }
            if session.cancelled.load(Ordering::Relaxed) {
                return Ok(());
            }
            let api = engine(&directory)?;
            if session.cancelled.load(Ordering::Relaxed) {
                return Ok(());
            }
            playback_worker(
                api,
                &path,
                &session,
                receiver,
                volume.clamp(0.0, 1.0),
                muted,
                looped,
            )
        })();
        if let Err(error) = result {
            if let Ok(mut status) = session.status.lock() {
                status.state = "error".into();
                status.message = error;
            }
        }
        session.finished.store(true, Ordering::Release);
    });
    Ok(id)
}
fn playback_worker(
    api: Arc<Api>,
    path: &Path,
    session: &Session,
    receiver: mpsc::Receiver<Control>,
    mut initial_volume: f64,
    initial_muted: bool,
    mut looped: bool,
) -> Result<(), String> {
    let player = Player::open(api.clone(), path, Some(session.sink.clone()), false)?;
    let mut analysis = Player::open(api.clone(), path, None, false).ok();
    let mut volume = initial_volume.min(0.5);
    let mut muted = initial_muted;
    let mut touched = false;
    let mut reduced = false;
    player.volume(volume, muted);
    player.play()?;
    if analysis.as_ref().is_some_and(|p| p.play().is_err()) {
        analysis = None;
    }
    let started = Instant::now();
    let mut initialized = false;
    let mut analysis_done = false;
    let mut prior_state = 0;
    let mut desired_pause = false;
    let mut pending_seek = None;
    while !session.cancelled.load(Ordering::Relaxed) {
        for control in receiver.try_iter() {
            match control {
                Control::Play => {
                    desired_pause = false;
                    if unsafe { (api.get_state)(player.raw) } == 6 {
                        unsafe {
                            (api.stop)(player.raw);
                        }
                    }
                    player.play()?;
                }
                Control::Pause => {
                    desired_pause = true;
                }
                Control::Seek { time } => {
                    pending_seek = Some(time);
                    if unsafe { (api.get_state)(player.raw) } == 6 {
                        unsafe {
                            (api.stop)(player.raw);
                        }
                        player.play()?;
                    }
                }
                Control::Volume {
                    volume: v,
                    muted: m,
                } => {
                    volume = v.clamp(0.0, 1.0);
                    muted = m;
                    touched = true;
                    player.volume(volume, muted);
                }
                Control::InitialVolume { volume: saved } => {
                    if !touched {
                        initial_volume = saved.clamp(0.0, 1.0);
                        volume = if reduced || !analysis_done {
                            initial_volume.min(0.5)
                        } else {
                            initial_volume
                        };
                        player.volume(volume, muted);
                    }
                }
                Control::Loop { enabled } => looped = enabled,
            }
        }
        let state = unsafe { (api.get_state)(player.raw) };
        if state == 7 {
            return Err("libVLCでもこの動画を再生できませんでした。形式・破損・ファイルへのアクセスを確認してください。".into());
        }
        if matches!(state, 3 | 4) {
            if let Some(time) = pending_seek.take() {
                unsafe {
                    (api.set_time)(player.raw, (time * 1000.0) as i64);
                }
            }
            if (state == 4) != desired_pause {
                unsafe {
                    (api.pause)(player.raw, desired_pause as i32);
                }
            }
        }
        if !initialized && state == 3 {
            initialized = true;
            player.volume(volume, muted);
        }
        let decision = analysis
            .as_ref()
            .and_then(|p| p._audio.as_ref())
            .and_then(|level| level.lock().ok())
            .and_then(|level| {
                ((level.samples >= 38_400 && level.loud())
                    || started.elapsed() > Duration::from_millis(4500))
                .then_some(level.loud())
            });
        if !analysis_done
            && (decision.is_some()
                || analysis.is_none()
                || started.elapsed() > Duration::from_secs(5))
        {
            reduced = decision == Some(true);
            if !touched {
                volume = if reduced {
                    initial_volume.min(0.5)
                } else {
                    initial_volume
                };
                player.volume(volume, muted);
            }
            analysis = None;
            analysis_done = true;
        }
        let (width, height, has_frame) = {
            let frames = session.sink.frames.lock().map_err(|e| e.to_string())?;
            (
                frames.original.0,
                frames.original.1,
                frames.latest.is_some(),
            )
        };
        if !has_frame && started.elapsed() > Duration::from_secs(30) {
            return Err(
                "映像を取得できませんでした。再試行するか、別の動画を開いてください。".into(),
            );
        }
        if state == 6 && looped && prior_state != 6 {
            unsafe {
                (api.stop)(player.raw);
            }
            player.play()?;
        }
        prior_state = state;
        if let Ok(mut status) = session.status.lock() {
            *status = Status {
                state: match state {
                    4 => "paused",
                    6 => "ended",
                    2 => "buffering",
                    3 if has_frame => "playing",
                    _ => "loading",
                }
                .into(),
                message: if has_frame {
                    ""
                } else {
                    "libVLCで動画を読み込み中…"
                }
                .into(),
                time: unsafe { (api.get_time)(player.raw) }.max(0) as f64 / 1000.0,
                duration: unsafe { (api.get_length)(player.raw) }.max(0) as f64 / 1000.0,
                width,
                height,
                volume,
                muted,
                auto_reduced: reduced,
            };
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}
#[tauri::command]
pub fn read_vlc_status(session_id: String) -> Result<Status, String> {
    session(&session_id)?
        .status
        .lock()
        .map(|s| s.clone())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn read_vlc_frame(
    session_id: String,
    after: u32,
) -> Result<tauri::ipc::Response, String> {
    let session = session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        tauri::ipc::Response::new(frame_packet(&session.sink, after))
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn control_vlc_player(session_id: String, control: Control) -> Result<(), String> {
    if matches!(control,Control::Seek{time} if !time.is_finite() || time<0.0 || time>31_536_000.0)
        || matches!(control,Control::Volume{volume,..} if !volume.is_finite())
        || matches!(control,Control::InitialVolume{volume} if !volume.is_finite())
    {
        return Err("再生パラメータが不正です。".into());
    }
    session(&session_id)?
        .sender
        .send(control)
        .map_err(|_| "再生セッションは終了しています。".into())
}
#[tauri::command]
pub async fn close_vlc_player(session_id: String) -> Result<(), String> {
    let session = sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id);
    let Some(session) = session else {
        return Ok(());
    };
    session.cancelled.store(true, Ordering::Relaxed);
    // In particular, deleting a playing video must await release of its file
    // handle. Never block the webview's UI thread while VLC drains playback.
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        while !session.finished.load(Ordering::Acquire) {
            if start.elapsed() > Duration::from_secs(10) {
                return Err("動画の終了を待っています。少し待ってから再試行してください。".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    #[test]
    fn windows_canonical_paths_remain_local_or_unc() {
        for (input, expected) in [
            (r"\\?\C:\動画\例 #1.mp4", r"C:\動画\例 #1.mp4"),
            (r"\\?\UNC\server\share\動画.mp4", r"\\server\share\動画.mp4"),
            (r"D:\動画.mp4", r"D:\動画.mp4"),
        ] {
            assert_eq!(
                vlc_path(Path::new(input)).unwrap().to_str().unwrap(),
                expected
            );
        }
        assert!(vlc_path(Path::new("bad\0path")).is_err());
    }
    #[test]
    fn bounds_frames_without_changing_aspect() {
        assert_eq!(display_dimensions(3840, 2160), Some((1920, 1080)));
        assert_eq!(display_dimensions(1080, 1920), Some((608, 1080)));
        assert_eq!(display_dimensions(0, 100), None);
        assert_eq!(display_dimensions(100_000, 100), None);
    }
    #[test]
    fn loudness_policy_matches_existing_thresholds() {
        assert!(
            !AudioLevel {
                squares: 100.0 * 0.1 * 0.1,
                samples: 100,
                peak: 0.2
            }
            .loud()
        );
        assert!(
            AudioLevel {
                squares: 100.0 * 0.3 * 0.3,
                samples: 100,
                peak: 0.8
            }
            .loud()
        );
    }
    #[test]
    fn frames_are_aligned_bounded_and_binary() {
        let picture = Picture::new(161, 93).unwrap();
        assert_eq!(picture.data as usize % 32, 0);
        assert_eq!(picture.pitch % 32, 0);
        let sink = Sink::default();
        {
            let mut frames = sink.frames.lock().unwrap();
            frames.latest = Some(picture);
            frames.original = (161, 93);
            frames.sequence = 1;
        }
        let packet = frame_packet(&sink, 0);
        assert_eq!(&packet[..4], &161u32.to_le_bytes());
        assert!(packet.len() < 100_000);
        assert!(frame_packet(&sink, 1).is_empty());
    }
    #[test]
    fn prepared_frames_remain_owned_until_display_or_shutdown() {
        let sink = Sink::default();
        sink.frames.lock().unwrap().dimensions = (161, 93);
        let mut plane = ptr::null_mut();
        let id = unsafe { lock(&sink as *const Sink as Handle, &mut plane) };
        assert!(!id.is_null());
        assert!(!plane.is_null());
        assert_eq!(sink.frames.lock().unwrap().in_flight.len(), 1);
        unsafe {
            display(&sink as *const Sink as Handle, id);
        }
        assert!(sink.frames.lock().unwrap().in_flight.is_empty());
        // A second prepared frame is deliberately not presented. It is still
        // inside the owning Sink, so Drop reclaims it after VLC is released.
        unsafe {
            lock(&sink as *const Sink as Handle, &mut plane);
        }
        assert_eq!(sink.frames.lock().unwrap().in_flight.len(), 1);
    }
    #[test]
    #[ignore = "requires the verified bundle and synthetic fixtures"]
    fn direct_decode_synthetic_formats() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/libvlc/vlc-3.0.23");
        let api = engine(&directory).unwrap();
        let fixtures = PathBuf::from(std::env::var("PIXVAULT_VLC_FIXTURES").unwrap());
        let mut count = 0;
        for entry in std::fs::read_dir(fixtures).unwrap().flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let before = std::fs::read(&path).unwrap();
            let sink = Arc::new(Sink::default());
            let player = Player::open(
                api.clone(),
                &path.canonicalize().unwrap(),
                Some(sink.clone()),
                true,
            )
            .unwrap();
            player.play().unwrap();
            let started = Instant::now();
            while frame_packet(&sink, 0).is_empty() {
                assert!(
                    started.elapsed() < Duration::from_secs(15),
                    "decode {} state {}",
                    path.display(),
                    unsafe { (api.get_state)(player.raw) }
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            unsafe {
                (api.pause)(player.raw, 1);
                (api.set_time)(player.raw, 200);
            }
            player.volume(0.5, true);
            drop(player);
            // Decode audio to a sample callback: test normalization without
            // producing sound or opening an OS audio/video window.
            let audio = Player::open(api.clone(), &path, None, false).unwrap();
            audio.play().unwrap();
            let audio_started = Instant::now();
            while audio._audio.as_ref().unwrap().lock().unwrap().samples < 38_400 {
                assert!(
                    audio_started.elapsed() < Duration::from_secs(10),
                    "audio {}",
                    path.display()
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(audio._audio.as_ref().unwrap().lock().unwrap().loud());
            drop(audio);
            assert_eq!(std::fs::read(&path).unwrap(), before);
            count += 1;
        }
        assert!(count >= 5, "Need at least five codec/container fixtures");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the verified bundle and synthetic fixtures"]
    fn native_session_controls_normalization_and_handle_release() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/libvlc/vlc-3.0.23");
        let api = engine(&directory).unwrap();
        let path = PathBuf::from(std::env::var("PIXVAULT_VLC_FIXTURES").unwrap())
            .join("日本語 ffv1.mkv")
            .canonicalize()
            .unwrap();
        let (sender, receiver) = mpsc::channel();
        let session = Arc::new(Session {
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            status: Mutex::new(Status::default()),
            sink: Arc::new(Sink::default()),
            sender,
        });
        let id = uuid::Uuid::new_v4().to_string();
        sessions()
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());
        let worker_session = session.clone();
        let worker_path = path.clone();
        let worker = std::thread::spawn(move || {
            let result = playback_worker(
                api,
                &worker_path,
                &worker_session,
                receiver,
                1.0,
                false,
                true,
            );
            worker_session.finished.store(true, Ordering::Release);
            result
        });
        let wait_status = |predicate: &dyn Fn(&Status) -> bool| {
            let start = Instant::now();
            loop {
                if predicate(&session.status.lock().unwrap()) {
                    break;
                }
                assert!(
                    start.elapsed() < Duration::from_secs(10),
                    "native status timeout"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait_status(&|s| s.auto_reduced && s.width == 320 && s.volume == 0.5);
        control_vlc_player(id.clone(), Control::InitialVolume { volume: 0.9 }).unwrap();
        control_vlc_player(id.clone(), Control::Pause).unwrap();
        wait_status(&|s| s.state == "paused");
        control_vlc_player(id.clone(), Control::Seek { time: 1.2 }).unwrap();
        control_vlc_player(
            id.clone(),
            Control::Volume {
                volume: 0.7,
                muted: true,
            },
        )
        .unwrap();
        wait_status(&|s| s.volume == 0.7 && s.muted && (s.time - 1.2).abs() < 0.2);
        control_vlc_player(id.clone(), Control::Play).unwrap();
        wait_status(&|s| s.state == "playing");
        assert_eq!(session.status.lock().unwrap().volume, 0.7);
        tauri::async_runtime::block_on(close_vlc_player(id)).unwrap();
        worker.join().unwrap().unwrap();
        // Exclusive access proves all VLC handles drained before recycling.
        let exclusive = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path);
        assert!(exclusive.is_ok(), "video still locked after close");
    }
}
