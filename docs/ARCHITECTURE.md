# GalleryWeb architecture

## Product boundary

GalleryWeb is a separately installed Windows application built with web
technologies. It targets supported Windows 10 and Windows 11 systems. The
Android Gallery project remains independently buildable and releasable.

Physical folder moves and a private in-app trash are out of scope. Existing
folder grouping remains a virtual metadata feature. A delete request must use
the Windows Shell recycle operation and must never silently fall back to
permanent deletion.

## Runtime

```text
React + TypeScript (WebView2)
              |
      typed Tauri commands
              |
Rust application service
  |           |           |
SQLite     file system   media/AI workers
```

The frontend owns presentation and transient interaction state. It cannot run
arbitrary SQL, arbitrary shell commands, or unrestricted file operations. The
Rust layer exposes narrow commands, validates every path against a registered
library root, performs mutations, and publishes progress events.

## Modules

| Module | Responsibility |
| --- | --- |
| `ui-shell` | Navigation, desktop layout, theme, keyboard and mouse input |
| `library` | Registered roots, scanning, file watching, media identity |
| `catalog` | SQLite metadata, tags, favorites, groups, bookmarks and history |
| `viewer` | Images, GIF, video, PDF and ZIP-backed books |
| `operations` | Thumbnails, frame extraction, GIF conversion and progress |
| `ai` | Model acquisition, tags, age rating, vectors and similarity |
| `downloads` | X candidate resolution, download history and safe filenames |
| `migration` | Android archive validation, dry run, matching and atomic import |
| `platform-windows` | Recycle Bin, wallpaper, notifications and app updates |

## Local storage

Application state is stored below the per-user local application data
directory. Media files remain in their original folders.

The first SQLite schema includes:

- `library_roots`
- `media_items`
- `media_metadata`
- `media_tags`
- `tag_translations`
- `folder_groups` and `folder_group_members`
- `video_downloads`
- `x_downloaded_media`
- `reference_projects` and `reference_items`
- `book_bookmarks`
- `preferences`
- `migration_runs` and `migration_issues`

Database changes use ordered migrations and transactional upgrades. A schema
version is stored in both SQLite and diagnostics output.

## File identity

A Windows path is not treated as a permanent identity. Each catalog item gets
an internal UUID and stores:

- canonical root ID and relative path
- file name, byte size and modification time
- MIME/media kind and dimensions when available
- optional SHA-256 fingerprint for migration or ambiguity resolution

The scanner reconciles renamed, replaced and missing files. File-system
watcher events are hints; a deterministic rescan is the source of truth. The
Windows watcher polls only supported-media fingerprints, waits for a stable
change, and rescans the changed registered root. Newly discovered image and
GIF IDs can be persisted in a bounded auto-analysis queue.

Visual vectors use a pinned, verified MobileNetV3 Small ONNX model and
versioned rows so an algorithm update triggers safe re-indexing instead of
mixing vector spaces.

## Safety rules

1. File mutations are allowed only below an enabled library root.
2. Delete means Windows Recycle Bin. Unsupported locations fail visibly.
3. Bulk actions show the resolved target count before execution.
4. Database state changes only after the file-system operation succeeds.
5. Import is dry-run first and commits atomically after user confirmation.
6. Original Android export archives are never modified.

## Compatibility

The minimum release test matrix is:

- Windows 10 22H2 x64
- Windows 11 current and previous supported feature updates, x64
- WebView2 Evergreen Runtime
- NTFS local drive, removable drive, and a read-only folder

Network shares are supported for reading after validation. Recycle behavior on
network shares is not guaranteed by Windows, so GalleryWeb must refuse delete
when it cannot guarantee a recoverable recycle operation.
