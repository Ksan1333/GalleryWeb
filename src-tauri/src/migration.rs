use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

use crate::{MIGRATION_FORMAT_VERSION, catalog, db::AppState};

const REQUIRED_ENTRIES: [&str; 9] = [
    "manifest.json",
    "settings.json",
    "favorites.json",
    "media.jsonl",
    "tags.jsonl",
    "video-downloads.jsonl",
    "references.jsonl",
    "bookmarks.jsonl",
    "checksums.json",
];
const CHECKSUMMED_ENTRIES: [&str; 8] = [
    "manifest.json",
    "settings.json",
    "favorites.json",
    "media.jsonl",
    "tags.jsonl",
    "video-downloads.jsonl",
    "references.jsonl",
    "bookmarks.jsonl",
];
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 192 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RECORDS_PER_FILE: usize = 1_000_000;
const MAX_ISSUES_IN_PREVIEW: usize = 200;
const TIMESTAMP_TOLERANCE_MILLIS: i64 = 120_000;
const PENDING_ARCHIVE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationIssue {
    pub severity: String,
    pub entity_type: String,
    pub source_identity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationArchivePreview {
    pub token: String,
    pub source_name: String,
    pub source_sha256: String,
    pub android_version: String,
    pub exported_at: String,
    pub total_media: usize,
    pub matched_media: usize,
    pub ambiguous_media: usize,
    pub missing_media: usize,
    pub matched_bookmarks: usize,
    pub unmatched_bookmarks: usize,
    pub tag_records: usize,
    pub bookmark_records: usize,
    pub reference_records: usize,
    pub x_history_records: usize,
    pub settings_namespaces: usize,
    pub issue_count: usize,
    pub already_imported: bool,
    pub issues: Vec<MigrationIssue>,
    pub unresolved_media: Vec<MigrationUnresolvedMedia>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResolutionCandidate {
    pub media_id: String,
    pub file_name: String,
    pub relative_path: String,
    pub file_size: u64,
    pub modified_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationUnresolvedMedia {
    pub source_identity: String,
    pub file_name: String,
    pub relative_path: Option<String>,
    pub file_size: u64,
    pub status: String,
    pub candidates: Vec<MigrationResolutionCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationImportResult {
    pub source_name: String,
    pub source_sha256: String,
    pub already_imported: bool,
    pub imported_media: usize,
    pub imported_favorites: usize,
    pub imported_tags: usize,
    pub imported_bookmarks: usize,
    pub imported_reference_projects: usize,
    pub imported_reference_items: usize,
    pub imported_x_history: usize,
    pub imported_settings_namespaces: usize,
    pub skipped_media: usize,
    pub issue_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBackupResult {
    pub path: String,
    pub preferences: usize,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowsSettingsBackup {
    kind: String,
    format_version: u32,
    app_version: String,
    exported_at_epoch_millis: i64,
    preferences: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
struct PendingArchive {
    path: PathBuf,
    sha256: String,
    created_at: Instant,
}

static PENDING_ARCHIVES: OnceLock<Mutex<HashMap<String, PendingArchive>>> = OnceLock::new();

fn pending_archives() -> &'static Mutex<HashMap<String, PendingArchive>> {
    PENDING_ARCHIVES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    android_app: AndroidApp,
    database_version: u32,
    exported_at: String,
    #[serde(default)]
    exported_at_epoch_millis: i64,
    #[serde(default)]
    device_timezone: String,
    record_counts: BTreeMap<String, usize>,
    hash_algorithm: String,
    #[serde(default)]
    feature_vectors_present: bool,
    #[serde(default)]
    media_hashes_present: bool,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidApp {
    package_name: String,
    version_name: String,
    version_code: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChecksumsDocument {
    format_version: u32,
    hash_algorithm: String,
    files: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct SettingsDocument {
    format_version: u32,
    version: u32,
    settings: BTreeMap<String, BTreeMap<String, Value>>,
    preference_types: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(default)]
struct FavoritesDocument {
    #[serde(rename = "formatVersion")]
    format_version: u32,
    version: u32,
    favorite_artists: BTreeMap<String, Value>,
    favorite_sites: BTreeMap<String, Value>,
    book_favorites: BTreeMap<String, Value>,
    #[serde(rename = "preferenceTypes")]
    preference_types: BTreeMap<String, BTreeMap<String, String>>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidMediaRecord {
    export_id: String,
    #[serde(default)]
    android_uri: String,
    relative_path: Option<String>,
    file_name: String,
    file_size: u64,
    #[serde(default)]
    date_added: i64,
    date_modified: Option<i64>,
    mime_type: Option<String>,
    #[serde(default)]
    duration: i64,
    #[serde(default)]
    width: i64,
    #[serde(default)]
    height: i64,
    sha256: Option<String>,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    age_rating: String,
    #[serde(default)]
    ai_analyzed: bool,
    #[serde(default)]
    ai_model: String,
    feature_vector: Option<Vec<f32>>,
    #[serde(default)]
    deleted: bool,
    deleted_date: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidTagRecord {
    export_id: String,
    tag: String,
    confidence: f32,
    #[serde(default)]
    source: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidVideoDownloadRecord {
    export_id: String,
    source_url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    android_save_path: String,
    media_export_id: Option<String>,
    relative_path: Option<String>,
    file_name: Option<String>,
    file_size: Option<u64>,
    date_modified: Option<i64>,
    mime_type: Option<String>,
    sha256: Option<String>,
    #[serde(default)]
    download_date: i64,
    #[serde(default)]
    status: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "recordType",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AndroidReferenceRecord {
    Project {
        export_id: String,
        title: String,
        status: String,
        created_at: i64,
    },
    Item {
        export_id: String,
        project_export_id: String,
        local_media_export_id: Option<String>,
        android_local_uri: Option<String>,
        #[serde(default)]
        remote_url: String,
        #[serde(default)]
        title: String,
        created_at: Option<i64>,
        #[serde(default)]
        added_at: i64,
    },
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidBookmarkRecord {
    export_id: String,
    #[serde(default)]
    bookmark_id: String,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    value_type: String,
    title: Option<String>,
    page: Option<i64>,
    relative_path: Option<String>,
    file_name: Option<String>,
    file_size: Option<u64>,
    date_modified: Option<i64>,
}

#[derive(Debug)]
struct ParsedArchive {
    manifest: Manifest,
    settings: SettingsDocument,
    favorites: FavoritesDocument,
    media: Vec<AndroidMediaRecord>,
    tags: Vec<AndroidTagRecord>,
    video_downloads: Vec<AndroidVideoDownloadRecord>,
    references: Vec<AndroidReferenceRecord>,
    bookmarks: Vec<AndroidBookmarkRecord>,
    sha256: String,
}

#[derive(Debug, Clone)]
struct CatalogMedia {
    id: String,
    relative_path: String,
    file_name: String,
    file_size: u64,
    modified_at: i64,
    sha256: Option<String>,
    absolute_path: PathBuf,
}

#[derive(Debug, Clone)]
struct PortableMatchRequest {
    source_identity: String,
    relative_path: Option<String>,
    file_name: String,
    file_size: u64,
    date_modified: Option<i64>,
    sha256: Option<String>,
}

#[derive(Debug, Clone)]
enum MatchOutcome {
    Matched(CatalogMedia),
    Ambiguous(Vec<CatalogMedia>),
    Missing,
}

#[derive(Debug)]
struct MatchSet {
    media: HashMap<String, MatchOutcome>,
    bookmarks: HashMap<String, MatchOutcome>,
    issues: Vec<MigrationIssue>,
}

pub fn inspect_android_archive(
    state: &AppState,
    path: &Path,
) -> Result<MigrationArchivePreview, String> {
    let archive = parse_archive(path)?;
    let matches = match_archive(state, &archive)?;
    let source_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("pixvault-migration.zip")
        .to_owned();
    let already_imported = was_imported(state, &archive.sha256)?;
    let token = Uuid::new_v4().to_string();
    {
        let mut pending = pending_archives()
            .lock()
            .map_err(|_| "移行ファイルの確認状態を保存できませんでした。".to_owned())?;
        pending.retain(|_, item| item.created_at.elapsed() < PENDING_ARCHIVE_TTL);
        if pending.len() >= 8 {
            let oldest = pending
                .iter()
                .min_by_key(|(_, item)| item.created_at)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                pending.remove(&oldest);
            }
        }
        pending.insert(
            token.clone(),
            PendingArchive {
                path: path.to_owned(),
                sha256: archive.sha256.clone(),
                created_at: Instant::now(),
            },
        );
    }

    let matched_media = matches
        .media
        .values()
        .filter(|value| matches!(value, MatchOutcome::Matched(_)))
        .count();
    let ambiguous_media = matches
        .media
        .values()
        .filter(|value| matches!(value, MatchOutcome::Ambiguous(_)))
        .count();
    let missing_media = matches
        .media
        .values()
        .filter(|value| matches!(value, MatchOutcome::Missing))
        .count();
    let matched_bookmarks = matches
        .bookmarks
        .values()
        .filter(|value| matches!(value, MatchOutcome::Matched(_)))
        .count();
    let issue_count = matches.issues.len();

    Ok(MigrationArchivePreview {
        token,
        source_name,
        source_sha256: archive.sha256,
        android_version: archive.manifest.android_app.version_name,
        exported_at: archive.manifest.exported_at,
        total_media: archive.media.len(),
        matched_media,
        ambiguous_media,
        missing_media,
        matched_bookmarks,
        unmatched_bookmarks: matches.bookmarks.len().saturating_sub(matched_bookmarks),
        tag_records: archive.tags.len(),
        bookmark_records: archive.bookmarks.len(),
        reference_records: archive.references.len(),
        x_history_records: archive.video_downloads.len(),
        settings_namespaces: archive.settings.settings.len(),
        issue_count,
        already_imported,
        issues: matches
            .issues
            .into_iter()
            .take(MAX_ISSUES_IN_PREVIEW)
            .collect(),
        unresolved_media: archive
            .media
            .iter()
            .filter_map(|record| {
                let outcome = matches.media.get(&record.export_id)?;
                let (status, candidates) = match outcome {
                    MatchOutcome::Matched(_) => return None,
                    MatchOutcome::Missing => ("missing", Vec::new()),
                    MatchOutcome::Ambiguous(candidates) => (
                        "ambiguous",
                        candidates
                            .iter()
                            .take(24)
                            .map(|candidate| MigrationResolutionCandidate {
                                media_id: candidate.id.clone(),
                                file_name: candidate.file_name.clone(),
                                relative_path: candidate.relative_path.clone(),
                                file_size: candidate.file_size,
                                modified_at: candidate.modified_at,
                            })
                            .collect(),
                    ),
                };
                Some(MigrationUnresolvedMedia {
                    source_identity: record.export_id.clone(),
                    file_name: record.file_name.clone(),
                    relative_path: record.relative_path.clone(),
                    file_size: record.file_size,
                    status: status.to_owned(),
                    candidates,
                })
            })
            .take(MAX_ISSUES_IN_PREVIEW)
            .collect(),
    })
}

pub fn commit_android_archive(
    state: &AppState,
    token: &str,
    resolutions: &HashMap<String, String>,
) -> Result<MigrationImportResult, String> {
    let pending = {
        let mut pending = pending_archives()
            .lock()
            .map_err(|_| "移行ファイルの確認状態を取得できませんでした。".to_owned())?;
        pending.retain(|_, item| item.created_at.elapsed() < PENDING_ARCHIVE_TTL);
        pending.get(token).cloned().ok_or_else(|| {
            "移行の確認期限が切れました。ファイルをもう一度選択してください。".to_owned()
        })?
    };
    let archive = parse_archive(&pending.path)?;
    if archive.sha256 != pending.sha256 {
        return Err("確認後に移行ファイルが変更されました。もう一度選択してください。".to_owned());
    }
    let mut matches = match_archive(state, &archive)?;
    apply_manual_resolutions(state, &archive, &mut matches, resolutions)?;
    let source_name = pending
        .path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("pixvault-migration.zip")
        .to_owned();
    let result = apply_archive(state, &archive, &matches, &source_name)?;
    if let Ok(mut entries) = pending_archives().lock() {
        entries.remove(token);
    }
    Ok(result)
}

pub fn write_settings_backup(
    state: &AppState,
    path: &Path,
    app_version: &str,
) -> Result<SettingsBackupResult, String> {
    let entries = catalog::get_preferences(state)?;
    let preferences = entries
        .into_iter()
        .map(|entry| (entry.key, entry.value))
        .collect::<BTreeMap<_, _>>();
    let document = WindowsSettingsBackup {
        kind: "pixvault-windows-settings".to_owned(),
        format_version: 1,
        app_version: app_version.to_owned(),
        exported_at_epoch_millis: catalog::now_millis(),
        preferences,
    };
    let mut bytes = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("設定バックアップを作成できませんでした: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("設定バックアップがサイズ上限を超えています。".to_owned());
    }
    fs::write(path, bytes)
        .map_err(|error| format!("設定バックアップを保存できませんでした: {error}"))?;
    Ok(SettingsBackupResult {
        path: path.to_string_lossy().into_owned(),
        preferences: document.preferences.len(),
    })
}

pub fn import_settings_backup(
    state: &AppState,
    path: &Path,
) -> Result<SettingsBackupResult, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("設定バックアップを読み込めませんでした: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 16 * 1024 * 1024 {
        return Err("設定バックアップのサイズまたは形式が正しくありません。".to_owned());
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("設定バックアップを読み込めませんでした: {error}"))?;
    let document: WindowsSettingsBackup = parse_json(&bytes, "設定バックアップ")?;
    if document.kind != "pixvault-windows-settings" || document.format_version != 1 {
        return Err("この設定バックアップ形式には対応していません。".to_owned());
    }
    if document.preferences.len() > 10_000 {
        return Err("設定バックアップの項目数が上限を超えています。".to_owned());
    }
    for key in document.preferences.keys() {
        catalog::validate_preference_key(key)?;
    }

    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("設定復元を開始できませんでした: {error}"))?;
    let now = catalog::now_millis();
    for (key, value) in &document.preferences {
        upsert_preference(&transaction, key, value, now)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("設定を復元できませんでした。変更は取り消されました: {error}"))?;
    Ok(SettingsBackupResult {
        path: path.to_string_lossy().into_owned(),
        preferences: document.preferences.len(),
    })
}

fn parse_archive(path: &Path) -> Result<ParsedArchive, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("移行ファイルを読み込めませんでした: {error}"))?;
    if !metadata.is_file() {
        return Err("選択した移行元はファイルではありません。".to_owned());
    }
    if metadata.len() == 0 || metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("移行ZIPのサイズが許容範囲外です。".to_owned());
    }
    let source_sha256 = sha256_file(path)?;
    let file = File::open(path).map_err(|error| format!("移行ZIPを開けませんでした: {error}"))?;
    let mut zip = ZipArchive::new(file)
        .map_err(|error| format!("正しいZIPファイルではありません: {error}"))?;
    validate_entry_list(&mut zip)?;

    let mut entry_bytes = BTreeMap::new();
    let mut total_uncompressed = 0_u64;
    for name in REQUIRED_ENTRIES {
        let bytes = read_entry(&mut zip, name)?;
        total_uncompressed = total_uncompressed.saturating_add(bytes.len() as u64);
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err("移行ZIPの展開後サイズが上限を超えています。".to_owned());
        }
        entry_bytes.insert(name, bytes);
    }

    let checksums: ChecksumsDocument = parse_json(
        entry_bytes.get("checksums.json").expect("required entry"),
        "checksums.json",
    )?;
    if checksums.format_version != MIGRATION_FORMAT_VERSION
        || !checksums.hash_algorithm.eq_ignore_ascii_case("SHA-256")
    {
        return Err("移行ZIPのチェックサム形式に対応していません。".to_owned());
    }
    let expected_names = CHECKSUMMED_ENTRIES.into_iter().collect::<HashSet<_>>();
    let actual_names = checksums
        .files
        .keys()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if expected_names != actual_names {
        return Err("checksums.json の対象ファイル一覧が正しくありません。".to_owned());
    }
    for name in CHECKSUMMED_ENTRIES {
        let expected = checksums
            .files
            .get(name)
            .ok_or_else(|| format!("{name} のチェックサムがありません。"))?;
        validate_sha256(expected)?;
        let actual = sha256_bytes(entry_bytes.get(name).expect("required entry"));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "{name} のSHA-256が一致しません。ファイルが破損しています。"
            ));
        }
    }

    let manifest: Manifest = parse_json(
        entry_bytes.get("manifest.json").expect("required entry"),
        "manifest.json",
    )?;
    if manifest.format_version != MIGRATION_FORMAT_VERSION {
        return Err(format!(
            "移行形式 v{} には対応していません（対応: v{}）。",
            manifest.format_version, MIGRATION_FORMAT_VERSION
        ));
    }
    if !manifest.hash_algorithm.eq_ignore_ascii_case("SHA-256") {
        return Err("manifest.json のハッシュ方式に対応していません。".to_owned());
    }
    if manifest.android_app.package_name.trim().is_empty()
        || manifest.android_app.version_name.trim().is_empty()
        || manifest.exported_at.trim().is_empty()
    {
        return Err("manifest.json のAndroidアプリ情報が不足しています。".to_owned());
    }

    let settings: SettingsDocument = parse_json(
        entry_bytes.get("settings.json").expect("required entry"),
        "settings.json",
    )?;
    let favorites: FavoritesDocument = parse_json(
        entry_bytes.get("favorites.json").expect("required entry"),
        "favorites.json",
    )?;
    if settings.format_version != MIGRATION_FORMAT_VERSION
        || favorites.format_version != MIGRATION_FORMAT_VERSION
    {
        return Err("設定またはお気に入りの移行形式が一致しません。".to_owned());
    }

    let media = parse_json_lines::<AndroidMediaRecord>(
        entry_bytes.get("media.jsonl").expect("required entry"),
        "media.jsonl",
    )?;
    let tags = parse_json_lines::<AndroidTagRecord>(
        entry_bytes.get("tags.jsonl").expect("required entry"),
        "tags.jsonl",
    )?;
    let video_downloads = parse_json_lines::<AndroidVideoDownloadRecord>(
        entry_bytes
            .get("video-downloads.jsonl")
            .expect("required entry"),
        "video-downloads.jsonl",
    )?;
    let references = parse_json_lines::<AndroidReferenceRecord>(
        entry_bytes.get("references.jsonl").expect("required entry"),
        "references.jsonl",
    )?;
    let bookmarks = parse_json_lines::<AndroidBookmarkRecord>(
        entry_bytes.get("bookmarks.jsonl").expect("required entry"),
        "bookmarks.jsonl",
    )?;

    validate_count(&manifest, "media", media.len())?;
    validate_count(&manifest, "tags", tags.len())?;
    validate_count(&manifest, "videoDownloads", video_downloads.len())?;
    validate_count(&manifest, "references", references.len())?;
    validate_count(&manifest, "bookmarks", bookmarks.len())?;
    validate_records(&media, &tags, &references, &bookmarks)?;

    Ok(ParsedArchive {
        manifest,
        settings,
        favorites,
        media,
        tags,
        video_downloads,
        references,
        bookmarks,
        sha256: source_sha256,
    })
}

fn validate_entry_list<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<(), String> {
    if zip.len() != REQUIRED_ENTRIES.len() {
        return Err("移行ZIPのファイル構成が正しくありません。".to_owned());
    }
    let required = REQUIRED_ENTRIES.into_iter().collect::<HashSet<_>>();
    let mut found = HashSet::new();
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|error| format!("ZIPエントリーを確認できませんでした: {error}"))?;
        let name = entry.name().to_owned();
        if !required.contains(name.as_str()) || !found.insert(name.clone()) {
            return Err(format!(
                "移行ZIPに未許可または重複したファイルがあります: {name}"
            ));
        }
        if entry.is_dir() || entry.size() > MAX_ENTRY_BYTES {
            return Err(format!(
                "移行ZIP内の {name} は読み込めない形式またはサイズです。"
            ));
        }
    }
    if found.len() != required.len() {
        return Err("移行ZIPに必要なファイルがありません。".to_owned());
    }
    Ok(())
}

fn read_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, name: &str) -> Result<Vec<u8>, String> {
    let mut entry = zip
        .by_name(name)
        .map_err(|error| format!("{name} を読み込めませんでした: {error}"))?;
    if entry.size() > MAX_ENTRY_BYTES {
        return Err(format!("{name} がサイズ上限を超えています。"));
    }
    let mut bytes = Vec::with_capacity(entry.size().min(16 * 1024 * 1024) as usize);
    entry
        .by_ref()
        .take(MAX_ENTRY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{name} の展開に失敗しました: {error}"))?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES {
        return Err(format!("{name} の展開後サイズが上限を超えています。"));
    }
    Ok(bytes)
}

fn parse_json<T: for<'de> Deserialize<'de>>(bytes: &[u8], name: &str) -> Result<T, String> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    serde_json::from_slice(bytes)
        .map_err(|error| format!("{name} のJSONが正しくありません: {error}"))
}

