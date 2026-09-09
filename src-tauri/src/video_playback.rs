//! On-demand compatibility playback. Originals are never rewritten.
use crate::{catalog, db::AppState};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::Manager;

// Monthly upstream snapshot (retained longer than daily builds), not a floating
// "latest" URL. Only this SHA-256 verified LGPL shared build may be executed.
const ENGINE_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-win64-lgpl-shared-8.1.zip";
const ENGINE_SHA256: &str = "e9712ffbdb03ef71bbab660c75b835bfe698ef6fad0247c76d8d394a39a3db63";
const ENGINE_BYTES: u64 = 70_835_150;
const OUTPUT_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const JOB_TIMEOUT: Duration = Duration::from_secs(30 * 60);
static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
static ENGINE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    state: String,
    message: String,
    path: Option<String>,
    progress: Option<u8>,
}

struct Job {
    cancelled: AtomicBool,
    status: Mutex<PlaybackStatus>,
    directory: PathBuf,
}

impl Job {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err("再生準備を中止しました。".into())
        } else {
            Ok(())
        }
    }
    fn update(&self, state: &str, message: &str, progress: Option<u8>) {
        if let Ok(mut status) = self.status.lock() {
            status.state = state.into();
            status.message = message.into();
            status.progress = progress;
        }
    }
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    JOBS.get_or_init(Mutex::default)
}

