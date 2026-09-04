#[cfg(test)]
use rusqlite::params;
use rusqlite::{OptionalExtension, params_from_iter, types::Value as SqlValue};
use serde::Serialize;
use walkdir::WalkDir;

use crate::db::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFolder {
    pub root_id: String,
    pub relative_folder: String,
    pub display_name: String,
    pub item_count: u64,
}

#[derive(Debug, Clone)]
struct PhysicalRoot {
    id: String,
    path: String,
    display_name: String,
    updated_at: i64,
}

/// Lists physical folders that currently contain cataloged media.
///
/// `relative_folder` is normalized with `/` separators. An empty value means
/// media stored directly below the registered library root.
pub fn list_media_folders(
    state: &AppState,
    root_id: Option<&str>,
    kinds_csv: Option<&str>,
    refresh_physical: bool,
) -> Result<Vec<MediaFolder>, String> {
    let normalized_kinds = kinds_csv
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|kind| !kind.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(kind) = normalized_kinds
        .iter()
        .find(|kind| !matches!(**kind, "image" | "gif" | "video" | "pdf" | "zip"))
    {
        return Err(format!("Unsupported media kind for folder listing: {kind}"));
    }
    let normalized_kinds = (!normalized_kinds.is_empty()).then(|| normalized_kinds.join(","));
    let include_physical_folders = normalized_kinds.is_none() && root_id.is_some();
    let (mut folders, physical_roots) = {
        let connection = state.database.lock()?;
        let mut sql = String::from(
            "WITH folder_counts AS (
                 SELECT m.root_id,
                        (
                            CASE
                                WHEN m.relative_path = m.file_name THEN ''
                                ELSE substr(
                                    m.relative_path,
                                    1,
                                    length(m.relative_path) - length(m.file_name) - 1
                                )
                            END COLLATE NOCASE
                        ) AS relative_folder,
                        COUNT(*) AS item_count
                 FROM media_items m
                 WHERE m.is_missing = 0",
        );
        let mut values = Vec::new();
        if let Some(root_id) = root_id {
            sql.push_str(" AND m.root_id = ?");
            values.push(SqlValue::Text(root_id.to_owned()));
        }
        if let Some(kinds) = normalized_kinds {
            sql.push_str(" AND instr(',' || ? || ',', ',' || m.media_kind || ',') > 0");
            values.push(SqlValue::Text(kinds));
        }
        sql.push_str(
            " GROUP BY m.root_id, relative_folder
             )
             SELECT f.root_id, r.display_name, f.relative_folder, f.item_count
             FROM folder_counts f
             JOIN library_roots r ON r.id = f.root_id
             WHERE r.enabled = 1
             ORDER BY r.display_name COLLATE NOCASE,
                      f.relative_folder COLLATE NOCASE",
        );
        let folders = {
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("Failed to prepare media folder query: {error}"))?;
            let rows = statement
                .query_map(params_from_iter(values), |row| {
                    let root_id: String = row.get(0)?;
                    let root_display_name: String = row.get(1)?;
                    let relative_folder: String = row.get(2)?;
                    let item_count: i64 = row.get(3)?;
                    let display_name = relative_folder
                        .rsplit('/')
                        .find(|segment| !segment.is_empty())
                        .unwrap_or(&root_display_name)
                        .to_owned();
                    Ok(MediaFolder {
                        root_id,
                        relative_folder,
                        display_name,
                        item_count: u64::try_from(item_count).unwrap_or_default(),
                    })
                })
                .map_err(|error| format!("Failed to query media folders: {error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read media folders: {error}"))?
        };
        let physical_roots = if include_physical_folders {
            let mut statement = connection
                .prepare(
                    "SELECT id, path, display_name, updated_at
                     FROM library_roots
                     WHERE enabled = 1 AND id = ?",
                )
                .map_err(|error| format!("Failed to prepare physical folder query: {error}"))?;
            let rows = statement
                .query_map([root_id.unwrap_or_default()], |row| {
                    Ok(PhysicalRoot {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        display_name: row.get(2)?,
                        updated_at: row.get(3)?,
                    })
                })
                .map_err(|error| format!("Failed to query physical folders: {error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read physical folders: {error}"))?
        } else {
            Vec::new()
        };
        (folders, physical_roots)
    };

    if include_physical_folders {
        let mut known = folders
            .iter()
            .map(|folder| (folder.root_id.clone(), folder.relative_folder.clone()))
            .collect::<std::collections::HashSet<_>>();
        for physical_root in physical_roots {
            let (cache_is_current, cached) = cached_physical_folders(state, &physical_root)?;
            let physical_folders = if !refresh_physical && cache_is_current {
                cached
            } else {
                // An unavailable/offline root must not hide its cataloged
                // folders. Keep the last persistent hierarchy (if any), and
                // otherwise return just the catalog-derived entries.
                refresh_physical_root_cache(state, &physical_root).unwrap_or(cached)
            };
            for physical_folder in physical_folders {
                if !known.insert((
                    physical_folder.root_id.clone(),
                    physical_folder.relative_folder.clone(),
                )) {
                    continue;
                }
                folders.push(MediaFolder {
                    root_id: physical_folder.root_id,
                    relative_folder: physical_folder.relative_folder,
                    display_name: physical_folder.display_name,
                    item_count: 0,
                });
            }
        }
        folders.sort_by(|left, right| {
            left.root_id.cmp(&right.root_id).then_with(|| {
                left.relative_folder
                    .to_lowercase()
                    .cmp(&right.relative_folder.to_lowercase())
            })
        });
    }

    Ok(folders)
}

