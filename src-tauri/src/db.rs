use std::{
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use rusqlite::{Connection, TransactionBehavior};

use crate::DATABASE_SCHEMA_VERSION;

const SCHEMA_V1: &str = r#"
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
);

CREATE TABLE library_roots (
    id TEXT PRIMARY KEY NOT NULL,
    path TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE media_items (
    id TEXT PRIMARY KEY NOT NULL,
    root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL COLLATE NOCASE,
    file_name TEXT NOT NULL,
    extension TEXT NOT NULL,
    media_kind TEXT NOT NULL CHECK(media_kind IN ('image', 'gif', 'video', 'pdf', 'zip')),
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
    modified_at INTEGER NOT NULL,
    is_missing INTEGER NOT NULL DEFAULT 0 CHECK(is_missing IN (0, 1)),
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(root_id, relative_path)
);

CREATE INDEX idx_media_items_root_kind ON media_items(root_id, media_kind);
CREATE INDEX idx_media_items_file_name ON media_items(file_name COLLATE NOCASE);
CREATE INDEX idx_media_items_favorite ON media_items(is_favorite) WHERE is_favorite = 1;
CREATE INDEX idx_media_items_missing ON media_items(is_missing) WHERE is_missing = 1;

CREATE TABLE media_metadata (
    media_id TEXT PRIMARY KEY NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    page_count INTEGER,
    sha256 TEXT,
    age_rating TEXT,
    android_identity TEXT,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_media_metadata_sha256
    ON media_metadata(sha256)
    WHERE sha256 IS NOT NULL;
CREATE INDEX idx_media_metadata_android_identity
    ON media_metadata(android_identity)
    WHERE android_identity IS NOT NULL;

CREATE TABLE tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE media_tags (
    media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'user',
    confidence REAL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(media_id, tag_id)
);

CREATE INDEX idx_media_tags_tag ON media_tags(tag_id, media_id);

CREATE TABLE tag_translations (
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    locale TEXT NOT NULL,
    display_name TEXT NOT NULL,
    PRIMARY KEY(tag_id, locale)
);

CREATE TABLE folder_groups (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE folder_group_members (
    group_id TEXT NOT NULL REFERENCES folder_groups(id) ON DELETE CASCADE,
    root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    relative_folder TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(group_id, root_id, relative_folder)
);

CREATE TABLE video_downloads (
    id TEXT PRIMARY KEY NOT NULL,
    source_url TEXT NOT NULL,
    media_url TEXT,
    local_path TEXT,
    author TEXT,
    post_text TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE INDEX idx_video_downloads_created ON video_downloads(created_at DESC);
CREATE INDEX idx_video_downloads_source ON video_downloads(source_url);

CREATE TABLE reference_projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE reference_items (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES reference_projects(id) ON DELETE CASCADE,
    media_id TEXT REFERENCES media_items(id) ON DELETE SET NULL,
    external_path TEXT,
    note TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    CHECK(media_id IS NOT NULL OR external_path IS NOT NULL)
);

CREATE INDEX idx_reference_items_project ON reference_items(project_id, sort_order);

CREATE TABLE book_bookmarks (
    id TEXT PRIMARY KEY NOT NULL,
    media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    page_index INTEGER NOT NULL CHECK(page_index >= 0),
    label TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(media_id, page_index)
);

CREATE TABLE preferences (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE migration_runs (
    id TEXT PRIMARY KEY NOT NULL,
    format_version INTEGER NOT NULL,
    source_name TEXT,
    source_sha256 TEXT,
    dry_run INTEGER NOT NULL CHECK(dry_run IN (0, 1)),
    status TEXT NOT NULL,
    summary_json TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE TABLE migration_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
    severity TEXT NOT NULL,
    entity_type TEXT,
    source_identity TEXT,
    message TEXT NOT NULL
);

CREATE INDEX idx_migration_issues_run ON migration_issues(run_id, severity);
"#;

const SCHEMA_V2: &str = r#"
ALTER TABLE media_metadata
    ADD COLUMN age_rating_source TEXT NOT NULL DEFAULT 'default'
    CHECK(age_rating_source IN ('default', 'user', 'ai'));
ALTER TABLE media_metadata
    ADD COLUMN is_ai_analyzed INTEGER NOT NULL DEFAULT 0
    CHECK(is_ai_analyzed IN (0, 1));
ALTER TABLE media_metadata ADD COLUMN ai_analysis_model TEXT;
ALTER TABLE media_metadata ADD COLUMN ai_analyzed_at INTEGER;

-- Ratings created before source tracking existed may have been chosen by the
-- user. Marking them as user-owned prevents a later AI pass from replacing
-- them.
UPDATE media_metadata
SET age_rating_source = 'user'
WHERE age_rating IS NOT NULL;
"#;

const SCHEMA_V3: &str = r#"
ALTER TABLE media_tags ADD COLUMN ai_category TEXT;
ALTER TABLE media_metadata
    ADD COLUMN ai_analysis_level TEXT
    CHECK(ai_analysis_level IS NULL OR ai_analysis_level IN ('standard', 'detailed'));
"#;

const SCHEMA_V4: &str = r#"
CREATE INDEX idx_media_items_present_modified
    ON media_items(modified_at DESC, file_name COLLATE NOCASE)
    WHERE is_missing = 0;
CREATE INDEX idx_media_items_kind_present_modified
    ON media_items(media_kind, modified_at DESC, file_name COLLATE NOCASE)
    WHERE is_missing = 0;
CREATE INDEX idx_media_items_root_kind_present_modified
    ON media_items(root_id, media_kind, modified_at DESC, file_name COLLATE NOCASE)
    WHERE is_missing = 0;
CREATE INDEX idx_media_items_root_folder_kind_present_modified
    ON media_items(
        root_id,
        (CASE
            WHEN relative_path = file_name THEN ''
            ELSE substr(relative_path, 1, length(relative_path) - length(file_name) - 1)
         END) COLLATE NOCASE,
        media_kind,
        modified_at DESC,
        file_name COLLATE NOCASE
    )
    WHERE is_missing = 0;
DROP INDEX IF EXISTS idx_media_items_root_kind;
ANALYZE;
"#;

const SCHEMA_V5: &str = r#"
CREATE TABLE media_visual_vectors (
    media_id TEXT PRIMARY KEY NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    model_version INTEGER NOT NULL,
    source_modified_at INTEGER NOT NULL,
    source_byte_size INTEGER NOT NULL,
    dimensions INTEGER NOT NULL,
    vector_blob BLOB,
    error_message TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_media_visual_vectors_fingerprint
    ON media_visual_vectors(model_version, source_modified_at, source_byte_size);
"#;

const SCHEMA_V6: &str = r#"
CREATE TABLE folder_hierarchy_cache (
    root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
    relative_folder TEXT NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    root_updated_at INTEGER NOT NULL,
    refreshed_at INTEGER NOT NULL,
    PRIMARY KEY(root_id, relative_folder)
);
CREATE INDEX idx_folder_hierarchy_cache_root
    ON folder_hierarchy_cache(root_id, relative_folder COLLATE NOCASE);

-- Existing libraries should stay responsive immediately after upgrading.
-- The root marker makes the empty cache valid; the next explicit catalog scan
-- fills it with the complete physical hierarchy.
INSERT INTO folder_hierarchy_cache(
    root_id, relative_folder, display_name, root_path, root_updated_at, refreshed_at
)
SELECT id, '', display_name, path, updated_at,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM library_roots
WHERE enabled = 1;
"#;

const SCHEMA_V7: &str = r#"
-- AI tags are derived data. Remove results from older detailed analyses that
-- used a lower threshold so every retained AI tag follows the current 60%
-- confidence contract.
DELETE FROM media_tags
WHERE source = 'ai'
  AND (confidence IS NULL OR confidence < 0.60);
"#;

const SCHEMA_V8: &str = r#"
CREATE TABLE x_downloaded_media (
    source_url TEXT NOT NULL COLLATE NOCASE,
    media_key TEXT NOT NULL,
    destination_dir TEXT NOT NULL COLLATE NOCASE,
    history_id TEXT REFERENCES video_downloads(id) ON DELETE SET NULL,
    variant_url TEXT NOT NULL,
    local_path TEXT NOT NULL COLLATE NOCASE,
    media_kind TEXT NOT NULL CHECK(media_kind IN ('image', 'gif', 'video')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY(source_url, media_key, destination_dir)
);
CREATE INDEX idx_x_downloaded_media_history
    ON x_downloaded_media(history_id);
CREATE INDEX idx_x_downloaded_media_status
    ON x_downloaded_media(status, completed_at DESC);
"#;

const SCHEMA_V9: &str = r#"
-- File identity is deliberately separate from user metadata: it is a local,
-- best-effort scan cache, not a portable identifier for another computer.
CREATE TABLE media_file_identities (
    media_id TEXT PRIMARY KEY NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    file_identity TEXT NOT NULL
);
CREATE INDEX idx_media_file_identities_identity
    ON media_file_identities(file_identity);
"#;

pub struct Database {
    connection: Mutex<Connection>,
    path: PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create database directory {}: {error}",
                    parent.display()
                )
            })?;
        }

        let connection = Connection::open(path)
            .map_err(|error| format!("Failed to open database {}: {error}", path.display()))?;
        Self::from_connection(connection, path.to_path_buf())
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self, String> {
        let connection = Connection::open_in_memory()
            .map_err(|error| format!("Failed to open in-memory database: {error}"))?;
        Self::from_connection(connection, PathBuf::from(":memory:"))
    }

    fn from_connection(mut connection: Connection, path: PathBuf) -> Result<Self, String> {
        configure_connection(&connection)?;
        migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            path,
        })
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "The catalog database lock is poisoned".to_owned())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub struct AppState {
    pub database: Database,
}

impl AppState {
    pub fn open(database_path: &Path) -> Result<Self, String> {
        Ok(Self {
            database: Database::open(database_path)?,
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self, String> {
        Ok(Self {
            database: Database::in_memory()?,
        })
    }
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA journal_size_limit = 67108864;",
        )
        .map_err(|error| format!("Failed to configure SQLite: {error}"))
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    let mut current_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Failed to read database schema version: {error}"))?;

    if current_version > DATABASE_SCHEMA_VERSION {
        return Err(format!(
            "Database schema version {current_version} is newer than this application supports ({DATABASE_SCHEMA_VERSION})"
        ));
    }

    if current_version == 0 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Failed to start schema migration: {error}"))?;
        transaction
            .execute_batch(SCHEMA_V1)
            .map_err(|error| format!("Failed to create schema version 1: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (?1, 'initial catalog', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [1_u32],
            )
            .map_err(|error| format!("Failed to record schema migration: {error}"))?;
        transaction
            .pragma_update(None, "user_version", 1_u32)
            .map_err(|error| format!("Failed to update schema version: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit schema migration: {error}"))?;
        current_version = 1;
    }

    if current_version < 2 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Failed to start AI metadata migration: {error}"))?;
        transaction
            .execute_batch(SCHEMA_V2)
            .map_err(|error| format!("Failed to create schema version 2: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (2, 'AI analysis metadata ownership', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(|error| format!("Failed to record AI metadata migration: {error}"))?;
        transaction
            .pragma_update(None, "user_version", 2_u32)
            .map_err(|error| format!("Failed to update AI metadata schema version: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit AI metadata migration: {error}"))?;
        current_version = 2;
    }

    if current_version < 3 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Failed to start AI analysis level migration: {error}"))?;
        transaction
            .execute_batch(SCHEMA_V3)
            .map_err(|error| format!("Failed to create schema version 3: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (3, 'AI analysis levels and tag categories', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(|error| format!("Failed to record AI analysis level migration: {error}"))?;
        transaction
            .pragma_update(None, "user_version", 3_u32)
            .map_err(|error| {
                format!("Failed to update AI analysis level schema version: {error}")
            })?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit AI analysis level migration: {error}"))?;
        current_version = 3;
    }

    if current_version < 4 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Failed to start media query index migration: {error}"))?;
        transaction
            .execute_batch(SCHEMA_V4)
            .map_err(|error| format!("Failed to create schema version 4: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (4, 'large library media query indexes', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(|error| format!("Failed to record media query index migration: {error}"))?;
        transaction
            .pragma_update(None, "user_version", 4_u32)
            .map_err(|error| {
                format!("Failed to update media query index schema version: {error}")
            })?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit media query index migration: {error}"))?;
        current_version = 4;
    }

    if current_version < 5 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Failed to start visual vector cache migration: {error}"))?;
        transaction
            .execute_batch(SCHEMA_V5)
            .map_err(|error| format!("Failed to create schema version 5: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (5, 'persistent visual feature vectors', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(|error| format!("Failed to record visual vector migration: {error}"))?;
        transaction
            .pragma_update(None, "user_version", 5_u32)
            .map_err(|error| format!("Failed to update visual vector schema version: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit visual vector migration: {error}"))?;
        current_version = 5;
    }

    if current_version < 6 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                format!("Failed to start folder hierarchy cache migration: {error}")
            })?;
        transaction
            .execute_batch(SCHEMA_V6)
            .map_err(|error| format!("Failed to create schema version 6: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (6, 'persistent folder hierarchy cache', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(|error| format!("Failed to record folder hierarchy cache migration: {error}"))?;
        transaction
            .pragma_update(None, "user_version", 6_u32)
            .map_err(|error| {
                format!("Failed to update folder hierarchy cache schema version: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("Failed to commit folder hierarchy cache migration: {error}")
        })?;
        current_version = 6;
    }

    if current_version < 7 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                format!("Failed to start AI confidence threshold migration: {error}")
            })?;
        transaction
            .execute_batch(SCHEMA_V7)
            .map_err(|error| format!("Failed to normalize AI tag confidence: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (7, 'AI tag confidence threshold 60 percent', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(|error| {
                format!("Failed to record AI confidence threshold migration: {error}")
            })?;
        transaction
            .pragma_update(None, "user_version", 7_u32)
            .map_err(|error| format!("Failed to update AI confidence schema version: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("Failed to commit AI confidence threshold migration: {error}")
        })?;
        current_version = 7;
    }

    if current_version < 8 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Failed to start X duplicate tracking migration: {error}"))?;
        transaction
            .execute_batch(SCHEMA_V8)
            .map_err(|error| format!("Failed to create X duplicate tracking schema: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (8, 'X media duplicate tracking', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(|error| format!("Failed to record X duplicate tracking migration: {error}"))?;
        transaction
            .pragma_update(None, "user_version", 8_u32)
            .map_err(|error| {
                format!("Failed to update X duplicate tracking schema version: {error}")
            })?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit X duplicate tracking migration: {error}"))?;
        current_version = 8;
    }

    if current_version < 9 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Failed to start file identity migration: {error}"))?;
        transaction
            .execute_batch(SCHEMA_V9)
            .map_err(|error| format!("Failed to create file identity schema: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (9, 'stable local file identities', CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
                [],
            )
            .map_err(|error| format!("Failed to record file identity migration: {error}"))?;
        transaction
            .pragma_update(None, "user_version", 9_u32)
            .map_err(|error| format!("Failed to update file identity schema version: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit file identity migration: {error}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_all_schema_tables() {
        let database = Database::in_memory().expect("database should initialize");
        let connection = database.lock().expect("database lock");
        let mut statement = connection
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .expect("table query");
        let names: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .expect("table rows")
            .collect::<Result<_, _>>()
            .expect("table values");

        for expected in [
            "library_roots",
            "media_items",
            "media_metadata",
            "media_tags",
            "tag_translations",
            "folder_groups",
            "folder_group_members",
            "video_downloads",
            "reference_projects",
            "reference_items",
            "book_bookmarks",
            "preferences",
            "migration_runs",
            "migration_issues",
            "media_visual_vectors",
            "folder_hierarchy_cache",
            "x_downloaded_media",
            "media_file_identities",
        ] {
            assert!(names.iter().any(|name| name == expected), "{expected}");
        }

        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        assert_eq!(version, DATABASE_SCHEMA_VERSION);

        let metadata_columns: Vec<String> = connection
            .prepare("PRAGMA table_info(media_metadata)")
            .expect("metadata column query")
            .query_map([], |row| row.get(1))
            .expect("metadata columns")
            .collect::<Result<_, _>>()
            .expect("metadata column names");
        for expected in [
            "age_rating_source",
            "is_ai_analyzed",
            "ai_analysis_model",
            "ai_analyzed_at",
            "ai_analysis_level",
        ] {
            assert!(
                metadata_columns.iter().any(|column| column == expected),
                "{expected}"
            );
        }

        let media_tag_columns: Vec<String> = connection
            .prepare("PRAGMA table_info(media_tags)")
            .expect("media tag column query")
            .query_map([], |row| row.get(1))
            .expect("media tag columns")
            .collect::<Result<_, _>>()
            .expect("media tag column names");
        assert!(
            media_tag_columns
                .iter()
                .any(|column| column == "ai_category")
        );

        let media_indexes: Vec<String> = connection
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'index' AND tbl_name = 'media_items'
                 ORDER BY name",
            )
            .expect("media index query")
            .query_map([], |row| row.get(0))
            .expect("media index rows")
            .collect::<Result<_, _>>()
            .expect("media index names");
        for expected in [
            "idx_media_items_present_modified",
            "idx_media_items_kind_present_modified",
            "idx_media_items_root_kind_present_modified",
            "idx_media_items_root_folder_kind_present_modified",
        ] {
            assert!(
                media_indexes.iter().any(|index| index == expected),
                "{expected}"
            );
        }
    }

    #[test]
    fn migration_marks_existing_ratings_as_user_owned() {
        let mut connection = Connection::open_in_memory().expect("open legacy database");
        configure_connection(&connection).expect("configure legacy database");
        connection
            .execute_batch(SCHEMA_V1)
            .expect("initialize legacy schema");
        connection
            .execute_batch(
                "INSERT INTO schema_migrations(version, name, applied_at)
                 VALUES (1, 'initial catalog', 1);
                 INSERT INTO library_roots(
                    id, path, display_name, enabled, created_at, updated_at
                 ) VALUES ('root', 'C:\\media', 'media', 1, 1, 1);
                 INSERT INTO media_items(
                    id, root_id, relative_path, file_name, extension, media_kind,
                    mime_type, byte_size, modified_at, first_seen_at, last_seen_at,
                    updated_at
                 ) VALUES (
                    'media', 'root', 'image.png', 'image.png', 'png', 'image',
                    'image/png', 1, 1, 1, 1, 1
                 );
                 INSERT INTO media_metadata(media_id, age_rating, updated_at)
                 VALUES ('media', 'R15', 1);
                 INSERT INTO tags(id, name, created_at, updated_at)
                 VALUES
                    ('low-tag', 'low confidence', 1, 1),
                    ('high-tag', 'high confidence', 1, 1);
                 INSERT INTO media_tags(media_id, tag_id, source, confidence, created_at)
                 VALUES
                    ('media', 'low-tag', 'ai', 0.59, 1),
                    ('media', 'high-tag', 'ai', 0.60, 1);
                 PRAGMA user_version = 1;",
            )
            .expect("seed legacy database");

        migrate(&mut connection).expect("migrate to current schema");
        let source: String = connection
            .query_row(
                "SELECT age_rating_source FROM media_metadata WHERE media_id = 'media'",
                [],
                |row| row.get(0),
            )
            .expect("rating source");
        assert_eq!(source, "user");
        let folder_cache_marker: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM folder_hierarchy_cache
                 WHERE root_id = 'root' AND relative_folder = ''",
                [],
                |row| row.get(0),
            )
            .expect("folder hierarchy cache marker");
        assert_eq!(folder_cache_marker, 1);
        let remaining_ai_tags: Vec<String> = connection
            .prepare(
                "SELECT tag_id FROM media_tags
                 WHERE media_id = 'media' AND source = 'ai'
                 ORDER BY tag_id",
            )
            .expect("AI confidence migration query")
            .query_map([], |row| row.get(0))
            .expect("AI confidence migration rows")
            .collect::<Result<_, _>>()
            .expect("AI confidence migration values");
        assert_eq!(remaining_ai_tags, vec!["high-tag".to_owned()]);
    }
}