fn parse_json_lines<T: for<'de> Deserialize<'de>>(
    bytes: &[u8],
    name: &str,
) -> Result<Vec<T>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("{name} はUTF-8ではありません: {error}"))?;
    let mut records = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        if records.len() >= MAX_RECORDS_PER_FILE {
            return Err(format!("{name} のレコード数が上限を超えています。"));
        }
        records.push(
            serde_json::from_str(line).map_err(|error| {
                format!("{name} の{}行目が正しくありません: {error}", index + 1)
            })?,
        );
    }
    Ok(records)
}

fn validate_count(manifest: &Manifest, key: &str, actual: usize) -> Result<(), String> {
    let expected = manifest
        .record_counts
        .get(key)
        .ok_or_else(|| format!("manifest.json に {key} の件数がありません。"))?;
    if *expected != actual {
        return Err(format!(
            "{key} の件数が一致しません（manifest: {expected} / 実際: {actual}）。"
        ));
    }
    Ok(())
}

fn validate_records(
    media: &[AndroidMediaRecord],
    tags: &[AndroidTagRecord],
    references: &[AndroidReferenceRecord],
    bookmarks: &[AndroidBookmarkRecord],
) -> Result<(), String> {
    let mut media_ids = HashSet::new();
    for record in media {
        if record.export_id.trim().is_empty()
            || record.file_name.trim().is_empty()
            || !media_ids.insert(record.export_id.as_str())
        {
            return Err("media.jsonl に空欄または重複した識別子があります。".to_owned());
        }
        if let Some(hash) = &record.sha256 {
            validate_sha256(hash)?;
        }
        if let Some(vector) = &record.feature_vector {
            if vector.is_empty()
                || vector.len() > 4096
                || vector.iter().any(|value| !value.is_finite())
            {
                return Err(format!(
                    "{} の特徴ベクトルが正しくありません。",
                    record.export_id
                ));
            }
        }
    }
    for tag in tags {
        if !media_ids.contains(tag.export_id.as_str())
            || tag.tag.trim().is_empty()
            || !tag.confidence.is_finite()
            || !(0.0..=1.0).contains(&tag.confidence)
        {
            return Err("tags.jsonl に参照不明または不正なタグがあります。".to_owned());
        }
    }
    let project_ids = references
        .iter()
        .filter_map(|record| match record {
            AndroidReferenceRecord::Project { export_id, .. } => Some(export_id.as_str()),
            AndroidReferenceRecord::Item { .. } => None,
        })
        .collect::<HashSet<_>>();
    for record in references {
        if let AndroidReferenceRecord::Item {
            project_export_id,
            local_media_export_id,
            ..
        } = record
        {
            if !project_ids.contains(project_export_id.as_str())
                || local_media_export_id
                    .as_ref()
                    .is_some_and(|id| !media_ids.contains(id.as_str()))
            {
                return Err(
                    "references.jsonl に参照不明のプロジェクトまたはメディアがあります。"
                        .to_owned(),
                );
            }
        }
    }
    let mut bookmark_ids = HashSet::new();
    for bookmark in bookmarks {
        if bookmark.export_id.trim().is_empty() || !bookmark_ids.insert(bookmark.export_id.as_str())
        {
            return Err("bookmarks.jsonl に空欄または重複した識別子があります。".to_owned());
        }
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("SHA-256値の形式が正しくありません。".to_owned())
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("ファイルのSHA-256を計算できませんでした: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("ファイルのSHA-256を計算できませんでした: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn load_catalog_media(state: &AppState) -> Result<Vec<CatalogMedia>, String> {
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(
            "SELECT m.id, r.path, m.relative_path, m.file_name, m.byte_size,
                    m.modified_at, mm.sha256
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             LEFT JOIN media_metadata mm ON mm.media_id = m.id
             WHERE m.is_missing = 0 AND r.enabled = 1",
        )
        .map_err(|error| format!("移行用のメディア一覧を準備できませんでした: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let root_path: String = row.get(1)?;
            let relative_path: String = row.get(2)?;
            Ok(CatalogMedia {
                id: row.get(0)?,
                absolute_path: PathBuf::from(root_path).join(&relative_path),
                relative_path,
                file_name: row.get(3)?,
                file_size: row.get::<_, i64>(4)?.max(0) as u64,
                modified_at: row.get(5)?,
                sha256: row.get(6)?,
            })
        })
        .map_err(|error| format!("移行用のメディア一覧を取得できませんでした: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("移行用のメディア一覧を読み込めませんでした: {error}"))
}

fn match_archive(state: &AppState, archive: &ParsedArchive) -> Result<MatchSet, String> {
    let catalog = load_catalog_media(state)?;
    let mut issues = Vec::new();
    let mut media_matches = HashMap::new();
    for media in &archive.media {
        let request = PortableMatchRequest {
            source_identity: media.export_id.clone(),
            relative_path: media.relative_path.clone(),
            file_name: media.file_name.clone(),
            file_size: media.file_size,
            date_modified: media.date_modified,
            sha256: media.sha256.clone(),
        };
        let outcome = match_portable(&catalog, &request)?;
        push_match_issue(&mut issues, "media", &request, &outcome);
        media_matches.insert(media.export_id.clone(), outcome);
    }

    let mut bookmark_matches = HashMap::new();
    for bookmark in &archive.bookmarks {
        let Some(file_name) = bookmark
            .file_name
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        else {
            issues.push(MigrationIssue {
                severity: "warning".to_owned(),
                entity_type: "bookmark".to_owned(),
                source_identity: bookmark.export_id.clone(),
                message: "しおりに照合用のファイル名がないためスキップします。".to_owned(),
            });
            bookmark_matches.insert(bookmark.export_id.clone(), MatchOutcome::Missing);
            continue;
        };
        let request = PortableMatchRequest {
            source_identity: bookmark.export_id.clone(),
            relative_path: bookmark.relative_path.clone(),
            file_name: file_name.clone(),
            file_size: bookmark.file_size.unwrap_or_default(),
            date_modified: bookmark.date_modified,
            sha256: None,
        };
        let outcome = match_portable(&catalog, &request)?;
        push_match_issue(&mut issues, "bookmark", &request, &outcome);
        bookmark_matches.insert(bookmark.export_id.clone(), outcome);
    }
    Ok(MatchSet {
        media: media_matches,
        bookmarks: bookmark_matches,
        issues,
    })
}

fn match_portable(
    catalog: &[CatalogMedia],
    request: &PortableMatchRequest,
) -> Result<MatchOutcome, String> {
    let same_size = catalog
        .iter()
        .filter(|item| item.file_size == request.file_size)
        .collect::<Vec<_>>();
    let same_name_and_size = catalog
        .iter()
        .filter(|item| {
            item.file_size == request.file_size
                && item
                    .file_name
                    .eq_ignore_ascii_case(request.file_name.trim())
        })
        .collect::<Vec<_>>();
    if same_name_and_size.is_empty() {
        if let Some(expected_hash) = request.sha256.as_deref() {
            return match_hash_candidates(&same_size, expected_hash);
        }
        return Ok(MatchOutcome::Missing);
    }

    let mut remaining = same_name_and_size.clone();
    if let Some(relative_path) = request.relative_path.as_deref() {
        let path_matches = same_name_and_size
            .iter()
            .copied()
            .filter(|item| portable_path_matches(relative_path, &item.relative_path))
            .collect::<Vec<_>>();
        if path_matches.len() == 1 {
            return Ok(MatchOutcome::Matched(path_matches[0].clone()));
        }
        if !path_matches.is_empty() {
            remaining = path_matches;
        }
    }

    if let Some(modified) = request.date_modified.filter(|value| *value > 0) {
        let time_matches = remaining
            .iter()
            .copied()
            .filter(|item| item.modified_at.abs_diff(modified) <= TIMESTAMP_TOLERANCE_MILLIS as u64)
            .collect::<Vec<_>>();
        if time_matches.len() == 1 {
            return Ok(MatchOutcome::Matched(time_matches[0].clone()));
        }
        if !time_matches.is_empty() {
            remaining = time_matches;
        }
    }

    if let Some(expected_hash) = request.sha256.as_deref() {
        let outcome = match_hash_candidates(&remaining, expected_hash)?;
        if !matches!(outcome, MatchOutcome::Missing) {
            return Ok(outcome);
        }
    }

    Ok(MatchOutcome::Ambiguous(
        remaining.into_iter().cloned().collect(),
    ))
}

fn match_hash_candidates(
    candidates: &[&CatalogMedia],
    expected_hash: &str,
) -> Result<MatchOutcome, String> {
    let cached_matches = candidates
        .iter()
        .copied()
        .filter(|item| {
            item.sha256
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case(expected_hash))
        })
        .collect::<Vec<_>>();
    if cached_matches.len() == 1 {
        return Ok(MatchOutcome::Matched(cached_matches[0].clone()));
    }
    if cached_matches.len() > 1 {
        return Ok(MatchOutcome::Ambiguous(
            cached_matches.into_iter().cloned().collect(),
        ));
    }
    if candidates.len() > 64 {
        return Ok(MatchOutcome::Ambiguous(
            candidates.iter().map(|item| (*item).clone()).collect(),
        ));
    }
    let mut matches = Vec::new();
    for item in candidates {
        if item.sha256.is_some() {
            continue;
        }
        if sha256_file(&item.absolute_path)
            .is_ok_and(|actual| actual.eq_ignore_ascii_case(expected_hash))
        {
            matches.push(*item);
        }
    }
    match matches.len() {
        0 => Ok(MatchOutcome::Missing),
        1 => Ok(MatchOutcome::Matched(matches[0].clone())),
        _ => Ok(MatchOutcome::Ambiguous(
            matches.into_iter().cloned().collect(),
        )),
    }
}

fn normalize_portable_path(value: &str) -> String {
    let mut segments = Vec::new();
    for segment in value.replace('\\', "/").split('/') {
        match segment.trim() {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            value if value.ends_with(':') && segments.is_empty() => {}
            value => segments.push(value.to_lowercase()),
        }
    }
    segments.join("/")
}

fn portable_path_matches(android_path: &str, windows_relative_path: &str) -> bool {
    let android = normalize_portable_path(android_path);
    let windows = normalize_portable_path(windows_relative_path);
    android == windows
        || android.ends_with(&format!("/{windows}"))
        || windows.ends_with(&format!("/{android}"))
}

fn push_match_issue(
    issues: &mut Vec<MigrationIssue>,
    entity_type: &str,
    request: &PortableMatchRequest,
    outcome: &MatchOutcome,
) {
    let message = match outcome {
        MatchOutcome::Matched(_) => return,
        MatchOutcome::Ambiguous(candidates) => format!(
            "{} は候補が {} 件あるため自動照合しません。",
            request.file_name,
            candidates.len()
        ),
        MatchOutcome::Missing => format!(
            "{} に一致する登録済みファイルが見つかりません。",
            request.file_name
        ),
    };
    issues.push(MigrationIssue {
        severity: "warning".to_owned(),
        entity_type: entity_type.to_owned(),
        source_identity: request.source_identity.clone(),
        message,
    });
}

fn apply_manual_resolutions(
    state: &AppState,
    archive: &ParsedArchive,
    matches: &mut MatchSet,
    resolutions: &HashMap<String, String>,
) -> Result<(), String> {
    if resolutions.is_empty() {
        return Ok(());
    }
    let source_ids = archive
        .media
        .iter()
        .map(|record| record.export_id.as_str())
        .collect::<HashSet<_>>();
    let catalog = load_catalog_media(state)?;
    let catalog_by_id = catalog
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<HashMap<_, _>>();
    let mut assigned_targets = matches
        .media
        .iter()
        .filter_map(|(source_id, outcome)| match outcome {
            MatchOutcome::Matched(item) => Some((item.id.clone(), source_id.clone())),
            _ => None,
        })
        .collect::<HashMap<_, _>>();

    for (source_id, media_id) in resolutions {
        if !source_ids.contains(source_id.as_str()) {
            return Err(format!("移行元の項目が見つかりません: {source_id}"));
        }
        if matches
            .media
            .get(source_id)
            .is_some_and(|outcome| matches!(outcome, MatchOutcome::Matched(_)))
        {
            return Err("自動照合済みの項目は手動で上書きできません。".to_owned());
        }
        let target = catalog_by_id
            .get(media_id)
            .cloned()
            .ok_or_else(|| format!("割り当て先のメディアが見つかりません: {media_id}"))?;
        if let Some(existing_source) = assigned_targets.get(media_id) {
            return Err(format!(
                "同じメディアを複数の移行項目へ割り当てることはできません（{existing_source}）。"
            ));
        }
        assigned_targets.insert(media_id.clone(), source_id.clone());
        matches
            .media
            .insert(source_id.clone(), MatchOutcome::Matched(target));
    }
    matches.issues.retain(|issue| {
        issue.entity_type != "media" || !resolutions.contains_key(&issue.source_identity)
    });
    Ok(())
}

fn was_imported(state: &AppState, sha256: &str) -> Result<bool, String> {
    state
        .database
        .lock()?
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM migration_runs
                WHERE source_sha256 = ?1 AND dry_run = 0 AND status = 'completed'
             )",
            [sha256],
            |row| row.get(0),
        )
        .map_err(|error| format!("移行履歴を確認できませんでした: {error}"))
}

fn apply_archive(
    state: &AppState,
    archive: &ParsedArchive,
    matches: &MatchSet,
    source_name: &str,
) -> Result<MigrationImportResult, String> {
    if was_imported(state, &archive.sha256)? {
        return Ok(MigrationImportResult {
            source_name: source_name.to_owned(),
            source_sha256: archive.sha256.clone(),
            already_imported: true,
            imported_media: 0,
            imported_favorites: 0,
            imported_tags: 0,
            imported_bookmarks: 0,
            imported_reference_projects: 0,
            imported_reference_items: 0,
            imported_x_history: 0,
            imported_settings_namespaces: 0,
            skipped_media: archive.media.len(),
            issue_count: matches.issues.len(),
        });
    }

    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("移行トランザクションを開始できませんでした: {error}"))?;
    let now = catalog::now_millis();
    let run_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO migration_runs(
                id, format_version, source_name, source_sha256, dry_run, status,
                summary_json, started_at, completed_at
             ) VALUES (?1, ?2, ?3, ?4, 0, 'running', NULL, ?5, NULL)",
            params![
                run_id,
                archive.manifest.format_version,
                source_name,
                archive.sha256,
                now
            ],
        )
        .map_err(|error| format!("移行履歴を開始できませんでした: {error}"))?;

    let mut imported_media = 0;
    let mut imported_favorites = 0;
    let mut imported_tags = 0;
    for media in &archive.media {
        if media.deleted {
            continue;
        }
        let Some(MatchOutcome::Matched(target)) = matches.media.get(&media.export_id) else {
            continue;
        };
        if media.favorite {
            imported_favorites += transaction
                .execute(
                    "UPDATE media_items SET is_favorite = 1, updated_at = ?2 WHERE id = ?1",
                    params![target.id, now],
                )
                .map_err(|error| format!("お気に入りを移行できませんでした: {error}"))?;
        }
        let rating = normalize_age_rating(&media.age_rating);
        transaction
            .execute(
                "INSERT INTO media_metadata(
                    media_id, width, height, duration_ms, sha256, age_rating,
                    android_identity, updated_at, age_rating_source,
                    is_ai_analyzed, ai_analysis_model, ai_analyzed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(media_id) DO UPDATE SET
                    width = CASE WHEN excluded.width > 0 THEN excluded.width ELSE media_metadata.width END,
                    height = CASE WHEN excluded.height > 0 THEN excluded.height ELSE media_metadata.height END,
                    duration_ms = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE media_metadata.duration_ms END,
                    sha256 = COALESCE(excluded.sha256, media_metadata.sha256),
                    age_rating = COALESCE(excluded.age_rating, media_metadata.age_rating),
                    age_rating_source = CASE WHEN excluded.age_rating IS NULL THEN media_metadata.age_rating_source ELSE excluded.age_rating_source END,
                    android_identity = excluded.android_identity,
                    is_ai_analyzed = MAX(media_metadata.is_ai_analyzed, excluded.is_ai_analyzed),
                    ai_analysis_model = COALESCE(NULLIF(excluded.ai_analysis_model, ''), media_metadata.ai_analysis_model),
                    ai_analyzed_at = COALESCE(excluded.ai_analyzed_at, media_metadata.ai_analyzed_at),
                    updated_at = excluded.updated_at",
                params![
                    target.id,
                    media.width.max(0),
                    media.height.max(0),
                    media.duration.max(0),
                    media.sha256,
                    rating,
                    media.android_uri,
                    now,
                    if rating.is_some() { "user" } else { "default" },
                    media.ai_analyzed,
                    media.ai_model,
                    media.ai_analyzed.then_some(now),
                ],
            )
            .map_err(|error| format!("メディア情報を移行できませんでした: {error}"))?;
        if let Some(vector) = &media.feature_vector {
            let blob = encode_vector(vector);
            transaction
                .execute(
                    "INSERT INTO media_visual_vectors(
                        media_id, model_version, source_modified_at, source_byte_size,
                        dimensions, vector_blob, error_message, updated_at
                     ) VALUES (?1, 0, ?2, ?3, ?4, ?5, NULL, ?6)
                     ON CONFLICT(media_id) DO UPDATE SET
                        model_version = excluded.model_version,
                        source_modified_at = excluded.source_modified_at,
                        source_byte_size = excluded.source_byte_size,
                        dimensions = excluded.dimensions,
                        vector_blob = excluded.vector_blob,
                        error_message = NULL,
                        updated_at = excluded.updated_at",
                    params![
                        target.id,
                        target.modified_at,
                        target.file_size as i64,
                        vector.len() as i64,
                        blob,
                        now
                    ],
                )
                .map_err(|error| format!("特徴ベクトルを移行できませんでした: {error}"))?;
        }
        imported_media += 1;
    }

    for (bookmark_id, value) in &archive.favorites.book_favorites {
        if !value.as_bool().unwrap_or(false) {
            continue;
        }
        let Some(bookmark) = archive
            .bookmarks
            .iter()
            .find(|bookmark| bookmark.bookmark_id == *bookmark_id)
        else {
            continue;
        };
        let Some(MatchOutcome::Matched(target)) = matches.bookmarks.get(&bookmark.export_id) else {
            continue;
        };
        imported_favorites += transaction
            .execute(
                "UPDATE media_items SET is_favorite = 1, updated_at = ?2 WHERE id = ?1",
                params![target.id, now],
            )
            .map_err(|error| format!("本のお気に入りを移行できませんでした: {error}"))?;
    }

    for tag in &archive.tags {
        let Some(MatchOutcome::Matched(target)) = matches.media.get(&tag.export_id) else {
            continue;
        };
        let name = tag.tag.trim();
        let tag_id = tag_id_for_name(&transaction, name, now)?;
        imported_tags += transaction
            .execute(
                "INSERT INTO media_tags(media_id, tag_id, source, confidence, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(media_id, tag_id) DO UPDATE SET
                    confidence = MAX(COALESCE(media_tags.confidence, 0), COALESCE(excluded.confidence, 0)),
                    source = CASE WHEN media_tags.source = 'user' THEN media_tags.source ELSE excluded.source END",
                params![
                    target.id,
                    tag_id,
                    if tag.source.eq_ignore_ascii_case("ai") { "ai" } else { "migration" },
                    tag.confidence,
                    now
                ],
            )
            .map_err(|error| format!("タグを移行できませんでした: {error}"))?;
    }

    let imported_bookmarks = import_bookmarks(&transaction, archive, matches, now)?;
    let (imported_reference_projects, imported_reference_items) =
        import_references(&transaction, archive, matches, now)?;
    let imported_x_history = import_x_history(&transaction, archive, matches, now)?;
    import_android_preferences(&transaction, archive, now)?;

    for issue in &matches.issues {
        transaction
            .execute(
                "INSERT INTO migration_issues(
                    run_id, severity, entity_type, source_identity, message
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    run_id,
                    issue.severity,
                    issue.entity_type,
                    issue.source_identity,
                    issue.message
                ],
            )
            .map_err(|error| format!("移行問題を記録できませんでした: {error}"))?;
    }
    let result = MigrationImportResult {
        source_name: source_name.to_owned(),
        source_sha256: archive.sha256.clone(),
        already_imported: false,
        imported_media,
        imported_favorites,
        imported_tags,
        imported_bookmarks,
        imported_reference_projects,
        imported_reference_items,
        imported_x_history,
        imported_settings_namespaces: archive.settings.settings.len(),
        skipped_media: archive.media.len().saturating_sub(imported_media),
        issue_count: matches.issues.len(),
    };
    let summary_json = serde_json::to_string(&result)
        .map_err(|error| format!("移行結果を記録できませんでした: {error}"))?;
    transaction
        .execute(
            "UPDATE migration_runs
             SET status = 'completed', summary_json = ?2, completed_at = ?3
             WHERE id = ?1",
            params![run_id, summary_json, now],
        )
        .map_err(|error| format!("移行履歴を完了できませんでした: {error}"))?;
    transaction.commit().map_err(|error| {
        format!("移行内容を保存できませんでした。変更は取り消されました: {error}")
    })?;
    Ok(result)
}

