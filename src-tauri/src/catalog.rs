use std::{
    collections::{HashMap, HashSet},
    fs::Metadata,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{
    Connection, OptionalExtension, TransactionBehavior, params, params_from_iter,
    types::Value as SqlValue,
};
use serde_json::Value;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    db::AppState,
    models::{
        BookBookmark, CatalogImportPayload, ImportCatalogResult, KindCount, LibraryRoot,
        LibraryRootRecord, LibrarySummary, MediaDateGroup, MediaItem, MediaPageInfo, MediaQuery,
        MutationResult, PreferenceEntry, RootScanResult, ScanIssue, ScanReport, Tag, TagInput,
        TagWithCount, XHistoryInput, XHistoryItem,
    },
};

const MAX_SCAN_ISSUES: usize = 500;
const MASS_MISSING_GUARD_MIN_ITEMS: u64 = 1_000;
const SUSPICIOUS_MISSING_SAMPLE_SIZE: usize = 16;
const SUSPICIOUS_MISSING_SAMPLE_MINIMUM: usize = 8;
const SUPPORTED_KINDS: [&str; 5] = ["image", "gif", "video", "pdf", "zip"];

#[derive(Debug)]
struct ScanCandidate {
    relative_path: String,
    file_name: String,
    extension: String,
    media_kind: String,
    mime_type: String,
    byte_size: i64,
    modified_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct SimilarityCandidate {
    pub id: String,
}

#[derive(Debug)]
struct MediaRow {
    id: String,
    root_id: String,
    root_path: String,
    relative_path: String,
    file_name: String,
    extension: String,
    kind: String,
    mime_type: String,
    byte_size: i64,
    modified_at: i64,
    is_missing: bool,
    is_favorite: bool,
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
    page_count: Option<i64>,
    sha256: Option<String>,
    age_rating: Option<String>,
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

pub fn add_library_root(state: &AppState, input_path: &str) -> Result<LibraryRoot, String> {
    let canonical = canonical_directory(input_path)?;
    let path = path_to_string(&canonical)?;
    let display_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.clone());
    let id = Uuid::new_v4().to_string();
    let now = now_millis();

    let connection = state.database.lock()?;
    connection
        .execute(
            "INSERT INTO library_roots(id, path, display_name, enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)
             ON CONFLICT(path) DO UPDATE SET
                display_name = excluded.display_name,
                enabled = 1,
                updated_at = excluded.updated_at",
            params![id, path, display_name, now],
        )
        .map_err(|error| format!("Failed to register library root: {error}"))?;

    query_library_root_by_path(&connection, &path)?
        .ok_or_else(|| "The registered library root could not be read back".to_owned())
}

pub fn list_library_roots(state: &AppState) -> Result<Vec<LibraryRoot>, String> {
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(
            "SELECT r.id, r.path, r.display_name, r.enabled,
                    COUNT(m.id) AS item_count,
                    COALESCE(SUM(CASE WHEN m.is_missing = 1 THEN 1 ELSE 0 END), 0) AS missing_count,
                    r.created_at, r.updated_at
             FROM library_roots r
             LEFT JOIN media_items m ON m.root_id = r.id
             GROUP BY r.id
             ORDER BY r.display_name COLLATE NOCASE, r.path COLLATE NOCASE",
        )
        .map_err(|error| format!("Failed to prepare library root query: {error}"))?;

    let rows = statement
        .query_map([], library_root_from_row)
        .map_err(|error| format!("Failed to query library roots: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read library roots: {error}"))
}

/// Returns only the fields needed by background folder watching.
///
/// Unlike `list_library_roots`, this query does not join or aggregate the media
/// catalog, so refreshing watcher subscriptions remains cheap for large
/// libraries.
pub(crate) fn list_enabled_library_root_records(
    state: &AppState,
) -> Result<Vec<LibraryRootRecord>, String> {
    get_root_records(state, None)
}

pub fn remove_library_root(state: &AppState, root_id: &str) -> Result<MutationResult, String> {
    let connection = state.database.lock()?;
    let affected = connection
        .execute("DELETE FROM library_roots WHERE id = ?1", [root_id])
        .map_err(|error| format!("Failed to remove library root: {error}"))?;
    Ok(MutationResult {
        affected: affected as u64,
    })
}

pub fn scan_library(state: &AppState, root_id: Option<&str>) -> Result<ScanReport, String> {
    let roots = get_root_records(state, root_id)?;
    if roots.is_empty() && root_id.is_some() {
        return Err("The requested enabled library root was not found".to_owned());
    }

    let mut results = Vec::with_capacity(roots.len());
    for root in roots {
        results.push(scan_one_root(state, root)?);
    }
    Ok(ScanReport::from_roots(results))
}

/// Repairs the legacy state produced when a removable or slow drive briefly
/// returned `NotFound` for most of a large library. Only roots where missing
/// records are the majority are considered, and the flags are restored only
/// when at least 75% of a stable ID sample currently resolves to real files.
/// No filesystem content is changed.
pub(crate) fn recover_suspicious_missing_media(
    state: &AppState,
) -> Result<Vec<(String, u64)>, String> {
    let suspicious_roots = {
        let connection = state.database.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT r.id, r.path, COUNT(m.id) AS total_count,
                        SUM(CASE WHEN m.is_missing = 1 THEN 1 ELSE 0 END) AS missing_count
                 FROM library_roots r
                 JOIN media_items m ON m.root_id = r.id
                 WHERE r.enabled = 1
                 GROUP BY r.id
                 HAVING total_count >= ?1 AND missing_count * 2 > total_count",
            )
            .map_err(|error| format!("Failed to prepare missing-media recovery: {error}"))?;
        statement
            .query_map([MASS_MISSING_GUARD_MIN_ITEMS as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    nonnegative_u64(row.get::<_, i64>(2)?),
                    nonnegative_u64(row.get::<_, i64>(3)?),
                ))
            })
            .map_err(|error| format!("Failed to query missing-media recovery roots: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read missing-media recovery roots: {error}"))?
    };

    let mut recovered = Vec::new();
    for (root_id, root_path, total_count, missing_count) in suspicious_roots {
        let root = PathBuf::from(&root_path);
        if !root.is_dir() {
            continue;
        }
        let sample = {
            let connection = state.database.lock()?;
            let mut statement = connection
                .prepare(
                    "SELECT relative_path
                     FROM media_items
                     WHERE root_id = ?1 AND is_missing = 1
                     ORDER BY id
                     LIMIT ?2",
                )
                .map_err(|error| format!("Failed to prepare missing-media sample: {error}"))?;
            statement
                .query_map(
                    params![root_id, SUSPICIOUS_MISSING_SAMPLE_SIZE as i64],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| format!("Failed to query missing-media sample: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read missing-media sample: {error}"))?
        };
        let present_count = sample
            .iter()
            .filter(|relative| join_catalog_path(&root, relative).is_file())
            .count();
        if !should_recover_suspicious_missing_root(
            total_count,
            missing_count,
            present_count,
            sample.len(),
        ) {
            continue;
        }

        let connection = state.database.lock()?;
        let affected = connection
            .execute(
                "UPDATE media_items
                 SET is_missing = 0, updated_at = ?2
                 WHERE root_id = ?1 AND is_missing = 1",
                params![root_id, now_millis()],
            )
            .map_err(|error| format!("Failed to restore present media records: {error}"))?;
        recovered.push((root_id, affected as u64));
    }
    Ok(recovered)
}

fn should_recover_suspicious_missing_root(
    total_count: u64,
    missing_count: u64,
    sample_present: usize,
    sample_count: usize,
) -> bool {
    total_count >= MASS_MISSING_GUARD_MIN_ITEMS
        && missing_count.saturating_mul(2) > total_count
        && sample_count >= SUSPICIOUS_MISSING_SAMPLE_MINIMUM
        && sample_present.saturating_mul(4) >= sample_count.saturating_mul(3)
}

fn scan_result_has_suspicious_mass_drop(previous_active: u64, scanned_supported: u64) -> bool {
    previous_active >= MASS_MISSING_GUARD_MIN_ITEMS
        && scanned_supported.saturating_mul(2) < previous_active
}

pub fn list_media_items(
    state: &AppState,
    query: Option<MediaQuery>,
) -> Result<Vec<MediaItem>, String> {
    let query = query.unwrap_or_default();
    let limit = query.limit.unwrap_or(250).clamp(1, 1_000);
    let offset = query.offset.unwrap_or(0);
    let mut sql = String::from(
        "SELECT m.id, m.root_id, r.path, m.relative_path, m.file_name, m.extension,
                m.media_kind, m.mime_type, m.byte_size, m.modified_at,
                m.is_missing, m.is_favorite,
                mm.width, mm.height, mm.duration_ms, mm.page_count, mm.sha256, mm.age_rating
         FROM media_items m
         JOIN library_roots r ON r.id = m.root_id
         LEFT JOIN media_metadata mm ON mm.media_id = m.id
         WHERE ",
    );
    let (filter_sql, mut values) = build_media_filter(&query)?;
    sql.push_str(&filter_sql);
    let sort_column = match query.sort_by.as_deref() {
        Some("name") => "m.file_name COLLATE NOCASE",
        Some("size") => "m.byte_size",
        Some("importedAt") => "m.first_seen_at",
        _ => "m.modified_at",
    };
    let sort_direction = if query.sort_direction.as_deref() == Some("asc") {
        "ASC"
    } else {
        "DESC"
    };
    sql.push_str(&format!(
        " ORDER BY {sort_column} {sort_direction},
                   m.file_name COLLATE NOCASE,
                   m.relative_path COLLATE NOCASE,
                   m.id
          LIMIT ? OFFSET ?"
    ));
    values.push(SqlValue::Integer(i64::from(limit)));
    values.push(SqlValue::Integer(i64::from(offset)));

    let connection = state.database.lock()?;
    let rows = {
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Failed to prepare media query: {error}"))?;
        let mapped = statement
            .query_map(params_from_iter(values), |row| {
                Ok(MediaRow {
                    id: row.get(0)?,
                    root_id: row.get(1)?,
                    root_path: row.get(2)?,
                    relative_path: row.get(3)?,
                    file_name: row.get(4)?,
                    extension: row.get(5)?,
                    kind: row.get(6)?,
                    mime_type: row.get(7)?,
                    byte_size: row.get(8)?,
                    modified_at: row.get(9)?,
                    is_missing: row.get(10)?,
                    is_favorite: row.get(11)?,
                    width: row.get(12)?,
                    height: row.get(13)?,
                    duration_ms: row.get(14)?,
                    page_count: row.get(15)?,
                    sha256: row.get(16)?,
                    age_rating: row.get(17)?,
                })
            })
            .map_err(|error| format!("Failed to query media: {error}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read media: {error}"))?
    };

    materialize_media_rows(&connection, rows)
}

