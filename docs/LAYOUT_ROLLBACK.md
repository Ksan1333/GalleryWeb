# PixVault layout rollback

The pre-overhaul 0.1.25 layout source is preserved at:

`layout-backups/PixVault-layout-source-0.1.25-pre-overhaul.zip`

- SHA-256: `8F7CD3DBE952CE55702933B7CAB4282E537C7520FE6D5273E81FB4F692C73E88`
- Files: `src/App.tsx`, `src/App.css`, `src/components/HomeShelves.tsx`, `src/components/HomeShelves.css`
- The archive is source-only. It does not contain personal media, the SQLite catalog, or app preferences.

Preview the exact restore targets:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-layout-0.1.25.ps1
```

Restore the old layout after reviewing the targets:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-layout-0.1.25.ps1 -Apply
```

The restore script validates the archive hash and restricts all overwrite targets to these four project files. Run the normal build afterward to verify the restored source.

## 0.1.26 gallery-tuning checkpoint

The layout immediately before the 0.1.27 gallery density changes is preserved at:

`layout-backups/PixVault-layout-source-0.1.26-pre-gallery-tuning.zip`

- SHA-256: `224236990510B13AFA8EEFD90B4E33CD6A5718FA722EAFDAD575E6B5356C7D57`
- Scope: app shell styles, media collection, viewer sizing, display/search settings, and tutorial copy

Preview its seven exact restore targets:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-gallery-layout-0.1.26.ps1
```

Apply only this gallery-layout rollback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-gallery-layout-0.1.26.ps1 -Apply
```

## 0.1.27 square-gallery and book-cache checkpoint

The source immediately before the 0.1.28 square thumbnails and full-book caching changes is preserved at:

`layout-backups/PixVault-layout-source-0.1.27-pre-square-book-cache.zip`

- SHA-256: `C672ED2E987DB0942D651F7DC23EFCC39F4E4E481D33670DF24D32641260AFAA`
- Scope: media collection layout, app styles, book viewer source/styles, app shell, and layout contracts

Preview its six exact restore targets:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-square-book-layout-0.1.27.ps1
```

Apply only this rollback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-square-book-layout-0.1.27.ps1 -Apply
```

## 0.1.28 performance-overhaul checkpoint

The complete source immediately before the 0.1.29 performance overhaul is preserved at:

`layout-backups/PixVault-source-0.1.28-pre-performance-overhaul.zip`

- SHA-256: `8209A1694BFFEEAA291765F1F41B4C70E755DBA20D3EFB23011B48D2E9855C4C`
- Scope: web source, native Rust source/tests, scripts, and package/build configuration
- The archive contains no personal media, SQLite catalog, generated cache, or application preferences

This is a broad source checkpoint intended for manual recovery of the performance phase. Keep any later source work separately before restoring it.
