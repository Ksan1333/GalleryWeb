mod ai;
mod ascii2d;
mod background_activity;
mod book_cache;
mod catalog;
mod db;
mod diagnostics;
mod external_input;
mod feature_vectors;
mod file_browser;
mod folder_watcher;
mod in_app_browser;
mod media_folders;
mod migration;
mod models;
mod organization;
mod platform;
mod system_metrics;
mod tag_translations;
mod thumbnail_cache;
mod video_decode;
mod web_search;
mod windows_notifications;
mod x_downloader;

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, OnceLock, RwLock,
        atomic::{AtomicBool, Ordering as AtomicOrdering},
    },
    time::{Duration, Instant, SystemTime},
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::{
    db::AppState,
    models::{
        ArchiveBookInfo, ArchiveBookPageCacheEntry, BookBookmark, CatalogImportPayload,
        ImportCatalogResult, LibraryRoot, LibrarySummary, MediaItem, MediaQuery, MutationResult,
        PreferenceEntry, RuntimeInfo, ScanReport, Tag, TagInput, TagWithCount, XHistoryInput,
        XHistoryItem,
    },
};

pub(crate) const DATABASE_SCHEMA_VERSION: u32 = 9;
const MIGRATION_FORMAT_VERSION: u32 = 1;
const DRAWING_REFERENCES_PREFERENCE_KEY: &str = "drawing.references";
const MAX_BOOK_COVER_BYTES: u64 = 20 * 1024 * 1024;
const MAX_BOOK_PAGE_BYTES: u64 = 40 * 1024 * 1024;
const MAX_ARCHIVE_BOOK_PAGES: usize = 20_000;
const MAX_ARCHIVE_BOOK_TOTAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BOOK_BATCH_PAGES: usize = 24;
const MAX_ARCHIVE_BOOK_BATCH_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_PAGE_INDEX_CACHE_ENTRIES: usize = 8;
const MAX_MEDIA_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;
const MAX_CAPTURE_BYTES: usize = 40 * 1024 * 1024;
const MAX_REFERENCE_CACHE_BYTES: u64 = 100 * 1024 * 1024;
const THUMBNAIL_PRECACHE_CURSOR_KEY: &str = "thumbnail.precacheCursor";
const THUMBNAIL_PRECACHE_FINGERPRINT_KEY: &str = "thumbnail.precacheFingerprint";
const MAX_THUMBNAIL_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_THUMBNAIL_CACHE_FILES: usize = 40_000;
const THUMBNAIL_CACHE_TARGET_BYTES: u64 = MAX_THUMBNAIL_CACHE_BYTES * 9 / 10;
const THUMBNAIL_CACHE_TARGET_FILES: usize = MAX_THUMBNAIL_CACHE_FILES * 9 / 10;
const MAX_MEDIA_PREVIEW_CACHE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_CACHE_FILES: usize = 2_000;
static THUMBNAIL_PRECACHE_RUNNING: AtomicBool = AtomicBool::new(false);
static THUMBNAIL_PRECACHE_PROGRESS: OnceLock<Mutex<Option<ThumbnailPrecacheProgress>>> =
    OnceLock::new();
const THUMBNAIL_PRECACHE_PROGRESS_EVENT: &str = "thumbnail-precache-progress";
const MEDIA_PRESENCE_CACHE_TTL: Duration = Duration::from_secs(45);
const MEDIA_PRESENCE_QUEUE_LIMIT: usize = 2_048;
const MEDIA_PRESENCE_BATCH_SIZE: usize = 12;
const NATIVE_THUMBNAIL_BACKGROUND_WORKERS: usize = 1;
const THUMBNAIL_BACKGROUND_QUIET_PERIOD: Duration = Duration::from_millis(650);
const STARTUP_DIAGNOSTIC_DELAY: Duration = Duration::from_secs(5);
const STARTUP_DIAGNOSTIC_QUIET_PERIOD: Duration = Duration::from_secs(2);
const STARTUP_DIAGNOSTIC_POLL_INTERVAL: Duration = Duration::from_millis(200);
const STARTUP_MISSING_RECOVERY_DELAY: Duration = Duration::from_secs(7);
const THUMBNAIL_INDEX_MANIFEST_NAME: &str = ".thumbnail-index-v1.json";
const THUMBNAIL_PRECACHE_CHECKPOINT_INTERVAL: usize = 2_048;
static THUMBNAIL_PRECACHE_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct ThumbnailPathIndex {
    directory: Option<PathBuf>,
    file_names: HashSet<String>,
    added_during_scan: HashSet<String>,
    removed_during_scan: HashSet<String>,
    initializing: bool,
    ready: bool,
}

impl ThumbnailPathIndex {
    fn publish_snapshot(&mut self, directory: &Path, mut file_names: HashSet<String>, ready: bool) {
        if self.directory.as_deref() != Some(directory) {
            return;
        }
        // Visible requests can publish or invalidate files while the manifest
        // is read or the directory is enumerated. Neither snapshot may undo
        // those changes; retain the overlay until reconciliation finishes.
        file_names.extend(self.added_during_scan.iter().cloned());
        for removed in &self.removed_during_scan {
            file_names.remove(removed);
        }
        self.file_names = file_names;
        if ready {
            self.added_during_scan.clear();
            self.removed_during_scan.clear();
            self.initializing = false;
            self.ready = true;
        }
    }
}

static THUMBNAIL_PATH_INDEX: OnceLock<RwLock<ThumbnailPathIndex>> = OnceLock::new();
static THUMBNAIL_MANIFEST_WRITE: OnceLock<Mutex<()>> = OnceLock::new();

/// Keep database mutex waits, SQLite work, and filesystem probes off the IPC
/// dispatcher and async executor. Callers obtain the managed AppState inside
/// this worker, retaining the existing connection instead of reopening the DB.
async fn run_catalog_worker<T: Send + 'static>(
    operation: &'static str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    background_activity::note_foreground_activity();
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("{operation} worker failed: {error}"))?
}

#[derive(Clone)]
struct MediaPresenceCandidate {
    media_id: String,
    absolute_path: String,
    modified_at: i64,
}

#[derive(Clone, Copy)]
struct MediaPresenceCheck {
    modified_at: i64,
    checked_at: Instant,
    present: bool,
}

#[derive(Default)]
struct MediaPresenceControl {
    running: bool,
    pending: VecDeque<MediaPresenceCandidate>,
    queued: HashSet<String>,
    checked: HashMap<String, MediaPresenceCheck>,
}

static MEDIA_PRESENCE_CONTROL: OnceLock<Mutex<MediaPresenceControl>> = OnceLock::new();

#[derive(Clone)]
struct CanonicalRootEntry {
    path: PathBuf,
    checked_at: Instant,
}

static CANONICAL_ROOT_CACHE: OnceLock<RwLock<HashMap<PathBuf, CanonicalRootEntry>>> =
    OnceLock::new();
const CANONICAL_ROOT_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy)]
struct ThumbnailFailureBackoff {
    attempts: u8,
    retry_at: Instant,
}

static THUMBNAIL_FAILURE_BACKOFF: OnceLock<Mutex<HashMap<String, ThumbnailFailureBackoff>>> =
    OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThumbnailWorkPriority {
    Foreground,
    Background,
}

#[derive(Default)]
struct NativeThumbnailWorkState {
    running_foreground: usize,
    running_background: usize,
    waiting_foreground: usize,
    active_keys: HashSet<String>,
}

static NATIVE_THUMBNAIL_WORK: OnceLock<(Mutex<NativeThumbnailWorkState>, Condvar)> =
    OnceLock::new();

struct NativeThumbnailPermit {
    key: String,
    priority: ThumbnailWorkPriority,
}

impl Drop for NativeThumbnailPermit {
    fn drop(&mut self) {
        let (state, wake) = NATIVE_THUMBNAIL_WORK.get_or_init(|| {
            (
                Mutex::new(NativeThumbnailWorkState::default()),
                Condvar::new(),
            )
        });
        if let Ok(mut state) = state.lock() {
            match self.priority {
                ThumbnailWorkPriority::Foreground => {
                    state.running_foreground = state.running_foreground.saturating_sub(1);
                }
                ThumbnailWorkPriority::Background => {
                    state.running_background = state.running_background.saturating_sub(1);
                }
            }
            state.active_keys.remove(&self.key);
            wake.notify_all();
        }
    }
}

fn native_thumbnail_foreground_limit() -> usize {
    match std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
    {
        0..=2 => 1,
        3..=4 => 2,
        5..=8 => 3,
        _ => 4,
    }
}

fn acquire_native_thumbnail_permit(
    key: String,
    priority: ThumbnailWorkPriority,
) -> Result<Option<NativeThumbnailPermit>, String> {
    let (state, wake) = NATIVE_THUMBNAIL_WORK.get_or_init(|| {
        (
            Mutex::new(NativeThumbnailWorkState::default()),
            Condvar::new(),
        )
    });
    let mut state = state
        .lock()
        .map_err(|_| "Native thumbnail worker state is unavailable".to_owned())?;
    if priority == ThumbnailWorkPriority::Foreground {
        state.waiting_foreground += 1;
    }
    loop {
        if priority == ThumbnailWorkPriority::Background
            && THUMBNAIL_PRECACHE_CANCEL_REQUESTED.load(AtomicOrdering::Acquire)
        {
            return Ok(None);
        }
        let has_capacity = match priority {
            ThumbnailWorkPriority::Foreground => {
                state.running_foreground < native_thumbnail_foreground_limit()
            }
            ThumbnailWorkPriority::Background => {
                state.running_background < NATIVE_THUMBNAIL_BACKGROUND_WORKERS
                    && state.running_foreground == 0
                    && state.waiting_foreground == 0
                    && !background_activity::is_foreground_active(THUMBNAIL_BACKGROUND_QUIET_PERIOD)
            }
        };
        if has_capacity && !state.active_keys.contains(&key) {
            break;
        }
        let (next_state, _) = wake
            .wait_timeout(state, Duration::from_millis(50))
            .map_err(|_| "Native thumbnail worker state is unavailable".to_owned())?;
        state = next_state;
    }
    match priority {
        ThumbnailWorkPriority::Foreground => {
            state.waiting_foreground = state.waiting_foreground.saturating_sub(1);
            state.running_foreground += 1;
        }
        ThumbnailWorkPriority::Background => state.running_background += 1,
    }
    state.active_keys.insert(key.clone());
    Ok(Some(NativeThumbnailPermit { key, priority }))
}

fn canonical_library_root(root: &Path) -> Option<PathBuf> {
    if let Ok(cache) = CANONICAL_ROOT_CACHE
        .get_or_init(|| RwLock::new(HashMap::new()))
        .read()
        && let Some(entry) = cache.get(root)
        && entry.checked_at.elapsed() < CANONICAL_ROOT_CACHE_TTL
    {
        return Some(entry.path.clone());
    }
    let canonical = root.canonicalize().ok().filter(|path| path.is_dir())?;
    if let Ok(mut cache) = CANONICAL_ROOT_CACHE
        .get_or_init(|| RwLock::new(HashMap::new()))
        .write()
    {
        if cache.len() >= 256 {
            cache.retain(|_, entry| entry.checked_at.elapsed() < CANONICAL_ROOT_CACHE_TTL);
            if cache.len() >= 256 {
                cache.clear();
            }
        }
        cache.insert(
            root.to_owned(),
            CanonicalRootEntry {
                path: canonical.clone(),
                checked_at: Instant::now(),
            },
        );
    }
    Some(canonical)
}

fn thumbnail_failure_is_deferred(key: &str) -> bool {
    THUMBNAIL_FAILURE_BACKOFF
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|failures| failures.get(key).copied())
        .is_some_and(|failure| failure.retry_at > Instant::now())
}

fn record_thumbnail_failure(key: String) {
    let Ok(mut failures) = THUMBNAIL_FAILURE_BACKOFF
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    else {
        return;
    };
    if failures.len() >= 16_384 {
        failures.retain(|_, failure| failure.retry_at > Instant::now());
        if failures.len() >= 16_384 {
            failures.clear();
        }
    }
    let attempts = failures
        .get(&key)
        .map(|failure| failure.attempts.saturating_add(1))
        .unwrap_or(1);
    let delay = match attempts {
        1 => Duration::from_secs(5 * 60),
        2 => Duration::from_secs(30 * 60),
        3 => Duration::from_secs(2 * 60 * 60),
        _ => Duration::from_secs(12 * 60 * 60),
    };
    failures.insert(
        key,
        ThumbnailFailureBackoff {
            attempts,
            retry_at: Instant::now() + delay,
        },
    );
}

fn clear_thumbnail_failure(key: &str) {
    if let Ok(mut failures) = THUMBNAIL_FAILURE_BACKOFF
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        failures.remove(key);
    }
}

struct AtomicRunningGuard(&'static AtomicBool);

impl Drop for AtomicRunningGuard {
    fn drop(&mut self) {
        self.0.store(false, AtomicOrdering::Release);
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailPrecacheProgress {
    phase: &'static str,
    message: String,
    current: usize,
    total: usize,
}

fn report_thumbnail_precache_progress(app: &tauri::AppHandle, progress: ThumbnailPrecacheProgress) {
    if let Ok(mut current) = THUMBNAIL_PRECACHE_PROGRESS
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        *current = Some(progress.clone());
    }
    let _ = app.emit(THUMBNAIL_PRECACHE_PROGRESS_EVENT, progress);
}

#[tauri::command]
fn get_thumbnail_precache_status() -> Result<Option<ThumbnailPrecacheProgress>, String> {
    THUMBNAIL_PRECACHE_PROGRESS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map(|progress| progress.clone())
        .map_err(|_| "サムネイル進捗の状態を取得できませんでした。".to_owned())
}

/// Starts the optional full thumbnail cache pass only when an explicit Tauri
/// command requests it. It deliberately does not chain vector indexing.
#[tauri::command]
fn start_thumbnail_precache(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> bool {
    schedule_thumbnail_precache(app, state.database.path().to_owned(), limit.unwrap_or(128))
}

#[tauri::command]
fn cancel_thumbnail_precache() -> bool {
    if !THUMBNAIL_PRECACHE_RUNNING.load(AtomicOrdering::Acquire) {
        return false;
    }
    THUMBNAIL_PRECACHE_CANCEL_REQUESTED.store(true, AtomicOrdering::Release);
    if let Some((_, wake)) = NATIVE_THUMBNAIL_WORK.get() {
        wake.notify_all();
    }
    true
}

fn is_web_reference(value: &str) -> bool {
    value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        || value
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
}

#[derive(Debug, Clone)]
struct ArchivePageEntry {
    zip_index: usize,
    name: String,
    extension: String,
    size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ArchivePageIndexKey {
    path: PathBuf,
    modified_millis: u128,
    byte_size: u64,
}

#[derive(Default)]
struct ArchivePageIndexCache {
    entries: HashMap<ArchivePageIndexKey, Arc<Vec<ArchivePageEntry>>>,
    lru: VecDeque<ArchivePageIndexKey>,
}

static ARCHIVE_PAGE_INDEX_CACHE: OnceLock<Mutex<ArchivePageIndexCache>> = OnceLock::new();

#[tauri::command]
fn get_runtime_info() -> RuntimeInfo {
    let update_endpoint_configured = option_env!("PIXVAULT_UPDATE_ENDPOINT")
        .is_some_and(|value| value.trim().to_ascii_lowercase().starts_with("https://"));
    let update_public_key_configured =
        option_env!("PIXVAULT_UPDATE_PUBLIC_KEY").is_some_and(|value| !value.trim().is_empty());
    let signing_certificate_configured = option_env!("PIXVAULT_WINDOWS_CERTIFICATE_THUMBPRINT")
        .is_some_and(|value| !value.trim().is_empty());
    RuntimeInfo {
        app_name: if cfg!(target_os = "linux") {
            "PixVault"
        } else {
            "PixVault for Windows"
        },
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        database_schema_version: DATABASE_SCHEMA_VERSION,
        migration_format_version: MIGRATION_FORMAT_VERSION,
        // Keep the updater fail-closed until the signed distribution pipeline
        // supplies all three values and the updater transport is integrated.
        automatic_updates_enabled: false,
        update_https_endpoint_configured: update_endpoint_configured,
        update_public_key_configured,
        windows_signing_certificate_configured: signing_certificate_configured,
    }
}

#[tauri::command]
fn record_diagnostic_event(event: String, message: String) -> Result<bool, String> {
    if !matches!(
        event.as_str(),
        "renderer-error" | "unhandled-rejection" | "renderer-recovered"
    ) {
        return Err("Unsupported diagnostic event".to_owned());
    }
    diagnostics::record(&event, &message);
    Ok(true)
}

#[cfg(test)]
mod diagnostic_command_tests {
    use super::record_diagnostic_event;

    #[test]
    fn renderer_diagnostics_accept_only_bounded_event_categories() {
        assert!(
            record_diagnostic_event("renderer-error".to_owned(), "TypeError".to_owned()).is_ok()
        );
        assert!(record_diagnostic_event("arbitrary".to_owned(), "not allowed".to_owned()).is_err());
    }
}

#[tauri::command]
fn pick_library_root(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("メディアフォルダーを選択")
        .blocking_pick_folder();
    selected
        .map(|file_path| match file_path {
            FilePath::Path(path) => path
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "Selected folder path is not valid Unicode".to_owned()),
            FilePath::Url(_) => {
                Err("Only local Windows folders can be registered as library roots".to_owned())
            }
        })
        .transpose()
}

#[tauri::command]
fn pick_drawing_reference(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("お絵描き資料を選択")
        .blocking_pick_file();
    selected
        .map(|file_path| match file_path {
            FilePath::Path(path) => {
                app.asset_protocol_scope()
                    .allow_file(&path)
                    .map_err(|error| format!("Failed to allow drawing reference asset: {error}"))?;
                path.to_str()
                    .map(ToOwned::to_owned)
                    .ok_or_else(|| "Selected file path is not valid Unicode".to_owned())
            }
            FilePath::Url(_) => {
                Err("Only local files can be used as drawing references".to_owned())
            }
        })
        .transpose()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TemporaryReferenceCacheResult {
    path: String,
    bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TemporaryReferenceCleanupResult {
    removed: u64,
    missing: u64,
}

#[tauri::command]
fn cache_temporary_drawing_reference(
    app: tauri::AppHandle,
    project_id: String,
    reference_id: String,
    source_path: String,
) -> Result<TemporaryReferenceCacheResult, String> {
    let directory = reference_cache_directory(&app, &project_id)?;
    let (path, bytes) =
        copy_temporary_reference(Path::new(&source_path), &directory, &reference_id)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("Failed to allow cached reference asset: {error}"))?;
    Ok(TemporaryReferenceCacheResult {
        path: path
            .to_str()
            .map(ToOwned::to_owned)
            .ok_or_else(|| "Cached reference path is not valid Unicode".to_owned())?,
        bytes,
    })
}

#[tauri::command]
fn cleanup_temporary_drawing_references(
    app: tauri::AppHandle,
    project_id: String,
    paths: Vec<String>,
) -> Result<TemporaryReferenceCleanupResult, String> {
    let directory = reference_cache_directory(&app, &project_id)?;
    let (removed, missing) = cleanup_reference_cache_files(&directory, &paths)?;
    Ok(TemporaryReferenceCleanupResult { removed, missing })
}

#[tauri::command]
fn pick_android_migration_archive(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<migration::MigrationArchivePreview>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Android版のPixVault移行ZIPを選択")
        .add_filter("PixVault移行ZIP", &["zip"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = match selected {
        FilePath::Path(path) => path,
        FilePath::Url(_) => {
            return Err("ローカルの移行ZIPを選択してください。".to_owned());
        }
    };
    migration::inspect_android_archive(&state, &path).map(Some)
}

#[tauri::command]
fn commit_android_migration_archive(
    state: State<'_, AppState>,
    token: String,
    resolutions: Option<HashMap<String, String>>,
) -> Result<migration::MigrationImportResult, String> {
    if token.trim().is_empty() || token.len() > 128 {
        return Err("移行確認トークンが正しくありません。".to_owned());
    }
    migration::commit_android_archive(&state, &token, &resolutions.unwrap_or_default())
}

#[tauri::command]
fn export_settings_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<migration::SettingsBackupResult>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("PixVault設定バックアップの保存先")
        .set_file_name("pixvault-settings-backup.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = match selected {
        FilePath::Path(path) => path,
        FilePath::Url(_) => return Err("ローカルファイルへ保存してください。".to_owned()),
    };
    migration::write_settings_backup(&state, &path, env!("CARGO_PKG_VERSION")).map(Some)
}

#[tauri::command]
fn import_settings_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<migration::SettingsBackupResult>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("PixVault設定バックアップを選択")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = match selected {
        FilePath::Path(path) => path,
        FilePath::Url(_) => return Err("ローカルの設定バックアップを選択してください。".to_owned()),
    };
    migration::import_settings_backup(&state, &path).map(Some)
}

#[tauri::command]
fn get_system_diagnostics(
    state: State<'_, AppState>,
) -> Result<diagnostics::SystemDiagnostics, String> {
    diagnostics::inspect(&state)
}

#[tauri::command]
fn optimize_catalog(state: State<'_, AppState>) -> Result<diagnostics::SystemDiagnostics, String> {
    diagnostics::optimize(&state)
}

/// Runs the startup integrity check after the first paint and only once the
/// user has stopped interacting. The SQLite quick-check can scan a large
/// catalog, so it must never delay creation of the main window.
fn schedule_startup_diagnostics(database_path: PathBuf) {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(STARTUP_DIAGNOSTIC_DELAY);
        background_activity::wait_until_quiet(
            STARTUP_DIAGNOSTIC_QUIET_PERIOD,
            STARTUP_DIAGNOSTIC_POLL_INTERVAL,
        );
        let result = AppState::open(&database_path).and_then(|worker_state| {
            let result = diagnostics::inspect(&worker_state);
            if result.is_ok() {
                // PASSIVE never waits for readers. Combined with the database
                // journal size limit, this gradually releases WAL space left
                // by older full-catalog scans without delaying interaction.
                if let Ok(connection) = worker_state.database.lock() {
                    let _ = connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
                }
            }
            result
        });
        match result {
            Ok(diagnostics_result) => diagnostics::record(
                "database",
                &format!(
                    "Deferred startup integrity status: {}",
                    diagnostics_result.status
                ),
            ),
            Err(error) => diagnostics::record("database-error", &error),
        }
    });
}

/// Repairs false missing flags left by older presence checks after the first
/// paint. The catalog helper samples real paths before changing any flags, so
/// an actually offline or largely deleted root is left untouched.
fn schedule_startup_missing_recovery(app: tauri::AppHandle, database_path: PathBuf) {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(STARTUP_MISSING_RECOVERY_DELAY);
        background_activity::wait_until_quiet(
            STARTUP_DIAGNOSTIC_QUIET_PERIOD,
            STARTUP_DIAGNOSTIC_POLL_INTERVAL,
        );
        let result = AppState::open(&database_path)
            .and_then(|worker_state| catalog::recover_suspicious_missing_media(&worker_state));
        match result {
            Ok(recovered) => {
                let restored = recovered.iter().map(|(_, count)| *count).sum::<u64>();
                if restored == 0 {
                    return;
                }
                invalidate_media_presence_cache();
                diagnostics::record(
                    "missing-media-recovery",
                    &format!("Restored {restored} falsely missing catalog records"),
                );
                let _ = app.emit(
                    folder_watcher::LIBRARY_WATCH_EVENT,
                    serde_json::json!({
                        "rootId": "recovery",
                        "inserted": 0,
                        "updated": restored,
                        "missing": 0,
                        "queuedForAnalysis": 0
                    }),
                );
            }
            Err(error) => diagnostics::record("missing-media-recovery-error", &error),
        }
    });
}

