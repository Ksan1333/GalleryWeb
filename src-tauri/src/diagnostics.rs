use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    panic,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{DATABASE_SCHEMA_VERSION, catalog, db::AppState};

const DIAGNOSTIC_FORMAT_VERSION: u8 = 1;
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RECENT_LOG_BYTES: usize = 64 * 1024;
const MAX_RECENT_LOG_LINES: usize = 200;
static DIAGNOSTIC_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static LOG_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnostics {
    pub checked_at: i64,
    pub status: String,
    pub quick_check_messages: Vec<String>,
    pub foreign_key_issues: u64,
    pub database_schema_version: u32,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub root_count: u64,
    pub media_count: u64,
    pub missing_media_count: u64,
    pub last_crash_detected: bool,
    pub last_crash_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticExportResult {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshotResult {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticReport {
    format_version: u8,
    generated_at: i64,
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
    privacy: &'static str,
    diagnostics: SystemDiagnostics,
    recent_events: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashMarker {
    recorded_at: i64,
    summary: String,
}

fn diagnostic_directory() -> Option<&'static Path> {
    DIAGNOSTIC_DIRECTORY.get().map(PathBuf::as_path)
}

fn log_path() -> Option<PathBuf> {
    diagnostic_directory().map(|directory| directory.join("pixvault.log"))
}

fn crash_marker_path() -> Option<PathBuf> {
    diagnostic_directory().map(|directory| directory.join("last-crash.json"))
}

fn safe_log_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn rotate_log_if_needed(path: &Path) -> Result<(), String> {
    let Ok(metadata) = path.metadata() else {
        return Ok(());
    };
    if metadata.len() <= MAX_LOG_BYTES {
        return Ok(());
    }
    let previous = path.with_extension("previous.log");
    if previous.is_file() {
        fs::remove_file(&previous)
            .map_err(|error| format!("Failed to replace the previous diagnostic log: {error}"))?;
    }
    fs::rename(path, previous)
        .map_err(|error| format!("Failed to rotate the diagnostic log: {error}"))
}

pub fn initialize(app_local_data_directory: &Path) -> Result<(), String> {
    let directory = app_local_data_directory.join("diagnostics");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create the diagnostic directory: {error}"))?;
    let _ = DIAGNOSTIC_DIRECTORY.set(directory.clone());
    let log = directory.join("pixvault.log");
    rotate_log_if_needed(&log)?;
    let previous_hook = panic::take_hook();
    panic::set_hook(Box::new(move |panic_info| {
        let payload = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| {
                panic_info
                    .payload()
                    .downcast_ref::<String>()
                    .map(String::as_str)
            })
            .unwrap_or("unexpected native panic");
        let location = panic_info
            .location()
            .map(|location| {
                let file_name = Path::new(location.file())
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("native-code");
                format!("{file_name}:{}", location.line())
            })
            .unwrap_or_else(|| "unknown location".to_owned());
        let summary = safe_log_text(&format!("{location}: {payload}"), 700);
        record("panic", &summary);
        if let Some(path) = crash_marker_path() {
            let marker = CrashMarker {
                recorded_at: catalog::now_millis(),
                summary,
            };
            if let Ok(bytes) = serde_json::to_vec_pretty(&marker) {
                let _ = fs::write(path, bytes);
            }
        }
        previous_hook(panic_info);
    }));
    record(
        "startup",
        &format!("PixVault {} started", env!("CARGO_PKG_VERSION")),
    );
    Ok(())
}

pub fn record(event: &str, message: &str) {
    let Some(path) = log_path() else {
        return;
    };
    let event = safe_log_text(event, 40);
    let message = safe_log_text(message, 700);
    if event.is_empty() || message.is_empty() {
        return;
    }
    let Ok(_guard) = LOG_WRITE_LOCK.lock() else {
        return;
    };
    let _ = rotate_log_if_needed(&path);
    let line = format!("{}\t{}\t{}\n", catalog::now_millis(), event, message);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn read_crash_marker() -> Option<CrashMarker> {
    let bytes = fs::read(crash_marker_path()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn database_size(path: &Path) -> u64 {
    path.metadata().map(|metadata| metadata.len()).unwrap_or(0)
}

pub fn inspect(state: &AppState) -> Result<SystemDiagnostics, String> {
    let connection = state.database.lock()?;
    let quick_check_messages = connection
        .prepare("PRAGMA quick_check(100)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| format!("Failed to check catalog integrity: {error}"))?;
    let foreign_key_issues: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Failed to check catalog relationships: {error}"))?;
    let root_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM library_roots", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count library roots: {error}"))?;
    let media_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM media_items", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count catalog media: {error}"))?;
    let missing_media_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM media_items WHERE is_missing = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count missing catalog media: {error}"))?;
    drop(connection);

    let healthy = quick_check_messages.len() == 1
        && quick_check_messages[0].eq_ignore_ascii_case("ok")
        && foreign_key_issues == 0;
    let crash = read_crash_marker();
    let database_path = state.database.path();
    let wal_path = PathBuf::from(format!("{}-wal", database_path.to_string_lossy()));
    Ok(SystemDiagnostics {
        checked_at: catalog::now_millis(),
        status: if healthy { "healthy" } else { "issues" }.to_owned(),
        quick_check_messages,
        foreign_key_issues: foreign_key_issues.max(0) as u64,
        database_schema_version: DATABASE_SCHEMA_VERSION,
        database_bytes: database_size(database_path),
        wal_bytes: database_size(&wal_path),
        root_count: root_count.max(0) as u64,
        media_count: media_count.max(0) as u64,
        missing_media_count: missing_media_count.max(0) as u64,
        last_crash_detected: crash.is_some(),
        last_crash_summary: crash.map(|item| safe_log_text(&item.summary, 300)),
    })
}

pub fn optimize(state: &AppState) -> Result<SystemDiagnostics, String> {
    let before = inspect(state)?;
    if before.status != "healthy" {
        return Err("整合性に問題があるため、自動メンテナンスを実行しませんでした。先に診断レポートを書き出してください。".to_owned());
    }
    let connection = state.database.lock()?;
    connection
        .execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);")
        .map_err(|error| format!("Failed to optimize the catalog: {error}"))?;
    drop(connection);
    record(
        "maintenance",
        "Catalog optimize and passive WAL checkpoint completed",
    );
    inspect(state)
}

fn recent_log_lines() -> Vec<String> {
    let Some(path) = log_path() else {
        return Vec::new();
    };
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    let start = bytes.len().saturating_sub(MAX_RECENT_LOG_BYTES);
    String::from_utf8_lossy(&bytes[start..])
        .lines()
        .rev()
        .take(MAX_RECENT_LOG_LINES)
        .map(|line| safe_log_text(line, 900))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<u64, String> {
    if !path.is_absolute() {
        return Err("保存先は絶対パスで指定してください。".to_owned());
    }
    if path.exists() {
        return Err(
            "既存ファイルは上書きしません。新しいファイル名を選択してください。".to_owned(),
        );
    }
    path.parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| "保存先フォルダーが見つかりません。".to_owned())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("Failed to create the diagnostic file: {error}"))?;
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to write the diagnostic file: {error}"));
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(bytes.len() as u64)
}

