//! On-demand filesystem navigation. Catalog roots are internal indexing scopes,
//! not a prerequisite for browsing. Never recursively enumerate a drive here.
use crate::{catalog, db::AppState, models::LibraryRoot};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub path: String,
    pub display_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub path: Option<String>,
    pub parent_path: Option<String>,
    pub folders: Vec<FolderEntry>,
    pub root_id: Option<String>,
    pub relative_folder: String,
    pub priority_path: Option<String>,
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{value}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    }
}

pub fn priority_root(state: &AppState, path: &str) -> Result<LibraryRoot, String> {
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("フォルダーを開けません: {error}"))?;
    let existing = catalog::list_library_roots(state)?
        .into_iter()
        .filter(|root| root.is_priority && canonical.starts_with(&root.path))
        .max_by_key(|root| root.path.len());
    let root = match existing {
        Some(root) => root,
        None => catalog::add_library_root(state, path)?,
    };
    catalog::set_root_priority(state, &root.id, true)?;
    Ok(LibraryRoot {
        is_priority: true,
        ..root
    })
}

pub fn browse(state: &AppState, path: Option<&str>, scan: bool) -> Result<FolderListing, String> {
    let Some(path) = path.filter(|path| !path.trim().is_empty()) else {
        return Ok(FolderListing {
            path: None,
            parent_path: None,
            folders: drives(),
            root_id: None,
            relative_folder: String::new(),
            priority_path: None,
        });
    };
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("フォルダーを開けません: {error}"))?;
    if !canonical.is_dir() {
        return Err("フォルダーを指定してください。".to_owned());
    }
    let entries = std::fs::read_dir(&canonical).map_err(|error| {
        format!("このフォルダーを読み取る権限がないか、接続されていません: {error}")
    })?;
    let mut folders = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("フォルダー一覧を読み取れません: {error}"))?;
        // Junctions/symlinks are navigable explicitly, but never followed by a recursive scanner.
        if entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() || (kind.is_symlink() && entry.path().is_dir()))
        {
            folders.push(FolderEntry {
                path: display_path(&entry.path()),
                display_name: entry.file_name().to_string_lossy().into_owned(),
            });
        }
    }
    folders.sort_by_cached_key(|folder| folder.display_name.to_lowercase());
    let roots = catalog::list_enabled_library_root_records(state)?;
    let covering = roots
        .iter()
        .filter(|root| canonical.starts_with(&root.path))
        .max_by_key(|root| root.path.len());
    let (root_id, root_path) = if let Some(root) = covering {
        (root.id.clone(), PathBuf::from(&root.path))
    } else {
        let root = catalog::add_library_root(state, &canonical.to_string_lossy())?;
        catalog::set_root_priority(state, &root.id, false)?;
        (root.id, canonical.clone())
    };
    let relative_folder = canonical
        .strip_prefix(&root_path)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    // Persist visited scopes for non-recursive monitoring even under an
    // existing non-priority root. This does not duplicate catalog ownership.
    let hash = format!("{:x}", Sha256::digest(relative_folder.as_bytes()));
    let visit = serde_json::json!({ "rootId": root_id, "relativeFolder": relative_folder, "path": canonical.to_string_lossy() });
    state.database.lock()?.execute(
        "INSERT INTO preferences(key, value_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
         WHERE preferences.value_json <> excluded.value_json",
        rusqlite::params![format!("folder.visited.{root_id}.{}", &hash[..32]), visit.to_string(), catalog::now_millis()],
    ).map_err(|error| error.to_string())?;
    if scan {
        catalog::scan_folder(state, &root_id, &relative_folder)?;
    }
    let priority_path = roots
        .iter()
        .filter(|root| root.is_priority && canonical.starts_with(&root.path))
        .max_by_key(|root| root.path.len())
        .map(|root| display_path(Path::new(&root.path)));
    Ok(FolderListing {
        path: Some(display_path(&canonical)),
        parent_path: canonical
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .map(display_path),
        folders,
        root_id: Some(root_id),
        relative_folder,
        priority_path,
    })
}

fn drives() -> Vec<FolderEntry> {
    #[cfg(windows)]
    {
        // SAFETY: GetLogicalDrives takes no pointers and only reads the drive bitmap.
        let mask = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
        (0..26)
            .filter(|index| mask & (1 << index) != 0)
            .map(|index| {
                let letter = char::from(b'A' + index as u8);
                FolderEntry {
                    path: format!("{letter}:\\"),
                    display_name: format!("{letter}: ドライブ"),
                }
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![FolderEntry {
            path: "/".to_owned(),
            display_name: "ファイルシステム".to_owned(),
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browsing_is_shallow_and_priority_removal_preserves_catalog() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("empty")).unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        std::fs::write(dir.path().join("one.jpg"), b"one").unwrap();
        std::fs::write(dir.path().join("nested/two.jpg"), b"two").unwrap();
        let state = AppState::in_memory().unwrap();
        let listing = browse(&state, dir.path().to_str(), true).unwrap();
        assert_eq!(listing.folders.len(), 2);
        assert!(listing.priority_path.is_none());
        assert_eq!(catalog::list_media_items(&state, None).unwrap().len(), 1);
        let root = priority_root(&state, dir.path().to_str().unwrap()).unwrap();
        catalog::scan_library(&state, Some(&root.id)).unwrap();
        assert_eq!(catalog::list_media_items(&state, None).unwrap().len(), 2);
        catalog::set_root_priority(&state, &root.id, false).unwrap();
        assert_eq!(catalog::list_media_items(&state, None).unwrap().len(), 2);
        let child = browse(&state, dir.path().join("nested").to_str(), true).unwrap();
        assert_eq!(child.root_id, listing.root_id);
        assert_eq!(catalog::list_media_items(&state, None).unwrap().len(), 2);
    }

    #[test]
    fn promoting_a_child_retains_ids_and_never_duplicates_parent_media() {
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("子フォルダー");
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("one.jpg"), b"image").unwrap();
        let state = AppState::in_memory().unwrap();
        let parent = priority_root(&state, dir.path().to_str().unwrap()).unwrap();
        catalog::scan_library(&state, Some(&parent.id)).unwrap();
        let original = catalog::list_media_items(&state, None).unwrap().remove(0);
        catalog::set_favorite(&state, &original.id, true).unwrap();
        catalog::set_root_priority(&state, &parent.id, false).unwrap();
        let promoted = priority_root(&state, child.to_str().unwrap()).unwrap();
        catalog::scan_library(&state, None).unwrap();
        let items = catalog::list_media_items(&state, None).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, original.id);
        assert_eq!(items[0].root_id, promoted.id);
        assert!(items[0].is_favorite);
        assert_eq!(items[0].relative_path, "one.jpg");
    }
}
