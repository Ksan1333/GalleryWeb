use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub app_name: &'static str,
    pub app_version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub database_schema_version: u32,
    pub migration_format_version: u32,
    pub automatic_updates_enabled: bool,
    pub update_https_endpoint_configured: bool,
    pub update_public_key_configured: bool,
    pub windows_signing_certificate_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub affected: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRoot {
    pub id: String,
    pub path: String,
    pub display_name: String,
    pub enabled: bool,
    pub is_priority: bool,
    pub item_count: u64,
    pub missing_count: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct LibraryRootRecord {
    pub id: String,
    pub path: String,
    pub display_name: String,
    pub enabled: bool,
    pub is_priority: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaQuery {
    pub root_id: Option<String>,
    pub folder_path: Option<String>,
    pub kind: Option<String>,
    pub kinds: Vec<String>,
    pub search: Option<String>,
    pub age_rating: Option<String>,
    pub tag_ids: Vec<String>,
    pub modified_from: Option<i64>,
    pub modified_before: Option<i64>,
    pub favorite_only: bool,
    pub include_missing: bool,
    pub sort_by: Option<String>,
    pub sort_direction: Option<String>,
    pub include_date_groups: bool,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaDateGroup {
    pub date: String,
    pub item_count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaPageInfo {
    pub total_count: u64,
    pub date_groups: Vec<MediaDateGroup>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub root_id: String,
    pub root_path: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub file_name: String,
    pub extension: String,
    pub kind: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub modified_at: i64,
    pub is_missing: bool,
    pub is_favorite: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub page_count: Option<u32>,
    pub sha256: Option<String>,
    pub age_rating: String,
    pub tags: Vec<Tag>,
    /// Existing app-local thumbnail cache entry, resolved without a second
    /// per-card database command.
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookBookmark {
    pub id: String,
    pub media_id: String,
    pub page_index: u32,
    pub label: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveBookInfo {
    pub page_count: u32,
    pub page_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveBookPageCacheEntry {
    pub page_index: u32,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindCount {
    pub kind: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub root_count: u64,
    pub total_items: u64,
    pub favorite_items: u64,
    pub missing_items: u64,
    pub total_bytes: u64,
    pub by_kind: Vec<KindCount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootScanResult {
    pub root_id: String,
    pub scanned_files: u64,
    pub supported_files: u64,
    pub inserted: u64,
    pub updated: u64,
    pub missing: u64,
    pub issues: Vec<ScanIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub roots: Vec<RootScanResult>,
    pub scanned_files: u64,
    pub supported_files: u64,
    pub inserted: u64,
    pub updated: u64,
    pub missing: u64,
    pub issue_count: u64,
}

impl ScanReport {
    pub fn from_roots(roots: Vec<RootScanResult>) -> Self {
        Self {
            scanned_files: roots.iter().map(|item| item.scanned_files).sum(),
            supported_files: roots.iter().map(|item| item.supported_files).sum(),
            inserted: roots.iter().map(|item| item.inserted).sum(),
            updated: roots.iter().map(|item| item.updated).sum(),
            missing: roots.iter().map(|item| item.missing).sum(),
            issue_count: roots.iter().map(|item| item.issues.len() as u64).sum(),
            roots,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagWithCount {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub media_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    pub id: Option<String>,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceEntry {
    pub key: String,
    pub value: Value,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XHistoryItem {
    pub id: String,
    pub source_url: String,
    pub media_url: Option<String>,
    pub local_path: Option<String>,
    pub author: Option<String>,
    pub post_text: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XHistoryInput {
    pub id: Option<String>,
    pub source_url: String,
    pub media_url: Option<String>,
    pub local_path: Option<String>,
    pub author: Option<String>,
    pub post_text: Option<String>,
    pub status: Option<String>,
    pub error_message: Option<String>,
    pub created_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFavorite {
    pub media_id: String,
    pub is_favorite: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMediaTags {
    pub media_id: String,
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CatalogImportPayload {
    pub preferences: BTreeMap<String, Value>,
    pub favorites: Vec<ImportedFavorite>,
    pub tags: Vec<Tag>,
    pub media_tags: Vec<ImportedMediaTags>,
    pub x_history: Vec<XHistoryInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCatalogResult {
    pub dry_run: bool,
    pub preferences: u64,
    pub favorites: u64,
    pub tags: u64,
    pub media_tag_links: u64,
    pub x_history: u64,
    pub issues: Vec<String>,
}