fn normalize_age_rating(value: &str) -> Option<String> {
    match value.trim().to_ascii_uppercase().replace('-', "").as_str() {
        "SFW" | "SAFE" | "GENERAL" => Some("SFW".to_owned()),
        "R15" => Some("R15".to_owned()),
        "R18" => Some("R18".to_owned()),
        _ => None,
    }
}

fn encode_vector(values: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(values));
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn stable_id(namespace: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("pixvault:{namespace}:{value}").as_bytes());
    format!("android-{}", &format!("{digest:x}")[..32])
}

fn tag_id_for_name(transaction: &Transaction<'_>, name: &str, now: i64) -> Result<String, String> {
    if let Some(existing) = transaction
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("既存タグを確認できませんでした: {error}"))?
    {
        return Ok(existing);
    }
    let id = stable_id("tag", &name.to_lowercase());
    transaction
        .execute(
            "INSERT INTO tags(id, name, color, created_at, updated_at)
             VALUES (?1, ?2, NULL, ?3, ?3)",
            params![id, name, now],
        )
        .map_err(|error| format!("タグ {name} を作成できませんでした: {error}"))?;
    Ok(id)
}

fn import_bookmarks(
    transaction: &Transaction<'_>,
    archive: &ParsedArchive,
    matches: &MatchSet,
    now: i64,
) -> Result<usize, String> {
    let mut imported = 0;
    for bookmark in &archive.bookmarks {
        let Some(page) = bookmark.page.filter(|value| *value >= 0) else {
            continue;
        };
        let Some(MatchOutcome::Matched(target)) = matches.bookmarks.get(&bookmark.export_id) else {
            continue;
        };
        imported += transaction
            .execute(
                "INSERT INTO book_bookmarks(id, media_id, page_index, label, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(media_id, page_index) DO UPDATE SET
                    label = COALESCE(excluded.label, book_bookmarks.label)",
                params![bookmark.export_id, target.id, page, bookmark.title, now],
            )
            .map_err(|error| format!("しおりを移行できませんでした: {error}"))?;
    }
    Ok(imported)
}