/// Returns every image candidate in chronological order without materializing
/// full media records. Adjacent similarity grouping is O(n), so this compact
/// query remains practical for libraries with tens of thousands of items.
pub(crate) fn list_similarity_candidates(
    state: &AppState,
    query: Option<MediaQuery>,
) -> Result<Vec<SimilarityCandidate>, String> {
    let mut query = query.unwrap_or_default();
    query.limit = None;
    query.offset = None;
    query.kinds = vec!["image".to_owned(), "gif".to_owned()];
    query.kind = None;
    let (filter_sql, values) = build_media_filter(&query)?;
    let sql = format!(
        "SELECT m.id
         FROM media_items m
         JOIN library_roots r ON r.id = m.root_id
         LEFT JOIN media_metadata mm ON mm.media_id = m.id
         WHERE {filter_sql}
         ORDER BY m.modified_at ASC, m.id ASC"
    );
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare similarity candidates: {error}"))?;
    statement
        .query_map(params_from_iter(values), |row| {
            Ok(SimilarityCandidate { id: row.get(0)? })
        })
        .map_err(|error| format!("Failed to query similarity candidates: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read similarity candidates: {error}"))
}

pub(crate) fn get_media_items_by_ids(
    state: &AppState,
    media_ids: &[String],
) -> Result<Vec<MediaItem>, String> {
    if media_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", media_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT m.id, m.root_id, r.path, m.relative_path, m.file_name, m.extension,
                m.media_kind, m.mime_type, m.byte_size, m.modified_at,
                m.is_missing, m.is_favorite,
                mm.width, mm.height, mm.duration_ms, mm.page_count, mm.sha256, mm.age_rating
         FROM media_items m
         JOIN library_roots r ON r.id = m.root_id
         LEFT JOIN media_metadata mm ON mm.media_id = m.id
         WHERE m.id IN ({placeholders}) AND m.is_missing = 0 AND r.enabled = 1"
    );
    let connection = state.database.lock()?;
    let rows = {
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Failed to prepare media id query: {error}"))?;
        let mapped = statement
            .query_map(params_from_iter(media_ids), |row| {
                Ok(MediaRow {
                    id: row.get(0)?,
                    root_id: row.get(1)?,
                    root_path: row.get(2)?,
                    relative_path: row.get(3)?,
                    file_name: row.get(4)?,
                    extension: row.get(5)?,
                    kind: row.get(6)?,
                    mime_type: row.get(7)?,
                    byte_size: row.get(8)?,
                    modified_at: row.get(9)?,
                    is_missing: row.get(10)?,
                    is_favorite: row.get(11)?,
                    width: row.get(12)?,
                    height: row.get(13)?,
                    duration_ms: row.get(14)?,
                    page_count: row.get(15)?,
                    sha256: row.get(16)?,
                    age_rating: row.get(17)?,
                })
            })
            .map_err(|error| format!("Failed to query media ids: {error}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read media ids: {error}"))?
    };
    materialize_media_rows(&connection, rows)
}

fn materialize_media_rows(
    connection: &Connection,
    rows: Vec<MediaRow>,
) -> Result<Vec<MediaItem>, String> {
    let media_ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let mut tags_by_media = tags_for_media_ids(connection, &media_ids)?;

    rows.into_iter()
        .map(|row| {
            let tags = tags_by_media.remove(&row.id).unwrap_or_default();
            let absolute_path = path_to_string(&join_catalog_path(
                Path::new(&row.root_path),
                &row.relative_path,
            ))?;
            Ok(MediaItem {
                id: row.id,
                root_id: row.root_id,
                root_path: row.root_path,
                relative_path: row.relative_path,
                absolute_path,
                file_name: row.file_name,
                extension: row.extension,
                kind: row.kind,
                mime_type: row.mime_type,
                byte_size: nonnegative_u64(row.byte_size),
                modified_at: row.modified_at,
                is_missing: row.is_missing,
                is_favorite: row.is_favorite,
                width: optional_u32(row.width),
                height: optional_u32(row.height),
                duration_ms: row.duration_ms.map(nonnegative_u64),
                page_count: optional_u32(row.page_count),
                sha256: row.sha256,
                age_rating: row.age_rating.unwrap_or_else(|| "UNRATED".to_owned()),
                tags,
                thumbnail_path: None,
            })
        })
        .collect()
}

/// Returns the compact layout metadata needed by the virtualized gallery.
///
/// The UI can reserve the complete scroll height from `total_count` while
/// keeping only visible media pages in memory. Date buckets are intentionally
/// compact (one row per calendar day), even for very large libraries.
pub fn get_media_page_info(
    state: &AppState,
    query: Option<MediaQuery>,
) -> Result<MediaPageInfo, String> {
    let query = query.unwrap_or_default();
    let (filter_sql, values) = build_media_filter(&query)?;
    let connection = state.database.lock()?;

    let total_count = connection
        .query_row(
            &format!(
                "SELECT COUNT(*)
                 FROM media_items m
                 JOIN library_roots r ON r.id = m.root_id
                 LEFT JOIN media_metadata mm ON mm.media_id = m.id
                 WHERE {filter_sql}"
            ),
            params_from_iter(values.iter()),
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Failed to count media: {error}"))
        .map(nonnegative_u64)?;

    let date_groups = if query.include_date_groups {
        let direction = if query.sort_direction.as_deref() == Some("asc") {
            "ASC"
        } else {
            "DESC"
        };
        let group_sql = format!(
            "SELECT strftime('%Y-%m-%d', m.modified_at / 1000, 'unixepoch', 'localtime') AS media_date,
                    COUNT(*) AS item_count
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             LEFT JOIN media_metadata mm ON mm.media_id = m.id
             WHERE {filter_sql}
             GROUP BY media_date
             ORDER BY media_date {direction}"
        );
        let mut statement = connection
            .prepare(&group_sql)
            .map_err(|error| format!("Failed to prepare media date groups: {error}"))?;
        let rows = statement
            .query_map(params_from_iter(values.iter()), |row| {
                let date = row
                    .get::<_, Option<String>>(0)?
                    .unwrap_or_else(|| "1970-01-01".to_owned());
                let count = row.get::<_, i64>(1)?;
                Ok(MediaDateGroup {
                    date,
                    item_count: nonnegative_u64(count),
                })
            })
            .map_err(|error| format!("Failed to query media date groups: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read media date groups: {error}"))?
    } else {
        Vec::new()
    };

    Ok(MediaPageInfo {
        total_count,
        date_groups,
    })
}

fn build_media_filter(query: &MediaQuery) -> Result<(String, Vec<SqlValue>), String> {
    let mut conditions = vec!["r.enabled = 1".to_owned()];
    let mut values: Vec<SqlValue> = Vec::new();

    if let Some(root_id) = query
        .root_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        conditions.push("m.root_id = ?".to_owned());
        values.push(SqlValue::Text(root_id.to_owned()));
    }
    if let Some(folder_path) = query.folder_path.as_deref() {
        let normalized = folder_path.replace('\\', "/").trim_matches('/').to_owned();
        if normalized
            .split('/')
            .any(|component| component == "." || component == "..")
        {
            return Err("Folder filter contains an invalid path component".to_owned());
        }
        conditions.push(
            "(
                CASE
                    WHEN m.relative_path = m.file_name THEN ''
                    ELSE substr(
                        m.relative_path,
                        1,
                        length(m.relative_path) - length(m.file_name) - 1
                    )
                END COLLATE NOCASE
            ) = ?"
                .to_owned(),
        );
        values.push(SqlValue::Text(normalized));
    }

    let mut kinds = query
        .kinds
        .iter()
        .map(String::as_str)
        .filter(|kind| !kind.trim().is_empty())
        .collect::<Vec<_>>();
    if kinds.is_empty()
        && let Some(kind) = query.kind.as_deref().filter(|kind| !kind.trim().is_empty())
    {
        kinds.push(kind);
    }
    kinds.sort_unstable();
    kinds.dedup();
    if let Some(kind) = kinds.iter().find(|kind| !SUPPORTED_KINDS.contains(kind)) {
        return Err(format!("Unsupported media kind: {kind}"));
    }
    if kinds.len() == 1 {
        conditions.push("m.media_kind = ?".to_owned());
        values.push(SqlValue::Text(kinds[0].to_owned()));
    } else if !kinds.is_empty() {
        conditions.push(format!(
            "m.media_kind IN ({})",
            std::iter::repeat_n("?", kinds.len())
                .collect::<Vec<_>>()
                .join(", ")
        ));
        values.extend(
            kinds
                .into_iter()
                .map(|kind| SqlValue::Text(kind.to_owned())),
        );
    }

    if let Some(search) = query
        .search
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        conditions.push(
            "(m.file_name LIKE ? ESCAPE '\\'
              OR m.relative_path LIKE ? ESCAPE '\\'
              OR EXISTS (
                  SELECT 1 FROM media_tags search_mt
                  JOIN tags search_t ON search_t.id = search_mt.tag_id
                  WHERE search_mt.media_id = m.id AND search_t.name LIKE ? ESCAPE '\\'
              ))"
            .to_owned(),
        );
        let pattern = format!("%{}%", escape_like(search.trim()));
        values.push(SqlValue::Text(pattern.clone()));
        values.push(SqlValue::Text(pattern.clone()));
        values.push(SqlValue::Text(pattern));
    }
    if let Some(age_rating) = query
        .age_rating
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let normalized = normalize_age_rating(age_rating)?;
        if normalized == "UNRATED" {
            conditions.push("mm.age_rating IS NULL".to_owned());
        } else {
            conditions.push("mm.age_rating = ?".to_owned());
            values.push(SqlValue::Text(normalized));
        }
    }
    for tag_id in query
        .tag_ids
        .iter()
        .filter(|value| !value.trim().is_empty())
    {
        conditions.push(
            "EXISTS (
                SELECT 1 FROM media_tags filter_mt
                WHERE filter_mt.media_id = m.id AND filter_mt.tag_id = ?
            )"
            .to_owned(),
        );
        values.push(SqlValue::Text(tag_id.to_owned()));
    }
    if let Some(modified_from) = query.modified_from {
        conditions.push("m.modified_at >= ?".to_owned());
        values.push(SqlValue::Integer(modified_from));
    }
    if let Some(modified_before) = query.modified_before {
        conditions.push("m.modified_at < ?".to_owned());
        values.push(SqlValue::Integer(modified_before));
    }
    if query.favorite_only {
        conditions.push("m.is_favorite = 1".to_owned());
    }
    if !query.include_missing {
        conditions.push("m.is_missing = 0".to_owned());
    }
    Ok((conditions.join(" AND "), values))
}