#[tauri::command]
fn export_diagnostics_report(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<diagnostics::DiagnosticExportResult>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("PixVault診断レポートの保存先")
        .set_file_name("pixvault-diagnostics.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = match selected {
        FilePath::Path(path) => path,
        FilePath::Url(_) => return Err("ローカルファイルへ保存してください。".to_owned()),
    };
    diagnostics::export_report(&state, &path).map(Some)
}

#[tauri::command]
fn create_catalog_recovery_snapshot(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<diagnostics::RecoverySnapshotResult>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("PixVault復旧用カタログの保存先")
        .set_file_name("pixvault-catalog-recovery.sqlite3")
        .add_filter("SQLite", &["sqlite3"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = match selected {
        FilePath::Path(path) => path,
        FilePath::Url(_) => return Err("ローカルファイルへ保存してください。".to_owned()),
    };
    diagnostics::create_recovery_snapshot(&state, &path).map(Some)
}

#[tauri::command]
fn get_default_x_download_directory(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .download_dir()
        .map_err(|error| format!("Downloadsフォルダーを取得できませんでした: {error}"))?
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Downloadsフォルダーのパスを扱えません。".to_owned())
}

#[tauri::command]
fn pick_x_download_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Xメディアの保存先を選択")
        .blocking_pick_folder();
    selected
        .map(|file_path| match file_path {
            FilePath::Path(path) => path
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| "選択した保存先のパスを扱えません。".to_owned()),
            FilePath::Url(_) => Err("ローカルフォルダーを選択してください。".to_owned()),
        })
        .transpose()
}

#[tauri::command]
async fn get_archive_cover(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> Result<Option<String>, String> {
    background_activity::note_foreground_activity();
    let (_root, archive_path) = catalog::resolve_media_path_for_recycle(&state, &media_id)?;
    let data_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve application data directory: {error}"))?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        let generation = archive_book_cache_generation(&media_id, &archive_path)?;
        book_cache::with_directory(
            &data_root,
            book_cache::Kind::Covers,
            &safe_cache_id(&media_id),
            &generation,
            |directory| {
                let path = cache_archive_cover(&archive_path, directory)?;
                Ok((path.clone(), path.into_iter().collect()))
            },
        )
    })
    .await
    .map_err(|error| format!("Archive cover task failed: {error}"))??;
    if let Some(path) = &path {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|error| format!("Failed to allow book cover asset: {error}"))?;
    }
    Ok(path.and_then(|path| path.to_str().map(ToOwned::to_owned)))
}

fn cache_archive_cover(
    archive_path: &Path,
    cache_directory: &Path,
) -> Result<Option<PathBuf>, String> {
    let extension = archive_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension != "zip" && extension != "cbz" {
        return Ok(None);
    }

    std::fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("Failed to create book cover cache: {error}"))?;
    for extension in ["jpg", "jpeg", "png", "webp", "gif"] {
        let path = cache_directory.join(format!("cover.{extension}"));
        if path.metadata().is_ok_and(|metadata| {
            metadata.is_file() && metadata.len() > 0 && metadata.len() <= MAX_BOOK_COVER_BYTES
        }) {
            return Ok(Some(path));
        }
    }

    let source = std::fs::File::open(&archive_path)
        .map_err(|error| format!("Failed to open archive {}: {error}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(source)
        .map_err(|error| format!("Failed to read archive {}: {error}", archive_path.display()))?;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read archive entry: {error}"))?;
        if entry.is_dir() || entry.size() == 0 || entry.size() > MAX_BOOK_COVER_BYTES {
            continue;
        }
        let entry_extension = std::path::Path::new(entry.name())
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let Some(entry_extension) = entry_extension else {
            continue;
        };
        if !matches!(
            entry_extension.as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "gif"
        ) {
            continue;
        }
        let cache_path = cache_directory.join(format!("cover.{entry_extension}"));
        if !cache_path.exists() {
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry
                .take(MAX_BOOK_COVER_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("Failed to extract book cover: {error}"))?;
            if bytes.len() as u64 > MAX_BOOK_COVER_BYTES {
                return Err("Book cover exceeds the 20 MB extraction limit".to_owned());
            }
            let temporary_path =
                cache_directory.join(format!("cover-{}.tmp", uuid::Uuid::new_v4()));
            let published = std::fs::write(&temporary_path, bytes)
                .and_then(|_| std::fs::rename(&temporary_path, &cache_path));
            if let Err(error) = published {
                let _ = std::fs::remove_file(&temporary_path);
                return Err(format!("Failed to cache book cover: {error}"));
            }
        }
        return Ok(Some(cache_path));
    }
    Ok(None)
}

#[tauri::command]
async fn get_archive_book_info(
    state: State<'_, AppState>,
    media_id: String,
) -> Result<ArchiveBookInfo, String> {
    background_activity::note_foreground_activity();
    let (_root, archive_path) = catalog::resolve_media_path_for_recycle(&state, &media_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let pages = archive_page_entries(&archive_path)?;
        Ok(ArchiveBookInfo {
            page_count: u32::try_from(pages.len()).unwrap_or(u32::MAX),
            page_names: pages.into_iter().map(|page| page.name).collect(),
        })
    })
    .await
    .map_err(|error| format!("Archive page indexing task failed: {error}"))?
}

#[tauri::command]
async fn get_archive_book_page(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    page_index: u32,
) -> Result<Option<String>, String> {
    background_activity::note_foreground_activity();
    let (_root, archive_path) = catalog::resolve_media_path_for_recycle(&state, &media_id)?;
    let data_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve application data directory: {error}"))?;
    let entries = tauri::async_runtime::spawn_blocking(move || {
        cache_managed_archive_book_pages(&data_root, &media_id, &archive_path, &[page_index])
    })
    .await
    .map_err(|error| format!("Archive page extraction task failed: {error}"))??;
    let Some(entry) = entries.into_iter().next() else {
        return Ok(None);
    };
    if let Some(error) = entry.error {
        return Err(error);
    }
    let Some(path) = entry.path else {
        return Ok(None);
    };
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("Failed to allow book page asset: {error}"))?;
    Ok(Some(path))
}

#[tauri::command]
async fn precache_archive_book_pages(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    page_indices: Vec<u32>,
) -> Result<Vec<ArchiveBookPageCacheEntry>, String> {
    background_activity::note_foreground_activity();
    if page_indices.len() > MAX_ARCHIVE_BOOK_BATCH_PAGES {
        return Err(format!(
            "A book page cache batch cannot exceed {MAX_ARCHIVE_BOOK_BATCH_PAGES} pages"
        ));
    }
    let (_root, archive_path) = catalog::resolve_media_path_for_recycle(&state, &media_id)?;
    let data_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve application data directory: {error}"))?;
    let entries = tauri::async_runtime::spawn_blocking(move || {
        cache_managed_archive_book_pages(&data_root, &media_id, &archive_path, &page_indices)
    })
    .await
    .map_err(|error| format!("Archive page extraction task failed: {error}"))??;

    for entry in &entries {
        if let Some(path) = &entry.path {
            app.asset_protocol_scope()
                .allow_file(path)
                .map_err(|error| format!("Failed to allow book page asset: {error}"))?;
        }
    }
    Ok(entries)
}

fn cache_managed_archive_book_pages(
    data_root: &Path,
    media_id: &str,
    archive_path: &Path,
    page_indices: &[u32],
) -> Result<Vec<ArchiveBookPageCacheEntry>, String> {
    let generation = archive_book_cache_generation(media_id, archive_path)?;
    book_cache::with_directory(
        data_root,
        book_cache::Kind::Pages,
        &safe_cache_id(media_id),
        &generation,
        |directory| {
            let entries = cache_archive_book_pages(archive_path, directory, page_indices)?;
            let paths = entries
                .iter()
                .filter_map(|entry| entry.path.as_ref().map(PathBuf::from))
                .collect();
            Ok((entries, paths))
        },
    )
}

fn archive_book_cache_generation(media_id: &str, archive_path: &Path) -> Result<String, String> {
    let index_key = archive_page_index_key(archive_path)?;
    Ok(format!(
        "{}-{}-{}",
        safe_cache_id(media_id),
        index_key.modified_millis,
        index_key.byte_size
    ))
}

fn archive_page_index_key(archive_path: &Path) -> Result<ArchivePageIndexKey, String> {
    let metadata = archive_path.metadata().map_err(|error| {
        format!(
            "Failed to inspect archive {}: {error}",
            archive_path.display()
        )
    })?;
    let modified_millis = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    Ok(ArchivePageIndexKey {
        path: archive_path.to_owned(),
        modified_millis,
        byte_size: metadata.len(),
    })
}

fn cached_archive_page_index(archive_path: &Path) -> Option<Arc<Vec<ArchivePageEntry>>> {
    let key = archive_page_index_key(archive_path).ok()?;
    let mut cache = ARCHIVE_PAGE_INDEX_CACHE
        .get_or_init(|| Mutex::new(ArchivePageIndexCache::default()))
        .lock()
        .ok()?;
    let pages = cache.entries.get(&key).cloned()?;
    cache.lru.retain(|candidate| candidate != &key);
    cache.lru.push_back(key);
    Some(pages)
}

fn remember_archive_page_index(archive_path: &Path, pages: Arc<Vec<ArchivePageEntry>>) {
    let Ok(key) = archive_page_index_key(archive_path) else {
        return;
    };
    let Ok(mut cache) = ARCHIVE_PAGE_INDEX_CACHE
        .get_or_init(|| Mutex::new(ArchivePageIndexCache::default()))
        .lock()
    else {
        return;
    };
    let stale_keys = cache
        .entries
        .keys()
        .filter(|candidate| candidate.path == key.path && *candidate != &key)
        .cloned()
        .collect::<Vec<_>>();
    for stale_key in stale_keys {
        cache.entries.remove(&stale_key);
        cache.lru.retain(|candidate| candidate != &stale_key);
    }
    cache.entries.insert(key.clone(), pages);
    cache.lru.retain(|candidate| candidate != &key);
    cache.lru.push_back(key);
    while cache.entries.len() > MAX_ARCHIVE_PAGE_INDEX_CACHE_ENTRIES {
        let Some(oldest) = cache.lru.pop_front() else {
            break;
        };
        cache.entries.remove(&oldest);
    }
}

fn cached_archive_book_page(
    cache_directory: &Path,
    page_index: u32,
    max_page_bytes: u64,
) -> Option<PathBuf> {
    ["jpg", "jpeg", "png", "webp", "gif", "bmp"]
        .into_iter()
        .map(|extension| cache_directory.join(format!("{page_index:06}.{extension}")))
        .find(|path| {
            path.metadata().is_ok_and(|metadata| {
                metadata.is_file() && metadata.len() > 0 && metadata.len() <= max_page_bytes
            })
        })
}

fn cache_archive_book_pages(
    archive_path: &Path,
    cache_directory: &Path,
    page_indices: &[u32],
) -> Result<Vec<ArchiveBookPageCacheEntry>, String> {
    cache_archive_book_pages_with_limits(
        archive_path,
        cache_directory,
        page_indices,
        MAX_BOOK_PAGE_BYTES,
        MAX_ARCHIVE_BOOK_BATCH_BYTES,
        MAX_ARCHIVE_BOOK_PAGES,
        MAX_ARCHIVE_BOOK_TOTAL_BYTES,
        true,
    )
}