fn import_references(
    transaction: &Transaction<'_>,
    archive: &ParsedArchive,
    matches: &MatchSet,
    now: i64,
) -> Result<(usize, usize), String> {
    let mut projects = Vec::new();
    let mut items_by_project: HashMap<&str, Vec<Value>> = HashMap::new();
    let mut imported_projects = 0;
    let mut imported_items = 0;

    for record in &archive.references {
        if let AndroidReferenceRecord::Project {
            export_id,
            title,
            created_at,
            ..
        } = record
        {
            transaction
                .execute(
                    "INSERT INTO reference_projects(id, name, description, created_at, updated_at)
                     VALUES (?1, ?2, 'Android版から移行', ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        updated_at = excluded.updated_at",
                    params![export_id, title, (*created_at).max(0), now],
                )
                .map_err(|error| format!("資料プロジェクトを移行できませんでした: {error}"))?;
            imported_projects += 1;
        }
    }

    for record in &archive.references {
        if let AndroidReferenceRecord::Item {
            export_id,
            project_export_id,
            local_media_export_id,
            remote_url,
            title,
            added_at,
            ..
        } = record
        {
            let matched = local_media_export_id
                .as_ref()
                .and_then(|id| matches.media.get(id))
                .and_then(|outcome| match outcome {
                    MatchOutcome::Matched(target) => Some(target),
                    _ => None,
                });
            let path = matched
                .map(|target| target.absolute_path.to_string_lossy().into_owned())
                .or_else(|| (!remote_url.trim().is_empty()).then(|| remote_url.trim().to_owned()));
            let Some(path) = path else {
                continue;
            };
            let source = if matched.is_some() { "gallery" } else { "url" };
            items_by_project
                .entry(project_export_id)
                .or_default()
                .push(json!({
                    "id": export_id,
                    "name": if title.trim().is_empty() { &path } else { title },
                    "path": path,
                    "source": source,
                    "mediaId": matched.map(|target| target.id.as_str()),
                    "previewUrl": if source == "url" { Some(remote_url.as_str()) } else { None },
                    "addedAt": added_at,
                }));
            transaction
                .execute(
                    "INSERT INTO reference_items(
                        id, project_id, media_id, external_path, note, sort_order, created_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                        project_id = excluded.project_id,
                        media_id = excluded.media_id,
                        external_path = excluded.external_path,
                        note = excluded.note",
                    params![
                        export_id,
                        project_export_id,
                        matched.map(|target| target.id.as_str()),
                        if matched.is_none() {
                            Some(remote_url.as_str())
                        } else {
                            None
                        },
                        title,
                        imported_items as i64,
                        if *added_at > 0 { *added_at } else { now }
                    ],
                )
                .map_err(|error| format!("資料項目を移行できませんでした: {error}"))?;
            imported_items += 1;
        }
    }

    for record in &archive.references {
        if let AndroidReferenceRecord::Project {
            export_id,
            title,
            status,
            created_at,
        } = record
        {
            projects.push(json!({
                "id": export_id,
                "name": title,
                "status": if status.eq_ignore_ascii_case("finished") || status.eq_ignore_ascii_case("completed") { "finished" } else { "active" },
                "createdAt": created_at.to_string(),
                "items": items_by_project.remove(export_id.as_str()).unwrap_or_default(),
            }));
        }
    }
    merge_array_preference(transaction, "drawing.references", projects, "id", now)?;
    Ok((imported_projects, imported_items))
}

fn import_x_history(
    transaction: &Transaction<'_>,
    archive: &ParsedArchive,
    matches: &MatchSet,
    now: i64,
) -> Result<usize, String> {
    let mut imported = 0;
    for item in &archive.video_downloads {
        if item.source_url.trim().is_empty() {
            continue;
        }
        let matched = item
            .media_export_id
            .as_ref()
            .and_then(|id| matches.media.get(id))
            .and_then(|outcome| match outcome {
                MatchOutcome::Matched(target) => Some(target),
                _ => None,
            });
        let status = match item.status.trim().to_ascii_lowercase().as_str() {
            "success" | "saved" | "complete" | "completed" => "completed",
            "fail" | "failed" | "error" => "failed",
            _ => "completed",
        };
        imported += transaction
            .execute(
                "INSERT INTO video_downloads(
                    id, source_url, media_url, local_path, author, post_text,
                    status, error_message, created_at, completed_at
                 ) VALUES (?1, ?2, NULL, ?3, NULL, ?4, ?5, NULL, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    source_url = excluded.source_url,
                    local_path = COALESCE(excluded.local_path, video_downloads.local_path),
                    post_text = excluded.post_text,
                    status = excluded.status,
                    completed_at = excluded.completed_at",
                params![
                    item.export_id,
                    item.source_url,
                    matched.map(|target| target.absolute_path.to_string_lossy().into_owned()),
                    item.title,
                    status,
                    if item.download_date > 0 {
                        item.download_date
                    } else {
                        now
                    },
                    (status == "completed").then_some(if item.download_date > 0 {
                        item.download_date
                    } else {
                        now
                    })
                ],
            )
            .map_err(|error| format!("X保存履歴を移行できませんでした: {error}"))?;
    }
    Ok(imported)
}

fn import_android_preferences(
    transaction: &Transaction<'_>,
    archive: &ParsedArchive,
    now: i64,
) -> Result<(), String> {
    upsert_preference(
        transaction,
        "migration.android.settings",
        &serde_json::to_value(&archive.settings)
            .map_err(|error| format!("Android設定を変換できませんでした: {error}"))?,
        now,
    )?;
    upsert_preference(
        transaction,
        "migration.android.favorites",
        &serde_json::to_value(&archive.favorites)
            .map_err(|error| format!("Androidお気に入りを変換できませんでした: {error}"))?,
        now,
    )?;

    let creators = embedded_json_array(archive.favorites.favorite_artists.get("artists"))
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| normalize_creator(value, index))
        .collect::<Vec<_>>();
    merge_array_preference(transaction, "favorites.creators", creators, "name", now)?;

    let sites = embedded_json_array(archive.favorites.favorite_sites.get("favorite_sites"))
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| normalize_site(value, index))
        .collect::<Vec<_>>();
    merge_array_preference(transaction, "favorites.sites", sites, "url", now)?;
    Ok(())
}