/// Refreshes the persistent physical hierarchy after a catalog scan. Normal
/// folder listings can then return without walking a large library again.
pub fn invalidate_folder_hierarchy_cache(
    state: &AppState,
    root_id: Option<&str>,
) -> Result<(), String> {
    let connection = state.database.lock()?;
    connection.execute("DELETE FROM folder_hierarchy_cache WHERE relative_folder = '' AND (?1 IS NULL OR root_id = ?1)", [root_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn refresh_folder_hierarchy_cache(
    state: &AppState,
    root_id: Option<&str>,
) -> Result<(), String> {
    let physical_roots = {
        let connection = state.database.lock()?;
        let mut sql = String::from(
            "SELECT id, path, display_name, updated_at
             FROM library_roots
             WHERE enabled = 1",
        );
        let mut values = Vec::new();
        if let Some(root_id) = root_id {
            sql.push_str(" AND id = ?");
            values.push(SqlValue::Text(root_id.to_owned()));
        }
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Failed to prepare folder cache roots: {error}"))?;
        statement
            .query_map(params_from_iter(values), |row| {
                Ok(PhysicalRoot {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    display_name: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|error| format!("Failed to query folder cache roots: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read folder cache roots: {error}"))?
    };
    for physical_root in physical_roots {
        refresh_physical_root_cache(state, &physical_root)?;
    }
    Ok(())
}

fn cached_physical_folders(
    state: &AppState,
    root: &PhysicalRoot,
) -> Result<(bool, Vec<MediaFolder>), String> {
    let connection = state.database.lock()?;
    let marker_matches = connection
        .query_row(
            "SELECT root_path = ?2 AND root_updated_at = ?3
             FROM folder_hierarchy_cache
             WHERE root_id = ?1 AND relative_folder = ''",
            rusqlite::params![root.id, root.path, root.updated_at],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to validate folder hierarchy cache: {error}"))?
        .unwrap_or(false);
    let mut statement = connection
        .prepare(
            "SELECT relative_folder, display_name
             FROM folder_hierarchy_cache
             WHERE root_id = ?1 AND relative_folder <> ''
             ORDER BY relative_folder COLLATE NOCASE",
        )
        .map_err(|error| format!("Failed to prepare cached folder hierarchy: {error}"))?;
    let folders = statement
        .query_map([&root.id], |row| {
            Ok(MediaFolder {
                root_id: root.id.clone(),
                relative_folder: row.get(0)?,
                display_name: row.get(1)?,
                item_count: 0,
            })
        })
        .map_err(|error| format!("Failed to query cached folder hierarchy: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read cached folder hierarchy: {error}"))?;
    Ok((marker_matches, folders))
}

fn refresh_physical_root_cache(
    state: &AppState,
    root: &PhysicalRoot,
) -> Result<Vec<MediaFolder>, String> {
    let root_path = std::path::Path::new(&root.path);
    if !root_path.is_dir() {
        return Err(format!(
            "Library root is not an accessible directory: {}",
            root_path.display()
        ));
    }
    let mut folders = WalkDir::new(root_path)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
        .filter_map(|entry| {
            let relative = entry.path().strip_prefix(root_path).ok()?;
            let components = relative
                .components()
                .map(|component| component.as_os_str().to_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?;
            let relative_folder = components.join("/");
            if relative_folder.is_empty() {
                return None;
            }
            let display_name = components
                .last()
                .cloned()
                .unwrap_or_else(|| root.display_name.clone());
            Some(MediaFolder {
                root_id: root.id.clone(),
                relative_folder,
                display_name,
                item_count: 0,
            })
        })
        .collect::<Vec<_>>();
    folders.sort_by(|left, right| {
        left.relative_folder
            .to_lowercase()
            .cmp(&right.relative_folder.to_lowercase())
    });
    folders.dedup_by(|left, right| {
        left.relative_folder
            .eq_ignore_ascii_case(&right.relative_folder)
    });

    let refreshed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    let mut connection = state.database.lock()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to update folder hierarchy cache: {error}"))?;
    transaction
        .execute(
            "DELETE FROM folder_hierarchy_cache WHERE root_id = ?1",
            [&root.id],
        )
        .map_err(|error| format!("Failed to clear stale folder hierarchy cache: {error}"))?;
    transaction
        .execute(
            "INSERT INTO folder_hierarchy_cache(
                root_id, relative_folder, display_name, root_path, root_updated_at, refreshed_at
             ) VALUES (?1, '', ?2, ?3, ?4, ?5)",
            rusqlite::params![
                root.id,
                root.display_name,
                root.path,
                root.updated_at,
                refreshed_at
            ],
        )
        .map_err(|error| format!("Failed to write folder hierarchy cache marker: {error}"))?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO folder_hierarchy_cache(
                    root_id, relative_folder, display_name, root_path, root_updated_at, refreshed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|error| format!("Failed to prepare folder hierarchy cache write: {error}"))?;
        for folder in &folders {
            statement
                .execute(rusqlite::params![
                    root.id,
                    folder.relative_folder,
                    folder.display_name,
                    root.path,
                    root.updated_at,
                    refreshed_at
                ])
                .map_err(|error| format!("Failed to write cached folder hierarchy: {error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit folder hierarchy cache: {error}"))?;
    Ok(folders)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::AppState;

    fn insert_root(state: &AppState, id: &str, name: &str) {
        state
            .database
            .lock()
            .expect("database lock")
            .execute(
                "INSERT INTO library_roots(
                    id, path, display_name, enabled, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![id, format!("C:/{id}"), name],
            )
            .expect("insert library root");
    }

    fn insert_media(state: &AppState, id: &str, root_id: &str, relative_path: &str) {
        let file_name = relative_path.rsplit('/').next().expect("fixture file name");
        state
            .database
            .lock()
            .expect("database lock")
            .execute(
                "INSERT INTO media_items(
                    id, root_id, relative_path, file_name, extension, media_kind,
                    mime_type, byte_size, modified_at, is_missing, is_favorite,
                    first_seen_at, last_seen_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, 'jpg', 'image',
                    'image/jpeg', 10, 1, 0, 0, 1, 1, 1
                 )",
                params![id, root_id, relative_path, file_name],
            )
            .expect("insert media");
    }

    #[test]
    fn aggregates_direct_and_nested_physical_folders() {
        let state = AppState::in_memory().expect("in-memory state");
        insert_root(&state, "root-a", "Pictures");
        insert_media(&state, "one", "root-a", "cover.jpg");
        insert_media(&state, "two", "root-a", "art/page1.jpg");
        insert_media(&state, "three", "root-a", "art/page2.jpg");
        insert_media(&state, "four", "root-a", "art/2026/page3.jpg");

        let folders = list_media_folders(&state, Some("root-a"), None, false).expect("folder list");
        assert_eq!(
            folders,
            vec![
                MediaFolder {
                    root_id: "root-a".to_owned(),
                    relative_folder: String::new(),
                    display_name: "Pictures".to_owned(),
                    item_count: 1,
                },
                MediaFolder {
                    root_id: "root-a".to_owned(),
                    relative_folder: "art".to_owned(),
                    display_name: "art".to_owned(),
                    item_count: 2,
                },
                MediaFolder {
                    root_id: "root-a".to_owned(),
                    relative_folder: "art/2026".to_owned(),
                    display_name: "2026".to_owned(),
                    item_count: 1,
                },
            ]
        );
    }

    #[test]
    fn can_list_all_roots_or_an_empty_root_filter() {
        let state = AppState::in_memory().expect("in-memory state");
        insert_root(&state, "root-a", "Pictures");
        insert_root(&state, "root-b", "Books");
        insert_media(&state, "one", "root-a", "art/page.jpg");
        insert_media(&state, "two", "root-b", "comic/page.jpg");

        assert_eq!(
            list_media_folders(&state, None, None, false)
                .expect("all roots")
                .len(),
            2
        );
        assert!(
            list_media_folders(&state, Some("missing"), None, false)
                .expect("missing root")
                .is_empty()
        );
    }

    #[test]
    fn filters_folders_and_counts_by_media_kind() {
        let state = AppState::in_memory().expect("in-memory state");
        insert_root(&state, "root-a", "Pictures");
        insert_media(&state, "image-one", "root-a", "mixed/image.jpg");
        insert_media(&state, "image-two", "root-a", "images/second.jpg");
        state
            .database
            .lock()
            .expect("database lock")
            .execute(
                "INSERT INTO media_items(
                    id, root_id, relative_path, file_name, extension, media_kind,
                    mime_type, byte_size, modified_at, is_missing, is_favorite,
                    first_seen_at, last_seen_at, updated_at
                 ) VALUES (
                    'video-one', 'root-a', 'mixed/movie.mp4', 'movie.mp4', 'mp4',
                    'video', 'video/mp4', 10, 2, 0, 0, 2, 2, 2
                 )",
                [],
            )
            .expect("insert video");

        let images = list_media_folders(&state, Some("root-a"), Some("image"), false)
            .expect("image folders");
        assert_eq!(images.len(), 2);
        assert_eq!(
            images
                .iter()
                .find(|folder| folder.relative_folder == "mixed")
                .map(|folder| folder.item_count),
            Some(1)
        );

        let videos = list_media_folders(&state, Some("root-a"), Some("video"), false)
            .expect("video folders");
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].relative_folder, "mixed");
        assert_eq!(videos[0].item_count, 1);

        let combined = list_media_folders(&state, Some("root-a"), Some("image,video"), false)
            .expect("combined folders");
        assert_eq!(combined.len(), 2);

        assert!(list_media_folders(&state, None, Some("unknown"), false).is_err());
    }

    #[test]
    fn unfiltered_root_includes_physical_subfolders_without_cataloged_media() {
        let state = AppState::in_memory().expect("in-memory state");
        let directory = tempfile::tempdir().expect("temporary library root");
        std::fs::create_dir_all(directory.path().join("empty").join("nested"))
            .expect("physical folder hierarchy");
        state
            .database
            .lock()
            .expect("database lock")
            .execute(
                "INSERT INTO library_roots(
                    id, path, display_name, enabled, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![
                    "root-physical",
                    directory.path().to_string_lossy(),
                    "Physical"
                ],
            )
            .expect("insert physical root");

        let folders = list_media_folders(&state, Some("root-physical"), None, false)
            .expect("unfiltered physical folder list");
        assert!(
            folders
                .iter()
                .any(|folder| folder.relative_folder == "empty" && folder.item_count == 0)
        );
        assert!(
            folders.iter().any(|folder| {
                folder.relative_folder == "empty/nested" && folder.item_count == 0
            })
        );

        let cached_rows: u32 = state
            .database
            .lock()
            .expect("database lock")
            .query_row(
                "SELECT COUNT(*) FROM folder_hierarchy_cache
                 WHERE root_id = 'root-physical'",
                [],
                |row| row.get(0),
            )
            .expect("cached folder count");
        // Root marker + two physical folders.
        assert_eq!(cached_rows, 3);

        std::fs::remove_dir(directory.path().join("empty").join("nested"))
            .expect("remove nested folder");
        let from_cache = list_media_folders(&state, Some("root-physical"), None, false)
            .expect("persistent cached folder list");
        assert!(
            from_cache
                .iter()
                .any(|folder| folder.relative_folder == "empty/nested")
        );

        let refreshed = list_media_folders(&state, Some("root-physical"), None, true)
            .expect("explicitly refreshed folder list");
        assert!(
            refreshed
                .iter()
                .all(|folder| folder.relative_folder != "empty/nested")
        );
    }

    #[test]
    fn unavailable_root_keeps_catalog_folders_visible() {
        let state = AppState::in_memory().expect("in-memory state");
        insert_root(&state, "offline", "Offline");
        insert_media(&state, "one", "offline", "art/page.jpg");

        let folders = list_media_folders(&state, Some("offline"), None, false)
            .expect("catalog folders remain available");
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].relative_folder, "art");
        assert_eq!(folders[0].item_count, 1);
    }

    #[test]
    fn root_revision_change_invalidates_persistent_hierarchy() {
        let state = AppState::in_memory().expect("in-memory state");
        let directory = tempfile::tempdir().expect("temporary library root");
        std::fs::create_dir_all(directory.path().join("before")).expect("initial physical folder");
        state
            .database
            .lock()
            .expect("database lock")
            .execute(
                "INSERT INTO library_roots(
                    id, path, display_name, enabled, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 1, 1, 1)",
                params![
                    "root-revision",
                    directory.path().to_string_lossy(),
                    "Revision"
                ],
            )
            .expect("insert library root");

        let first = list_media_folders(&state, Some("root-revision"), None, false)
            .expect("initial folder list");
        assert!(
            first
                .iter()
                .any(|folder| folder.relative_folder == "before")
        );

        std::fs::remove_dir(directory.path().join("before")).expect("remove old folder");
        std::fs::create_dir_all(directory.path().join("after")).expect("create new folder");
        state
            .database
            .lock()
            .expect("database lock")
            .execute(
                "UPDATE library_roots SET updated_at = 2 WHERE id = 'root-revision'",
                [],
            )
            .expect("advance root revision");

        let refreshed = list_media_folders(&state, Some("root-revision"), None, false)
            .expect("revision invalidates cache");
        assert!(
            refreshed
                .iter()
                .all(|folder| folder.relative_folder != "before")
        );
        assert!(
            refreshed
                .iter()
                .any(|folder| folder.relative_folder == "after")
        );
    }

    #[test]
    fn physical_hierarchy_cache_survives_database_reopen() {
        let directory = tempfile::tempdir().expect("temporary test directory");
        let library = directory.path().join("library");
        std::fs::create_dir_all(library.join("cached").join("nested")).expect("physical hierarchy");
        let database_path = directory.path().join("catalog.sqlite3");
        {
            let state = AppState::open(&database_path).expect("open database");
            state
                .database
                .lock()
                .expect("database lock")
                .execute(
                    "INSERT INTO library_roots(
                        id, path, display_name, enabled, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, 1, 1, 1)",
                    params!["persistent", library.to_string_lossy(), "Persistent"],
                )
                .expect("insert library root");
            let folders = list_media_folders(&state, Some("persistent"), None, true)
                .expect("populate hierarchy cache");
            assert!(
                folders
                    .iter()
                    .any(|folder| folder.relative_folder == "cached/nested")
            );
        }

        std::fs::remove_dir(library.join("cached").join("nested"))
            .expect("remove folder after caching");
        let reopened = AppState::open(&database_path).expect("reopen database");
        let cached = list_media_folders(&reopened, Some("persistent"), None, false)
            .expect("read persisted hierarchy");
        assert!(
            cached
                .iter()
                .any(|folder| folder.relative_folder == "cached/nested")
        );
    }
}