fn cache_archive_book_pages_with_limits(
    archive_path: &Path,
    cache_directory: &Path,
    page_indices: &[u32],
    max_page_bytes: u64,
    max_batch_bytes: u64,
    max_book_pages: usize,
    max_book_bytes: u64,
    use_shared_index: bool,
) -> Result<Vec<ArchiveBookPageCacheEntry>, String> {
    if page_indices.len() > MAX_ARCHIVE_BOOK_BATCH_PAGES {
        return Err(format!(
            "A book page cache batch cannot exceed {MAX_ARCHIVE_BOOK_BATCH_PAGES} pages"
        ));
    }
    fs::create_dir_all(cache_directory)
        .map_err(|error| format!("Failed to create book page cache: {error}"))?;
    let mut requested = page_indices.to_vec();
    requested.sort_unstable();
    requested.dedup();
    let mut results = HashMap::<u32, ArchiveBookPageCacheEntry>::new();
    let mut missing = Vec::new();
    for page_index in &requested {
        if let Some(cache_path) =
            cached_archive_book_page(cache_directory, *page_index, max_page_bytes)
        {
            results.insert(
                *page_index,
                ArchiveBookPageCacheEntry {
                    page_index: *page_index,
                    path: cache_path.to_str().map(ToOwned::to_owned),
                    error: None,
                },
            );
        } else {
            missing.push(*page_index);
        }
    }
    if missing.is_empty() {
        return Ok(requested
            .into_iter()
            .filter_map(|page_index| results.remove(&page_index))
            .collect());
    }

    let source = fs::File::open(archive_path)
        .map_err(|error| format!("Failed to open archive {}: {error}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(source)
        .map_err(|error| format!("Failed to read archive {}: {error}", archive_path.display()))?;
    let pages = if use_shared_index {
        cached_archive_page_index(archive_path)
    } else {
        None
    };
    let pages = match pages {
        Some(pages) => pages,
        None => {
            let pages = Arc::new(archive_page_entries_from_archive(
                &mut archive,
                max_book_pages,
                max_book_bytes,
            )?);
            if use_shared_index {
                remember_archive_page_index(archive_path, Arc::clone(&pages));
            }
            pages
        }
    };
    let mut reserved_batch_bytes = 0_u64;
    for page_index in missing {
        let Some(page) = pages.get(page_index as usize) else {
            results.insert(
                page_index,
                ArchiveBookPageCacheEntry {
                    page_index,
                    path: None,
                    error: Some("Book page is outside the archive page range".to_owned()),
                },
            );
            continue;
        };
        if page.size > max_page_bytes {
            results.insert(
                page_index,
                ArchiveBookPageCacheEntry {
                    page_index,
                    path: None,
                    error: Some(format!(
                        "Book page exceeds the {} MB extraction limit",
                        max_page_bytes / 1024 / 1024
                    )),
                },
            );
            continue;
        }
        let Some(next_batch_bytes) = reserved_batch_bytes.checked_add(page.size) else {
            results.insert(
                page_index,
                ArchiveBookPageCacheEntry {
                    page_index,
                    path: None,
                    error: Some("Book page cache batch size overflowed".to_owned()),
                },
            );
            continue;
        };
        if next_batch_bytes > max_batch_bytes {
            results.insert(
                page_index,
                ArchiveBookPageCacheEntry {
                    page_index,
                    path: None,
                    error: Some(format!(
                        "Book page cache batch exceeds the {} MB extraction limit",
                        max_batch_bytes / 1024 / 1024
                    )),
                },
            );
            continue;
        }
        reserved_batch_bytes = next_batch_bytes;

        let cache_path =
            cache_directory.join(format!("{page_index:06}.{}", page.extension.as_str()));
        let temporary_path =
            cache_path.with_extension(format!("{}.{}.tmp", page.extension, uuid::Uuid::new_v4()));
        let extraction = (|| -> Result<(), String> {
            let entry = archive
                .by_index(page.zip_index)
                .map_err(|error| format!("Failed to read archive page: {error}"))?;
            let mut temporary = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
                .map_err(|error| format!("Failed to create temporary book page: {error}"))?;
            let copied = std::io::copy(&mut entry.take(max_page_bytes + 1), &mut temporary)
                .map_err(|error| format!("Failed to extract book page: {error}"))?;
            drop(temporary);
            if copied == 0 || copied > max_page_bytes {
                return Err("Book page exceeds the extraction limit or is empty".to_owned());
            }
            if let Err(error) = fs::rename(&temporary_path, &cache_path) {
                if cached_archive_book_page(cache_directory, page_index, max_page_bytes).is_none() {
                    return Err(format!("Failed to publish cached book page: {error}"));
                }
            }
            Ok(())
        })();
        if let Err(error) = extraction {
            let _ = fs::remove_file(&temporary_path);
            results.insert(
                page_index,
                ArchiveBookPageCacheEntry {
                    page_index,
                    path: None,
                    error: Some(error),
                },
            );
            continue;
        }
        let _ = fs::remove_file(&temporary_path);
        results.insert(
            page_index,
            ArchiveBookPageCacheEntry {
                page_index,
                path: cache_path.to_str().map(ToOwned::to_owned),
                error: None,
            },
        );
    }

    Ok(requested
        .into_iter()
        .filter_map(|page_index| results.remove(&page_index))
        .collect())
}

fn archive_page_entries(archive_path: &Path) -> Result<Vec<ArchivePageEntry>, String> {
    let extension = archive_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if extension != "zip" && extension != "cbz" {
        return Err("Only ZIP and CBZ books expose archive pages".to_owned());
    }
    if let Some(pages) = cached_archive_page_index(archive_path) {
        return Ok(pages.as_ref().clone());
    }
    let source = std::fs::File::open(archive_path)
        .map_err(|error| format!("Failed to open archive {}: {error}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(source)
        .map_err(|error| format!("Failed to read archive {}: {error}", archive_path.display()))?;
    let pages = Arc::new(archive_page_entries_from_archive(
        &mut archive,
        MAX_ARCHIVE_BOOK_PAGES,
        MAX_ARCHIVE_BOOK_TOTAL_BYTES,
    )?);
    remember_archive_page_index(archive_path, Arc::clone(&pages));
    Ok(pages.as_ref().clone())
}

fn archive_page_entries_from_archive<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    max_pages: usize,
    max_total_bytes: u64,
) -> Result<Vec<ArchivePageEntry>, String> {
    let mut pages = Vec::new();
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            // A damaged entry must not prevent healthy pages from being indexed.
            continue;
        };
        if entry.is_dir() || entry.name().replace('\\', "/").starts_with("__MACOSX/") {
            continue;
        }
        let page_extension = Path::new(entry.name())
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if !matches!(
            page_extension.as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"
        ) {
            continue;
        }
        if pages.len() >= max_pages {
            return Err(format!("Archive book exceeds the {max_pages} page limit"));
        }
        total_bytes = total_bytes
            .checked_add(entry.size())
            .ok_or_else(|| "Archive book expanded size overflowed".to_owned())?;
        if total_bytes > max_total_bytes {
            return Err(format!(
                "Archive book exceeds the {} MB expanded-size limit",
                max_total_bytes / 1024 / 1024
            ));
        }
        pages.push(ArchivePageEntry {
            zip_index: index,
            name: entry.name().to_owned(),
            extension: page_extension,
            size: entry.size(),
        });
    }
    pages.sort_by(|left, right| natural_name_cmp(&left.name, &right.name));
    Ok(pages)
}

fn natural_name_cmp(left: &str, right: &str) -> Ordering {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let (mut left_index, mut right_index) = (0, 0);
    while left_index < left_bytes.len() && right_index < right_bytes.len() {
        if left_bytes[left_index].is_ascii_digit() && right_bytes[right_index].is_ascii_digit() {
            let left_start = left_index;
            let right_start = right_index;
            while left_index < left_bytes.len() && left_bytes[left_index].is_ascii_digit() {
                left_index += 1;
            }
            while right_index < right_bytes.len() && right_bytes[right_index].is_ascii_digit() {
                right_index += 1;
            }
            let left_number = left[left_start..left_index].trim_start_matches('0');
            let right_number = right[right_start..right_index].trim_start_matches('0');
            let length_order = left_number.len().cmp(&right_number.len());
            if length_order != Ordering::Equal {
                return length_order;
            }
            let number_order = left_number.cmp(right_number);
            if number_order != Ordering::Equal {
                return number_order;
            }
        } else {
            let character_order = left_bytes[left_index]
                .to_ascii_lowercase()
                .cmp(&right_bytes[right_index].to_ascii_lowercase());
            if character_order != Ordering::Equal {
                return character_order;
            }
            left_index += 1;
            right_index += 1;
        }
    }
    left_bytes.len().cmp(&right_bytes.len())
}

fn safe_cache_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn validate_reference_cache_key(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err(format!("{label} is invalid"));
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(())
}

fn reference_cache_directory(app: &tauri::AppHandle, project_id: &str) -> Result<PathBuf, String> {
    validate_reference_cache_key(project_id, "Reference project id")?;
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join("reference-cache").join(project_id))
        .map_err(|error| format!("Failed to resolve reference cache directory: {error}"))
}

fn copy_temporary_reference(
    source: &Path,
    project_directory: &Path,
    reference_id: &str,
) -> Result<(PathBuf, u64), String> {
    validate_reference_cache_key(reference_id, "Reference id")?;
    let source = source
        .canonicalize()
        .map_err(|error| format!("Cannot resolve the selected reference file: {error}"))?;
    let metadata = source
        .metadata()
        .map_err(|error| format!("Cannot inspect the selected reference file: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("The selected reference must be a non-empty file".to_owned());
    }
    if metadata.len() > MAX_REFERENCE_CACHE_BYTES {
        return Err(format!(
            "The selected reference exceeds the {} MB cache limit",
            MAX_REFERENCE_CACHE_BYTES / 1024 / 1024
        ));
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| {
            matches!(
                value.as_str(),
                "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff"
            )
        })
        .ok_or_else(|| "Only supported image files can be cached as references".to_owned())?;
    image::ImageReader::open(&source)
        .map_err(|error| format!("Cannot open the selected reference image: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("Cannot identify the selected reference image: {error}"))?
        .into_dimensions()
        .map_err(|error| format!("Cannot decode the selected reference image: {error}"))?;

    fs::create_dir_all(project_directory)
        .map_err(|error| format!("Failed to create reference cache: {error}"))?;
    let destination = project_directory.join(format!("{reference_id}.{extension}"));
    if destination.is_file() {
        return Ok((destination, metadata.len()));
    }
    let temporary = project_directory.join(format!(".{reference_id}.{}.tmp", uuid::Uuid::new_v4()));
    let result = fs::copy(&source, &temporary)
        .map_err(|error| format!("Failed to copy the temporary reference: {error}"))
        .and_then(|written| {
            if written != metadata.len() {
                return Err("The temporary reference copy was incomplete".to_owned());
            }
            fs::rename(&temporary, &destination)
                .map_err(|error| format!("Failed to finalize the temporary reference: {error}"))?;
            Ok((destination.clone(), written))
        });
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn cleanup_reference_cache_files(
    project_directory: &Path,
    paths: &[String],
) -> Result<(u64, u64), String> {
    if paths.len() > 2_000 {
        return Err("Too many temporary references were requested for cleanup".to_owned());
    }
    if !project_directory.exists() {
        return Ok((0, paths.len() as u64));
    }
    let canonical_project = project_directory
        .canonicalize()
        .map_err(|error| format!("Cannot resolve reference cache: {error}"))?;
    let mut missing = 0_u64;
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for raw_path in paths {
        if !seen.insert(raw_path) {
            continue;
        }
        let path = PathBuf::from(raw_path);
        if !path.exists() {
            missing += 1;
            continue;
        }
        let canonical_path = path
            .canonicalize()
            .map_err(|error| format!("Cannot resolve temporary reference: {error}"))?;
        if canonical_path == canonical_project || !canonical_path.starts_with(&canonical_project) {
            return Err("A requested temporary reference is outside the managed cache".to_owned());
        }
        if !canonical_path.is_file() {
            return Err("Only managed reference cache files can be removed".to_owned());
        }
        validated.push(canonical_path);
    }
    let mut removed = 0_u64;
    for canonical_path in validated {
        fs::remove_file(&canonical_path)
            .map_err(|error| format!("Failed to remove temporary reference: {error}"))?;
        removed += 1;
    }
    if project_directory
        .read_dir()
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
    {
        let _ = fs::remove_dir(project_directory);
    }
    Ok((removed, missing))
}

fn media_thumbnail_cache_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join("media-thumbnails"))
        .map_err(|error| format!("Failed to resolve application data directory: {error}"))
}

fn legacy_media_thumbnail_path(
    cache_directory: &Path,
    media_id: &str,
    modified_at: i64,
) -> PathBuf {
    cache_directory.join(format!("{}-{modified_at}.jpg", safe_cache_id(media_id)))
}

fn normalized_thumbnail_source_identity(source: &Path) -> String {
    let identity = source.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        identity.to_ascii_lowercase()
    } else {
        identity
    }
}

fn media_thumbnail_path(
    cache_directory: &Path,
    source: &Path,
    modified_at: i64,
    byte_size: u64,
) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(normalized_thumbnail_source_identity(source).as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    cache_directory.join(format!("{digest}-{modified_at}-{byte_size}.jpg"))
}

fn thumbnail_index_file_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ThumbnailIndexManifest {
    version: u8,
    file_names: Vec<String>,
}

fn thumbnail_index_manifest_path(directory: &Path) -> PathBuf {
    directory.join(THUMBNAIL_INDEX_MANIFEST_NAME)
}

fn load_thumbnail_index_manifest(directory: &Path) -> HashSet<String> {
    let path = thumbnail_index_manifest_path(directory);
    let Ok(bytes) = fs::read(&path) else {
        return HashSet::new();
    };
    let Ok(manifest) = serde_json::from_slice::<ThumbnailIndexManifest>(&bytes) else {
        eprintln!(
            "Ignoring invalid thumbnail index manifest {}",
            path.display()
        );
        return HashSet::new();
    };
    if manifest.version != 1 {
        return HashSet::new();
    }
    manifest
        .file_names
        .into_iter()
        .filter(|name| {
            Path::new(name)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
        })
        .collect()
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are NUL-terminated and remain alive for the call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn persist_thumbnail_index_manifest(directory: &Path) -> Result<(), String> {
    let _write_guard = THUMBNAIL_MANIFEST_WRITE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Thumbnail manifest writer is unavailable".to_owned())?;
    let mut file_names = THUMBNAIL_PATH_INDEX
        .get_or_init(|| RwLock::new(ThumbnailPathIndex::default()))
        .read()
        .map_err(|_| "Thumbnail path index is unavailable".to_owned())
        .map(|state| {
            if state.directory.as_deref() == Some(directory) {
                state.file_names.iter().cloned().collect::<Vec<_>>()
            } else {
                Vec::new()
            }
        })?;
    file_names.sort_unstable();
    let bytes = serde_json::to_vec(&ThumbnailIndexManifest {
        version: 1,
        file_names,
    })
    .map_err(|error| format!("Failed to encode thumbnail index manifest: {error}"))?;
    let destination = thumbnail_index_manifest_path(directory);
    let temporary = directory.join(format!(".thumbnail-index-v1.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Failed to write thumbnail index manifest: {error}"))?;
    if let Err(error) = replace_file_atomically(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Failed to publish thumbnail index manifest: {error}"
        ));
    }
    Ok(())
}

fn schedule_thumbnail_path_index(directory: PathBuf) {
    let index = THUMBNAIL_PATH_INDEX.get_or_init(|| RwLock::new(ThumbnailPathIndex::default()));
    let should_start = {
        let Ok(mut state) = index.write() else {
            return;
        };
        if state.directory.as_deref() != Some(directory.as_path()) {
            state.directory = Some(directory.clone());
            state.file_names.clear();
            state.added_during_scan.clear();
            state.removed_during_scan.clear();
            state.initializing = false;
            state.ready = false;
        }
        if state.initializing || state.ready {
            false
        } else {
            state.initializing = true;
            true
        }
    };
    if !should_start {
        return;
    }

    tauri::async_runtime::spawn_blocking(move || {
        // Disk reads and JSON parsing must not delay application setup or hold
        // the shared index lock. Until published, visible requests use the
        // existing per-file lookup fallback instead of waiting for the index.
        let manifest = load_thumbnail_index_manifest(&directory);
        if let Ok(mut state) = THUMBNAIL_PATH_INDEX
            .get_or_init(|| RwLock::new(ThumbnailPathIndex::default()))
            .write()
        {
            state.publish_snapshot(&directory, manifest, false);
        }
        let mut discovered = HashSet::new();
        if let Ok(entries) = fs::read_dir(&directory) {
            for (index, entry) in entries.flatten().enumerate() {
                if index % 128 == 0 {
                    background_activity::wait_until_quiet(
                        Duration::from_millis(250),
                        Duration::from_millis(40),
                    );
                }
                let path = entry.path();
                if !path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
                {
                    continue;
                }
                if let Some(file_name) = thumbnail_index_file_name(&path) {
                    discovered.insert(file_name);
                }
            }
        }
        if let Ok(mut state) = THUMBNAIL_PATH_INDEX
            .get_or_init(|| RwLock::new(ThumbnailPathIndex::default()))
            .write()
        {
            state.publish_snapshot(&directory, discovered, true);
        }
        if let Err(error) = persist_thumbnail_index_manifest(&directory) {
            eprintln!("Thumbnail index manifest update skipped: {error}");
        }
    });
}

fn indexed_thumbnail_exists(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Some(file_name) = thumbnail_index_file_name(path) else {
        return false;
    };
    THUMBNAIL_PATH_INDEX
        .get_or_init(|| RwLock::new(ThumbnailPathIndex::default()))
        .read()
        .map(|state| {
            state.directory.as_deref() == Some(parent) && state.file_names.contains(&file_name)
        })
        .unwrap_or(false)
}

fn thumbnail_path_exists(path: &Path) -> bool {
    let (indexed, index_is_ready) = path.parent().map_or((false, false), |parent| {
        THUMBNAIL_PATH_INDEX
            .get_or_init(|| RwLock::new(ThumbnailPathIndex::default()))
            .read()
            .map(|state| {
                if state.directory.as_deref() == Some(parent) {
                    (
                        state
                            .file_names
                            .contains(&thumbnail_index_file_name(path).unwrap_or_default()),
                        state.ready,
                    )
                } else {
                    (false, false)
                }
            })
            .unwrap_or((false, false))
    });
    if indexed {
        if index_is_ready || path.is_file() {
            return true;
        }
        // A persisted manifest can briefly contain an entry removed while the
        // application was closed. Repair that one stale hit immediately; the
        // background reconciliation will repair the rest.
        forget_indexed_thumbnail(path);
        return false;
    }
    if index_is_ready || !path.is_file() {
        return false;
    }
    record_indexed_thumbnail(path);
    true
}

fn record_indexed_thumbnail(path: &Path) {
    let (Some(parent), Some(file_name)) = (path.parent(), thumbnail_index_file_name(path)) else {
        return;
    };
    if let Ok(mut state) = THUMBNAIL_PATH_INDEX
        .get_or_init(|| RwLock::new(ThumbnailPathIndex::default()))
        .write()
        && state.directory.as_deref() == Some(parent)
    {
        state.file_names.insert(file_name.clone());
        if state.initializing {
            state.removed_during_scan.remove(&file_name);
            state.added_during_scan.insert(file_name);
        }
    }
}

fn forget_indexed_thumbnail(path: &Path) {
    let (Some(parent), Some(file_name)) = (path.parent(), thumbnail_index_file_name(path)) else {
        return;
    };
    if let Ok(mut state) = THUMBNAIL_PATH_INDEX
        .get_or_init(|| RwLock::new(ThumbnailPathIndex::default()))
        .write()
        && state.directory.as_deref() == Some(parent)
    {
        state.file_names.remove(&file_name);
        if state.initializing {
            state.added_during_scan.remove(&file_name);
            state.removed_during_scan.insert(file_name);
        }
    }
}

fn thumbnail_index_is_ready(directory: &Path) -> bool {
    THUMBNAIL_PATH_INDEX
        .get_or_init(|| RwLock::new(ThumbnailPathIndex::default()))
        .read()
        .map(|state| state.directory.as_deref() == Some(directory) && state.ready)
        .unwrap_or(false)
}