pub fn get_library_summary(state: &AppState) -> Result<LibrarySummary, String> {
    let connection = state.database.lock()?;
    let (root_count, total_items, favorite_items, missing_items, total_bytes): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM library_roots WHERE enabled = 1),
                COUNT(*),
                COALESCE(SUM(CASE WHEN is_favorite = 1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN is_missing = 1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN is_missing = 0 THEN byte_size ELSE 0 END), 0)
             FROM media_items",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|error| format!("Failed to query library summary: {error}"))?;

    let by_kind = {
        let mut statement = connection
            .prepare(
                "SELECT media_kind, COUNT(*)
                 FROM media_items
                 WHERE is_missing = 0
                 GROUP BY media_kind
                 ORDER BY media_kind",
            )
            .map_err(|error| format!("Failed to prepare media kind summary: {error}"))?;
        statement
            .query_map([], |row| {
                Ok(KindCount {
                    kind: row.get(0)?,
                    count: nonnegative_u64(row.get(1)?),
                })
            })
            .map_err(|error| format!("Failed to query media kind summary: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read media kind summary: {error}"))?
    };

    Ok(LibrarySummary {
        root_count: nonnegative_u64(root_count),
        total_items: nonnegative_u64(total_items),
        favorite_items: nonnegative_u64(favorite_items),
        missing_items: nonnegative_u64(missing_items),
        total_bytes: nonnegative_u64(total_bytes),
        by_kind,
    })
}

pub fn set_favorite(
    state: &AppState,
    media_id: &str,
    is_favorite: bool,
) -> Result<MutationResult, String> {
    let connection = state.database.lock()?;
    let affected = connection
        .execute(
            "UPDATE media_items SET is_favorite = ?2, updated_at = ?3 WHERE id = ?1",
            params![media_id, is_favorite, now_millis()],
        )
        .map_err(|error| format!("Failed to update favorite: {error}"))?;
    if affected == 0 {
        return Err("The requested media item was not found".to_owned());
    }
    Ok(MutationResult {
        affected: affected as u64,
    })
}

pub fn set_age_rating(
    state: &AppState,
    media_id: &str,
    age_rating: &str,
) -> Result<String, String> {
    let normalized = normalize_age_rating(age_rating)?;
    let connection = state.database.lock()?;
    ensure_media_exists(&connection, media_id)?;
    let stored_rating = (normalized != "UNRATED").then_some(normalized.as_str());
    let source = if stored_rating.is_some() {
        "user"
    } else {
        "default"
    };
    connection
        .execute(
            "INSERT INTO media_metadata(media_id, age_rating, age_rating_source, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(media_id) DO UPDATE SET
                age_rating = excluded.age_rating,
                age_rating_source = excluded.age_rating_source,
                updated_at = excluded.updated_at",
            params![media_id, stored_rating, source, now_millis()],
        )
        .map_err(|error| format!("Failed to update age rating: {error}"))?;
    Ok(normalized)
}