fn embedded_json_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(values)) => values.clone(),
        Some(Value::String(value)) => serde_json::from_str::<Vec<Value>>(value).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn normalize_creator(value: Value, index: usize) -> Option<Value> {
    let object = value.as_object()?;
    let name = object.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let links = object
        .get("links")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(link_index, link)| {
            let item = link.as_object()?;
            let url = item.get("url")?.as_str()?.trim();
            if url.is_empty() {
                return None;
            }
            Some(json!({
                "id": stable_id("creator-link", &format!("{name}:{index}:{link_index}:{url}")),
                "platform": item.get("platform").and_then(Value::as_str).unwrap_or("リンク"),
                "url": url,
            }))
        })
        .collect::<Vec<_>>();
    if links.is_empty() {
        return None;
    }
    Some(json!({
        "id": stable_id("creator", &name.to_lowercase()),
        "name": name,
        "links": links,
    }))
}

fn normalize_site(value: Value, index: usize) -> Option<Value> {
    let object = value.as_object()?;
    let url = object.get("url")?.as_str()?.trim();
    if url.is_empty() {
        return None;
    }
    Some(json!({
        "id": stable_id("site", &format!("{index}:{}", url.to_lowercase())),
        "name": object.get("name").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or(url),
        "url": url,
        "description": object.get("description").and_then(Value::as_str).unwrap_or(""),
    }))
}