fn wait_for_thumbnail_index_reconciliation(directory: &Path) -> bool {
    schedule_thumbnail_path_index(directory.to_owned());
    while !thumbnail_index_is_ready(directory) {
        if THUMBNAIL_PRECACHE_CANCEL_REQUESTED.load(AtomicOrdering::Acquire) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    true
}

fn attach_existing_thumbnail_paths(
    app: &tauri::AppHandle,
    media_items: &mut [MediaItem],
) -> Result<(), String> {
    let cache_directory = media_thumbnail_cache_directory(app)?;
    for item in media_items {
        let stable_path = media_thumbnail_path(
            &cache_directory,
            Path::new(&item.absolute_path),
            item.modified_at,
            item.byte_size,
        );
        let legacy_path = legacy_media_thumbnail_path(&cache_directory, &item.id, item.modified_at);
        let cache_path = if thumbnail_path_exists(&stable_path) {
            Some(stable_path)
        } else if thumbnail_path_exists(&legacy_path) {
            Some(legacy_path)
        } else {
            None
        };
        if let Some(cache_path) = cache_path {
            item.thumbnail_path = cache_path.to_str().map(ToOwned::to_owned);
        }
    }
    Ok(())
}

fn trim_media_presence_cache(control: &mut MediaPresenceControl) {
    if control.checked.len() <= 16_384 {
        return;
    }
    control
        .checked
        .retain(|_, check| check.checked_at.elapsed() < MEDIA_PRESENCE_CACHE_TTL);
    if control.checked.len() > 16_384 {
        // This cache is purely an optimization. Dropping it is safer than
        // allowing a very large library to grow process memory without bound.
        control.checked.clear();
    }
}

fn run_media_presence_worker(database_path: PathBuf) {
    let result = (|| -> Result<(), String> {
        let state = AppState::open(&database_path)?;
        loop {
            background_activity::wait_until_quiet(
                Duration::from_millis(450),
                Duration::from_millis(75),
            );
            let batch = {
                let mut control = MEDIA_PRESENCE_CONTROL
                    .get_or_init(|| Mutex::new(MediaPresenceControl::default()))
                    .lock()
                    .map_err(|_| "Media presence queue is unavailable".to_owned())?;
                if control.pending.is_empty() {
                    control.running = false;
                    return Ok(());
                }
                (0..MEDIA_PRESENCE_BATCH_SIZE)
                    .filter_map(|_| control.pending.pop_front())
                    .collect::<Vec<_>>()
            };

            let mut results = Vec::with_capacity(batch.len());
            let mut missing_ids = Vec::new();
            for candidate in batch {
                background_activity::wait_until_quiet(
                    Duration::from_millis(250),
                    Duration::from_millis(50),
                );
                let present = match fs::metadata(&candidate.absolute_path) {
                    Ok(metadata) => Some(metadata.is_file()),
                    // `NotFound` is not authoritative for removable, sleeping,
                    // network, or briefly reconnecting drives. Folder watching,
                    // an explicit rescan, or a renderer-confirmed failure owns
                    // persistent deletion detection; this low-priority check
                    // must never hide a large live library after transient I/O.
                    Err(_) => Some(true),
                };
                if present == Some(false) {
                    missing_ids.push(candidate.media_id.clone());
                }
                results.push((candidate, present));
            }

            if !missing_ids.is_empty() {
                catalog::mark_media_ids_missing(&state, &missing_ids)?;
            }
            if let Ok(mut control) = MEDIA_PRESENCE_CONTROL
                .get_or_init(|| Mutex::new(MediaPresenceControl::default()))
                .lock()
            {
                for (candidate, present) in results {
                    control.queued.remove(&candidate.media_id);
                    if let Some(present) = present {
                        control.checked.insert(
                            candidate.media_id,
                            MediaPresenceCheck {
                                modified_at: candidate.modified_at,
                                checked_at: Instant::now(),
                                present,
                            },
                        );
                    }
                }
                trim_media_presence_cache(&mut control);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    })();

    if let Err(error) = result {
        eprintln!("Media presence validation stopped: {error}");
        if let Ok(mut control) = MEDIA_PRESENCE_CONTROL
            .get_or_init(|| Mutex::new(MediaPresenceControl::default()))
            .lock()
        {
            control.running = false;
            control.pending.clear();
            control.queued.clear();
        }
    }
}

/// Queues stale/unknown paths for a low-priority worker and returns records
/// already known to be missing. The gallery hot path itself performs no
/// filesystem metadata calls.
fn schedule_media_presence_validation(
    database_path: PathBuf,
    media_items: &[MediaItem],
) -> HashSet<String> {
    let mut known_missing = HashSet::new();
    let mut should_start = false;
    if let Ok(mut control) = MEDIA_PRESENCE_CONTROL
        .get_or_init(|| Mutex::new(MediaPresenceControl::default()))
        .lock()
    {
        trim_media_presence_cache(&mut control);
        for item in media_items {
            if let Some(check) = control.checked.get(&item.id).copied()
                && check.modified_at == item.modified_at
                && check.checked_at.elapsed() < MEDIA_PRESENCE_CACHE_TTL
            {
                if !check.present {
                    known_missing.insert(item.id.clone());
                }
                continue;
            }
            if control.pending.len() >= MEDIA_PRESENCE_QUEUE_LIMIT
                || !control.queued.insert(item.id.clone())
            {
                continue;
            }
            control.pending.push_back(MediaPresenceCandidate {
                media_id: item.id.clone(),
                absolute_path: item.absolute_path.clone(),
                modified_at: item.modified_at,
            });
        }
        if !control.running && !control.pending.is_empty() {
            control.running = true;
            should_start = true;
        }
    }
    if should_start {
        tauri::async_runtime::spawn_blocking(move || run_media_presence_worker(database_path));
    }
    known_missing
}

fn invalidate_media_presence_cache() {
    if let Ok(mut control) = MEDIA_PRESENCE_CONTROL
        .get_or_init(|| Mutex::new(MediaPresenceControl::default()))
        .lock()
    {
        control.pending.clear();
        control.queued.clear();
        control.checked.clear();
    }
}

fn get_or_generate_media_thumbnail(
    app: &tauri::AppHandle,
    media_id: &str,
    kind: &str,
    modified_at: i64,
    byte_size: u64,
    root: &Path,
    relative: &Path,
    priority: ThumbnailWorkPriority,
) -> Result<(Option<String>, bool), String> {
    let cache_directory = media_thumbnail_cache_directory(app)?;
    let source_identity = root.join(relative);
    let cache_path =
        media_thumbnail_path(&cache_directory, &source_identity, modified_at, byte_size);
    let legacy_path = legacy_media_thumbnail_path(&cache_directory, media_id, modified_at);
    if thumbnail_path_exists(&cache_path) {
        return Ok((cache_path.to_str().map(ToOwned::to_owned), false));
    }
    if thumbnail_path_exists(&legacy_path) && priority == ThumbnailWorkPriority::Foreground {
        return Ok((legacy_path.to_str().map(ToOwned::to_owned), false));
    }
    if !thumbnail_path_exists(&cache_path) {
        {
            let permit_key = thumbnail_index_file_name(&cache_path)
                .unwrap_or_else(|| format!("{media_id}-{modified_at}"));
            if thumbnail_failure_is_deferred(&permit_key) {
                return Ok((None, false));
            }
            let Some(_permit) = acquire_native_thumbnail_permit(permit_key.clone(), priority)?
            else {
                return Ok((None, false));
            };
            // A duplicate request may have completed while this worker waited.
            if !thumbnail_path_exists(&cache_path) {
                if thumbnail_path_exists(&legacy_path) {
                    if priority == ThumbnailWorkPriority::Background {
                        if fs::copy(&legacy_path, &cache_path).is_ok() {
                            record_indexed_thumbnail(&cache_path);
                            clear_thumbnail_failure(&permit_key);
                            return Ok((cache_path.to_str().map(ToOwned::to_owned), false));
                        }
                    } else {
                        record_indexed_thumbnail(&legacy_path);
                        return Ok((legacy_path.to_str().map(ToOwned::to_owned), false));
                    }
                }
                let Some(canonical_root) = canonical_library_root(root) else {
                    return Ok((None, true));
                };
                let source = match canonical_root.join(relative).canonicalize() {
                    Ok(source)
                        if source.is_file()
                            && source != canonical_root
                            && source.starts_with(&canonical_root) =>
                    {
                        source
                    }
                    _ => return Ok((None, true)),
                };
                match thumbnail_cache::generate_thumbnail(&source, kind, &cache_path) {
                    Ok(true) => {
                        record_indexed_thumbnail(&cache_path);
                        clear_thumbnail_failure(&permit_key);
                    }
                    Ok(false) if thumbnail_path_exists(&cache_path) => {
                        record_indexed_thumbnail(&cache_path);
                        clear_thumbnail_failure(&permit_key);
                    }
                    Ok(false) => {
                        record_thumbnail_failure(permit_key);
                        return Ok((None, false));
                    }
                    Err(error) => {
                        eprintln!(
                            "Visible thumbnail skipped for {}: {error}",
                            source.display()
                        );
                        record_thumbnail_failure(permit_key);
                        return Ok((None, false));
                    }
                }
            } else {
                record_indexed_thumbnail(&cache_path);
            }
        }
    }
    // `media-thumbnails` is recursively allowed once during application
    // setup, so a per-thumbnail protocol scope mutation would only add IPC
    // latency and lock contention here.
    Ok((cache_path.to_str().map(ToOwned::to_owned), false))
}

#[derive(Clone)]
struct ThumbnailSourceRecord {
    media_id: String,
    kind: String,
    modified_at: i64,
    byte_size: u64,
    root: String,
    relative: PathBuf,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaThumbnailResult {
    media_id: String,
    thumbnail_path: Option<String>,
}

fn resolve_thumbnail_sources(
    state: &AppState,
    media_ids: &[String],
) -> Result<Vec<ThumbnailSourceRecord>, String> {
    let mut unique_ids = Vec::with_capacity(media_ids.len().min(512));
    let mut seen = HashSet::new();
    for media_id in media_ids.iter().take(512) {
        if seen.insert(media_id.clone()) {
            unique_ids.push(media_id.clone());
        }
    }
    if unique_ids.is_empty() {
        return Ok(Vec::new());
    }

    let connection = state.database.lock()?;
    let mut records_by_id = HashMap::with_capacity(unique_ids.len());
    for ids in unique_ids.chunks(400) {
        let placeholders = (1..=ids.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT m.id, m.media_kind, m.modified_at, m.byte_size, r.path, m.relative_path
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             WHERE m.id IN ({placeholders})
               AND m.is_missing = 0
               AND r.enabled = 1
               AND m.media_kind IN ('image', 'gif', 'video', 'zip')"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Failed to prepare thumbnail sources: {error}"))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    u64::try_from(row.get::<_, i64>(3)?).unwrap_or_default(),
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|error| format!("Failed to resolve thumbnail sources: {error}"))?;
        for row in rows {
            let (media_id, kind, modified_at, byte_size, root, relative) =
                row.map_err(|error| format!("Failed to read thumbnail source: {error}"))?;
            let relative = PathBuf::from(relative);
            if relative.is_absolute()
                || relative.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                })
            {
                continue;
            }
            records_by_id.insert(
                media_id.clone(),
                ThumbnailSourceRecord {
                    media_id,
                    kind,
                    modified_at,
                    byte_size,
                    root,
                    relative,
                },
            );
        }
    }
    Ok(unique_ids
        .into_iter()
        .filter_map(|media_id| records_by_id.remove(&media_id))
        .collect())
}

fn generate_thumbnail_batch(
    app: tauri::AppHandle,
    records: Vec<ThumbnailSourceRecord>,
) -> Vec<(usize, MediaThumbnailResult, bool)> {
    if records.is_empty() {
        return Vec::new();
    }
    let work = Mutex::new(records.into_iter().enumerate().collect::<VecDeque<_>>());
    let results = Mutex::new(Vec::new());
    let worker_count = native_thumbnail_foreground_limit().min(
        work.lock()
            .map(|queue| queue.len())
            .unwrap_or_default()
            .max(1),
    );
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let worker_app = app.clone();
            let work = &work;
            let results = &results;
            scope.spawn(move || {
                loop {
                    let next = work.lock().ok().and_then(|mut queue| queue.pop_front());
                    let Some((index, record)) = next else {
                        break;
                    };
                    let (thumbnail_path, source_unavailable) = get_or_generate_media_thumbnail(
                        &worker_app,
                        &record.media_id,
                        &record.kind,
                        record.modified_at,
                        record.byte_size,
                        Path::new(&record.root),
                        &record.relative,
                        ThumbnailWorkPriority::Foreground,
                    )
                    .unwrap_or_else(|error| {
                        eprintln!("Visible thumbnail skipped for {}: {error}", record.media_id);
                        (None, false)
                    });
                    let result = MediaThumbnailResult {
                        media_id: record.media_id,
                        thumbnail_path,
                    };
                    if result.thumbnail_path.is_some() {
                        let _ = worker_app.emit("media-thumbnail-resolved", result.clone());
                    }
                    if let Ok(mut output) = results.lock() {
                        output.push((index, result, source_unavailable));
                    }
                }
            });
        }
    });
    results.into_inner().unwrap_or_default()
}

#[tauri::command]
async fn get_media_thumbnails(
    app: tauri::AppHandle,
    media_ids: Vec<String>,
) -> Result<Vec<MediaThumbnailResult>, String> {
    run_catalog_worker("Thumbnail batch", move || {
        let state = app.state::<AppState>();
        let requested_ids = media_ids.into_iter().take(512).collect::<Vec<_>>();
        let records = resolve_thumbnail_sources(&state, &requested_ids)?;
        let mut generated = generate_thumbnail_batch(app.clone(), records);
        generated.sort_by_key(|(index, _, _)| *index);
        for (_, result, unavailable) in &generated {
            if *unavailable {
                let _ = catalog::reconcile_media_load_failure(&state, &result.media_id);
            }
        }
        let mut by_id = generated
            .into_iter()
            .map(|(_, result, _)| (result.media_id.clone(), result))
            .collect::<HashMap<_, _>>();
        let mut seen = HashSet::new();
        Ok(requested_ids
            .into_iter()
            .filter(|media_id| seen.insert(media_id.clone()))
            .map(|media_id| {
                by_id.remove(&media_id).unwrap_or(MediaThumbnailResult {
                    media_id,
                    thumbnail_path: None,
                })
            })
            .collect())
    })
    .await
}

#[tauri::command]
async fn get_media_thumbnail(
    app: tauri::AppHandle,
    media_id: String,
) -> Result<Option<String>, String> {
    run_catalog_worker("Thumbnail", move || {
        let state = app.state::<AppState>();
        let Some(record) = resolve_thumbnail_sources(&state, std::slice::from_ref(&media_id))?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        let (thumbnail, source_unavailable) = get_or_generate_media_thumbnail(
            &app,
            &media_id,
            &record.kind,
            record.modified_at,
            record.byte_size,
            Path::new(&record.root),
            &record.relative,
            ThumbnailWorkPriority::Foreground,
        )?;
        if source_unavailable {
            let _ = catalog::reconcile_media_load_failure(&state, &media_id);
        }
        Ok(thumbnail)
    })
    .await
}

#[tauri::command]
async fn report_media_load_failure(
    state: State<'_, AppState>,
    media_id: String,
) -> Result<bool, String> {
    background_activity::note_foreground_activity();
    let database_path = state.database.path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = AppState::open(&database_path)?;
        let _ = catalog::reconcile_media_load_failure(&state, &media_id)?;
        state
            .database
            .lock()?
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM media_items WHERE id = ?1 AND is_missing = 1
                 )",
                [&media_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("Failed to read reconciled media state: {error}"))
    })
    .await
    .map_err(|error| format!("Media load reconciliation failed: {error}"))?
}

#[tauri::command]
fn notify_foreground_activity() {
    background_activity::note_foreground_activity();
    if let Some((_, wake)) = NATIVE_THUMBNAIL_WORK.get() {
        wake.notify_all();
    }
}

#[tauri::command]
fn take_pending_x_url(
    state: State<'_, external_input::ExternalInputState>,
) -> Result<Option<String>, String> {
    state.take_pending_x_url()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalMediaOpenBatch {
    request_id: String,
    items: Vec<MediaItem>,
    current_id: String,
}

fn import_external_media_item(
    state: &AppState,
    input: &external_input::ExternalMediaInput,
) -> Result<MediaItem, String> {
    let path = PathBuf::from(&input.path);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("「{}」を開けません: {error}", input.name))?;
    if !canonical.is_file() {
        return Err(format!("「{}」はファイルではありません。", input.name));
    }
    let (kind, _, _) = catalog::classify_media(&canonical)
        .ok_or_else(|| format!("「{}」の形式には対応していません。", input.name))?;
    if kind != input.kind {
        return Err(format!(
            "「{}」の形式が開く前に変更されました。",
            input.name
        ));
    }
    let parent = canonical
        .parent()
        .ok_or_else(|| format!("「{}」の親フォルダーを確認できません。", input.name))?;
    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "ファイル名をUnicodeとして読み取れません。".to_owned())?;
    let scope = file_browser::ensure_media_catalog_scope(state, parent)?;
    catalog::reconcile_changed_paths(state, &scope.root_id, std::slice::from_ref(&canonical))?;
    let relative_path = if scope.relative_folder.is_empty() {
        file_name.to_owned()
    } else {
        format!(
            "{}/{file_name}",
            scope.relative_folder.trim_end_matches('/')
        )
    };
    catalog::get_media_item_by_catalog_path(state, &scope.root_id, &relative_path)?
        .ok_or_else(|| format!("「{}」をPixVaultへ読み込めませんでした。", input.name))
}

#[tauri::command]
async fn take_pending_external_media(
    app: tauri::AppHandle,
) -> Result<Option<ExternalMediaOpenBatch>, String> {
    let worker_app = app.clone();
    let (items, failures) = run_catalog_worker("External media open", move || {
        let pending = worker_app
            .state::<external_input::ExternalInputState>()
            .take_pending_external_media()?;
        let state = worker_app.state::<AppState>();
        let mut items = Vec::with_capacity(pending.len());
        let mut failures = Vec::new();
        let mut affected_roots = HashSet::new();
        for input in pending {
            match import_external_media_item(&state, &input) {
                Ok(item) => {
                    affected_roots.insert(item.root_id.clone());
                    items.push(item);
                }
                Err(error) => failures.push(error),
            }
        }
        for root_id in affected_roots {
            media_folders::invalidate_folder_hierarchy_cache(&state, Some(&root_id))?;
        }
        Ok((items, failures))
    })
    .await?;
    if items.is_empty() && failures.is_empty() {
        return Ok(None);
    }
    if items.is_empty() {
        return Err(failures
            .into_iter()
            .next()
            .unwrap_or_else(|| "外部ファイルをPixVaultで開けませんでした。".to_owned()));
    }
    if !failures.is_empty() {
        diagnostics::record("external-media-open-warning", &failures.join(" | "));
    }
    for item in &items {
        app.asset_protocol_scope()
            .allow_file(&item.absolute_path)
            .map_err(|error| format!("外部ファイルの表示を許可できません: {error}"))?;
    }
    // The selected original must not wait for the thumbnail index to load.
    // The viewer requests surrounding thumbnails after its first media paint.
    invalidate_media_presence_cache();
    let current_id = items[0].id.clone();
    Ok(Some(ExternalMediaOpenBatch {
        request_id: uuid::Uuid::new_v4().to_string(),
        items,
        current_id,
    }))
}

#[tauri::command]
fn show_windows_notification(
    app: tauri::AppHandle,
    title: String,
    message: String,
    tone: String,
) -> Result<bool, String> {
    windows_notifications::show(&app, &title, &message, &tone)
}

