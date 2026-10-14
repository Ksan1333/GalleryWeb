//! Media Engine on its own COM thread. The shared session/surface layer owns
//! cancellation, file-handle draining and input geometry for both backends.
use super::{Control, Session, Status};
use std::{
    path::Path,
    sync::{atomic::Ordering, mpsc},
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{HWND, RECT},
        Media::MediaFoundation::*,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize,
        },
        UI::WindowsAndMessaging::GetClientRect,
    },
    core::{BSTR, Interface, implement},
};

#[implement(IMFMediaEngineNotify)]
struct Notify(mpsc::Sender<u32>);
impl IMFMediaEngineNotify_Impl for Notify_Impl {
    fn EventNotify(&self, event: u32, _: usize, _: u32) -> windows::core::Result<()> {
        let _ = self.0.send(event);
        Ok(())
    }
}

struct Runtime;
impl Runtime {
    fn start() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(error);
            }
        }
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}
struct Engine(IMFMediaEngine);
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            let _ = self.0.Shutdown();
        }
    }
}

fn create_engine(
    hwnd: Option<usize>,
    notify: &IMFMediaEngineNotify,
) -> windows::core::Result<Engine> {
    unsafe {
        let mut attributes = None;
        MFCreateAttributes(&mut attributes, 2)?;
        let attributes = attributes.unwrap();
        attributes.SetUnknown(&MF_MEDIA_ENGINE_CALLBACK, notify)?;
        if let Some(hwnd) = hwnd {
            attributes.SetUINT64(&MF_MEDIA_ENGINE_PLAYBACK_HWND, hwnd as u64)?;
        }
        let factory: IMFMediaEngineClassFactory =
            CoCreateInstance(&CLSID_MFMediaEngineClassFactory, None, CLSCTX_INPROC_SERVER)?;
        let flags = if hwnd.is_none() {
            MF_MEDIA_ENGINE_AUDIOONLY.0 as u32
        } else {
            0
        };
        Ok(Engine(factory.CreateInstance(flags, &attributes)?))
    }
}

pub(super) fn run(
    path: &Path,
    session: &Session,
    controls: mpsc::Receiver<Control>,
    volume: f64,
    muted: bool,
    looped: bool,
) -> Result<(), String> {
    unsafe { play(path, session, controls, volume, muted, looped) }
        .map_err(|e| format!("Media Foundation: {e}"))
}