pub fn list_book_bookmarks(state: &AppState, media_id: &str) -> Result<Vec<BookBookmark>, String> {
    let connection = state.database.lock()?;
    ensure_media_exists(&connection, media_id)?;
    let mut statement = connection
        .prepare(
            "SELECT id, media_id, page_index, label, created_at
             FROM book_bookmarks
             WHERE media_id = ?1
             ORDER BY page_index",
        )
        .map_err(|error| format!("Failed to prepare bookmark query: {error}"))?;
    statement
        .query_map([media_id], |row| {
            let page_index: i64 = row.get(2)?;
            Ok(BookBookmark {
                id: row.get(0)?,
                media_id: row.get(1)?,
                page_index: optional_u32(Some(page_index)).unwrap_or_default(),
                label: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Failed to query bookmarks: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read bookmarks: {error}"))
}

pub fn set_book_bookmark(
    state: &AppState,
    media_id: &str,
    page_index: u32,
    is_bookmarked: bool,
) -> Result<MutationResult, String> {
    let connection = state.database.lock()?;
    ensure_media_exists(&connection, media_id)?;
    let affected = if is_bookmarked {
        connection
            .execute(
                "INSERT INTO book_bookmarks(id, media_id, page_index, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(media_id, page_index) DO NOTHING",
                params![
                    Uuid::new_v4().to_string(),
                    media_id,
                    i64::from(page_index),
                    now_millis()
                ],
            )
            .map_err(|error| format!("Failed to save bookmark: {error}"))?
    } else {
        connection
            .execute(
                "DELETE FROM book_bookmarks WHERE media_id = ?1 AND page_index = ?2",
                params![media_id, i64::from(page_index)],
            )
            .map_err(|error| format!("Failed to remove bookmark: {error}"))?
    };
    Ok(MutationResult {
        affected: affected as u64,
    })
}

pub fn list_tags(state: &AppState) -> Result<Vec<TagWithCount>, String> {
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(
            "SELECT t.id, t.name, t.color, COUNT(mt.media_id)
             FROM tags t
             LEFT JOIN media_tags mt ON mt.tag_id = t.id
             GROUP BY t.id
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|error| format!("Failed to prepare tag query: {error}"))?;
    statement
        .query_map([], |row| {
            Ok(TagWithCount {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                media_count: nonnegative_u64(row.get(3)?),
            })
        })
        .map_err(|error| format!("Failed to query tags: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read tags: {error}"))
}

pub fn upsert_tag(state: &AppState, input: TagInput) -> Result<Tag, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Tag name cannot be empty".to_owned());
    }
    validate_color(input.color.as_deref())?;
    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_millis();
    let connection = state.database.lock()?;
    connection
        .execute(
            "INSERT INTO tags(id, name, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                color = excluded.color,
                updated_at = excluded.updated_at",
            params![id, name, input.color, now],
        )
        .map_err(|error| format!("Failed to save tag: {error}"))?;
    Ok(Tag {
        id,
        name: name.to_owned(),
        color: input.color,
        source: None,
        confidence: None,
        ai_category: None,
    })
}

pub fn delete_tag(state: &AppState, tag_id: &str) -> Result<MutationResult, String> {
    let connection = state.database.lock()?;
    let affected = connection
        .execute("DELETE FROM tags WHERE id = ?1", [tag_id])
        .map_err(|error| format!("Failed to delete tag: {error}"))?;
    Ok(MutationResult {
        affected: affected as u64,
    })
}

pub fn set_media_tags(
    state: &AppState,
    media_id: &str,
    tag_ids: Vec<String>,
) -> Result<Vec<Tag>, String> {
    let unique_ids: HashSet<String> = tag_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty())
        .collect();
    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to start tag update: {error}"))?;

    ensure_media_exists(&transaction, media_id)?;
    for tag_id in &unique_ids {
        ensure_tag_exists(&transaction, tag_id)?;
    }
    transaction
        .execute(
            "DELETE FROM media_tags WHERE media_id = ?1 AND source = 'user'",
            [media_id],
        )
        .map_err(|error| format!("Failed to clear user media tags: {error}"))?;
    let now = now_millis();
    for tag_id in &unique_ids {
        transaction
            .execute(
                "INSERT INTO media_tags(media_id, tag_id, source, created_at)
                 VALUES (?1, ?2, 'user', ?3)
                 ON CONFLICT(media_id, tag_id) DO NOTHING",
                params![media_id, tag_id, now],
            )
            .map_err(|error| format!("Failed to link tag: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit tag update: {error}"))?;
    drop(connection);

    let connection = state.database.lock()?;
    tags_for_media(&connection, media_id)
}

pub fn get_preferences(state: &AppState) -> Result<Vec<PreferenceEntry>, String> {
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare("SELECT key, value_json, updated_at FROM preferences ORDER BY key")
        .map_err(|error| format!("Failed to prepare preferences query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| format!("Failed to query preferences: {error}"))?;

    rows.map(|row| {
        let (key, json, updated_at) =
            row.map_err(|error| format!("Failed to read preference: {error}"))?;
        let value = serde_json::from_str(&json)
            .map_err(|error| format!("Preference {key} contains invalid JSON: {error}"))?;
        Ok(PreferenceEntry {
            key,
            value,
            updated_at,
        })
    })
    .collect()
}

pub fn set_preference(
    state: &AppState,
    key: &str,
    value: Value,
) -> Result<PreferenceEntry, String> {
    validate_preference_key(key)?;
    let json = serde_json::to_string(&value)
        .map_err(|error| format!("Failed to encode preference: {error}"))?;
    let updated_at = now_millis();
    let connection = state.database.lock()?;
    connection
        .execute(
            "INSERT INTO preferences(key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at",
            params![key, json, updated_at],
        )
        .map_err(|error| format!("Failed to save preference: {error}"))?;
    Ok(PreferenceEntry {
        key: key.to_owned(),
        value,
        updated_at,
    })
}

pub fn delete_preference(state: &AppState, key: &str) -> Result<MutationResult, String> {
    let connection = state.database.lock()?;
    let affected = connection
        .execute("DELETE FROM preferences WHERE key = ?1", [key])
        .map_err(|error| format!("Failed to delete preference: {error}"))?;
    Ok(MutationResult {
        affected: affected as u64,
    })
}

pub fn list_x_history(state: &AppState, limit: Option<u32>) -> Result<Vec<XHistoryItem>, String> {
    let limit = limit.unwrap_or(250).clamp(1, 2_000);
    let connection = state.database.lock()?;
    let mut statement = connection
        .prepare(
            "SELECT id, source_url, media_url, local_path, author, post_text, status,
                    error_message, created_at, completed_at
             FROM video_downloads
             ORDER BY created_at DESC
             LIMIT ?1",
        )
        .map_err(|error| format!("Failed to prepare X history query: {error}"))?;
    statement
        .query_map([limit], x_history_from_row)
        .map_err(|error| format!("Failed to query X history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read X history: {error}"))
}

pub fn upsert_x_history(state: &AppState, input: XHistoryInput) -> Result<XHistoryItem, String> {
    let item = normalize_x_history(input)?;
    let connection = state.database.lock()?;
    upsert_x_history_on(&connection, &item)?;
    Ok(item)
}

pub fn delete_x_history(state: &AppState, history_id: &str) -> Result<MutationResult, String> {
    let connection = state.database.lock()?;
    let affected = connection
        .execute("DELETE FROM video_downloads WHERE id = ?1", [history_id])
        .map_err(|error| format!("Failed to delete X history item: {error}"))?;
    Ok(MutationResult {
        affected: affected as u64,
    })
}

pub fn import_catalog_data(
    state: &AppState,
    payload: CatalogImportPayload,
    dry_run: bool,
) -> Result<ImportCatalogResult, String> {
    let mut issues = validate_import(state, &payload)?;
    let requested_tag_links = payload
        .media_tags
        .iter()
        .map(|item| item.tag_ids.len() as u64)
        .sum();
    let mut result = ImportCatalogResult {
        dry_run,
        preferences: payload.preferences.len() as u64,
        favorites: payload.favorites.len() as u64,
        tags: payload.tags.len() as u64,
        media_tag_links: requested_tag_links,
        x_history: payload.x_history.len() as u64,
        issues: std::mem::take(&mut issues),
    };
    if dry_run || !result.issues.is_empty() {
        return Ok(result);
    }

    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to start catalog import: {error}"))?;
    let now = now_millis();

    for (key, value) in &payload.preferences {
        let json = serde_json::to_string(value)
            .map_err(|error| format!("Failed to encode imported preference: {error}"))?;
        transaction
            .execute(
                "INSERT INTO preferences(key, value_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at",
                params![key, json, now],
            )
            .map_err(|error| format!("Failed to import preference {key}: {error}"))?;
    }
    for favorite in &payload.favorites {
        transaction
            .execute(
                "UPDATE media_items SET is_favorite = ?2, updated_at = ?3 WHERE id = ?1",
                params![favorite.media_id, favorite.is_favorite, now],
            )
            .map_err(|error| format!("Failed to import favorite: {error}"))?;
    }
    for tag in &payload.tags {
        transaction
            .execute(
                "INSERT INTO tags(id, name, color, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    color = excluded.color,
                    updated_at = excluded.updated_at",
                params![tag.id, tag.name.trim(), tag.color, now],
            )
            .map_err(|error| format!("Failed to import tag {}: {error}", tag.id))?;
    }
    for item in &payload.media_tags {
        for tag_id in item.tag_ids.iter().collect::<HashSet<_>>() {
            transaction
                .execute(
                    "INSERT INTO media_tags(media_id, tag_id, source, created_at)
                     VALUES (?1, ?2, 'migration', ?3)
                     ON CONFLICT(media_id, tag_id) DO NOTHING",
                    params![item.media_id, tag_id, now],
                )
                .map_err(|error| format!("Failed to import media tag: {error}"))?;
        }
    }
    for input in payload.x_history {
        let item = normalize_x_history(input)?;
        upsert_x_history_on(&transaction, &item)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit catalog import: {error}"))?;
    result.dry_run = false;
    Ok(result)
}

pub fn resolve_media_path_for_recycle(
    state: &AppState,
    media_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let connection = state.database.lock()?;
    let row: Option<(String, String, bool)> = connection
        .query_row(
            "SELECT r.path, m.relative_path, r.enabled
             FROM media_items m
             JOIN library_roots r ON r.id = m.root_id
             WHERE m.id = ?1",
            [media_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to resolve media item: {error}"))?;
    let (root, relative, enabled) =
        row.ok_or_else(|| "The requested media item was not found".to_owned())?;
    if !enabled {
        return Err("The media item's library root is disabled".to_owned());
    }
    drop(connection);

    let canonical_root = canonical_directory(&root)?;
    let catalog_target = join_catalog_path(&canonical_root, &relative);
    let canonical_target = match catalog_target.canonicalize() {
        Ok(target) => target,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                let _ = mark_media_missing(state, media_id);
            }
            return Err(format!(
                "Cannot resolve media path {}: {error}",
                catalog_target.display()
            ));
        }
    };
    if canonical_target == canonical_root || !canonical_target.starts_with(&canonical_root) {
        return Err("The media path escapes its registered library root".to_owned());
    }
    if !canonical_target.is_file() {
        return Err("Only cataloged files can be sent to the Recycle Bin".to_owned());
    }
    Ok((canonical_root, canonical_target))
}

pub fn resolve_library_folder(
    state: &AppState,
    root_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let connection = state.database.lock()?;
    let row: Option<(String, bool)> = connection
        .query_row(
            "SELECT path, enabled FROM library_roots WHERE id = ?1",
            [root_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to resolve library folder: {error}"))?;
    let (root, enabled) =
        row.ok_or_else(|| "The requested library root was not found".to_owned())?;
    if !enabled {
        return Err("The requested library root is disabled".to_owned());
    }
    drop(connection);

    let canonical_root = canonical_directory(&root)?;
    let catalog_target = join_catalog_path(&canonical_root, relative_path);
    let canonical_target = catalog_target.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve library folder {}: {error}",
            catalog_target.display()
        )
    })?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err("The requested folder escapes its registered library root".to_owned());
    }
    if !canonical_target.is_dir() {
        return Err("The requested catalog path is not a folder".to_owned());
    }
    Ok(canonical_target)
}

pub fn mark_media_recycled(state: &AppState, media_id: &str) -> Result<(), String> {
    mark_media_missing(state, media_id)
}

pub fn mark_media_missing(state: &AppState, media_id: &str) -> Result<(), String> {
    let connection = state.database.lock()?;
    let affected = connection
        .execute(
            "UPDATE media_items SET is_missing = 1, updated_at = ?2 WHERE id = ?1",
            params![media_id, now_millis()],
        )
        .map_err(|error| format!("Failed to update recycled media state: {error}"))?;
    if affected == 0 {
        return Err("The recycled media item no longer exists in the catalog".to_owned());
    }
    Ok(())
}

/// Checks only the media records that are about to be displayed. Missing
/// files are hidden immediately without requiring a full library rescan.
/// Permission and transient I/O errors are intentionally ignored so an
/// unavailable drive is not mistaken for a user deletion.
#[cfg(test)]
pub fn reconcile_missing_media_items(
    state: &AppState,
    media_items: &[MediaItem],
) -> Result<usize, String> {
    let missing_ids = media_items
        .iter()
        .filter(|item| !item.is_missing)
        .filter_map(|item| match std::fs::metadata(&item.absolute_path) {
            Ok(metadata) if !metadata.is_file() => Some(item.id.clone()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(item.id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if missing_ids.is_empty() {
        return Ok(0);
    }

    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start missing media reconciliation: {error}"))?;
    let updated_at = now_millis();
    let mut affected = 0_usize;
    for media_id in &missing_ids {
        affected += transaction
            .execute(
                "UPDATE media_items
                 SET is_missing = 1, updated_at = ?2
                 WHERE id = ?1 AND is_missing = 0",
                params![media_id, updated_at],
            )
            .map_err(|error| format!("Failed to reconcile missing media: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit missing media reconciliation: {error}"))?;
    Ok(affected)
}

/// Marks paths already verified as missing by the asynchronous presence
/// worker. Filesystem access deliberately happens before this function so the
/// catalog write is short and never holds the SQLite mutex during I/O.
pub fn mark_media_ids_missing(state: &AppState, media_ids: &[String]) -> Result<usize, String> {
    if media_ids.is_empty() {
        return Ok(0);
    }
    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start missing media update: {error}"))?;
    let updated_at = now_millis();
    let mut affected = 0_usize;
    {
        let mut statement = transaction
            .prepare_cached(
                "UPDATE media_items
                 SET is_missing = 1, updated_at = ?2
                 WHERE id = ?1 AND is_missing = 0",
            )
            .map_err(|error| format!("Failed to prepare missing media update: {error}"))?;
        for media_id in media_ids {
            affected += statement
                .execute(params![media_id, updated_at])
                .map_err(|error| format!("Failed to mark missing media: {error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit missing media update: {error}"))?;
    Ok(affected)
}

/// Rechecks one source after the renderer reports a load failure. Only an
/// authoritative NotFound/non-file result changes the catalog; offline drives
/// and permission errors remain visible until a later successful scan.
pub fn reconcile_media_load_failure(state: &AppState, media_id: &str) -> Result<bool, String> {
    let candidate = {
        let connection = state.database.lock()?;
        connection
            .query_row(
                "SELECT r.path, m.relative_path, m.is_missing
                 FROM media_items m
                 JOIN library_roots r ON r.id = m.root_id
                 WHERE m.id = ?1",
                [media_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Failed to resolve failed media load: {error}"))?
    };
    let Some((root, relative, already_missing)) = candidate else {
        return Ok(false);
    };
    if already_missing {
        return Ok(false);
    }
    let relative_path = Path::new(&relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Ok(false);
    }
    let path = Path::new(&root).join(relative_path);
    let missing = match std::fs::metadata(path) {
        Ok(metadata) => !metadata.is_file(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    };
    if !missing {
        return Ok(false);
    }
    Ok(mark_media_ids_missing(state, &[media_id.to_owned()])? > 0)
}

fn scan_one_root(state: &AppState, root: LibraryRootRecord) -> Result<RootScanResult, String> {
    let root_path = PathBuf::from(&root.path);
    let mut issues = Vec::new();
    if !root.enabled {
        return Err(format!("Library root {} is disabled", root.id));
    }
    let canonical_root = match root_path.canonicalize() {
        Ok(path) if path.is_dir() => path,
        Ok(_) => {
            return Err(format!(
                "Library root is not a directory: {}",
                root_path.display()
            ));
        }
        Err(error) => {
            return Err(format!(
                "Cannot access library root {}: {error}",
                root_path.display()
            ));
        }
    };
    let previous_active = {
        let connection = state.database.lock()?;
        connection
            .query_row(
                "SELECT COUNT(*) FROM media_items WHERE root_id = ?1 AND is_missing = 0",
                [&root.id],
                |row| row.get::<_, i64>(0),
            )
            .map(nonnegative_u64)
            .map_err(|error| format!("Failed to count active media before scan: {error}"))?
    };

    let mut scanned_files = 0_u64;
    let mut candidates = Vec::new();
    for entry in WalkDir::new(&canonical_root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                push_scan_issue(
                    &mut issues,
                    error
                        .path()
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_else(|| root.path.clone()),
                    error.to_string(),
                );
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        scanned_files += 1;
        let Some((kind, extension, mime_type)) = classify_media(entry.path()) else {
            continue;
        };
        match scan_candidate(&canonical_root, entry.path(), kind, extension, mime_type) {
            Ok(candidate) => candidates.push(candidate),
            Err(message) => push_scan_issue(
                &mut issues,
                entry.path().to_string_lossy().into_owned(),
                message,
            ),
        }
    }
    if scan_result_has_suspicious_mass_drop(previous_active, candidates.len() as u64) {
        push_scan_issue(
            &mut issues,
            root.path.clone(),
            format!(
                "Scan completeness guard preserved missing state: found {} of {} previously visible media",
                candidates.len(),
                previous_active
            ),
        );
    }

    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to start scan reconciliation: {error}"))?;
    transaction
        .execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS scan_seen_paths (
                relative_path TEXT PRIMARY KEY COLLATE NOCASE
             ) WITHOUT ROWID;
             DELETE FROM scan_seen_paths;",
        )
        .map_err(|error| format!("Failed to prepare scan reconciliation: {error}"))?;
    let previous_seen: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(last_seen_at), 0) FROM media_items WHERE root_id = ?1",
            [&root.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to read scan generation: {error}"))?;
    let scan_token = now_millis().max(previous_seen.saturating_add(1));
    let mut inserted = 0_u64;
    let mut updated = 0_u64;

    for candidate in &candidates {
        transaction
            .execute(
                "INSERT OR IGNORE INTO scan_seen_paths(relative_path) VALUES (?1)",
                [&candidate.relative_path],
            )
            .map_err(|error| format!("Failed to record scanned media: {error}"))?;
        let existing: Option<(
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            i64,
            bool,
        )> = transaction
            .query_row(
                "SELECT id, relative_path, file_name, extension, media_kind, mime_type,
                        byte_size, modified_at, is_missing
                 FROM media_items
                 WHERE root_id = ?1 AND relative_path = ?2",
                params![root.id, candidate.relative_path],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Failed to reconcile scanned media: {error}"))?;
        if let Some((
            id,
            relative_path,
            file_name,
            extension,
            media_kind,
            mime_type,
            byte_size,
            modified_at,
            is_missing,
        )) = existing
        {
            let changed = relative_path != candidate.relative_path
                || file_name != candidate.file_name
                || extension != candidate.extension
                || media_kind != candidate.media_kind
                || mime_type != candidate.mime_type
                || byte_size != candidate.byte_size
                || modified_at != candidate.modified_at
                || is_missing;
            if changed {
                transaction
                    .execute(
                        "UPDATE media_items SET
                            relative_path = ?3,
                            file_name = ?4,
                            extension = ?5,
                            media_kind = ?6,
                            mime_type = ?7,
                            byte_size = ?8,
                            modified_at = ?9,
                            is_missing = 0,
                            last_seen_at = ?10,
                            updated_at = ?10
                         WHERE id = ?1 AND root_id = ?2",
                        params![
                            id,
                            root.id,
                            candidate.relative_path,
                            candidate.file_name,
                            candidate.extension,
                            candidate.media_kind,
                            candidate.mime_type,
                            candidate.byte_size,
                            candidate.modified_at,
                            scan_token
                        ],
                    )
                    .map_err(|error| format!("Failed to update scanned media: {error}"))?;
                updated += 1;
            }
        } else {
            transaction
                .execute(
                    "INSERT INTO media_items(
                        id, root_id, relative_path, file_name, extension, media_kind, mime_type,
                        byte_size, modified_at, is_missing, is_favorite,
                        first_seen_at, last_seen_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10, ?10, ?10)",
                    params![
                        Uuid::new_v4().to_string(),
                        root.id,
                        candidate.relative_path,
                        candidate.file_name,
                        candidate.extension,
                        candidate.media_kind,
                        candidate.mime_type,
                        candidate.byte_size,
                        candidate.modified_at,
                        scan_token
                    ],
                )
                .map_err(|error| format!("Failed to insert scanned media: {error}"))?;
            inserted += 1;
        }
    }

    if issues.is_empty() {
        transaction
            .execute(
                "UPDATE media_items
                 SET is_missing = 1, updated_at = ?2
                 WHERE root_id = ?1
                   AND is_missing = 0
                   AND NOT EXISTS (
                       SELECT 1
                       FROM scan_seen_paths seen
                       WHERE seen.relative_path = media_items.relative_path COLLATE NOCASE
                   )",
                params![root.id, scan_token],
            )
            .map_err(|error| format!("Failed to mark missing media: {error}"))?;
    }
    let missing: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM media_items WHERE root_id = ?1 AND is_missing = 1",
            [&root.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count missing media: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit scan: {error}"))?;

    Ok(RootScanResult {
        root_id: root.id,
        scanned_files,
        supported_files: candidates.len() as u64,
        inserted,
        updated,
        missing: nonnegative_u64(missing),
        issues,
    })
}

fn scan_candidate(
    root: &Path,
    path: &Path,
    media_kind: &'static str,
    extension: String,
    mime_type: String,
) -> Result<ScanCandidate, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve file: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("Resolved file escapes the registered library root".to_owned());
    }
    let relative = canonical
        .strip_prefix(root)
        .map_err(|_| "Cannot calculate the path relative to its library root".to_owned())?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
    {
        return Err("Invalid relative media path".to_owned());
    }
    let relative_path = path_to_string(relative)?.replace('\\', "/");
    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "File name is not valid Unicode".to_owned())?
        .to_owned();
    let metadata = canonical
        .metadata()
        .map_err(|error| format!("Cannot read file metadata: {error}"))?;

    Ok(ScanCandidate {
        relative_path,
        file_name,
        extension,
        media_kind: media_kind.to_owned(),
        mime_type,
        byte_size: i64::try_from(metadata.len())
            .map_err(|_| "File is too large for the catalog".to_owned())?,
        modified_at: metadata_modified_millis(&metadata),
    })
}

fn get_root_records(
    state: &AppState,
    root_id: Option<&str>,
) -> Result<Vec<LibraryRootRecord>, String> {
    let connection = state.database.lock()?;
    let mut records = Vec::new();
    if let Some(root_id) = root_id {
        let record = connection
            .query_row(
                "SELECT id, path, display_name, enabled
                 FROM library_roots
                 WHERE id = ?1 AND enabled = 1",
                [root_id],
                |row| {
                    Ok(LibraryRootRecord {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        display_name: row.get(2)?,
                        enabled: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("Failed to query library root: {error}"))?;
        if let Some(record) = record {
            records.push(record);
        }
    } else {
        let mut statement = connection
            .prepare(
                "SELECT id, path, display_name, enabled
                 FROM library_roots
                 WHERE enabled = 1
                 ORDER BY created_at",
            )
            .map_err(|error| format!("Failed to prepare scan root query: {error}"))?;
        records = statement
            .query_map([], |row| {
                Ok(LibraryRootRecord {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    display_name: row.get(2)?,
                    enabled: row.get(3)?,
                })
            })
            .map_err(|error| format!("Failed to query scan roots: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read scan roots: {error}"))?;
    }
    Ok(records)
}

fn query_library_root_by_path(
    connection: &rusqlite::Connection,
    path: &str,
) -> Result<Option<LibraryRoot>, String> {
    connection
        .query_row(
            "SELECT r.id, r.path, r.display_name, r.enabled,
                    COUNT(m.id),
                    COALESCE(SUM(CASE WHEN m.is_missing = 1 THEN 1 ELSE 0 END), 0),
                    r.created_at, r.updated_at
             FROM library_roots r
             LEFT JOIN media_items m ON m.root_id = r.id
             WHERE r.path = ?1
             GROUP BY r.id",
            [path],
            library_root_from_row,
        )
        .optional()
        .map_err(|error| format!("Failed to query registered library root: {error}"))
}

fn library_root_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryRoot> {
    Ok(LibraryRoot {
        id: row.get(0)?,
        path: row.get(1)?,
        display_name: row.get(2)?,
        enabled: row.get(3)?,
        item_count: nonnegative_u64(row.get(4)?),
        missing_count: nonnegative_u64(row.get(5)?),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn tags_for_media(connection: &rusqlite::Connection, media_id: &str) -> Result<Vec<Tag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.id, t.name, t.color, mt.source, mt.confidence, mt.ai_category
             FROM tags t
             JOIN media_tags mt ON mt.tag_id = t.id
             WHERE mt.media_id = ?1
             ORDER BY CASE WHEN mt.source = 'ai' THEN 0 ELSE 1 END,
                      mt.confidence DESC,
                      t.name COLLATE NOCASE",
        )
        .map_err(|error| format!("Failed to prepare media tag query: {error}"))?;
    statement
        .query_map([media_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                source: row.get(3)?,
                confidence: row.get(4)?,
                ai_category: row.get(5)?,
            })
        })
        .map_err(|error| format!("Failed to query media tags: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read media tags: {error}"))
}

fn tags_for_media_ids(
    connection: &rusqlite::Connection,
    media_ids: &[String],
) -> Result<HashMap<String, Vec<Tag>>, String> {
    let mut result: HashMap<String, Vec<Tag>> = HashMap::new();
    for chunk in media_ids.chunks(400) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT mt.media_id, t.id, t.name, t.color,
                    mt.source, mt.confidence, mt.ai_category
             FROM media_tags mt
             JOIN tags t ON t.id = mt.tag_id
             WHERE mt.media_id IN ({placeholders})
             ORDER BY mt.media_id,
                      CASE WHEN mt.source = 'ai' THEN 0 ELSE 1 END,
                      mt.confidence DESC,
                      t.name COLLATE NOCASE"
        );
        let values = chunk
            .iter()
            .cloned()
            .map(SqlValue::Text)
            .collect::<Vec<_>>();
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Failed to prepare batched media tag query: {error}"))?;
        let rows = statement
            .query_map(params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Tag {
                        id: row.get(1)?,
                        name: row.get(2)?,
                        color: row.get(3)?,
                        source: row.get(4)?,
                        confidence: row.get(5)?,
                        ai_category: row.get(6)?,
                    },
                ))
            })
            .map_err(|error| format!("Failed to query batched media tags: {error}"))?;
        for row in rows {
            let (media_id, tag) =
                row.map_err(|error| format!("Failed to read batched media tag: {error}"))?;
            result.entry(media_id).or_default().push(tag);
        }
    }
    Ok(result)
}

fn normalize_age_rating(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_uppercase().replace('-', "").as_str() {
        "SFW" | "SAFE" | "GENERAL" => Ok("SFW".to_owned()),
        "R15" => Ok("R15".to_owned()),
        "R18" => Ok("R18".to_owned()),
        "UNRATED" | "UNSET" | "NONE" => Ok("UNRATED".to_owned()),
        _ => Err("Age rating must be UNRATED, SFW, R15, or R18".to_owned()),
    }
}

fn ensure_media_exists(connection: &rusqlite::Connection, media_id: &str) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM media_items WHERE id = ?1)",
            [media_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to validate media item: {error}"))?;
    if exists {
        Ok(())
    } else {
        Err(format!("Unknown media item: {media_id}"))
    }
}

fn ensure_tag_exists(connection: &rusqlite::Connection, tag_id: &str) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM tags WHERE id = ?1)",
            [tag_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to validate tag: {error}"))?;
    if exists {
        Ok(())
    } else {
        Err(format!("Unknown tag: {tag_id}"))
    }
}

fn validate_import(
    state: &AppState,
    payload: &CatalogImportPayload,
) -> Result<Vec<String>, String> {
    let connection = state.database.lock()?;
    let mut issues = Vec::new();
    for key in payload.preferences.keys() {
        if let Err(error) = validate_preference_key(key) {
            issues.push(error);
        }
    }

    let mut imported_tag_ids = HashSet::new();
    let mut imported_tag_names = HashSet::new();
    for tag in &payload.tags {
        if tag.id.trim().is_empty() {
            issues.push("Imported tag has an empty id".to_owned());
        }
        if tag.name.trim().is_empty() {
            issues.push(format!("Imported tag {} has an empty name", tag.id));
        }
        if !imported_tag_ids.insert(tag.id.clone()) {
            issues.push(format!("Duplicate imported tag id: {}", tag.id));
        }
        if !imported_tag_names.insert(tag.name.trim().to_lowercase()) {
            issues.push(format!("Duplicate imported tag name: {}", tag.name));
        }
        if let Err(error) = validate_color(tag.color.as_deref()) {
            issues.push(format!("Imported tag {}: {error}", tag.id));
        }
    }

    let mut known_media_ids = HashSet::new();
    for favorite in &payload.favorites {
        known_media_ids.insert(favorite.media_id.as_str());
    }
    for item in &payload.media_tags {
        known_media_ids.insert(item.media_id.as_str());
    }
    for media_id in known_media_ids {
        if let Err(error) = ensure_media_exists(&connection, media_id) {
            issues.push(error);
        }
    }
    for item in &payload.media_tags {
        for tag_id in &item.tag_ids {
            if !imported_tag_ids.contains(tag_id)
                && let Err(error) = ensure_tag_exists(&connection, tag_id)
            {
                issues.push(error);
            }
        }
    }
    for item in &payload.x_history {
        if item.source_url.trim().is_empty() {
            issues.push("Imported X history item has an empty source URL".to_owned());
        }
    }
    issues.sort();
    issues.dedup();
    Ok(issues)
}

fn normalize_x_history(input: XHistoryInput) -> Result<XHistoryItem, String> {
    let source_url = input.source_url.trim();
    if source_url.is_empty() {
        return Err("X history source URL cannot be empty".to_owned());
    }
    let status = input.status.unwrap_or_else(|| {
        if input.local_path.is_some() {
            "completed".to_owned()
        } else {
            "queued".to_owned()
        }
    });
    if ![
        "queued",
        "resolving",
        "downloading",
        "completed",
        "failed",
        "cancelled",
    ]
    .contains(&status.as_str())
    {
        return Err(format!("Unsupported X history status: {status}"));
    }
    Ok(XHistoryItem {
        id: input
            .id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        source_url: source_url.to_owned(),
        media_url: input.media_url,
        local_path: input.local_path,
        author: input.author,
        post_text: input.post_text,
        status,
        error_message: input.error_message,
        created_at: input.created_at.unwrap_or_else(now_millis),
        completed_at: input.completed_at,
    })
}

fn upsert_x_history_on(
    connection: &rusqlite::Connection,
    item: &XHistoryItem,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO video_downloads(
                id, source_url, media_url, local_path, author, post_text, status,
                error_message, created_at, completed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                source_url = excluded.source_url,
                media_url = excluded.media_url,
                local_path = excluded.local_path,
                author = excluded.author,
                post_text = excluded.post_text,
                status = excluded.status,
                error_message = excluded.error_message,
                created_at = excluded.created_at,
                completed_at = excluded.completed_at",
            params![
                item.id,
                item.source_url,
                item.media_url,
                item.local_path,
                item.author,
                item.post_text,
                item.status,
                item.error_message,
                item.created_at,
                item.completed_at
            ],
        )
        .map_err(|error| format!("Failed to save X history: {error}"))?;
    Ok(())
}

fn x_history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<XHistoryItem> {
    Ok(XHistoryItem {
        id: row.get(0)?,
        source_url: row.get(1)?,
        media_url: row.get(2)?,
        local_path: row.get(3)?,
        author: row.get(4)?,
        post_text: row.get(5)?,
        status: row.get(6)?,
        error_message: row.get(7)?,
        created_at: row.get(8)?,
        completed_at: row.get(9)?,
    })
}

fn canonical_directory(input_path: &str) -> Result<PathBuf, String> {
    if input_path.trim().is_empty() {
        return Err("Library path cannot be empty".to_owned());
    }
    let input = Path::new(input_path);
    if !input.is_absolute() {
        return Err("Library path must be absolute".to_owned());
    }
    let canonical = input
        .canonicalize()
        .map_err(|error| format!("Cannot access library root {}: {error}", input.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "Library root is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn join_catalog_path(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|component| !component.is_empty())
        .fold(root.to_path_buf(), |path, component| path.join(component))
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Path is not valid Unicode: {}", path.display()))
}

pub(crate) fn classify_media(path: &Path) -> Option<(&'static str, String, String)> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let kind = match extension.as_str() {
        "gif" => "gif",
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "heic" | "heif" | "avif" | "tif" | "tiff" => {
            "image"
        }
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "mpeg" | "mpg" | "ts" | "m2ts" => {
            "video"
        }
        "pdf" => "pdf",
        "zip" | "cbz" => "zip",
        _ => return None,
    };
    let mime_type = match extension.as_str() {
        "cbz" => "application/vnd.comicbook+zip".to_owned(),
        "mkv" => "video/x-matroska".to_owned(),
        "heic" => "image/heic".to_owned(),
        "heif" => "image/heif".to_owned(),
        _ => mime_guess::from_path(path)
            .first_raw()
            .unwrap_or("application/octet-stream")
            .to_owned(),
    };
    Some((kind, extension, mime_type))
}

fn metadata_modified_millis(metadata: &Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn push_scan_issue(issues: &mut Vec<ScanIssue>, path: String, message: String) {
    if issues.len() < MAX_SCAN_ISSUES {
        issues.push(ScanIssue { path, message });
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn optional_u32(value: Option<i64>) -> Option<u32> {
    value.and_then(|value| u32::try_from(value).ok())
}

fn nonnegative_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}

fn validate_color(color: Option<&str>) -> Result<(), String> {
    if let Some(color) = color {
        let valid = color.len() == 7
            && color.starts_with('#')
            && color[1..]
                .chars()
                .all(|character| character.is_ascii_hexdigit());
        if !valid {
            return Err("Tag color must use #RRGGBB format".to_owned());
        }
    }
    Ok(())
}

pub(crate) fn validate_preference_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 128 {
        return Err(format!("Invalid preference key: {key}"));
    }
    if !key
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(format!(
            "Preference key may contain only letters, digits, '.', '_' and '-': {key}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{Duration, Instant},
    };

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;
    use crate::models::{ImportedFavorite, ImportedMediaTags};

    fn initialized_state() -> AppState {
        AppState::in_memory().expect("in-memory state")
    }

    #[test]
    fn suspicious_missing_recovery_requires_a_large_majority_and_live_sample() {
        assert!(should_recover_suspicious_missing_root(
            220_000, 205_000, 16, 16
        ));
        assert!(should_recover_suspicious_missing_root(
            10_000, 8_000, 12, 16
        ));
        assert!(!should_recover_suspicious_missing_root(999, 900, 16, 16));
        assert!(!should_recover_suspicious_missing_root(
            10_000, 4_000, 16, 16
        ));
        assert!(!should_recover_suspicious_missing_root(
            10_000, 8_000, 11, 16
        ));
        assert!(!should_recover_suspicious_missing_root(10_000, 8_000, 7, 7));
    }

    #[test]
    fn mass_drop_guard_preserves_previous_visibility() {
        assert!(scan_result_has_suspicious_mass_drop(220_000, 15_000));
        assert!(scan_result_has_suspicious_mass_drop(1_000, 499));
        assert!(!scan_result_has_suspicious_mass_drop(999, 0));
        assert!(!scan_result_has_suspicious_mass_drop(10_000, 5_000));
    }

    #[test]
    fn registers_scans_queries_and_marks_missing_media() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("photo.JPG"), b"jpeg").expect("image fixture");
        fs::write(directory.path().join("clip.mp4"), b"video").expect("video fixture");
        fs::write(directory.path().join("ignored.txt"), b"text").expect("text fixture");
        let state = initialized_state();

        let root = add_library_root(&state, directory.path().to_str().unwrap()).expect("add root");
        let first = scan_library(&state, Some(&root.id)).expect("first scan");
        assert_eq!(first.supported_files, 2);
        assert_eq!(first.inserted, 2);
        assert_eq!(first.updated, 0);

        let items = list_media_items(&state, None).expect("media items");
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|item| item.kind == "image"));
        assert!(items.iter().any(|item| item.kind == "video"));

        fs::remove_file(directory.path().join("clip.mp4")).expect("remove fixture");
        let second = scan_library(&state, Some(&root.id)).expect("second scan");
        assert_eq!(second.missing, 1);
        assert_eq!(list_media_items(&state, None).unwrap().len(), 1);
        let with_missing = list_media_items(
            &state,
            Some(MediaQuery {
                include_missing: true,
                ..MediaQuery::default()
            }),
        )
        .unwrap();
        assert_eq!(with_missing.len(), 2);
    }

    #[test]
    fn unchanged_rescan_skips_writes_and_changed_media_preserves_user_data() {
        let directory = tempdir().expect("temporary directory");
        let media_path = directory.path().join("photo.jpg");
        fs::write(&media_path, b"image").expect("image fixture");
        let state = initialized_state();
        let root = add_library_root(&state, directory.path().to_str().unwrap()).unwrap();

        let first = scan_library(&state, Some(&root.id)).expect("initial scan");
        assert_eq!(first.inserted, 1);
        assert_eq!(first.updated, 0);
        let media = list_media_items(&state, None).unwrap().remove(0);
        set_favorite(&state, &media.id, true).unwrap();
        let tag = upsert_tag(
            &state,
            TagInput {
                id: None,
                name: "Keep across scans".to_owned(),
                color: None,
            },
        )
        .unwrap();
        set_media_tags(&state, &media.id, vec![tag.id.clone()]).unwrap();
        let before_rescan: (i64, i64) = state
            .database
            .lock()
            .unwrap()
            .query_row(
                "SELECT last_seen_at, updated_at FROM media_items WHERE id = ?1",
                [&media.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        let unchanged = scan_library(&state, Some(&root.id)).expect("unchanged rescan");
        assert_eq!(unchanged.inserted, 0);
        assert_eq!(unchanged.updated, 0);
        let after_rescan: (i64, i64) = state
            .database
            .lock()
            .unwrap()
            .query_row(
                "SELECT last_seen_at, updated_at FROM media_items WHERE id = ?1",
                [&media.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(after_rescan, before_rescan);

        fs::write(&media_path, b"image with changed byte size").expect("changed image fixture");
        let changed = scan_library(&state, Some(&root.id)).expect("changed rescan");
        assert_eq!(changed.inserted, 0);
        assert_eq!(changed.updated, 1);
        let refreshed = list_media_items(
            &state,
            Some(MediaQuery {
                favorite_only: true,
                ..MediaQuery::default()
            }),
        )
        .unwrap();
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].id, media.id);
        assert!(refreshed[0].tags.iter().any(|item| item.id == tag.id));

        fs::remove_file(&media_path).expect("remove image fixture");
        let missing = scan_library(&state, Some(&root.id)).expect("missing scan");
        assert_eq!(missing.missing, 1);
        fs::write(&media_path, b"image with changed byte size").expect("restore image fixture");
        let restored = scan_library(&state, Some(&root.id)).expect("restored scan");
        assert_eq!(restored.inserted, 0);
        assert_eq!(restored.updated, 1);
        assert_eq!(restored.missing, 0);
        let restored_media = list_media_items(&state, None).unwrap().remove(0);
        assert_eq!(restored_media.id, media.id);
        assert!(restored_media.is_favorite);
        assert!(restored_media.tags.iter().any(|item| item.id == tag.id));
    }

    #[test]
    fn visible_page_reconciliation_hides_files_removed_outside_the_app() {
        let directory = tempdir().expect("temporary directory");
        let path = directory.path().join("moved.jpg");
        fs::write(&path, b"image").expect("image fixture");
        let state = initialized_state();
        let root = add_library_root(&state, directory.path().to_str().unwrap()).unwrap();
        scan_library(&state, Some(&root.id)).unwrap();

        let items = list_media_items(&state, None).unwrap();
        assert_eq!(items.len(), 1);
        fs::remove_file(path).expect("simulate an external move or deletion");

        assert_eq!(reconcile_missing_media_items(&state, &items).unwrap(), 1);
        assert!(list_media_items(&state, None).unwrap().is_empty());
    }

    #[test]
    fn renderer_load_failure_marks_only_a_confirmed_missing_file() {
        let directory = tempdir().expect("temporary directory");
        let path = directory.path().join("failed.jpg");
        fs::write(&path, b"image").expect("image fixture");
        let state = initialized_state();
        let root = add_library_root(&state, directory.path().to_str().unwrap()).unwrap();
        scan_library(&state, Some(&root.id)).unwrap();
        let media_id = list_media_items(&state, None).unwrap()[0].id.clone();

        assert!(!reconcile_media_load_failure(&state, &media_id).unwrap());
        fs::remove_file(path).expect("simulate failed renderer source");
        assert!(reconcile_media_load_failure(&state, &media_id).unwrap());
        assert!(!reconcile_media_load_failure(&state, &media_id).unwrap());
        assert!(list_media_items(&state, None).unwrap().is_empty());
    }

    #[test]
    fn page_info_and_multi_kind_paging_share_the_same_filter() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("a.jpg"), b"image").unwrap();
        fs::write(directory.path().join("b.mp4"), b"video").unwrap();
        fs::write(directory.path().join("c.pdf"), b"book").unwrap();
        let state = initialized_state();
        let root = add_library_root(&state, directory.path().to_str().unwrap()).unwrap();
        scan_library(&state, Some(&root.id)).unwrap();

        let base_query = MediaQuery {
            root_id: Some(root.id),
            kinds: vec!["image".to_owned(), "video".to_owned()],
            sort_by: Some("name".to_owned()),
            sort_direction: Some("asc".to_owned()),
            include_date_groups: true,
            ..MediaQuery::default()
        };
        let info = get_media_page_info(&state, Some(base_query.clone())).unwrap();
        assert_eq!(info.total_count, 2);
        assert_eq!(
            info.date_groups
                .iter()
                .map(|group| group.item_count)
                .sum::<u64>(),
            2
        );

        let first = list_media_items(
            &state,
            Some(MediaQuery {
                limit: Some(1),
                offset: Some(0),
                ..base_query.clone()
            }),
        )
        .unwrap();
        let second = list_media_items(
            &state,
            Some(MediaQuery {
                limit: Some(1),
                offset: Some(1),
                ..base_query
            }),
        )
        .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_ne!(first[0].id, second[0].id);
        assert!(matches!(first[0].kind.as_str(), "image" | "video"));
        assert!(matches!(second[0].kind.as_str(), "image" | "video"));
    }

    #[test]
    fn favorite_tags_preferences_and_history_round_trip() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("photo.png"), b"png").expect("image fixture");
        let state = initialized_state();
        let root = add_library_root(&state, directory.path().to_str().unwrap()).unwrap();
        scan_library(&state, Some(&root.id)).unwrap();
        let media = list_media_items(&state, None).unwrap().remove(0);

        set_favorite(&state, &media.id, true).unwrap();
        let tag = upsert_tag(
            &state,
            TagInput {
                id: None,
                name: "Reference".to_owned(),
                color: Some("#112233".to_owned()),
            },
        )
        .unwrap();
        set_media_tags(&state, &media.id, vec![tag.id.clone()]).unwrap();
        set_preference(&state, "viewer.zoom", json!(1.5)).unwrap();
        let history = upsert_x_history(
            &state,
            XHistoryInput {
                id: None,
                source_url: "https://x.com/example/status/1".to_owned(),
                media_url: None,
                local_path: None,
                author: Some("example".to_owned()),
                post_text: None,
                status: None,
                error_message: None,
                created_at: None,
                completed_at: None,
            },
        )
        .unwrap();

        let refreshed = list_media_items(
            &state,
            Some(MediaQuery {
                favorite_only: true,
                ..MediaQuery::default()
            }),
        )
        .unwrap();
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].tags[0].id, tag.id);
        assert_eq!(get_preferences(&state).unwrap()[0].value, json!(1.5));
        assert_eq!(list_x_history(&state, None).unwrap()[0].id, history.id);
    }

    #[test]
    fn physical_folder_filter_matches_only_direct_children() {
        let directory = tempdir().expect("temporary directory");
        fs::create_dir_all(directory.path().join("art").join("nested")).unwrap();
        fs::write(directory.path().join("root.jpg"), b"image").unwrap();
        fs::write(directory.path().join("art").join("page.jpg"), b"image").unwrap();
        fs::write(
            directory.path().join("art").join("nested").join("deep.jpg"),
            b"image",
        )
        .unwrap();
        let state = initialized_state();
        let root = add_library_root(&state, directory.path().to_str().unwrap()).unwrap();
        scan_library(&state, Some(&root.id)).unwrap();

        let direct = list_media_items(
            &state,
            Some(MediaQuery {
                root_id: Some(root.id.clone()),
                folder_path: Some(String::new()),
                ..MediaQuery::default()
            }),
        )
        .unwrap();
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0].file_name, "root.jpg");

        let art = list_media_items(
            &state,
            Some(MediaQuery {
                root_id: Some(root.id),
                folder_path: Some("art".to_owned()),
                ..MediaQuery::default()
            }),
        )
        .unwrap();
        assert_eq!(art.len(), 1);
        assert_eq!(art[0].file_name, "page.jpg");
    }

    #[test]
    fn manual_tag_updates_preserve_ai_owned_tags() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("photo.png"), b"image").unwrap();
        let state = initialized_state();
        let root = add_library_root(&state, directory.path().to_str().unwrap()).unwrap();
        scan_library(&state, Some(&root.id)).unwrap();
        let media_id = list_media_items(&state, None).unwrap().remove(0).id;
        let user_tag = upsert_tag(
            &state,
            TagInput {
                id: None,
                name: "manual".to_owned(),
                color: None,
            },
        )
        .unwrap();
        let ai_tag = upsert_tag(
            &state,
            TagInput {
                id: None,
                name: "ai-result".to_owned(),
                color: None,
            },
        )
        .unwrap();
        state
            .database
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO media_tags(media_id, tag_id, source, confidence, created_at)
                 VALUES (?1, ?2, 'ai', 0.91, 1)",
                params![media_id, ai_tag.id],
            )
            .unwrap();

        set_media_tags(&state, &media_id, vec![user_tag.id.clone()]).unwrap();
        set_media_tags(&state, &media_id, Vec::new()).unwrap();
        let remaining = tags_for_media(&state.database.lock().unwrap(), &media_id).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, ai_tag.id);
    }

    #[test]
    fn catalog_import_is_validated_then_committed_atomically() {
        let directory = tempdir().expect("temporary directory");
        fs::write(directory.path().join("photo.webp"), b"webp").expect("image fixture");
        let state = initialized_state();
        let root = add_library_root(&state, directory.path().to_str().unwrap()).unwrap();
        scan_library(&state, Some(&root.id)).unwrap();
        let media_id = list_media_items(&state, None).unwrap().remove(0).id;
        let payload = CatalogImportPayload {
            preferences: [("theme.mode".to_owned(), json!("dark"))]
                .into_iter()
                .collect(),
            favorites: vec![ImportedFavorite {
                media_id: media_id.clone(),
                is_favorite: true,
            }],
            tags: vec![Tag {
                id: "android-tag-1".to_owned(),
                name: "Imported".to_owned(),
                color: None,
                source: None,
                confidence: None,
                ai_category: None,
            }],
            media_tags: vec![ImportedMediaTags {
                media_id: media_id.clone(),
                tag_ids: vec!["android-tag-1".to_owned()],
            }],
            x_history: Vec::new(),
        };

        let dry_run = import_catalog_data(&state, payload.clone(), true).unwrap();
        assert!(dry_run.dry_run);
        assert!(dry_run.issues.is_empty());
        assert!(get_preferences(&state).unwrap().is_empty());

        let committed = import_catalog_data(&state, payload, false).unwrap();
        assert!(!committed.dry_run);
        assert!(committed.issues.is_empty());
        assert_eq!(get_preferences(&state).unwrap().len(), 1);
        assert!(
            list_media_items(&state, None).unwrap()[0]
                .tags
                .iter()
                .any(|tag| tag.id == "android-tag-1")
        );
    }

    #[test]
    fn rejects_relative_roots_and_invalid_preference_keys() {
        let state = initialized_state();
        assert!(add_library_root(&state, "relative/path").is_err());
        assert!(set_preference(&state, "bad key", json!(true)).is_err());
    }

    #[test]
    fn lightweight_root_query_returns_only_enabled_roots() {
        let state = initialized_state();
        state
            .database
            .lock()
            .expect("database")
            .execute_batch(
                "INSERT INTO library_roots(id, path, display_name, enabled, created_at, updated_at)
                 VALUES
                     ('enabled', 'C:\\Enabled', 'Enabled', 1, 1, 1),
                     ('disabled', 'C:\\Disabled', 'Disabled', 0, 2, 2);",
            )
            .expect("root fixtures");

        let roots = list_enabled_library_root_records(&state).expect("enabled roots");
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, "enabled");
        assert!(roots[0].enabled);
    }

    #[test]
    fn ten_thousand_item_catalog_keeps_bounded_page_queries_responsive() {
        let state = initialized_state();
        {
            let mut connection = state.database.lock().expect("database lock");
            let transaction = connection.transaction().expect("transaction");
            transaction
                .execute(
                    "INSERT INTO library_roots(id, path, display_name, enabled, created_at, updated_at)
                     VALUES ('large-root', 'C:\\LargeLibrary', 'Large library', 1, 1, 1)",
                    [],
                )
                .expect("root");
            {
                let mut insert = transaction
                    .prepare(
                        "INSERT INTO media_items(
                            id, root_id, relative_path, file_name, extension, media_kind,
                            mime_type, byte_size, modified_at, is_missing, is_favorite,
                            first_seen_at, last_seen_at, updated_at
                         ) VALUES (?1, 'large-root', ?2, ?3, 'jpg', 'image',
                                   'image/jpeg', 1024, ?4, 0, 0, 1, 1, 1)",
                    )
                    .expect("insert statement");
                for index in 0..10_000_i64 {
                    let file_name = format!("image-{index:05}.jpg");
                    insert
                        .execute(params![
                            format!("media-{index}"),
                            file_name,
                            file_name,
                            index
                        ])
                        .expect("media insert");
                }
            }
            transaction.commit().expect("commit");
        }

        let started = Instant::now();
        let page = list_media_items(
            &state,
            Some(MediaQuery {
                root_id: Some("large-root".to_owned()),
                kind: Some("image".to_owned()),
                sort_by: Some("modifiedAt".to_owned()),
                sort_direction: Some("desc".to_owned()),
                limit: Some(120),
                offset: Some(4_920),
                ..MediaQuery::default()
            }),
        )
        .expect("large catalog page");
        let elapsed = started.elapsed();
        assert_eq!(page.len(), 120);
        assert!(
            page.windows(2)
                .all(|pair| pair[0].modified_at >= pair[1].modified_at)
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "bounded 10,000-item page query took {elapsed:?}"
        );
        assert_eq!(
            get_library_summary(&state).expect("summary").total_items,
            10_000
        );
    }
}