fn merge_array_preference(
    transaction: &Transaction<'_>,
    key: &str,
    imported: Vec<Value>,
    identity_key: &str,
    now: i64,
) -> Result<(), String> {
    if imported.is_empty() {
        return Ok(());
    }
    let existing_json: Option<String> = transaction
        .query_row(
            "SELECT value_json FROM preferences WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("既存の {key} を読み込めませんでした: {error}"))?;
    let mut existing = existing_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<Vec<Value>>(value).ok())
        .unwrap_or_default();
    let mut identities = existing
        .iter()
        .filter_map(|value| value.get(identity_key)?.as_str())
        .map(|value| value.trim().to_lowercase())
        .collect::<HashSet<_>>();
    for value in imported {
        let Some(identity) = value
            .get(identity_key)
            .and_then(Value::as_str)
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if identities.insert(identity) {
            existing.push(value);
        }
    }
    upsert_preference(transaction, key, &Value::Array(existing), now)
}

fn upsert_preference(
    transaction: &Transaction<'_>,
    key: &str,
    value: &Value,
    now: i64,
) -> Result<(), String> {
    let encoded = serde_json::to_string(value)
        .map_err(|error| format!("{key} をJSONへ変換できませんでした: {error}"))?;
    transaction
        .execute(
            "INSERT INTO preferences(key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at",
            params![key, encoded, now],
        )
        .map_err(|error| format!("{key} を保存できませんでした: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, io::Write, path::Path};

    use serde_json::json;
    use tempfile::tempdir;
    use zip::{ZipWriter, write::SimpleFileOptions};

    use crate::{catalog, db::AppState};

    use super::{
        CHECKSUMMED_ENTRIES, CatalogMedia, PortableMatchRequest, REQUIRED_ENTRIES,
        commit_android_archive, import_settings_backup, inspect_android_archive, match_portable,
        normalize_portable_path, parse_archive, portable_path_matches, sha256_bytes, stable_id,
        write_settings_backup,
    };

    #[test]
    fn portable_paths_match_across_registered_root_boundaries() {
        assert!(portable_path_matches(
            "Pictures/Gallery/example.jpg",
            "Gallery\\example.jpg"
        ));
        assert!(portable_path_matches("DCIM/example.jpg", "example.jpg"));
        assert!(!portable_path_matches("one/example.jpg", "two/example.jpg"));
    }

    #[test]
    fn portable_path_normalization_removes_drive_and_traversal() {
        assert_eq!(
            normalize_portable_path("C:\\Users\\Ninji\\..\\Pictures\\A.JPG"),
            "users/pictures/a.jpg"
        );
    }

    #[test]
    fn stable_ids_are_reproducible_and_namespaced() {
        assert_eq!(stable_id("tag", "blue"), stable_id("tag", "blue"));
        assert_ne!(stable_id("tag", "blue"), stable_id("site", "blue"));
    }

    #[test]
    fn name_and_size_without_a_contract_match_are_not_guessed() {
        let catalog = vec![CatalogMedia {
            id: "windows-id".to_owned(),
            relative_path: "Other/example.jpg".to_owned(),
            file_name: "example.jpg".to_owned(),
            file_size: 3,
            modified_at: 1_000_000,
            sha256: None,
            absolute_path: "Other/example.jpg".into(),
        }];
        let request = PortableMatchRequest {
            source_identity: "android-id".to_owned(),
            relative_path: Some("Pictures/example.jpg".to_owned()),
            file_name: "example.jpg".to_owned(),
            file_size: 3,
            date_modified: Some(10),
            sha256: None,
        };
        assert!(matches!(
            match_portable(&catalog, &request).unwrap(),
            super::MatchOutcome::Ambiguous(candidates) if candidates.len() == 1
        ));
    }

    #[test]
    fn sha256_matches_a_file_that_was_renamed_during_copy() {
        let directory = tempdir().unwrap();
        let renamed = directory.path().join("renamed.jpg");
        fs::write(&renamed, b"jpg").unwrap();
        let catalog = vec![CatalogMedia {
            id: "windows-id".to_owned(),
            relative_path: "renamed.jpg".to_owned(),
            file_name: "renamed.jpg".to_owned(),
            file_size: 3,
            modified_at: 20,
            sha256: None,
            absolute_path: renamed,
        }];
        let request = PortableMatchRequest {
            source_identity: "android-id".to_owned(),
            relative_path: Some("Pictures/original.jpg".to_owned()),
            file_name: "original.jpg".to_owned(),
            file_size: 3,
            date_modified: None,
            sha256: Some(sha256_bytes(b"jpg")),
        };
        assert!(matches!(
            match_portable(&catalog, &request).unwrap(),
            super::MatchOutcome::Matched(ref item) if item.id == "windows-id"
        ));
    }

    #[test]
    fn android_fixture_is_previewed_and_committed_atomically() {
        let directory = tempdir().unwrap();
        let media_directory = directory.path().join("Pictures").join("Gallery");
        fs::create_dir_all(&media_directory).unwrap();
        fs::write(media_directory.join("example.jpg"), b"jpg").unwrap();
        let archive_path = directory.path().join("pixvault-migration.zip");
        write_fixture(&archive_path, false);

        let state = AppState::in_memory().unwrap();
        catalog::add_library_root(&state, directory.path().to_str().unwrap()).unwrap();
        catalog::scan_library(&state, None).unwrap();

        let preview = inspect_android_archive(&state, &archive_path).unwrap();
        assert_eq!(preview.total_media, 1);
        assert_eq!(preview.matched_media, 1);
        assert_eq!(preview.issue_count, 0);

        let result = commit_android_archive(&state, &preview.token, &Default::default()).unwrap();
        assert!(!result.already_imported);
        assert_eq!(result.imported_media, 1);
        assert_eq!(result.imported_favorites, 1);
        assert_eq!(result.imported_tags, 1);
        assert_eq!(result.imported_reference_projects, 1);
        assert_eq!(result.imported_reference_items, 1);
        assert_eq!(result.imported_x_history, 1);

        let connection = state.database.lock().unwrap();
        let favorite: bool = connection
            .query_row("SELECT is_favorite FROM media_items", [], |row| row.get(0))
            .unwrap();
        let tag_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM media_tags", [], |row| row.get(0))
            .unwrap();
        let migration_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM migration_runs WHERE status = 'completed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(favorite);
        // The migration archive itself is a cataloged ZIP book in this fixture,
        // so it also carries its scanner-managed current-parent-folder tag.
        assert_eq!(tag_count, 2);
        let folder_tag_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM media_tags WHERE source = 'folder'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folder_tag_count, 1);
        assert_eq!(migration_count, 1);
    }

    #[test]
    fn archive_with_a_bad_checksum_is_rejected_before_matching() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("tampered.zip");
        write_fixture(&archive_path, true);
        let error = parse_archive(&archive_path).unwrap_err();
        assert!(error.contains("SHA-256"));
    }

    #[test]
    fn settings_backup_round_trip_is_atomic_and_versioned() {
        let directory = tempdir().unwrap();
        let backup_path = directory.path().join("settings.json");
        let state = AppState::in_memory().unwrap();
        catalog::set_preference(&state, "theme", json!("dark")).unwrap();
        catalog::set_preference(
            &state,
            "favorites.sites",
            json!([{"url": "https://example.com"}]),
        )
        .unwrap();

        let exported = write_settings_backup(&state, &backup_path, "test").unwrap();
        assert_eq!(exported.preferences, 2);
        catalog::set_preference(&state, "theme", json!("light")).unwrap();

        let imported = import_settings_backup(&state, &backup_path).unwrap();
        assert_eq!(imported.preferences, 2);
        let preferences = catalog::get_preferences(&state).unwrap();
        assert_eq!(
            preferences
                .iter()
                .find(|entry| entry.key == "theme")
                .map(|entry| &entry.value),
            Some(&json!("dark"))
        );
    }

    fn write_fixture(path: &Path, corrupt_checksum: bool) {
        let mut entries = BTreeMap::<&str, Vec<u8>>::new();
        entries.insert(
            "settings.json",
            serde_json::to_vec(&json!({
                "formatVersion": 1,
                "version": 1,
                "settings": {"global_settings": {"showClock": true}},
                "preferenceTypes": {"global_settings": {"showClock": "boolean"}}
            }))
            .unwrap(),
        );
        entries.insert(
            "favorites.json",
            serde_json::to_vec(&json!({
                "formatVersion": 1,
                "version": 1,
                "favorite_artists": {"artists": "[]"},
                "favorite_sites": {"favorite_sites": "[]"},
                "book_favorites": {},
                "preferenceTypes": {}
            }))
            .unwrap(),
        );
        entries.insert(
            "media.jsonl",
            format!(
                "{}\n",
                json!({
                    "exportId": "media-id",
                    "androidUri": "content://media/1",
                    "relativePath": "Pictures/Gallery/example.jpg",
                    "fileName": "example.jpg",
                    "fileSize": 3,
                    "dateAdded": 1,
                    "dateModified": null,
                    "mimeType": "image/jpeg",
                    "duration": 0,
                    "width": 10,
                    "height": 20,
                    "sha256": null,
                    "favorite": true,
                    "ageRating": "SFW",
                    "aiAnalyzed": true,
                    "aiModel": "android-model",
                    "featureVector": [0.25, 0.5],
                    "deleted": false,
                    "deletedDate": null
                })
            )
            .into_bytes(),
        );
        entries.insert(
            "tags.jsonl",
            format!(
                "{}\n",
                json!({"exportId": "media-id", "tag": "landscape", "confidence": 0.8, "source": "ai"})
            )
            .into_bytes(),
        );
        entries.insert(
            "video-downloads.jsonl",
            format!(
                "{}\n",
                json!({
                    "exportId": "download-id",
                    "sourceUrl": "https://x.com/user/status/1",
                    "title": "post",
                    "androidSavePath": "content://media/1",
                    "mediaExportId": "media-id",
                    "relativePath": "Pictures/Gallery/example.jpg",
                    "fileName": "example.jpg",
                    "fileSize": 3,
                    "dateModified": null,
                    "mimeType": "image/jpeg",
                    "sha256": null,
                    "downloadDate": 1000,
                    "status": "COMPLETED"
                })
            )
            .into_bytes(),
        );
        entries.insert(
            "references.jsonl",
            format!(
                "{}\n{}\n",
                json!({"recordType": "project", "exportId": "project-id", "title": "Project", "status": "ACTIVE", "createdAt": 1000}),
                json!({"recordType": "item", "exportId": "item-id", "projectExportId": "project-id", "localMediaExportId": "media-id", "androidLocalUri": "content://media/1", "remoteUrl": "", "title": "Reference", "addedAt": 1001})
            )
            .into_bytes(),
        );
        entries.insert("bookmarks.jsonl", Vec::new());
        entries.insert(
            "manifest.json",
            serde_json::to_vec(&json!({
                "formatVersion": 1,
                "androidApp": {"packageName": "com.example.gallery", "versionName": "2.0.0", "versionCode": 11},
                "databaseVersion": 19,
                "exportedAt": "2026-08-20T00:00:00.000Z",
                "exportedAtEpochMillis": 1,
                "deviceTimezone": "Asia/Tokyo",
                "recordCounts": {"media": 1, "tags": 1, "videoDownloads": 1, "references": 2, "bookmarks": 0},
                "hashAlgorithm": "SHA-256",
                "featureVectorsPresent": true,
                "mediaHashesPresent": false
            }))
            .unwrap(),
        );

        let checksum_files = CHECKSUMMED_ENTRIES
            .iter()
            .map(|name| {
                let hash = if corrupt_checksum && *name == "media.jsonl" {
                    "0".repeat(64)
                } else {
                    sha256_bytes(entries.get(name).unwrap())
                };
                ((*name).to_owned(), hash)
            })
            .collect::<BTreeMap<_, _>>();
        entries.insert(
            "checksums.json",
            serde_json::to_vec(&json!({
                "formatVersion": 1,
                "hashAlgorithm": "SHA-256",
                "files": checksum_files
            }))
            .unwrap(),
        );

        let file = fs::File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for name in REQUIRED_ENTRIES {
            writer.start_file(name, options).unwrap();
            writer.write_all(entries.get(name).unwrap()).unwrap();
        }
        writer.finish().unwrap();
    }
}