unsafe fn play(
    path: &Path,
    session: &Session,
    controls: mpsc::Receiver<Control>,
    volume: f64,
    muted: bool,
    looped: bool,
) -> windows::core::Result<()> {
    // All COM objects are created, used and released on this worker thread.
    unsafe {
        let _runtime = Runtime::start()?;
        let (events_tx, events) = mpsc::channel();
        let notify: IMFMediaEngineNotify = Notify(events_tx).into();
        let engine = create_engine(Some(session.surface.video), &notify)?;
        let media = &engine.0;
        let extended: IMFMediaEngineEx = media.cast()?;
        media.SetVolume(volume.clamp(0.0, 1.0))?;
        media.SetMuted(muted)?;
        media.SetLoop(looped)?;
        media.SetSource(&BSTR::from(path.to_string_lossy().as_ref()))?;
        media.Load()?;
        let start = Instant::now();
        let mut started = false;
        let mut paused = false;
        let mut seek = None;
        let mut seek_started = None;
        let mut previous_rect = RECT::default();
        while !session.cancelled.load(Ordering::Relaxed) {
            for event in events.try_iter() {
                if event == MF_MEDIA_ENGINE_EVENT_ERROR.0 as u32 {
                    return Err(windows::core::Error::new(
                        windows::core::HRESULT(0x80004005u32 as i32),
                        "動画の読み込み・デコードに失敗しました。",
                    ));
                }
                if event == MF_MEDIA_ENGINE_EVENT_SEEKED.0 as u32 {
                    seek_started = None;
                }
            }
            for control in controls.try_iter() {
                match control {
                    Control::Play => {
                        paused = false;
                        if started {
                            media.Play()?;
                        }
                    }
                    Control::Pause => {
                        paused = true;
                        media.Pause()?;
                    }
                    Control::Seek { time } => seek = Some(time),
                    Control::Volume { volume, muted } => {
                        media.SetVolume(volume.clamp(0.0, 1.0))?;
                        media.SetMuted(muted)?;
                    }
                    Control::InitialVolume { volume } => media.SetVolume(volume.clamp(0.0, 1.0))?,
                    Control::Loop { enabled } => media.SetLoop(enabled)?,
                    Control::Capture { reply, .. } => {
                        let _ = reply.send(Err(
                            "Media Foundation再生中のフレーム保存は未対応です。".into(),
                        ));
                    }
                }
            }
            let ready = media.GetReadyState() >= 2;
            if ready && !started {
                started = true;
                if !paused {
                    media.Play()?;
                }
            }
            // Coalesce dragging requests; never build a FIFO of obsolete seeks.
            if ready && !media.IsSeeking().as_bool() {
                if let Some(time) = seek.take() {
                    media.SetCurrentTime(time)?;
                    seek_started = Some(Instant::now());
                }
            }
            if (!started && start.elapsed() > Duration::from_secs(8))
                || seek_started.is_some_and(|t: Instant| t.elapsed() > Duration::from_secs(5))
            {
                return Err(windows::core::Error::new(
                    windows::core::HRESULT(0x800705B4u32 as i32),
                    "読み込みまたはシークがタイムアウトしました。",
                ));
            }
            let mut rect = RECT::default();
            GetClientRect(HWND(session.surface.video as _), &mut rect)?;
            if rect.right > 0 && rect.bottom > 0 && rect != previous_rect {
                extended.UpdateVideoStream(None, Some(&rect), None)?;
                previous_rect = rect;
            }
            let (mut width, mut height) = (0, 0);
            let _ = media.GetNativeVideoSize(Some(&mut width), Some(&mut height));
            let duration = media.GetDuration();
            let time = media.GetCurrentTime();
            if let Ok(mut status) = session.status.lock() {
                *status = Status {
                    state: if media.IsEnded().as_bool() {
                        "ended"
                    } else if !ready {
                        "loading"
                    } else if media.IsPaused().as_bool() {
                        "paused"
                    } else {
                        "playing"
                    }
                    .into(),
                    message: String::new(),
                    time: if time.is_finite() { time.max(0.0) } else { 0.0 },
                    duration: if duration.is_finite() {
                        duration.max(0.0)
                    } else {
                        0.0
                    },
                    width,
                    height,
                    volume: media.GetVolume(),
                    muted: media.GetMuted().as_bool(),
                    auto_reduced: false,
                };
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_foundation_headless_load_seek_and_release() {
        // Synthetic silent PCM only: no HWND, visible app, user media or audio.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("日本語 seek.wav");
        let data_size = 48000u32 * 2 * 4;
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend((36 + data_size).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(48000u32.to_le_bytes());
        wav.extend(96000u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(data_size.to_le_bytes());
        wav.resize(44 + data_size as usize, 0);
        std::fs::write(&path, &wav).unwrap();
        {
            let _runtime = Runtime::start().unwrap();
            let (tx, events) = mpsc::channel();
            let notify: IMFMediaEngineNotify = Notify(tx).into();
            let engine = create_engine(None, &notify).unwrap();
            unsafe {
                engine.0.SetMuted(true).unwrap();
                engine
                    .0
                    .SetSource(&BSTR::from(path.to_string_lossy().as_ref()))
                    .unwrap();
                engine.0.Load().unwrap();
                let deadline = Instant::now() + Duration::from_secs(15);
                while engine.0.GetReadyState() < 2 {
                    assert!(Instant::now() < deadline, "MF load timed out");
                    for event in events.try_iter() {
                        assert_ne!(event, MF_MEDIA_ENGINE_EVENT_ERROR.0 as u32);
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!((engine.0.GetDuration() - 4.0).abs() < 0.1);
                engine.0.Play().unwrap();
                engine.0.Pause().unwrap();
                engine.0.SetCurrentTime(2.0).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    assert!(Instant::now() < deadline, "MF seek timed out");
                    if events
                        .try_iter()
                        .any(|e| e == MF_MEDIA_ENGINE_EVENT_SEEKED.0 as u32)
                    {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!((engine.0.GetCurrentTime() - 2.0).abs() < 0.1);
                assert!(engine.0.IsPaused().as_bool());
            }
        }
        assert_eq!(std::fs::read(&path).unwrap(), wav);
        std::fs::remove_file(path).expect("MF shutdown must release the source file");
    }
}