#[tauri::command]
fn get_media_image_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> Result<Option<String>, String> {
    background_activity::note_foreground_activity();
    let (_root, source) = catalog::resolve_media_path_for_recycle(&state, &media_id)?;
    let (kind, modified_at): (String, i64) = state
        .database
        .lock()?
        .query_row(
            "SELECT media_kind, modified_at FROM media_items WHERE id = ?1 AND is_missing = 0",
            [&media_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Failed to resolve image preview: {error}"))?;
    if !matches!(kind.as_str(), "image" | "gif") {
        return Ok(None);
    }
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve image preview cache: {error}"))?
        .join("media-previews");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create image preview cache: {error}"))?;
    let destination = directory.join(format!("{}-{modified_at}.jpg", safe_cache_id(&media_id)));
    // A cache hit is the normal path. Avoid walking and stat-ing the entire
    // preview cache directory every time an already converted image opens.
    if destination.is_file() {
        app.asset_protocol_scope()
            .allow_file(&destination)
            .map_err(|error| format!("Failed to allow image preview asset: {error}"))?;
        return Ok(destination.to_str().map(ToOwned::to_owned));
    }
    let preview_usage = thumbnail_cache_usage(&directory)?;
    if preview_usage.bytes >= MAX_MEDIA_PREVIEW_CACHE_BYTES
        || preview_usage.files >= MAX_MEDIA_PREVIEW_CACHE_FILES
    {
        let _ = prune_thumbnail_cache(
            &directory,
            MAX_MEDIA_PREVIEW_CACHE_BYTES * 9 / 10,
            MAX_MEDIA_PREVIEW_CACHE_FILES * 9 / 10,
        )?;
    }
    thumbnail_cache::generate_image_preview(&source, &kind, &destination)?;
    if !destination.is_file() {
        return Ok(None);
    }
    app.asset_protocol_scope()
        .allow_file(&destination)
        .map_err(|error| format!("Failed to allow image preview asset: {error}"))?;
    Ok(destination.to_str().map(ToOwned::to_owned))
}

#[tauri::command]
fn save_media_thumbnail(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    data_url: String,
) -> Result<Option<String>, String> {
    let bytes = decode_jpeg_thumbnail(&data_url)?;
    let cache_path = media_thumbnail_cache_path(&app, &state, &media_id)?;
    if !cache_path.is_file() {
        let parent = cache_path
            .parent()
            .ok_or_else(|| "Thumbnail cache path has no parent directory".to_owned())?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create thumbnail cache: {error}"))?;
        let temporary_path = cache_path.with_extension(format!("jpg-{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary_path, bytes)
            .map_err(|error| format!("Failed to write cached thumbnail: {error}"))?;
        if let Err(error) = std::fs::rename(&temporary_path, &cache_path) {
            let _ = std::fs::remove_file(&temporary_path);
            if !cache_path.is_file() {
                return Err(format!("Failed to finalize cached thumbnail: {error}"));
            }
        }
    }
    record_indexed_thumbnail(&cache_path);
    app.asset_protocol_scope()
        .allow_file(&cache_path)
        .map_err(|error| format!("Failed to allow cached thumbnail asset: {error}"))?;
    Ok(cache_path.to_str().map(ToOwned::to_owned))
}

#[tauri::command]
fn save_capture(
    app: tauri::AppHandle,
    data_url: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let (extension, bytes) = decode_image_data_url(&data_url)?;
    let mut safe_name = suggested_name
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if safe_name.trim().is_empty() {
        safe_name = format!("PixVault_Capture.{extension}");
    } else if Path::new(&safe_name).extension().is_none() {
        safe_name.push('.');
        safe_name.push_str(extension);
    }
    let selected = app
        .dialog()
        .file()
        .set_title("スクリーンショットを保存")
        .set_file_name(&safe_name)
        .add_filter("Image", &[extension])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut path = match selected {
        FilePath::Path(path) => path,
        FilePath::Url(_) => return Err("Only local Windows paths can store captures".to_owned()),
    };
    if path.extension().is_none() {
        path.set_extension(extension);
    }
    std::fs::write(&path, bytes)
        .map_err(|error| format!("Failed to save screenshot {}: {error}", path.display()))?;
    Ok(path.to_str().map(ToOwned::to_owned))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGifConversionResult {
    path: String,
    catalogued: bool,
}

#[tauri::command]
async fn convert_video_to_gif(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> Result<Option<VideoGifConversionResult>, String> {
    background_activity::note_foreground_activity();
    let (canonical_root, source) = catalog::resolve_media_path_for_recycle(&state, &media_id)?;
    let (root_id, kind): (String, String) = state
        .database
        .lock()?
        .query_row(
            "SELECT root_id, media_kind FROM media_items WHERE id = ?1 AND is_missing = 0",
            [&media_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Failed to resolve GIF conversion source: {error}"))?;
    if kind != "video" {
        return Err("Only cataloged videos can be converted to GIF".to_owned());
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("converted");
    let selected = app
        .dialog()
        .file()
        .set_title("動画をGIFとして保存")
        .set_directory(source.parent().unwrap_or(&canonical_root))
        .set_file_name(format!("{stem}.gif"))
        .add_filter("GIF Image", &["gif"])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut destination = match selected {
        FilePath::Path(path) => path,
        FilePath::Url(_) => return Err("Only local Windows paths can store GIF files".to_owned()),
    };
    if destination.extension().is_none() {
        destination.set_extension("gif");
    }
    if destination
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("gif"))
    {
        return Err("The GIF destination must use the .gif extension".to_owned());
    }
    if destination.exists() {
        return Err(
            "The selected GIF destination already exists. Choose a new file name".to_owned(),
        );
    }
    let destination_parent = destination
        .parent()
        .ok_or_else(|| "The GIF destination has no parent folder".to_owned())?
        .canonicalize()
        .map_err(|error| format!("Cannot resolve the GIF destination folder: {error}"))?;
    if !destination_parent.is_dir() {
        return Err("The GIF destination folder is not available".to_owned());
    }
    let destination = destination_parent.join(
        destination
            .file_name()
            .ok_or_else(|| "The GIF destination has no file name".to_owned())?,
    );
    let database_path = state.database.path().to_owned();
    let worker_source = source.clone();
    let worker_destination = destination.clone();
    let worker_root_id = root_id.clone();
    let inside_registered_root = destination.starts_with(&canonical_root);
    let catalogued = tauri::async_runtime::spawn_blocking(move || {
        video_decode::convert_h264_mp4_to_gif(&worker_source, &worker_destination)?;
        if inside_registered_root {
            let worker_state = AppState::open(&database_path)?;
            catalog::scan_library(&worker_state, Some(&worker_root_id))?;
        }
        Ok::<bool, String>(inside_registered_root)
    })
    .await
    .map_err(|error| format!("GIF conversion worker failed: {error}"))??;
    if catalogued {
        media_folders::refresh_folder_hierarchy_cache(&state, Some(&root_id))?;
        invalidate_media_presence_cache();
    }
    Ok(Some(VideoGifConversionResult {
        path: destination
            .to_str()
            .map(ToOwned::to_owned)
            .ok_or_else(|| "Saved GIF path is not valid Unicode".to_owned())?,
        catalogued,
    }))
}

fn media_thumbnail_cache_path(
    app: &tauri::AppHandle,
    state: &AppState,
    media_id: &str,
) -> Result<std::path::PathBuf, String> {
    let (modified_at, byte_size, root, relative): (i64, i64, String, String) = state
        .database
        .lock()?
        .query_row(
            "SELECT m.modified_at, m.byte_size, r.path, m.relative_path
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             WHERE m.id = ?1 AND m.is_missing = 0 AND r.enabled = 1",
            [media_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("Failed to resolve media thumbnail: {error}"))?;
    let cache_directory = media_thumbnail_cache_directory(app)?;
    Ok(media_thumbnail_path(
        &cache_directory,
        &Path::new(&root).join(relative),
        modified_at,
        u64::try_from(byte_size).unwrap_or_default(),
    ))
}

fn schedule_thumbnail_precache(app: tauri::AppHandle, database_path: PathBuf, limit: u32) -> bool {
    if THUMBNAIL_PRECACHE_RUNNING.swap(true, AtomicOrdering::AcqRel) {
        return false;
    }
    THUMBNAIL_PRECACHE_CANCEL_REQUESTED.store(false, AtomicOrdering::Release);
    tauri::async_runtime::spawn_blocking(move || {
        let _running_guard = AtomicRunningGuard(&THUMBNAIL_PRECACHE_RUNNING);
        let result = AppState::open(&database_path)
            .and_then(|state| precache_missing_thumbnails(&app, &state, limit.clamp(32, 256)));
        if let Err(error) = result {
            eprintln!("Thumbnail precache stopped: {error}");
            report_thumbnail_precache_progress(
                &app,
                ThumbnailPrecacheProgress {
                    phase: "failed",
                    message: "サムネイルキャッシュの作成に失敗しました".to_owned(),
                    current: 0,
                    total: 0,
                },
            );
        }
    });
    true
}

#[derive(Clone)]
struct ThumbnailCandidate {
    media_id: String,
    root: String,
    relative: String,
    kind: String,
    modified_at: i64,
    byte_size: u64,
}

#[derive(Clone, Copy, Debug, Default, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ThumbnailPrecachePhase {
    #[default]
    Primary,
    Video,
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ThumbnailPrecacheCursor {
    generation: String,
    phase: ThumbnailPrecachePhase,
    modified_at: Option<i64>,
    media_id: String,
    evaluated: usize,
    available: usize,
    failed: usize,
    deferred_by_capacity: usize,
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailPrecacheCompletion {
    fingerprint: String,
    evaluated: usize,
    available: usize,
    failed: usize,
    deferred_by_capacity: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ThumbnailCacheUsage {
    bytes: u64,
    files: usize,
}

fn thumbnail_cache_entries(directory: &Path) -> Result<Vec<(PathBuf, u64, SystemTime)>, String> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Failed to inspect thumbnail cache: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to read thumbnail cache entry: {error}"))?;
        let path = entry.path();
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        if metadata.is_file() {
            entries.push((
                path,
                metadata.len(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ));
        }
    }
    Ok(entries)
}

fn thumbnail_cache_usage(directory: &Path) -> Result<ThumbnailCacheUsage, String> {
    let entries = thumbnail_cache_entries(directory)?;
    Ok(ThumbnailCacheUsage {
        bytes: entries.iter().map(|(_, bytes, _)| bytes).sum(),
        files: entries.len(),
    })
}

fn prune_thumbnail_cache(
    directory: &Path,
    target_bytes: u64,
    target_files: usize,
) -> Result<ThumbnailCacheUsage, String> {
    let mut entries = thumbnail_cache_entries(directory)?;
    let mut usage = ThumbnailCacheUsage {
        bytes: entries.iter().map(|(_, bytes, _)| bytes).sum(),
        files: entries.len(),
    };
    if usage.bytes <= target_bytes && usage.files <= target_files {
        return Ok(usage);
    }
    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, bytes, _) in entries {
        if usage.bytes <= target_bytes && usage.files <= target_files {
            break;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                forget_indexed_thumbnail(&path);
                usage.bytes = usage.bytes.saturating_sub(bytes);
                usage.files = usage.files.saturating_sub(1);
            }
            Err(error) => eprintln!("Failed to prune thumbnail {}: {error}", path.display()),
        }
    }
    Ok(usage)
}

fn thumbnail_precache_cursor(state: &AppState) -> Result<ThumbnailPrecacheCursor, String> {
    let connection = state.database.lock()?;
    let encoded = connection
        .query_row(
            "SELECT value_json FROM preferences WHERE key = ?1",
            [THUMBNAIL_PRECACHE_CURSOR_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok();
    Ok(encoded
        .and_then(|value| serde_json::from_str::<ThumbnailPrecacheCursor>(&value).ok())
        .unwrap_or_default())
}

fn thumbnail_precache_fingerprint(state: &AppState) -> Result<String, String> {
    let connection = state.database.lock()?;
    let (count, media_scan_at, root_updated_at, total_bytes): (i64, i64, i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(MAX(m.last_seen_at), 0),
                    COALESCE(MAX(r.updated_at), 0),
                    COALESCE(SUM(m.byte_size), 0)
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             WHERE m.is_missing = 0
               AND r.enabled = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("Failed to fingerprint thumbnail candidates: {error}"))?;
    Ok(format!(
        "v2:{count}:{media_scan_at}:{root_updated_at}:{total_bytes}"
    ))
}

fn thumbnail_precache_completion(state: &AppState) -> Result<ThumbnailPrecacheCompletion, String> {
    let connection = state.database.lock()?;
    let encoded = connection
        .query_row(
            "SELECT value_json FROM preferences WHERE key = ?1",
            [THUMBNAIL_PRECACHE_FINGERPRINT_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok();
    Ok(encoded
        .and_then(|value| {
            serde_json::from_str::<ThumbnailPrecacheCompletion>(&value)
                .ok()
                .or_else(|| {
                    serde_json::from_str::<String>(&value)
                        .ok()
                        .map(|fingerprint| ThumbnailPrecacheCompletion {
                            fingerprint,
                            ..ThumbnailPrecacheCompletion::default()
                        })
                })
        })
        .unwrap_or_default())
}

fn set_thumbnail_precache_cursor(
    state: &AppState,
    cursor: &ThumbnailPrecacheCursor,
) -> Result<(), String> {
    catalog::set_preference(
        state,
        THUMBNAIL_PRECACHE_CURSOR_KEY,
        serde_json::to_value(cursor)
            .map_err(|error| format!("Failed to encode thumbnail cursor: {error}"))?,
    )
    .map(|_| ())
}

fn query_thumbnail_candidates(
    state: &AppState,
    phase: ThumbnailPrecachePhase,
    cursor: &ThumbnailPrecacheCursor,
    limit: u32,
) -> Result<Vec<ThumbnailCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let kind_predicate = match phase {
        ThumbnailPrecachePhase::Primary => "m.media_kind IN ('image', 'gif', 'zip')",
        ThumbnailPrecachePhase::Video => "m.media_kind = 'video'",
    };
    let sql = format!(
        "SELECT m.id, r.path, m.relative_path, m.media_kind, m.modified_at, m.byte_size
         FROM media_items m
         JOIN library_roots r ON r.id = m.root_id
         WHERE m.is_missing = 0
           AND r.enabled = 1
           AND {kind_predicate}
           AND (?1 IS NULL
                OR m.modified_at < ?1
                OR (m.modified_at = ?1 AND m.id > ?2))
         ORDER BY m.modified_at DESC, m.id
         LIMIT ?3"
    );
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare thumbnail candidates: {error}"))?;
    let rows = statement
        .query_map(
            rusqlite::params![cursor.modified_at, cursor.media_id, limit],
            |row| {
                Ok(ThumbnailCandidate {
                    media_id: row.get(0)?,
                    root: row.get(1)?,
                    relative: row.get(2)?,
                    kind: row.get(3)?,
                    modified_at: row.get(4)?,
                    byte_size: u64::try_from(row.get::<_, i64>(5)?).unwrap_or_default(),
                })
            },
        )
        .map_err(|error| format!("Failed to query thumbnail candidates: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read thumbnail candidates: {error}"))
}

fn count_thumbnail_candidates_after(
    state: &AppState,
    phase: ThumbnailPrecachePhase,
    cursor: &ThumbnailPrecacheCursor,
) -> Result<usize, String> {
    let kind_predicate = match phase {
        ThumbnailPrecachePhase::Primary => "m.media_kind IN ('image', 'gif', 'zip')",
        ThumbnailPrecachePhase::Video => "m.media_kind = 'video'",
    };
    let sql = format!(
        "SELECT COUNT(*)
         FROM media_items m
         JOIN library_roots r ON r.id = m.root_id
         WHERE m.is_missing = 0
           AND r.enabled = 1
           AND {kind_predicate}
           AND (?1 IS NULL
                OR m.modified_at < ?1
                OR (m.modified_at = ?1 AND m.id > ?2))"
    );
    let count = state
        .database
        .lock()?
        .query_row(
            &sql,
            rusqlite::params![cursor.modified_at, cursor.media_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Failed to count thumbnail candidates: {error}"))?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

fn wait_for_thumbnail_background_quiet() -> bool {
    loop {
        if THUMBNAIL_PRECACHE_CANCEL_REQUESTED.load(AtomicOrdering::Acquire) {
            return false;
        }
        if !background_activity::is_foreground_active(THUMBNAIL_BACKGROUND_QUIET_PERIOD) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn checkpoint_thumbnail_wal(state: &AppState) {
    if background_activity::is_foreground_active(THUMBNAIL_BACKGROUND_QUIET_PERIOD) {
        return;
    }
    let Ok(connection) = state.database.lock() else {
        return;
    };
    let result = connection.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    });
    if let Err(error) = result {
        eprintln!("Passive thumbnail WAL checkpoint skipped: {error}");
    }
}

fn valid_thumbnail_file_names(
    state: &AppState,
    directory: &Path,
) -> Result<HashSet<String>, String> {
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(
            "SELECT m.id, r.path, m.relative_path, m.modified_at, m.byte_size
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             WHERE m.is_missing = 0
               AND r.enabled = 1",
        )
        .map_err(|error| format!("Failed to prepare valid thumbnail set: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                u64::try_from(row.get::<_, i64>(4)?).unwrap_or_default(),
            ))
        })
        .map_err(|error| format!("Failed to query valid thumbnail set: {error}"))?;
    let mut valid = HashSet::new();
    for row in rows {
        let (media_id, root, relative, modified_at, byte_size) =
            row.map_err(|error| format!("Failed to read valid thumbnail set: {error}"))?;
        let stable_path = media_thumbnail_path(
            directory,
            &Path::new(&root).join(&relative),
            modified_at,
            byte_size,
        );
        let stable_exists = indexed_thumbnail_exists(&stable_path);
        if let Some(name) = thumbnail_index_file_name(&stable_path) {
            valid.insert(name);
        }
        // Keep currently valid legacy entries for this session. The backfill
        // copies them to stable path-based keys without breaking an already
        // rendered asset URL.
        if !stable_exists {
            if let Some(name) = thumbnail_index_file_name(&legacy_media_thumbnail_path(
                directory,
                &media_id,
                modified_at,
            )) {
                valid.insert(name);
            }
        }
    }
    Ok(valid)
}

fn count_cached_thumbnail_candidates(state: &AppState, directory: &Path) -> Result<usize, String> {
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(
            "SELECT m.id, r.path, m.relative_path, m.modified_at, m.byte_size
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             WHERE m.is_missing = 0
               AND r.enabled = 1
               AND m.media_kind IN ('image', 'gif', 'video', 'zip')",
        )
        .map_err(|error| format!("Failed to prepare thumbnail coverage: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                u64::try_from(row.get::<_, i64>(4)?).unwrap_or_default(),
            ))
        })
        .map_err(|error| format!("Failed to query thumbnail coverage: {error}"))?;
    let mut cached = 0_usize;
    for row in rows {
        let (media_id, root, relative, modified_at, byte_size) =
            row.map_err(|error| format!("Failed to read thumbnail coverage: {error}"))?;
        let stable = media_thumbnail_path(
            directory,
            &Path::new(&root).join(relative),
            modified_at,
            byte_size,
        );
        let legacy = legacy_media_thumbnail_path(directory, &media_id, modified_at);
        if indexed_thumbnail_exists(&stable) || indexed_thumbnail_exists(&legacy) {
            cached = cached.saturating_add(1);
        }
    }
    Ok(cached)
}

fn sweep_orphaned_thumbnails(state: &AppState, directory: &Path) -> Result<Option<usize>, String> {
    let sweep_started = SystemTime::now();
    let valid = valid_thumbnail_file_names(state, directory)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Some(0)),
        Err(error) => return Err(format!("Failed to inspect thumbnail cache: {error}")),
    };
    let mut removed = 0_usize;
    for (index, entry) in entries.enumerate() {
        if index % 64 == 0 && !wait_for_thumbnail_background_quiet() {
            return Ok(None);
        }
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Some(name) = thumbnail_index_file_name(&path) else {
            continue;
        };
        if !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jpg"))
            || valid.contains(&name)
        {
            continue;
        }
        // A scan or visible request may publish a new thumbnail after the DB
        // snapshot above. Never classify such a concurrent write as orphaned.
        if path
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified >= sweep_started)
        {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                forget_indexed_thumbnail(&path);
                removed += 1;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                forget_indexed_thumbnail(&path);
            }
            Err(error) => eprintln!(
                "Failed to remove orphan thumbnail {}: {error}",
                path.display()
            ),
        }
    }
    persist_thumbnail_index_manifest(directory)?;
    Ok(Some(removed))
}

fn report_thumbnail_precache_cancelled(app: &tauri::AppHandle, current: usize, total: usize) {
    report_thumbnail_precache_progress(
        app,
        ThumbnailPrecacheProgress {
            phase: "cancelled",
            message: "サムネイルの事前生成を停止しました。".to_owned(),
            current,
            total,
        },
    );
}

fn precache_thumbnail_generation(
    app: &tauri::AppHandle,
    state: &AppState,
    batch_size: u32,
) -> Result<(), String> {
    let generation = thumbnail_precache_fingerprint(state)?;
    let cache_directory = media_thumbnail_cache_directory(app)?;
    fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("Failed to create thumbnail cache directory: {error}"))?;
    schedule_thumbnail_path_index(cache_directory.clone());
    if !wait_for_thumbnail_index_reconciliation(&cache_directory) {
        report_thumbnail_precache_cancelled(app, 0, 0);
        return Ok(());
    }
    let mut cursor = thumbnail_precache_cursor(state)?;
    if cursor.generation != generation {
        cursor = ThumbnailPrecacheCursor {
            generation: generation.clone(),
            ..ThumbnailPrecacheCursor::default()
        };
        set_thumbnail_precache_cursor(state, &cursor)?;
    } else if cursor.modified_at.is_none() && cursor.media_id.is_empty() {
        let completion = thumbnail_precache_completion(state)?;
        let cached_candidates = count_cached_thumbnail_candidates(state, &cache_directory)?;
        let capacity_state_sane = if completion.deferred_by_capacity == 0 {
            true
        } else {
            let usage = thumbnail_cache_usage(&cache_directory)?;
            usage.files >= THUMBNAIL_CACHE_TARGET_FILES
                || usage.bytes >= THUMBNAIL_CACHE_TARGET_BYTES
        };
        if completion.fingerprint == generation
            && capacity_state_sane
            && (completion.available == 0 || cached_candidates >= completion.available)
        {
            report_thumbnail_precache_progress(
                app,
                ThumbnailPrecacheProgress {
                    phase: "completed",
                    message: "現在のライブラリのサムネイル準備は完了済みです。".to_owned(),
                    current: 0,
                    total: 0,
                },
            );
            return Ok(());
        }
    }

    report_thumbnail_precache_progress(
        app,
        ThumbnailPrecacheProgress {
            phase: "running",
            message: "古いサムネイルキャッシュを整理しています。".to_owned(),
            current: 0,
            total: 0,
        },
    );
    let Some(orphan_count) = sweep_orphaned_thumbnails(state, &cache_directory)? else {
        report_thumbnail_precache_cancelled(app, 0, 0);
        return Ok(());
    };
    if orphan_count > 0 {
        eprintln!("Removed {orphan_count} orphaned thumbnail cache files");
    }

    let primary_remaining = if cursor.phase == ThumbnailPrecachePhase::Primary {
        count_thumbnail_candidates_after(state, ThumbnailPrecachePhase::Primary, &cursor)?
    } else {
        0
    };
    let video_cursor = if cursor.phase == ThumbnailPrecachePhase::Video {
        cursor.clone()
    } else {
        ThumbnailPrecacheCursor {
            generation: generation.clone(),
            phase: ThumbnailPrecachePhase::Video,
            ..ThumbnailPrecacheCursor::default()
        }
    };
    let video_remaining =
        count_thumbnail_candidates_after(state, ThumbnailPrecachePhase::Video, &video_cursor)?;
    let total = cursor
        .evaluated
        .saturating_add(primary_remaining)
        .saturating_add(video_remaining);
    let mut processed = cursor.evaluated;
    let mut generated = 0_usize;
    let mut available = cursor.available;
    let mut failed = cursor.failed;
    let mut deferred_by_capacity = cursor.deferred_by_capacity;
    let mut unavailable_ids = Vec::new();
    let mut last_progress_report = Instant::now();
    let mut cache_usage = thumbnail_cache_usage(&cache_directory)?;
    if cache_usage.bytes >= MAX_THUMBNAIL_CACHE_BYTES
        || cache_usage.files >= MAX_THUMBNAIL_CACHE_FILES
    {
        cache_usage = prune_thumbnail_cache(
            &cache_directory,
            THUMBNAIL_CACHE_TARGET_BYTES,
            THUMBNAIL_CACHE_TARGET_FILES,
        )?;
    }
    let mut capacity_exhausted = cache_usage.files >= THUMBNAIL_CACHE_TARGET_FILES
        || cache_usage.bytes >= THUMBNAIL_CACHE_TARGET_BYTES;

    report_thumbnail_precache_progress(
        app,
        ThumbnailPrecacheProgress {
            phase: "running",
            message: format!("サムネイルを準備しています（{processed}/{total}）"),
            current: processed,
            total,
        },
    );

    loop {
        if !wait_for_thumbnail_background_quiet() {
            set_thumbnail_precache_cursor(state, &cursor)?;
            report_thumbnail_precache_cancelled(app, processed, total);
            return Ok(());
        }
        let candidates = query_thumbnail_candidates(state, cursor.phase, &cursor, batch_size)?;
        if candidates.is_empty() {
            if cursor.phase == ThumbnailPrecachePhase::Primary {
                cursor = ThumbnailPrecacheCursor {
                    generation: generation.clone(),
                    phase: ThumbnailPrecachePhase::Video,
                    evaluated: processed,
                    available,
                    failed,
                    deferred_by_capacity,
                    ..ThumbnailPrecacheCursor::default()
                };
                set_thumbnail_precache_cursor(state, &cursor)?;
                continue;
            }
            break;
        }

        for candidate in candidates {
            if !wait_for_thumbnail_background_quiet() {
                set_thumbnail_precache_cursor(state, &cursor)?;
                report_thumbnail_precache_cancelled(app, processed, total);
                return Ok(());
            }
            let relative = PathBuf::from(&candidate.relative);
            let valid_relative = !relative.is_absolute()
                && !relative.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                });
            if valid_relative {
                let source_identity = Path::new(&candidate.root).join(&relative);
                let stable_path = media_thumbnail_path(
                    &cache_directory,
                    &source_identity,
                    candidate.modified_at,
                    candidate.byte_size,
                );
                let legacy_path = legacy_media_thumbnail_path(
                    &cache_directory,
                    &candidate.media_id,
                    candidate.modified_at,
                );
                let already_cached =
                    thumbnail_path_exists(&stable_path) || thumbnail_path_exists(&legacy_path);
                if already_cached || !capacity_exhausted {
                    let (thumbnail, source_unavailable) = get_or_generate_media_thumbnail(
                        app,
                        &candidate.media_id,
                        &candidate.kind,
                        candidate.modified_at,
                        candidate.byte_size,
                        Path::new(&candidate.root),
                        &relative,
                        ThumbnailWorkPriority::Background,
                    )?;
                    if THUMBNAIL_PRECACHE_CANCEL_REQUESTED.load(AtomicOrdering::Acquire) {
                        // Do not checkpoint this candidate. If generation had
                        // just completed, resume will observe the cache hit and
                        // commit it cheaply; if it was cancelled while waiting
                        // for a permit, it remains eligible for generation.
                        set_thumbnail_precache_cursor(state, &cursor)?;
                        report_thumbnail_precache_cancelled(app, processed, total);
                        return Ok(());
                    }
                    if source_unavailable {
                        unavailable_ids.push(candidate.media_id.clone());
                    }
                    if thumbnail.is_some() {
                        available = available.saturating_add(1);
                    } else {
                        failed = failed.saturating_add(1);
                    }
                    if thumbnail.as_deref() == stable_path.to_str() && !already_cached {
                        generated += 1;
                        cache_usage.files = cache_usage.files.saturating_add(1);
                        if let Ok(metadata) = stable_path.metadata() {
                            cache_usage.bytes = cache_usage.bytes.saturating_add(metadata.len());
                        }
                    }
                    if cache_usage.files >= THUMBNAIL_CACHE_TARGET_FILES
                        || cache_usage.bytes >= THUMBNAIL_CACHE_TARGET_BYTES
                    {
                        // Keep the newest image/GIF/book items already visited
                        // instead of evicting them merely to generate older or
                        // slower entries later in the same pass.
                        capacity_exhausted = true;
                    }
                } else {
                    deferred_by_capacity = deferred_by_capacity.saturating_add(1);
                }
            } else {
                failed = failed.saturating_add(1);
            }

            processed = processed.saturating_add(1);
            cursor.modified_at = Some(candidate.modified_at);
            cursor.media_id = candidate.media_id;
            cursor.evaluated = processed;
            cursor.available = available;
            cursor.failed = failed;
            cursor.deferred_by_capacity = deferred_by_capacity;
            if processed == total || last_progress_report.elapsed() >= Duration::from_millis(200) {
                report_thumbnail_precache_progress(
                    app,
                    ThumbnailPrecacheProgress {
                        phase: "running",
                        message: format!("サムネイルを準備しています（{processed}/{total}）"),
                        current: processed,
                        total,
                    },
                );
                last_progress_report = Instant::now();
            }
            if processed % THUMBNAIL_PRECACHE_CHECKPOINT_INTERVAL == 0 {
                set_thumbnail_precache_cursor(state, &cursor)?;
                if let Err(error) = persist_thumbnail_index_manifest(&cache_directory) {
                    eprintln!("Thumbnail index checkpoint skipped: {error}");
                }
                checkpoint_thumbnail_wal(state);
            }
        }
        set_thumbnail_precache_cursor(state, &cursor)?;
    }

    if !unavailable_ids.is_empty() {
        unavailable_ids.sort_unstable();
        unavailable_ids.dedup();
        for media_id in unavailable_ids {
            let _ = catalog::reconcile_media_load_failure(state, &media_id);
        }
    }
    persist_thumbnail_index_manifest(&cache_directory)?;
    catalog::set_preference(
        state,
        THUMBNAIL_PRECACHE_FINGERPRINT_KEY,
        serde_json::to_value(ThumbnailPrecacheCompletion {
            fingerprint: generation.clone(),
            evaluated: processed,
            available,
            failed,
            deferred_by_capacity,
        })
        .map_err(|error| format!("Failed to encode thumbnail completion ledger: {error}"))?,
    )?;
    set_thumbnail_precache_cursor(
        state,
        &ThumbnailPrecacheCursor {
            generation,
            ..ThumbnailPrecacheCursor::default()
        },
    )?;
    checkpoint_thumbnail_wal(state);
    report_thumbnail_precache_progress(
        app,
        ThumbnailPrecacheProgress {
            phase: "completed",
            message: format!("サムネイルの準備が完了しました（新規 {generated} 件）"),
            current: total,
            total,
        },
    );
    Ok(())
}

fn precache_missing_thumbnails(
    app: &tauri::AppHandle,
    state: &AppState,
    batch_size: u32,
) -> Result<(), String> {
    loop {
        let generation_before = thumbnail_precache_fingerprint(state)?;
        precache_thumbnail_generation(app, state, batch_size)?;
        if THUMBNAIL_PRECACHE_CANCEL_REQUESTED.load(AtomicOrdering::Acquire) {
            return Ok(());
        }
        let generation_after = thumbnail_precache_fingerprint(state)?;
        if generation_before == generation_after
            && thumbnail_precache_completion(state)?.fingerprint == generation_after
        {
            return Ok(());
        }
        // A foreground scan changed the catalog while this pass was yielding.
        // Start the new generation immediately rather than waiting for another
        // application restart; unchanged cache keys remain instant hits.
    }
}

fn decode_jpeg_thumbnail(data_url: &str) -> Result<Vec<u8>, String> {
    const PREFIX: &str = "data:image/jpeg;base64,";
    let encoded = data_url
        .strip_prefix(PREFIX)
        .ok_or_else(|| "Thumbnail must be a JPEG data URL".to_owned())?;
    if encoded.len() > MAX_MEDIA_THUMBNAIL_BYTES.saturating_mul(2) {
        return Err("Thumbnail data is too large".to_owned());
    }
    let bytes = decode_base64(encoded)?;
    if bytes.len() > MAX_MEDIA_THUMBNAIL_BYTES || !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Err("Thumbnail is not a valid JPEG image".to_owned());
    }
    Ok(bytes)
}

fn decode_image_data_url(data_url: &str) -> Result<(&'static str, Vec<u8>), String> {
    let (extension, encoded, magic): (&str, &str, &[u8]) =
        if let Some(encoded) = data_url.strip_prefix("data:image/png;base64,") {
            ("png", encoded, &[0x89, b'P', b'N', b'G'])
        } else if let Some(encoded) = data_url.strip_prefix("data:image/jpeg;base64,") {
            ("jpg", encoded, &[0xff, 0xd8, 0xff])
        } else if let Some(encoded) = data_url.strip_prefix("data:image/gif;base64,") {
            ("gif", encoded, b"GIF8")
        } else {
            return Err("Capture must be a PNG, JPEG, or GIF data URL".to_owned());
        };
    if encoded.len() > MAX_CAPTURE_BYTES.saturating_mul(2) {
        return Err("Capture data is too large".to_owned());
    }
    let bytes = decode_base64(encoded)?;
    if bytes.len() > MAX_CAPTURE_BYTES || !bytes.starts_with(magic) {
        return Err("Capture image data is invalid".to_owned());
    }
    Ok((extension, bytes))
}

fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty() || value.len() % 4 != 0 {
        return Err("Thumbnail contains invalid base64 data".to_owned());
    }
    let mut output = Vec::with_capacity(value.len() / 4 * 3);
    for (chunk_index, chunk) in value.as_bytes().chunks_exact(4).enumerate() {
        let is_last = chunk_index == value.len() / 4 - 1;
        let first = base64_value(chunk[0])
            .ok_or_else(|| "Thumbnail contains invalid base64 data".to_owned())?;
        let second = base64_value(chunk[1])
            .ok_or_else(|| "Thumbnail contains invalid base64 data".to_owned())?;
        let third = if chunk[2] == b'=' {
            if !is_last || chunk[3] != b'=' {
                return Err("Thumbnail contains invalid base64 padding".to_owned());
            }
            None
        } else {
            Some(
                base64_value(chunk[2])
                    .ok_or_else(|| "Thumbnail contains invalid base64 data".to_owned())?,
            )
        };
        let fourth = if chunk[3] == b'=' {
            if !is_last {
                return Err("Thumbnail contains invalid base64 padding".to_owned());
            }
            None
        } else {
            Some(
                base64_value(chunk[3])
                    .ok_or_else(|| "Thumbnail contains invalid base64 data".to_owned())?,
            )
        };
        output.push((first << 2) | (second >> 4));
        if let Some(third) = third {
            output.push((second << 4) | (third >> 2));
            if let Some(fourth) = fourth {
                output.push((third << 6) | fourth);
            }
        }
    }
    Ok(output)
}

fn base64_value(value: u8) -> Option<u8> {
    match value {
        b'A'..=b'Z' => Some(value - b'A'),
        b'a'..=b'z' => Some(value - b'a' + 26),
        b'0'..=b'9' => Some(value - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[tauri::command]
fn add_library_root(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<LibraryRoot, String> {
    let root = file_browser::priority_root(&state, &path)?;
    app.asset_protocol_scope()
        .allow_directory(&root.path, true)
        .map_err(|error| format!("Failed to allow library root assets: {error}"))?;
    Ok(root)
}

#[tauri::command]
async fn list_library_roots(app: tauri::AppHandle) -> Result<Vec<LibraryRoot>, String> {
    run_catalog_worker("Library roots", move || {
        catalog::list_library_roots(&app.state::<AppState>())
    })
    .await
}

#[tauri::command]
async fn browse_file_system(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
    scan: Option<bool>,
) -> Result<file_browser::FolderListing, String> {
    let database_path = state.database.path().to_owned();
    let listing = tauri::async_runtime::spawn_blocking(move || {
        let state = AppState::open(&database_path)?;
        file_browser::browse(&state, path.as_deref(), scan.unwrap_or(true))
    })
    .await
    .map_err(|error| error.to_string())??;
    if let Some(path) = &listing.path {
        app.asset_protocol_scope()
            .allow_directory(path, false)
            .map_err(|error| error.to_string())?;
    }
    invalidate_media_presence_cache();
    Ok(listing)
}

#[tauri::command]
fn set_folder_priority(
    state: State<'_, AppState>,
    root_id: String,
    priority: bool,
) -> Result<(), String> {
    catalog::set_root_priority(&state, &root_id, priority)
}

#[tauri::command]
async fn sync_media_folder(
    state: State<'_, AppState>,
    root_id: String,
    folder_path: Option<String>,
) -> Result<ScanReport, String> {
    let database_path = state.database.path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = AppState::open(&database_path)?;
        let report = if let Some(folder) = folder_path {
            ScanReport::from_roots(vec![catalog::scan_folder(&state, &root_id, &folder)?])
        } else {
            catalog::scan_library(&state, Some(&root_id))?
        };
        media_folders::invalidate_folder_hierarchy_cache(&state, Some(&root_id))?;
        invalidate_media_presence_cache();
        Ok(report)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn list_media_folders(
    state: State<'_, AppState>,
    root_id: Option<String>,
    kinds: Option<Vec<String>>,
    refresh_physical: Option<bool>,
) -> Result<Vec<media_folders::MediaFolder>, String> {
    background_activity::note_foreground_activity();
    let kinds_csv = kinds
        .filter(|values| !values.is_empty())
        .map(|values| values.join(","));
    media_folders::list_media_folders(
        &state,
        root_id.as_deref(),
        kinds_csv.as_deref(),
        refresh_physical.unwrap_or(false),
    )
}

#[tauri::command]
fn list_folder_groups(
    state: State<'_, AppState>,
) -> Result<Vec<organization::FolderGroup>, String> {
    organization::list_folder_groups(&state)
}

#[tauri::command]
fn save_folder_group(
    state: State<'_, AppState>,
    group_id: Option<String>,
    name: String,
    members: Vec<organization::FolderGroupMemberInput>,
) -> Result<organization::FolderGroup, String> {
    organization::save_folder_group(&state, group_id.as_deref(), &name, &members)
}

#[tauri::command]
fn delete_folder_group(
    state: State<'_, AppState>,
    group_id: String,
) -> Result<MutationResult, String> {
    organization::delete_folder_group(&state, &group_id)
}

#[tauri::command]
fn reorder_folder_groups(
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> Result<MutationResult, String> {
    organization::reorder_folder_groups(&state, &ordered_ids)
}

#[tauri::command]
fn remove_library_root(
    state: State<'_, AppState>,
    root_id: String,
) -> Result<MutationResult, String> {
    catalog::remove_library_root(&state, &root_id)
}

#[tauri::command]
async fn scan_library(
    state: State<'_, AppState>,
    root_id: Option<String>,
) -> Result<ScanReport, String> {
    background_activity::note_foreground_activity();
    let database_path = state.database.path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = AppState::open(&database_path)?;
        let report = catalog::scan_library(&state, root_id.as_deref())?;
        media_folders::invalidate_folder_hierarchy_cache(&state, root_id.as_deref())?;
        invalidate_media_presence_cache();
        Ok(report)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_library_summary(app: tauri::AppHandle) -> Result<LibrarySummary, String> {
    run_catalog_worker("Library summary", move || {
        catalog::get_library_summary(&app.state::<AppState>())
    })
    .await
}

#[tauri::command]
async fn list_media_items(
    app: tauri::AppHandle,
    query: Option<MediaQuery>,
) -> Result<Vec<MediaItem>, String> {
    run_catalog_worker("Media list", move || {
        let state = app.state::<AppState>();
        let mut media_items = catalog::list_media_items(&state, query)?;
        let known_missing =
            schedule_media_presence_validation(state.database.path().to_owned(), &media_items);
        if !known_missing.is_empty() {
            media_items.retain(|item| !known_missing.contains(&item.id));
        }
        attach_existing_thumbnail_paths(&app, &mut media_items)?;
        Ok(media_items)
    })
    .await
}

#[tauri::command]
async fn get_media_item_index(
    app: tauri::AppHandle,
    media_id: String,
    query: Option<MediaQuery>,
) -> Result<Option<u64>, String> {
    run_catalog_worker("Media index", move || {
        catalog::get_media_item_index(&app.state::<AppState>(), &media_id, query)
    })
    .await
}

#[tauri::command]
async fn get_visual_recommendations(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    limit: Option<u32>,
) -> Result<feature_vectors::VisualRecommendationResult, String> {
    background_activity::note_foreground_activity();
    let database_path = state.database.path().to_owned();
    let model_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Cannot resolve the visual model directory: {error}"))?
        .join("ai-models");
    feature_vectors::schedule_backfill(database_path.clone(), model_directory.clone());
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        let state = AppState::open(&database_path)?;
        feature_vectors::get_recommendations(
            &state,
            &model_directory,
            &media_id,
            limit.unwrap_or(25),
        )
    })
    .await
    .map_err(|error| format!("Visual recommendation task failed: {error}"))??;
    for recommendation in &mut result.recommendations {
        attach_existing_thumbnail_paths(&app, std::slice::from_mut(&mut recommendation.item))?;
    }
    Ok(result)
}

#[tauri::command]
async fn get_adjacent_similarity_groups(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    query: Option<MediaQuery>,
    threshold: Option<f32>,
) -> Result<feature_vectors::AdjacentSimilarityResult, String> {
    background_activity::note_foreground_activity();
    let database_path = state.database.path().to_owned();
    let model_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Cannot resolve the visual model directory: {error}"))?
        .join("ai-models");
    feature_vectors::schedule_backfill(database_path.clone(), model_directory);
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        let state = AppState::open(&database_path)?;
        feature_vectors::get_adjacent_similarity_groups(&state, query, threshold.unwrap_or(0.6))
    })
    .await
    .map_err(|error| format!("Adjacent similarity task failed: {error}"))??;
    for group in &mut result.groups {
        attach_existing_thumbnail_paths(&app, std::slice::from_mut(&mut group.representative))?;
    }
    Ok(result)
}

#[tauri::command]
fn get_media_items_by_ids(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_ids: Vec<String>,
) -> Result<Vec<MediaItem>, String> {
    if media_ids.len() > 10_000 {
        return Err("一度に開ける類似画像は10,000件までです。".to_owned());
    }
    let mut unique = Vec::with_capacity(media_ids.len());
    let mut seen = HashSet::new();
    for id in &media_ids {
        if !id.trim().is_empty() && seen.insert(id.clone()) {
            unique.push(id.clone());
        }
    }
    let mut by_id = HashMap::with_capacity(unique.len());
    for chunk in unique.chunks(400) {
        let mut items = catalog::get_media_items_by_ids(&state, chunk)?;
        attach_existing_thumbnail_paths(&app, &mut items)?;
        for item in items {
            by_id.insert(item.id.clone(), item);
        }
    }
    Ok(media_ids
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect())
}

#[tauri::command]
async fn get_media_page_info(
    app: tauri::AppHandle,
    query: Option<MediaQuery>,
) -> Result<models::MediaPageInfo, String> {
    run_catalog_worker("Media page info", move || {
        catalog::get_media_page_info(&app.state::<AppState>(), query)
    })
    .await
}

#[tauri::command]
fn recycle_media_item(
    state: State<'_, AppState>,
    media_id: String,
) -> Result<MutationResult, String> {
    platform::recycle_media_item(&state, &media_id)
}

#[tauri::command]
fn open_library_folder_in_explorer(
    state: State<'_, AppState>,
    root_id: String,
    relative_path: String,
) -> Result<(), String> {
    platform::open_library_folder_in_explorer(&state, &root_id, &relative_path)
}

#[tauri::command]
fn reveal_media_in_explorer(state: State<'_, AppState>, media_id: String) -> Result<(), String> {
    platform::reveal_media_in_explorer(&state, &media_id)
}

#[tauri::command]
fn set_favorite(
    state: State<'_, AppState>,
    media_id: String,
    is_favorite: bool,
) -> Result<MutationResult, String> {
    catalog::set_favorite(&state, &media_id, is_favorite)
}

#[tauri::command]
fn set_age_rating(
    state: State<'_, AppState>,
    media_id: String,
    age_rating: String,
) -> Result<String, String> {
    catalog::set_age_rating(&state, &media_id, &age_rating)
}

#[tauri::command]
fn list_book_bookmarks(
    state: State<'_, AppState>,
    media_id: String,
) -> Result<Vec<BookBookmark>, String> {
    catalog::list_book_bookmarks(&state, &media_id)
}

#[tauri::command]
fn set_book_bookmark(
    state: State<'_, AppState>,
    media_id: String,
    page_index: u32,
    is_bookmarked: bool,
) -> Result<MutationResult, String> {
    catalog::set_book_bookmark(&state, &media_id, page_index, is_bookmarked)
}

#[tauri::command]
fn set_wallpaper(state: State<'_, AppState>, media_id: String) -> Result<(), String> {
    platform::set_media_as_wallpaper(&state, &media_id)
}

#[tauri::command]
async fn search_ascii2d(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> Result<String, String> {
    let (_root, source) = catalog::resolve_media_path_for_recycle(&state, &media_id)?;
    let upload_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Cannot resolve ascii2d working directory: {error}"))?
        .join("ascii2d");
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = source
            .metadata()
            .map_err(|error| format!("Cannot inspect ascii2d source image: {error}"))?;
        if metadata.len() > 100 * 1024 * 1024 {
            return Err("ascii2d source exceeds the 100 MB preprocessing limit".to_owned());
        }
        let image = image::open(&source)
            .map_err(|error| format!("Cannot decode the image for ascii2d: {error}"))?
            .thumbnail(1_600, 1_600)
            .to_rgba8();
        let mut composited = image::RgbImage::new(image.width(), image.height());
        for (x, y, pixel) in image.enumerate_pixels() {
            let alpha = u16::from(pixel[3]);
            let blend = |channel: u8| {
                ((u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
            };
            composited.put_pixel(
                x,
                y,
                image::Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
            );
        }
        std::fs::create_dir_all(&upload_directory)
            .map_err(|error| format!("Cannot create ascii2d working directory: {error}"))?;
        let upload_path = upload_directory.join(format!("{}.jpg", safe_cache_id(&media_id)));
        let output = std::fs::File::create(&upload_path)
            .map_err(|error| format!("Cannot prepare ascii2d upload: {error}"))?;
        image::codecs::jpeg::JpegEncoder::new_with_quality(output, 90)
            .encode_image(&composited)
            .map_err(|error| format!("Cannot encode ascii2d upload: {error}"))?;
        ascii2d::search_image(&upload_path)
    })
    .await
    .map_err(|error| format!("ascii2d検索処理を完了できませんでした: {error}"))?
}

#[tauri::command]
async fn search_web(
    query: String,
    mode: Option<String>,
) -> Result<Vec<web_search::WebSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || web_search::search_web(&query, mode.as_deref()))
        .await
        .map_err(|error| format!("Web search worker failed: {error}"))?
}

#[tauri::command]
fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagWithCount>, String> {
    catalog::list_tags(&state)
}

#[tauri::command]
fn upsert_tag(state: State<'_, AppState>, tag: TagInput) -> Result<Tag, String> {
    catalog::upsert_tag(&state, tag)
}

#[tauri::command]
fn delete_tag(state: State<'_, AppState>, tag_id: String) -> Result<MutationResult, String> {
    catalog::delete_tag(&state, &tag_id)
}

#[tauri::command]
fn set_media_tags(
    state: State<'_, AppState>,
    media_id: String,
    tag_ids: Vec<String>,
) -> Result<Vec<Tag>, String> {
    catalog::set_media_tags(&state, &media_id, tag_ids)
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Result<Vec<PreferenceEntry>, String> {
    catalog::get_preferences(&state)
}

#[tauri::command]
fn set_preference(
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> Result<PreferenceEntry, String> {
    catalog::set_preference(&state, &key, value)
}

#[tauri::command]
fn delete_preference(state: State<'_, AppState>, key: String) -> Result<MutationResult, String> {
    catalog::delete_preference(&state, &key)
}

#[tauri::command]
fn list_x_history(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<XHistoryItem>, String> {
    let history = catalog::list_x_history(&state, limit)?;
    for item in &history {
        if let Some(path) = item
            .local_path
            .as_deref()
            .map(Path::new)
            .filter(|path| path.is_file())
        {
            app.asset_protocol_scope()
                .allow_file(path)
                .map_err(|error| {
                    format!(
                        "Xダウンロード履歴のプレビューを許可できませんでした（{}）: {error}",
                        path.display()
                    )
                })?;
        }
    }
    Ok(history)
}

#[tauri::command]
fn upsert_x_history(
    state: State<'_, AppState>,
    item: XHistoryInput,
) -> Result<XHistoryItem, String> {
    catalog::upsert_x_history(&state, item)
}

#[tauri::command]
fn delete_x_history(
    state: State<'_, AppState>,
    history_id: String,
) -> Result<MutationResult, String> {
    catalog::delete_x_history(&state, &history_id)
}

#[tauri::command]
async fn inspect_x_post(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source_url: String,
    destination: Option<String>,
) -> Result<x_downloader::XPostInspection, String> {
    let database_path = state.database.path().to_owned();
    let destination = destination
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| app.path().download_dir().ok());
    tauri::async_runtime::spawn_blocking(move || {
        let worker_state = AppState::open(&database_path)?;
        x_downloader::inspect_x_post_for_destination(
            &worker_state,
            &source_url,
            destination.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("X投稿の解析処理を完了できませんでした: {error}"))?
}

#[tauri::command]
async fn download_x_post(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source_url: String,
    destination: String,
    selections: Option<Vec<x_downloader::XMediaSelection>>,
) -> Result<x_downloader::XDownloadResult, String> {
    let database_path = state.database.path().to_owned();
    let destination = if destination.trim().is_empty() {
        app.path()
            .download_dir()
            .map_err(|error| format!("Downloadsフォルダーを取得できませんでした: {error}"))?
    } else {
        PathBuf::from(destination)
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let worker_state = AppState::open(&database_path)?;
        x_downloader::download_x_post(
            &worker_state,
            &source_url,
            &destination,
            selections.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Xダウンロード処理を完了できませんでした: {error}"))??;
    for path in &result.files {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|error| {
                format!("保存したXメディアのプレビューを許可できませんでした（{path}）: {error}")
            })?;
    }
    Ok(result)
}

#[tauri::command]
async fn finalize_x_gif(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<x_downloader::XGifFinalizeResult, String> {
    if token.trim().is_empty() || token.len() > 128 {
        return Err("GIF変換の承認トークンが不正です".to_owned());
    }
    let database_path = state.database.path().to_owned();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let worker_state = AppState::open(&database_path)?;
        x_downloader::finalize_x_gif(&worker_state, &token)
    })
    .await
    .map_err(|error| format!("GIF変換の保存処理を完了できませんでした: {error}"))??;
    app.asset_protocol_scope()
        .allow_file(&result.path)
        .map_err(|error| format!("変換したGIFのプレビューを許可できませんでした: {error}"))?;
    Ok(result)
}

#[tauri::command]
fn fail_x_gif_finalization(
    state: State<'_, AppState>,
    token: String,
    message: String,
) -> Result<XHistoryItem, String> {
    x_downloader::fail_x_gif_finalization(&state, &token, &message)
}

#[tauri::command]
fn list_tag_translations(
    state: State<'_, AppState>,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    tag_translations::list_tag_translations(&state)
}

#[tauri::command]
fn import_catalog_data(
    state: State<'_, AppState>,
    payload: CatalogImportPayload,
    dry_run: bool,
) -> Result<ImportCatalogResult, String> {
    catalog::import_catalog_data(&state, payload, dry_run)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    tauri::Builder::default()
        .manage(external_input::ExternalInputState::with_startup_pending(
            !startup_arguments.is_empty(),
        ))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            background_activity::note_foreground_activity();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // Canonicalizing a disconnected drive can block. Keep all path IO
            // out of the single-instance callback and wake JS only after the
            // durable native queue has accepted the arguments.
            let secondary_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let accepted_media =
                    match secondary_app.try_state::<external_input::ExternalInputState>() {
                        Some(state) => match state.ingest_arguments(args.iter()) {
                            Ok(accepted) => accepted,
                            Err(error) => {
                                diagnostics::record("external-input-error", &error);
                                0
                            }
                        },
                        None => {
                            diagnostics::record(
                                "external-input-error",
                                "External input state was unavailable for a secondary launch",
                            );
                            0
                        }
                    };
                if accepted_media > 0 {
                    let _ = secondary_app.emit("pixvault://external-media-open", ());
                }
                // Also wake the existing X downloader integration. Taking an
                // empty queue is harmless and avoids trusting event payloads.
                let _ = secondary_app.emit("pixvault://external-x-open", ());
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            background_activity::note_foreground_activity();
            let data_directory = app.path().app_local_data_dir().map_err(|error| {
                std::io::Error::other(format!(
                    "Failed to resolve application data directory: {error}"
                ))
            })?;
            diagnostics::initialize(&data_directory).map_err(std::io::Error::other)?;
            let database_path = data_directory.join("galleryweb.sqlite3");
            let ai_model_directory = data_directory.join("ai-models");
            let thumbnail_cache_directory = data_directory.join("media-thumbnails");
            fs::create_dir_all(&thumbnail_cache_directory)?;
            schedule_thumbnail_path_index(thumbnail_cache_directory.clone());
            app.asset_protocol_scope()
                .allow_directory(&thumbnail_cache_directory, true)
                .map_err(std::io::Error::other)?;
            let state = AppState::open(&database_path).map_err(std::io::Error::other)?;
            for root in
                catalog::list_enabled_library_root_records(&state).map_err(std::io::Error::other)?
            {
                app.asset_protocol_scope()
                    .allow_directory(&root.path, true)
                    .map_err(std::io::Error::other)?;
            }
            for entry in catalog::get_preferences(&state).map_err(std::io::Error::other)? {
                if entry.key != DRAWING_REFERENCES_PREFERENCE_KEY {
                    continue;
                }
                if let Some(references) = entry.value.as_array() {
                    for reference in references {
                        if let Some(path) = reference.get("path").and_then(Value::as_str) {
                            if !is_web_reference(path) {
                                app.asset_protocol_scope()
                                    .allow_file(path)
                                    .map_err(std::io::Error::other)?;
                            }
                        }
                        if let Some(items) = reference.get("items").and_then(Value::as_array) {
                            for item in items {
                                if let Some(path) = item.get("path").and_then(Value::as_str) {
                                    if !is_web_reference(path) {
                                        app.asset_protocol_scope()
                                            .allow_file(path)
                                            .map_err(std::io::Error::other)?;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            debug_assert_eq!(state.database.path(), database_path);
            if let Err(error) = external_input::register_windows_protocol() {
                eprintln!("PixVault X URL protocol registration failed: {error}");
                diagnostics::record("protocol-error", &error);
            }
            app.manage(state);
            app.manage(ai::AiRuntimeState::new(ai_model_directory));
            app.manage(system_metrics::SystemMetricsState::default());
            folder_watcher::start(app.handle().clone(), database_path.clone());
            schedule_startup_missing_recovery(app.handle().clone(), database_path.clone());
            schedule_startup_diagnostics(database_path);
            if !startup_arguments.is_empty() {
                let startup_app = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let accepted_media = match startup_app
                        .state::<external_input::ExternalInputState>()
                        .ingest_arguments(startup_arguments)
                    {
                        Ok(accepted) => accepted,
                        Err(error) => {
                            diagnostics::record("external-input-error", &error);
                            0
                        }
                    };
                    startup_app
                        .state::<external_input::ExternalInputState>()
                        .finish_startup();
                    if accepted_media > 0 {
                        let _ = startup_app.emit("pixvault://external-media-open", ());
                    }
                    let _ = startup_app.emit("pixvault://external-x-open", ());
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            record_diagnostic_event,
            get_system_diagnostics,
            optimize_catalog,
            export_diagnostics_report,
            create_catalog_recovery_snapshot,
            in_app_browser::open_in_app_browser,
            in_app_browser::get_in_app_browser_url,
            in_app_browser::set_in_app_browser_bounds,
            in_app_browser::control_in_app_browser,
            in_app_browser::close_in_app_browser,
            get_thumbnail_precache_status,
            start_thumbnail_precache,
            cancel_thumbnail_precache,
            notify_foreground_activity,
            take_pending_x_url,
            take_pending_external_media,
            show_windows_notification,
            pick_library_root,
            pick_drawing_reference,
            cache_temporary_drawing_reference,
            cleanup_temporary_drawing_references,
            pick_android_migration_archive,
            commit_android_migration_archive,
            export_settings_backup,
            import_settings_backup,
            get_default_x_download_directory,
            pick_x_download_folder,
            get_archive_cover,
            get_archive_book_info,
            get_archive_book_page,
            precache_archive_book_pages,
            get_media_thumbnail,
            get_media_thumbnails,
            report_media_load_failure,
            get_media_image_preview,
            save_media_thumbnail,
            save_capture,
            convert_video_to_gif,
            add_library_root,
            list_library_roots,
            browse_file_system,
            set_folder_priority,
            sync_media_folder,
            list_media_folders,
            list_folder_groups,
            save_folder_group,
            delete_folder_group,
            reorder_folder_groups,
            remove_library_root,
            scan_library,
            get_library_summary,
            list_media_items,
            get_media_item_index,
            get_visual_recommendations,
            get_adjacent_similarity_groups,
            get_media_items_by_ids,
            get_media_page_info,
            recycle_media_item,
            open_library_folder_in_explorer,
            reveal_media_in_explorer,
            set_favorite,
            set_age_rating,
            list_book_bookmarks,
            set_book_bookmark,
            set_wallpaper,
            search_ascii2d,
            search_web,
            list_tags,
            upsert_tag,
            delete_tag,
            set_media_tags,
            get_preferences,
            set_preference,
            delete_preference,
            list_x_history,
            upsert_x_history,
            delete_x_history,
            inspect_x_post,
            download_x_post,
            finalize_x_gif,
            fail_x_gif_finalization,
            list_tag_translations,
            import_catalog_data,
            ai::get_ai_model_status,
            ai::get_ai_analysis_status,
            ai::preview_ai_analysis_scope,
            ai::start_ai_analysis,
            ai::cancel_ai_analysis,
            ai::set_ai_analysis_paused,
            system_metrics::sample_system_load
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod external_media_open_tests {
    use super::{catalog, external_input, import_external_media_item};
    use crate::db::AppState;

    #[test]
    fn opening_one_file_imports_only_that_file_into_a_non_priority_scope() {
        let directory = tempfile::tempdir().expect("external media directory");
        let selected = directory.path().join("selected.webp");
        let sibling = directory.path().join("sibling.jpg");
        std::fs::write(&selected, b"selected").expect("write selected file");
        std::fs::write(&sibling, b"sibling").expect("write sibling file");
        let input = external_input::parse_external_media_input(selected.as_os_str())
            .expect("parse external media");
        let state = AppState::in_memory().expect("in-memory catalog");

        let imported = import_external_media_item(&state, &input).expect("import external media");

        assert_eq!(imported.file_name, "selected.webp");
        assert_eq!(imported.kind, "image");
        assert_eq!(catalog::list_media_items(&state, None).unwrap().len(), 1);
        let roots = catalog::list_library_roots(&state).expect("list roots");
        assert_eq!(roots.len(), 1);
        assert!(!roots[0].is_priority);
    }

    #[test]
    fn opening_from_an_existing_root_reuses_the_media_id_and_catalog_path() {
        let directory = tempfile::tempdir().expect("external media directory");
        let nested = directory.path().join("books");
        std::fs::create_dir(&nested).expect("create nested directory");
        let selected = nested.join("volume.zip");
        std::fs::write(&selected, b"not opened by this catalog test").expect("write selected file");
        let state = AppState::in_memory().expect("in-memory catalog");
        let root = catalog::add_library_root(&state, directory.path().to_str().unwrap())
            .expect("add priority root");
        let input = external_input::parse_external_media_input(selected.as_os_str())
            .expect("parse external media");

        let first = import_external_media_item(&state, &input).expect("first import");
        let second = import_external_media_item(&state, &input).expect("second import");

        assert_eq!(first.id, second.id);
        assert_eq!(first.root_id, root.id);
        assert_eq!(first.relative_path, "books/volume.zip");
        assert_eq!(first.kind, "zip");
        assert_eq!(catalog::list_media_items(&state, None).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod archive_book_tests {
    use std::{fs, io::Write, path::Path};

    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::{
        archive_book_cache_generation, archive_page_entries, archive_page_entries_from_archive,
        cache_archive_book_pages_with_limits, cache_archive_cover, cached_archive_page_index,
    };

    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).expect("create archive fixture");
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (name, bytes) in entries {
            writer
                .start_file(*name, options)
                .expect("start archive fixture entry");
            writer
                .write_all(bytes)
                .expect("write archive fixture entry");
        }
        writer.finish().expect("finish archive fixture");
    }

    #[test]
    fn archive_pages_are_indexed_in_natural_name_order() {
        let fixture = tempfile::tempdir().expect("archive fixture directory");
        let archive_path = fixture.path().join("book.cbz");
        write_archive(
            &archive_path,
            &[
                ("page10.jpg", b"ten"),
                ("page2.jpg", b"two"),
                ("ignored.txt", b"text"),
                ("page1.jpg", b"one"),
            ],
        );

        let pages = archive_page_entries(&archive_path).expect("index archive pages");
        assert_eq!(
            pages.into_iter().map(|page| page.name).collect::<Vec<_>>(),
            ["page1.jpg", "page2.jpg", "page10.jpg"]
        );
    }

    #[test]
    fn archive_page_index_is_reused_and_content_versioned() {
        let fixture = tempfile::tempdir().expect("archive fixture directory");
        let archive_path = fixture.path().join("book.cbz");
        write_archive(&archive_path, &[("page1.jpg", b"one")]);

        let first = archive_page_entries(&archive_path).expect("build shared page index");
        let cached = cached_archive_page_index(&archive_path).expect("reuse shared page index");
        assert_eq!(cached.len(), first.len());
        assert_eq!(cached[0].name, "page1.jpg");

        write_archive(
            &archive_path,
            &[("page1.jpg", b"one"), ("page2.jpg", b"second-page")],
        );
        assert!(cached_archive_page_index(&archive_path).is_none());
        let refreshed = archive_page_entries(&archive_path).expect("refresh changed page index");
        assert_eq!(refreshed.len(), 2);
    }

    #[test]
    fn cover_generation_changes_when_the_archive_is_replaced() {
        let fixture = tempfile::tempdir().expect("archive fixture directory");
        let archive_path = fixture.path().join("book.cbz");
        write_archive(&archive_path, &[("page1.jpg", b"old-cover")]);
        let first_generation = archive_book_cache_generation("book-id", &archive_path).unwrap();
        let first_directory = fixture.path().join(&first_generation);
        let first = cache_archive_cover(&archive_path, &first_directory)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"old-cover");
        write_archive(
            &archive_path,
            &[("page1.jpg", b"replacement-cover-more-bytes")],
        );
        let second_generation = archive_book_cache_generation("book-id", &archive_path).unwrap();
        assert_ne!(first_generation, second_generation);
        let second = cache_archive_cover(&archive_path, &fixture.path().join(second_generation))
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(second).unwrap(), b"replacement-cover-more-bytes");
        assert!(archive_path.exists());
    }

    #[test]
    fn archive_page_cache_hit_does_not_reopen_the_archive() {
        let fixture = tempfile::tempdir().expect("archive fixture directory");
        let archive_path = fixture.path().join("book.cbz");
        let cache_directory = fixture.path().join("cache");
        write_archive(&archive_path, &[("page1.jpg", b"cached-page")]);

        let first = cache_archive_book_pages_with_limits(
            &archive_path,
            &cache_directory,
            &[0],
            64,
            64,
            10,
            128,
            false,
        )
        .expect("cache archive page");
        let cached_path = first[0].path.as_ref().expect("cached page path");
        assert_eq!(
            fs::read(cached_path).expect("read cached page"),
            b"cached-page"
        );

        fs::write(&archive_path, b"archive is unavailable").expect("invalidate source archive");
        let second = cache_archive_book_pages_with_limits(
            &archive_path,
            &cache_directory,
            &[0],
            64,
            64,
            10,
            128,
            false,
        )
        .expect("reuse cached page without reopening archive");
        assert_eq!(second[0].path.as_ref(), Some(cached_path));
        assert!(second[0].error.is_none());
    }

    #[test]
    fn oversized_or_over_budget_page_does_not_stop_the_batch() {
        let fixture = tempfile::tempdir().expect("archive fixture directory");
        let archive_path = fixture.path().join("book.cbz");
        write_archive(
            &archive_path,
            &[("page1.jpg", b"large"), ("page2.jpg", b"ok")],
        );

        let page_limit_cache = fixture.path().join("page-limit-cache");
        let page_limited = cache_archive_book_pages_with_limits(
            &archive_path,
            &page_limit_cache,
            &[0, 1],
            3,
            10,
            10,
            128,
            false,
        )
        .expect("continue after oversized page");
        assert!(page_limited[0].path.is_none());
        assert!(page_limited[0].error.is_some());
        assert!(
            page_limited[1]
                .path
                .as_ref()
                .is_some_and(|path| Path::new(path).is_file())
        );

        let batch_limit_cache = fixture.path().join("batch-limit-cache");
        let batch_limited = cache_archive_book_pages_with_limits(
            &archive_path,
            &batch_limit_cache,
            &[0, 1],
            10,
            3,
            10,
            128,
            false,
        )
        .expect("continue after over-budget page");
        assert!(batch_limited[0].path.is_none());
        assert!(batch_limited[0].error.is_some());
        assert!(
            batch_limited[1]
                .path
                .as_ref()
                .is_some_and(|path| Path::new(path).is_file())
        );
        assert!(
            fs::read_dir(&batch_limit_cache)
                .expect("inspect cache directory")
                .flatten()
                .all(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        != Some("tmp")
                )
        );
    }

    #[test]
    fn archive_index_enforces_page_count_and_expanded_size_limits() {
        let fixture = tempfile::tempdir().expect("archive fixture directory");
        let archive_path = fixture.path().join("book.cbz");
        write_archive(
            &archive_path,
            &[("page1.jpg", b"large"), ("page2.jpg", b"ok")],
        );

        let source = fs::File::open(&archive_path).expect("open fixture archive");
        let mut archive = zip::ZipArchive::new(source).expect("read fixture archive");
        assert!(archive_page_entries_from_archive(&mut archive, 1, 128).is_err());

        let source = fs::File::open(&archive_path).expect("reopen fixture archive");
        let mut archive = zip::ZipArchive::new(source).expect("reread fixture archive");
        assert!(archive_page_entries_from_archive(&mut archive, 10, 6).is_err());
    }
}

#[cfg(test)]
mod thumbnail_tests {
    use std::fs;

    use super::{
        STARTUP_DIAGNOSTIC_DELAY, STARTUP_DIAGNOSTIC_POLL_INTERVAL,
        STARTUP_DIAGNOSTIC_QUIET_PERIOD, ThumbnailPathIndex, ThumbnailPrecacheCursor,
        ThumbnailPrecachePhase, cleanup_reference_cache_files, copy_temporary_reference,
        decode_image_data_url, decode_jpeg_thumbnail, is_web_reference,
        legacy_media_thumbnail_path, media_thumbnail_path, native_thumbnail_foreground_limit,
        prune_thumbnail_cache, run_catalog_worker, thumbnail_cache_usage,
        validate_reference_cache_key,
    };

    #[test]
    fn catalog_work_runs_off_the_calling_thread_and_preserves_errors() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(run_catalog_worker("test", || {
            Ok(std::thread::current().id())
        }))
        .expect("worker result");
        assert_ne!(caller, worker);
        let error = tauri::async_runtime::block_on(run_catalog_worker::<()>("test", || {
            Err("original catalog failure".to_owned())
        }))
        .unwrap_err();
        assert_eq!(error, "original catalog failure");
    }

    #[test]
    fn index_snapshots_preserve_visible_changes_during_manifest_and_directory_reads() {
        let directory = std::path::Path::new("thumbnail-fixture");
        let mut index = ThumbnailPathIndex {
            directory: Some(directory.to_owned()),
            initializing: true,
            ..ThumbnailPathIndex::default()
        };
        index.added_during_scan.insert("new.jpg".to_owned());
        index.removed_during_scan.insert("deleted.jpg".to_owned());
        index.publish_snapshot(
            directory,
            ["cached.jpg".to_owned(), "deleted.jpg".to_owned()].into(),
            false,
        );
        assert_eq!(
            index.file_names,
            ["cached.jpg".to_owned(), "new.jpg".to_owned()].into()
        );
        assert!(index.initializing);
        assert!(!index.ready);
        assert!(index.added_during_scan.contains("new.jpg"));
        assert!(index.removed_during_scan.contains("deleted.jpg"));

        index.publish_snapshot(
            directory,
            ["cached.jpg".to_owned(), "deleted.jpg".to_owned()].into(),
            true,
        );
        assert_eq!(
            index.file_names,
            ["cached.jpg".to_owned(), "new.jpg".to_owned()].into()
        );
        assert!(index.ready);
        assert!(!index.initializing);
        assert!(index.added_during_scan.is_empty());
        assert!(index.removed_during_scan.is_empty());
    }

    #[test]
    fn outdated_index_worker_cannot_replace_a_different_directory() {
        let directory = std::path::Path::new("current-thumbnails");
        let mut index = ThumbnailPathIndex {
            directory: Some(directory.to_owned()),
            file_names: ["current.jpg".to_owned()].into(),
            initializing: true,
            ..ThumbnailPathIndex::default()
        };
        index.publish_snapshot(
            std::path::Path::new("old-thumbnails"),
            Default::default(),
            true,
        );
        assert_eq!(index.file_names, ["current.jpg".to_owned()].into());
        assert!(!index.ready);
        assert!(index.initializing);
    }

    #[test]
    fn accepts_a_jpeg_data_url_for_thumbnail_cache() {
        let bytes =
            decode_jpeg_thumbnail("data:image/jpeg;base64,/9j/AA==").expect("valid thumbnail data");
        assert_eq!(bytes, vec![0xff, 0xd8, 0xff, 0x00]);
    }

    #[test]
    fn rejects_an_untrusted_thumbnail_format() {
        assert!(decode_jpeg_thumbnail("data:image/png;base64,iVBORw0KGgo=").is_err());
    }

    #[test]
    fn thumbnail_cache_path_is_stable_and_content_versioned() {
        let directory = std::path::Path::new("thumbnail-cache");
        let source = std::path::Path::new("root/item/one.jpg");
        let path = media_thumbnail_path(directory, source, 1_234, 5_678);
        assert_eq!(path.parent(), Some(directory));
        assert!(
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with("-1234-5678.jpg"))
        );
        assert_eq!(path, media_thumbnail_path(directory, source, 1_234, 5_678));
        assert_ne!(path, media_thumbnail_path(directory, source, 1_234, 5_679));
        assert_eq!(
            legacy_media_thumbnail_path(directory, "root:item/one", 1_234),
            directory.join("root_item_one-1234.jpg")
        );
    }

    #[test]
    fn native_thumbnail_foreground_concurrency_is_cpu_bounded() {
        assert!((1..=4).contains(&native_thumbnail_foreground_limit()));
    }

    #[test]
    fn startup_integrity_check_is_deferred_until_foreground_is_quiet() {
        assert!(STARTUP_DIAGNOSTIC_DELAY >= std::time::Duration::from_secs(3));
        assert!(STARTUP_DIAGNOSTIC_QUIET_PERIOD >= std::time::Duration::from_secs(1));
        assert!(STARTUP_DIAGNOSTIC_POLL_INTERVAL > std::time::Duration::ZERO);
        assert!(STARTUP_DIAGNOSTIC_POLL_INTERVAL <= STARTUP_DIAGNOSTIC_QUIET_PERIOD);
    }

    #[test]
    fn thumbnail_cursor_checkpoint_preserves_accumulated_ledger() {
        let cursor = ThumbnailPrecacheCursor {
            generation: "generation".to_owned(),
            phase: ThumbnailPrecachePhase::Video,
            modified_at: Some(123),
            media_id: "media".to_owned(),
            evaluated: 20_000,
            available: 19_000,
            failed: 250,
            deferred_by_capacity: 750,
        };
        let encoded = serde_json::to_string(&cursor).expect("encode cursor checkpoint");
        let decoded = serde_json::from_str::<ThumbnailPrecacheCursor>(&encoded)
            .expect("decode cursor checkpoint");
        assert_eq!(decoded.evaluated, 20_000);
        assert_eq!(decoded.available, 19_000);
        assert_eq!(decoded.failed, 250);
        assert_eq!(decoded.deferred_by_capacity, 750);
        assert_eq!(decoded.phase, ThumbnailPrecachePhase::Video);
    }

    #[test]
    fn accepts_gif_capture_data() {
        let (extension, bytes) = decode_image_data_url("data:image/gif;base64,R0lGODlh")
            .expect("valid GIF capture header");
        assert_eq!(extension, "gif");
        assert_eq!(bytes, b"GIF89a");
    }

    #[test]
    fn web_drawing_references_are_not_treated_as_local_files() {
        assert!(is_web_reference("https://example.com/reference.png"));
        assert!(is_web_reference("HTTP://example.com/reference"));
        assert!(!is_web_reference(r"C:\Pictures\reference.png"));
    }

    #[test]
    fn thumbnail_cache_pruning_keeps_disk_usage_bounded() {
        let directory = tempfile::tempdir().expect("thumbnail cache fixture");
        for index in 0..4 {
            fs::write(directory.path().join(format!("{index}.jpg")), [index; 10])
                .expect("write cached thumbnail");
        }
        fs::write(directory.path().join("ignored.tmp"), [0; 20])
            .expect("write ignored temporary file");

        let usage = prune_thumbnail_cache(directory.path(), 20, 2).expect("prune cache");
        assert!(usage.bytes <= 20);
        assert!(usage.files <= 2);
        assert_eq!(
            thumbnail_cache_usage(directory.path()).expect("cache usage"),
            usage
        );
        assert!(directory.path().join("ignored.tmp").is_file());
    }

    #[test]
    fn temporary_reference_cache_only_removes_managed_files() {
        let directory = tempfile::tempdir().expect("reference cache fixture");
        let source = directory.path().join("source.png");
        image::RgbImage::new(2, 2)
            .save(&source)
            .expect("write reference image");
        let project = directory.path().join("reference-cache").join("project-1");
        let (cached, bytes) = copy_temporary_reference(&source, &project, "reference-1")
            .expect("copy temporary reference");
        assert!(bytes > 0);
        assert!(cached.is_file());
        let outside = directory.path().join("outside.png");
        fs::copy(&source, &outside).expect("write outside file");

        let (removed, missing) =
            cleanup_reference_cache_files(&project, &[cached.to_string_lossy().into_owned()])
                .expect("clean managed cache");
        assert_eq!((removed, missing), (1, 0));
        assert!(outside.is_file());
        assert!(!cached.exists());
    }

    #[test]
    fn reference_cache_rejects_unsafe_identifiers_and_paths() {
        assert!(validate_reference_cache_key("safe-id_1", "id").is_ok());
        assert!(validate_reference_cache_key("../escape", "id").is_err());
        let directory = tempfile::tempdir().expect("reference cache fixture");
        let project = directory.path().join("reference-cache").join("project-1");
        fs::create_dir_all(&project).expect("create project cache");
        let outside = directory.path().join("outside.png");
        fs::write(&outside, b"outside").expect("write outside file");
        assert!(
            cleanup_reference_cache_files(&project, &[outside.to_string_lossy().into_owned()],)
                .is_err()
        );
        assert!(outside.is_file());
    }
}
