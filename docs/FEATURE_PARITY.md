# Android to Windows feature parity

This is the release checklist for GalleryWeb. A feature is not considered
complete because a screen exists; the native operation, persistent data,
failure behavior, and applicable tests must also exist.

Status values:

- `implemented`: native operation, persistence/failure behavior and applicable tests exist
- `partial`: the listed usable subset exists, but Android parity is not complete
- `foundation`: contract or shell exists, but the feature is not usable yet
- `planned`: accepted scope with no production implementation yet
- `excluded`: intentionally replaced or omitted by the Windows product

## Library and gallery

| Android capability | Windows behavior | Status |
| --- | --- | --- |
| MediaStore discovery | Scan user-registered Windows library roots | implemented |
| Image/GIF/video grid | Virtualized responsive large/medium/small grids with preallocated scroll space | implemented |
| Folder gallery | Physical folder browser for image/video/book; Gallery remains a chronological grid | implemented |
| Search | File name, tag, relative folder, media type and age rating | implemented |
| Sort | Added/modified date, name and size | implemented |
| Range/bulk selection | Mouse range, Ctrl/Shift selection, select-all and bulk favorite/tag/rating/recycle editing | implemented |
| Similarity groups | Chronological adjacent-vector groups, configurable threshold and grouped viewer | implemented |
| Custom scrollbar/date indicator | Themed desktop scrollbars plus date-group headers | implemented |
| Folder groups | SQLite-backed create, add/reassign, rename, release and reorder workflow | implemented |
| Physical folder move | Not exposed by GalleryWeb | excluded |

## Media viewer

| Android capability | Windows behavior | Status |
| --- | --- | --- |
| Image/GIF display | Native web image/GIF decoding with contained and fullscreen display | implemented |
| Pan/zoom/rotate | Mouse/touchpad pan and zoom plus non-destructive 90-degree temporary rotation | implemented |
| Video playback | HTML media playback, tap/double-tap controls and Windows-supported codecs | implemented |
| Frame strip and seek | Video seek preview plus GIF frame extraction and strip | implemented |
| Screenshot/frame save | Save dialog and registered-folder refresh | implemented |
| MP4 to GIF | X animated media and viewer-origin H.264 MP4 conversion use atomic local finalization | implemented |
| Favorite and tags | Transactional SQLite update | implemented |
| Slideshow | Timed image/GIF slideshow | implemented |
| Related/random media | Movable side/bottom panel using vector search, common tags and folder sampling | implemented |
| ascii2d upload search | Explicit bounded-image upload and result opening | implemented |
| Set wallpaper | Windows desktop wallpaper integration | implemented |
| Delete | Windows Recycle Bin only; no permanent fallback | implemented |

## Books and references

| Android capability | Windows behavior | Status |
| --- | --- | --- |
| ZIP books | Indexed archive pages without extracting beside the source | implemented |
| PDF books | PDF renderer with thumbnail cache | implemented |
| Reading direction/spread | Single/spread and LTR/RTL settings | implemented |
| Bookmarks and favorites | Persistent bookmarks and favorites | implemented |
| Previous/next book | Current folder/library order | implemented |
| Reference projects | Persistent project/items workflow | implemented |
| Reference search | Embedded search and explicit URL import | implemented |
| Temporary references | Managed local copies are removed on project completion/item/project deletion without touching source files | implemented |
| Favorite artists/sites | Editable local catalog with multi-link creators | implemented |

## AI and related media

| Android capability | Windows behavior | Status |
| --- | --- | --- |
| AI tagging | Local ONNX inference with period/folder scope | implemented |
| Age rating | Local model result and manual override | implemented |
| Feature vectors | Verified MobileNetV3 Small semantic vectors, L2 normalization and versioned SQLite blobs | implemented |
| Visual similarity | Whole-library cosine search above 40%, capped at 25 results, plus Android-style adjacent grouping | implemented |
| Model selection/download | Verified, pinned model cache | implemented |
| Background progress | Progress events and real cancellation across download/analysis/save | implemented |
| Resource throttling | Bounded workers, foreground-aware suspension and user pause/resume | implemented |

## X downloads

| Android capability | Windows behavior | Status |
| --- | --- | --- |
| Shared/VIEW URL | Text/URI drag-and-drop plus per-user `pixvault-x` Windows protocol handler | implemented |
| Status URL resolution | Validated public X syndication adapter with fixtures | implemented |
| Multi-media/quality choice | Per-media candidate grouping and quality dialog | implemented |
| GIF source handling | Local MP4-to-animated-GIF conversion with atomic finalization | implemented |
| Download history | SQLite history with image/video/GIF preview | implemented |
| Duplicate detection | Persistent source URL/media key/destination identity with on-disk existence verification | implemented |
| Timestamps and safe names | Explicit metadata and collision-safe `userID_postID` filenames | implemented |

## Settings, migration and platform

| Android capability | Windows behavior | Status |
| --- | --- | --- |
| Themes and custom palette | System/dark/light modes, all 20 visible Android presets and an eight-color custom palette | implemented |
| Viewer controls/settings | Per-media five-slot toolbar assignments, zoom behavior, video seek interval, book binding/view and seek-anchor settings | implemented |
| JSON settings backup | Versioned Windows JSON export/import with atomic preference restore | implemented |
| Full Android migration | Checksummed Android ZIP, bounded validation, ordered matching, manual resolution and atomic import | implemented |
| Foreground notifications | In-app history plus opt-out Windows native notifications and a test action | implemented |
| APK updates | Fail-closed updater readiness diagnostics; signed HTTPS distribution still requires external keys and hosting | external gate |
| Android permissions | Registered root and Windows access error handling | excluded |
| In-app trash screen | Recovery is delegated to Windows Recycle Bin | excluded |

## Required release tests

- Clean install and upgrade on Windows 10 22H2 x64.
- Clean install and upgrade on supported Windows 11 x64 versions.
- Empty library, 100-item mixed fixture, and 10,000-item performance library.
- Local NTFS, removable drive, unavailable root, read-only root and network path.
- Valid, legacy, corrupt, duplicated, interrupted and re-imported migration data.
- Every destructive operation verifies its resolved registered-root target.
- Recycle failure leaves both the source file and catalog state unchanged.
- Interrupted scan, AI analysis, download and conversion are restart-safe.