pub fn export_report(
    state: &AppState,
    destination: &Path,
) -> Result<DiagnosticExportResult, String> {
    let report = DiagnosticReport {
        format_version: DIAGNOSTIC_FORMAT_VERSION,
        generated_at: catalog::now_millis(),
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        privacy: "Media paths, file names, tags and preference values are excluded.",
        diagnostics: inspect(state)?,
        recent_events: recent_log_lines(),
    };
    let bytes = serde_json::to_vec_pretty(&report)
        .map_err(|error| format!("Failed to serialize the diagnostic report: {error}"))?;
    let written = write_new_file(destination, &bytes)?;
    record("diagnostics", "Privacy-reduced diagnostic report exported");
    Ok(DiagnosticExportResult {
        path: destination.to_string_lossy().into_owned(),
        bytes: written,
    })
}

fn verify_snapshot(path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Failed to reopen the recovery snapshot: {error}"))?;
    let status = connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to verify the recovery snapshot: {error}"))?;
    if !status.eq_ignore_ascii_case("ok") {
        return Err(format!("Recovery snapshot verification failed: {status}"));
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to open the recovery snapshot: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash the recovery snapshot: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:X}", hasher.finalize()))
}

pub fn create_recovery_snapshot(
    state: &AppState,
    destination: &Path,
) -> Result<RecoverySnapshotResult, String> {
    let diagnostics = inspect(state)?;
    if diagnostics.status != "healthy" {
        return Err("整合性に問題があるため、復旧スナップショットを作成しませんでした。診断レポートを書き出してください。".to_owned());
    }
    if !destination.is_absolute() {
        return Err("保存先は絶対パスで指定してください。".to_owned());
    }
    if destination.exists() {
        return Err(
            "既存ファイルは上書きしません。新しいファイル名を選択してください。".to_owned(),
        );
    }
    if destination == state.database.path() {
        return Err("使用中のカタログを保存先には選べません。".to_owned());
    }
    let parent = destination
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| "保存先フォルダーが見つかりません。".to_owned())?;
    let temporary = parent.join(format!(
        ".pixvault-recovery-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let temporary_text = temporary
        .to_str()
        .ok_or_else(|| "保存先パスをSQLiteで扱えません。".to_owned())?;
    let vacuum_result = state
        .database
        .lock()?
        .execute("VACUUM main INTO ?1", [temporary_text])
        .map_err(|error| format!("Failed to create the recovery snapshot: {error}"));
    if let Err(error) = vacuum_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = verify_snapshot(&temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let mut source = fs::File::open(&temporary)
        .map_err(|error| format!("Failed to reopen the recovery snapshot: {error}"))?;
    let mut output = match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
    {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "Failed to reserve the recovery destination: {error}"
            ));
        }
    };
    let copy_result = std::io::copy(&mut source, &mut output)
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("Failed to finalize the recovery snapshot: {error}"));
    let _ = fs::remove_file(&temporary);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    if let Err(error) = verify_snapshot(destination) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    let bytes = database_size(destination);
    let sha256 = file_sha256(destination)?;
    record("recovery", "Verified catalog recovery snapshot created");
    Ok(RecoverySnapshotResult {
        path: destination.to_string_lossy().into_owned(),
        bytes,
        sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_report_excludes_library_paths_and_file_names() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("catalog.sqlite3");
        let state = AppState::open(&database_path).expect("database");
        {
            let connection = state.database.lock().expect("database lock");
            connection
                .execute(
                    "INSERT INTO library_roots(id, path, display_name, enabled, created_at, updated_at)
                     VALUES ('root', 'C:\\Private\\Pictures', 'Secret Album', 1, 1, 1)",
                    [],
                )
                .expect("root");
        }
        let report_path = directory.path().join("diagnostics.json");
        export_report(&state, &report_path).expect("report");
        let report = fs::read_to_string(report_path).expect("report text");
        assert!(!report.contains("Private"));
        assert!(!report.contains("Secret Album"));
        assert!(report.contains("\"rootCount\": 1"));
        let retained = report.clone();
        let report_path = directory.path().join("diagnostics.json");
        assert!(export_report(&state, &report_path).is_err());
        assert_eq!(
            fs::read_to_string(report_path).expect("retained report"),
            retained
        );
    }

    #[test]
    fn recovery_snapshot_is_verified_and_never_overwrites() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = AppState::open(&directory.path().join("catalog.sqlite3")).expect("database");
        let snapshot_path = directory.path().join("recovery.sqlite3");
        let result = create_recovery_snapshot(&state, &snapshot_path).expect("snapshot");
        assert!(result.bytes > 0);
        assert_eq!(result.sha256.len(), 64);
        let original_hash = file_sha256(&snapshot_path).expect("original hash");
        assert!(create_recovery_snapshot(&state, &snapshot_path).is_err());
        assert_eq!(
            file_sha256(&snapshot_path).expect("retained hash"),
            original_hash
        );
    }

    #[test]
    fn healthy_catalog_can_be_optimized_without_changing_counts() {
        let state = AppState::in_memory().expect("database");
        let result = optimize(&state).expect("optimize");
        assert_eq!(result.status, "healthy");
        assert_eq!(result.media_count, 0);
    }
}