#[tauri::command]
pub fn start_video_playback(
    app: tauri::AppHandle,
    media_id: String,
    transcode: bool,
) -> Result<String, String> {
    let cache = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("video-playback");
    let id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(Job {
        cancelled: AtomicBool::new(false),
        directory: cache.join(&id),
        status: Mutex::new(PlaybackStatus {
            state: "preparing".into(),
            message: "互換再生を準備中…".into(),
            path: None,
            progress: None,
        }),
    });
    {
        let mut jobs = jobs().lock().map_err(|e| e.to_string())?;
        // Only one foreground viewer exists. Retire the previous session even
        // if its renderer vanished before sending cancellation.
        for old in jobs.values() {
            old.cancelled.store(true, Ordering::Relaxed);
        }
        jobs.clear();
        jobs.insert(id.clone(), job.clone());
    }
    std::thread::spawn(move || {
        let result = prepare(&app, &media_id, transcode, &job);
        match result {
            Ok(path) if job.check().is_ok() => {
                if let Ok(mut status) = job.status.lock() {
                    status.state = "ready".into();
                    status.message = "互換再生".into();
                    status.path = Some(path.to_string_lossy().into());
                    status.progress = Some(100);
                }
                // Hold the file for the lifetime of its playback session.
                while job.check().is_ok() {
                    std::thread::sleep(Duration::from_millis(250));
                }
                let _ = app.asset_protocol_scope().forbid_file(&path);
            }
            Err(error) => {
                crate::diagnostics::record("video-playback-error", &error);
                job.update("error", &error, None);
            }
            _ => {}
        }
        // Only this UUID directory was ever written by the worker. Retry briefly
        // while WebView2 releases its last range-read handle after navigation.
        for _ in 0..20 {
            if fs::remove_dir_all(&job.directory).is_ok() || !job.directory.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn get_video_playback_status(job_id: String) -> Result<PlaybackStatus, String> {
    let job = jobs()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&job_id)
        .cloned()
        .ok_or("再生準備が終了しました。")?;
    let status = job.status.lock().map_err(|e| e.to_string())?.clone();
    Ok(status)
}

#[tauri::command]
pub fn cancel_video_playback(job_id: String) {
    if let Ok(mut jobs) = jobs().lock() {
        if let Some(job) = jobs.remove(&job_id) {
            job.cancelled.store(true, Ordering::Relaxed);
        }
    }
}

// Run once on startup; stale sessions left by a crash contain derived data only.
pub fn cleanup_stale_sessions(data: &Path) {
    let Ok(active) = jobs().lock() else {
        return;
    };
    let root = data.join("video-playback");
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if !active.values().any(|job| job.directory == entry.path())
                && uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok()
                && entry
                    .file_type()
                    .is_ok_and(|t| t.is_dir() && !t.is_symlink())
                && entry
                    .path()
                    .canonicalize()
                    .ok()
                    .zip(root.canonicalize().ok())
                    .is_some_and(|(path, root)| path.starts_with(root))
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

fn prepare(
    app: &tauri::AppHandle,
    media_id: &str,
    force_transcode: bool,
    job: &Job,
) -> Result<PathBuf, String> {
    job.check()?;
    let state = app.state::<AppState>();
    let (_, source) = catalog::resolve_media_path_for_recycle(&state, media_id)?;
    if !catalog::classify_media(&source).is_some_and(|(kind, _, _)| kind == "video") {
        return Err("このファイルは動画ではありません。".into());
    }
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let engine = ensure_engine(&data, job)?;
    fs::create_dir_all(&job.directory).map_err(|e| e.to_string())?;
    let path = convert(&engine, &source, force_transcode, job)?;
    job.check()?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())?;
    Ok(path)
}

fn ensure_engine(data: &Path, job: &Job) -> Result<PathBuf, String> {
    if !cfg!(target_os = "windows") {
        return Err("互換再生はWindows版で利用できます。".into());
    }
    job.update("preparing", "再生エンジンを確認中…", None);
    // Cancellation must also work while another request finishes a download.
    let _guard = loop {
        job.check()?;
        if let Ok(guard) = ENGINE_LOCK.try_lock() {
            break guard;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let root = data.join("video-engine");
    let installed = root.join(ENGINE_SHA256);
    let engine = installed.join("bin");
    if engine.join("ffmpeg.exe").is_file() && engine.join("ffprobe.exe").is_file() {
        return Ok(engine);
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    // The engine mutex excludes active downloads. Remove only our abandoned
    // staging directories after a crash; keep installed engines and other data.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name
                .to_string_lossy()
                .strip_prefix("download-")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
                && entry
                    .file_type()
                    .is_ok_and(|t| t.is_dir() && !t.is_symlink())
                && entry
                    .path()
                    .canonicalize()
                    .ok()
                    .zip(root.canonicalize().ok())
                    .is_some_and(|(path, root)| path.starts_with(root))
            {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let stage = root.join(format!("download-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        job.update(
            "downloading",
            "初回のみ再生エンジンを取得中（約71MB）…",
            Some(0),
        );
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(15 * 60))
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client.get(ENGINE_URL).send().and_then(|r| r.error_for_status())
            .map_err(|_| "再生エンジンを取得できませんでした。インターネット接続を確認し、再試行してください。")?;
        let archive_path = stage.join("engine.zip");
        let mut archive_file = File::create(&archive_path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            job.check()?;
            let n = response.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            count += n as u64;
            if count > ENGINE_BYTES {
                return Err("再生エンジンのサイズが一致しません。".into());
            }
            hash.update(&buffer[..n]);
            archive_file
                .write_all(&buffer[..n])
                .map_err(|e| e.to_string())?;
            job.update(
                "downloading",
                "初回のみ再生エンジンを取得中（約71MB）…",
                Some((count * 100 / ENGINE_BYTES) as u8),
            );
        }
        drop(archive_file);
        if count != ENGINE_BYTES || format!("{:x}", hash.finalize()) != ENGINE_SHA256 {
            return Err("再生エンジンの検証に失敗しました。再試行してください。".into());
        }
        let unpacked = stage.join("unpacked");
        fs::create_dir(&unpacked).map_err(|e| e.to_string())?;
        let mut archive =
            zip::ZipArchive::new(File::open(archive_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let mut expanded = 0u64;
        for i in 0..archive.len() {
            job.check()?;
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            let Some(relative) = file
                .enclosed_name()
                .map(|p| p.components().skip(1).collect::<PathBuf>())
            else {
                continue;
            };
            if file.is_dir() || relative.as_os_str().is_empty() {
                continue;
            }
            expanded += file.size();
            if expanded > 512 * 1024 * 1024 {
                return Err("再生エンジンの展開サイズが上限を超えました。".into());
            }
            let destination = unpacked.join(relative);
            fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            std::io::copy(
                &mut file,
                &mut File::create(destination).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        job.check()?;
        if !unpacked.join("bin/ffmpeg.exe").is_file() || !unpacked.join("bin/ffprobe.exe").is_file()
        {
            return Err("再生エンジンが見つかりませんでした。".into());
        }
        fs::rename(&unpacked, &installed).map_err(|e| e.to_string())?;
        Ok(engine)
    })();
    let _ = fs::remove_dir_all(stage);
    result
}

fn command(engine: &Path, name: &str) -> Command {
    let mut command = Command::new(engine.join(format!("{name}.exe")));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00004000); // no console, below-normal priority
    }
    command
}

// Restrict inputs to local files: a crafted playlist must not initiate network
// requests from the helper process. Arguments are never passed through a shell.
fn input_args(command: &mut Command, source: &Path) {
    command
        .args(["-protocol_whitelist", "file,pipe", "-threads", "2", "-i"])
        .arg(source);
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(windows)]
fn kill_with_parent(child: &Child) -> Result<std::os::windows::io::OwnedHandle, String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err("再生エンジンのプロセス管理を開始できませんでした。".into());
        }
        let handle = OwnedHandle::from_raw_handle(raw);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            &info as *const _ as _,
            std::mem::size_of_val(&info) as u32,
        ) == 0
            || AssignProcessToJobObject(raw, child.as_raw_handle()) == 0
        {
            return Err("再生エンジンの終了処理を設定できませんでした。".into());
        }
        Ok(handle)
    }
}

fn wait(command: &mut Command, job: &Job, output: &Path, timeout: Duration) -> Result<(), String> {
    let mut child = ChildGuard(
        command
            .spawn()
            .map_err(|e| format!("再生エンジンを起動できません: {e}"))?,
    );
    #[cfg(windows)]
    let _parent_job = kill_with_parent(&child.0)?;
    let start = Instant::now();
    loop {
        job.check()?;
        if start.elapsed() > timeout {
            return Err("互換再生の準備が時間制限を超えました。".into());
        }
        if fs::metadata(output).is_ok_and(|m| m.len() > OUTPUT_LIMIT) {
            return Err("再生用データが上限の2GBを超えました。".into());
        }
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            return if status.success() {
                Ok(())
            } else {
                Err("この動画を互換形式に変換できませんでした。".into())
            };
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn convert(
    engine: &Path,
    source: &Path,
    force_transcode: bool,
    job: &Job,
) -> Result<PathBuf, String> {
    job.update("preparing", "動画の形式を確認中…", None);
    let probe_path = job.directory.join("probe.json");
    let mut probe = command(engine, "ffprobe");
    probe.args([
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,pix_fmt",
        "-of",
        "json",
    ]);
    input_args(&mut probe, source);
    probe.stdout(File::create(&probe_path).map_err(|e| e.to_string())?);
    wait(&mut probe, job, &probe_path, Duration::from_secs(30))?;
    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(&probe_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let stream = metadata["streams"]
        .as_array()
        .and_then(|streams| streams.iter().find(|s| s["codec_type"] == "video"))
        .ok_or("動画トラックが見つかりませんでした。")?;
    let can_copy = stream["codec_name"] == "h264"
        && matches!(stream["pix_fmt"].as_str(), Some("yuv420p" | "yuvj420p"));
    if can_copy && !force_transcode {
        job.update("preparing", "互換再生を準備中（映像の画質を維持）…", None);
        let output = job.directory.join("playback.mp4");
        let mut remux = command(engine, "ffmpeg");
        remux.args(["-nostdin", "-v", "error", "-y"]);
        input_args(&mut remux, source);
        remux
            .args([
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-sn",
                "-dn",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-ac",
                "2",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
            ])
            .arg(&output);
        if wait(&mut remux, job, &output, JOB_TIMEOUT).is_ok()
            && fs::metadata(&output).is_ok_and(|m| m.len() > 0 && m.len() <= OUTPUT_LIMIT)
        {
            return Ok(output);
        }
        job.check()?;
        let _ = fs::remove_file(output);
    }
    job.update(
        "preparing",
        "互換形式へ変換中…（長い動画は時間がかかります）",
        None,
    );
    let output = job.directory.join("playback.webm");
    let mut transcode = command(engine, "ffmpeg");
    transcode.args(["-nostdin", "-v", "error", "-y", "-filter_threads", "2"]);
    input_args(&mut transcode, source);
    transcode
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "2",
            "-row-mt",
            "1",
            "-deadline",
            "realtime",
            "-cpu-used",
            "6",
            "-crf",
            "28",
            "-b:v",
            "0",
            "-c:a",
            "libopus",
            "-ac",
            "2",
            "-b:a",
            "128k",
        ])
        .arg(&output);
    wait(&mut transcode, job, &output, JOB_TIMEOUT)?;
    if !fs::metadata(&output).is_ok_and(|m| m.len() > 0 && m.len() <= OUTPUT_LIMIT) {
        return Err("再生用データを生成できませんでした。".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_job(directory: PathBuf) -> Job {
        Job {
            cancelled: AtomicBool::new(false),
            directory,
            status: Mutex::new(PlaybackStatus {
                state: "preparing".into(),
                message: String::new(),
                path: None,
                progress: None,
            }),
        }
    }
    #[test]
    fn cleanup_only_owns_uuid_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("video-playback");
        let stale = root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("playback.webm"), b"partial").unwrap();
        fs::create_dir(root.join("keep-user-folder")).unwrap();
        cleanup_stale_sessions(temp.path());
        assert!(!stale.exists());
        assert!(root.join("keep-user-folder").exists());
    }
    #[test]
    fn cancellation_is_observed() {
        let temp = tempfile::tempdir().unwrap();
        let job = fixture_job(temp.path().to_path_buf());
        job.cancelled.store(true, Ordering::Relaxed);
        assert!(job.check().is_err());
    }
    // Real decoders/encoders tested against synthetic sources, never user media.
    #[test]
    #[ignore = "downloads the pinned playback engine; run explicitly for release validation"]
    fn real_compatibility_formats() {
        let temp = tempfile::tempdir().unwrap();
        let job = fixture_job(temp.path().join("session"));
        fs::create_dir(&job.directory).unwrap();
        let data = PathBuf::from(std::env::var("PIXVAULT_TEST_ENGINE_DATA").unwrap());
        let engine = ensure_engine(&data, &job).unwrap();
        let samples = data.join("samples");
        fs::create_dir_all(&samples).unwrap();
        for (codec, container) in [
            ("mpeg4", "avi"),
            ("ffv1", "mkv"),
            ("wmv2", "wmv"),
            ("libopenh264", "mov"),
            ("libkvazaar", "mkv"),
        ] {
            let source = temp.path().join(format!("日本語 {codec}.{container}"));
            let mut generate = command(&engine, "ffmpeg");
            generate
                .args([
                    "-nostdin",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=160x96:rate=10",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440",
                    "-t",
                    "0.5",
                    "-c:v",
                    codec,
                    "-c:a",
                    "pcm_s16le",
                ])
                .arg(&source);
            assert!(generate.status().unwrap().success(), "generate {codec}");
            let before = fs::read(&source).unwrap();
            let result = convert(&engine, &source, false, &job).unwrap();
            let mut decode = command(&engine, "ffmpeg");
            decode
                .args(["-v", "error", "-i"])
                .arg(&result)
                .args(["-f", "null", "-"]);
            assert!(decode.status().unwrap().success(), "decode {codec}");
            fs::copy(
                &result,
                samples.join(format!(
                    "{codec}.{}",
                    result.extension().unwrap().to_str().unwrap()
                )),
            )
            .unwrap();
            if codec == "libopenh264" {
                assert_eq!(result.extension().unwrap(), "mp4");
                let bytes = fs::read(&result).unwrap();
                assert!(
                    bytes.windows(4).position(|b| b == b"moov").unwrap()
                        < bytes.windows(4).position(|b| b == b"mdat").unwrap()
                );
                let forced = convert(&engine, &source, true, &job).unwrap();
                assert_eq!(forced.extension().unwrap(), "webm");
            }
            assert_eq!(fs::read(source).unwrap(), before);
        }
        let mut long_run = command(&engine, "ffmpeg");
        long_run.args([
            "-nostdin",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=10",
            "-t",
            "30",
            "-f",
            "null",
            "-",
        ]);
        let started = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(200));
                job.cancelled.store(true, Ordering::Relaxed);
            });
            assert!(
                wait(
                    &mut long_run,
                    &job,
                    &job.directory.join("unused"),
                    JOB_TIMEOUT
                )
                .is_err()
            );
        });
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "cancelled child must be killed and reaped promptly"
        );
    }
}
