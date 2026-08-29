# GalleryWeb roadmap

All Android feature groups are in scope except physical folder movement and a
private trash screen. A milestone is complete only when its automated tests and
the applicable Android regression cases pass.

## M0 — Foundation

- Independent repository and Windows build
- Architecture, safety rules, diagnostics and migration contract
- React desktop shell and typed Tauri command boundary

## M1 — Catalog and migration

- SQLite migrations and repositories
- Registered library roots, scanner and file watcher
- Thumbnail cache and operation progress
- Android migration exporter
- Windows dry-run importer and matching report

## M2 — Gallery and viewers

- Image/GIF/video grids and list modes
- Search, filters, sorting, ranges and bulk selection
- Image zoom, video playback, frame capture and GIF conversion
- Tags, favorite state, visual settings and Windows wallpaper
- Safe deletion to Windows Recycle Bin

## M3 — Books and references

- ZIP/PDF discovery and viewer
- Single/spread reading modes and bookmarks
- Reference projects, temporary references and related searches
- Favorite artists and sites

## M4 — Local AI

- Model download and verification
- AI tags and age rating
- Feature vectors, visual similarity and adjacent grouping
- Resumable progress, cancellation and resource throttling

## M5 — X downloads and release

- URL normalization and provider adapters
- Quality selection, images/video/GIF and history
- Settings backup and migration recovery tools
- Windows 10/11 regression, installer, signing and updater

## M6 — Reliability and release hardening

- Privacy-reduced rotating native/renderer diagnostics
- SQLite integrity checks, safe maintenance and verified recovery snapshots
- Automated contrast checks for all Android-visible themes
- 10,000-item catalog paging and summary regression
- Windows CI, version/hash/signature artifact gates and manual release matrix
- External gate: Windows 10/11 clean-machine verification, code signing and signed HTTPS updater

## M7 — Desktop workspace redesign

- Unified navigation, page context, history and primary actions
- Library-first home with overview, quick access and bento shelves
- Responsive drawer navigation and single-column small-screen layout
- Keyboard landmarks, current-page semantics and visible focus states
- Hash-verified 0.1.25 layout checkpoint and scoped restore script

## M8 — Gallery density and viewer scale

- Favorite image folders replace the virtual folder-group section
- Continuous media ordering without date-group headers
- Explorer-scale video and book folder/media tiles
- Window-relative media viewer without a fixed desktop width ceiling
- Hash-verified pre-tuning 0.1.26 checkpoint and scoped restore script

## M9 — Square gallery and immersive books

- Explorer-scale media rows for image, video, and book folders
- Square thumbnail frames for images, GIFs, videos, books, and folders
- Two-worker full-book background cache with display-sized PDF page assets
- Stable page canvases without a blocking loader on every page turn
- Hash-verified pre-0.1.28 checkpoint and scoped restore script

## M10 — Large-library performance overhaul

- Filesystem-event watcher instead of a four-second recursive poll
- Diff-only catalog scans without unchanged-row WAL writes
- Deferred integrity diagnostics and on-demand thumbnail/vector maintenance
- Debounced stale-while-revalidate gallery updates that preserve scroll state
- Interaction-driven GIF playback and bounded idle book-page caching
- Smaller startup bundle plus automated runtime performance contracts

## M11 — Right-bound book spreads

- Right-bound spread mode is the default
- Page 2 appears on the left and page 1 on the right
- Left-bound reading remains available as a viewer setting
- Automated layout contract protects the default page order

## M12 — Continuous viewer workflow

- Recycling the current item advances to the next gallery item without closing the viewer
- Recycling the last item falls back to the previous item and closes only when none remain
- Video volume and mute state persist across items and application restarts
- A safe 50% volume is used when no previous value exists

## M13 — Square compact galleries and unified folders

- Gallery, favorites, and folder media share the same Explorer-scale tile density
- Each tile remains square including thumbnail, filename, size, and modified date
- A unified media-folder screen sits between Gallery and Favorites
- Images, GIFs, videos, PDFs, ZIPs, and CBZs share one folder hierarchy view

## Release gates

- No permanent delete path exists in normal UI.
- Migration preserves all required record classes with an auditable report.
- A 10,000-item mixed library remains responsive during incremental scanning.
- Corrupt media, unavailable roots and interrupted work do not corrupt SQLite.
- Windows 10 and Windows 11 installers pass clean-machine tests.
