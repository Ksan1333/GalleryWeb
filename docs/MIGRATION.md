# Android to Windows migration contract

## Goal

Migration must preserve settings, favorite artists and sites, per-media
favorites, manual and AI tags, age ratings, AI analysis state, feature vectors,
bookmarks, reference projects, and X download history.

The current Android `gallery_backup.json` contains settings and favorites but
does not contain Room tables such as `media_tags` or `video_downloads`.
GalleryWeb therefore requires a new Android export action.

## Archive

The Android app exports a read-only ZIP archive named:

```text
pixvault-migration-YYYYMMDD-HHMMSS.zip
```

Required entries:

```text
manifest.json
settings.json
favorites.json
media.jsonl
tags.jsonl
video-downloads.jsonl
references.jsonl
bookmarks.jsonl
checksums.json
```

`manifest.json` contains:

- `formatVersion`
- Android app version and database version
- export timestamp and device timezone
- record counts
- hash algorithm
- whether feature vectors are present

No passwords, cookies, authentication tokens, Android installation identifiers,
or media file bytes are included.

## Media record

Each `media.jsonl` record includes a generated export ID and portable matching
data:

```json
{
  "exportId": "uuid",
  "androidUri": "content://media/external/images/media/123",
  "relativePath": "Pictures/Gallery/example.jpg",
  "fileName": "example.jpg",
  "fileSize": 123456,
  "dateAdded": 1710000000000,
  "dateModified": 1710000000000,
  "mimeType": "image/jpeg",
  "width": 1920,
  "height": 1080,
  "sha256": "optional-lowercase-hex",
  "favorite": true,
  "ageRating": "SFW",
  "aiAnalyzed": true,
  "aiModel": "model-id",
  "featureVector": []
}
```

Tags and related records refer to `exportId`, never to a Windows path.

## Windows matching

Import always scans the selected Windows media roots before matching. Matching
uses the following ordered rules:

1. normalized relative path + file name + byte size
2. file name + byte size + timestamp tolerance
3. SHA-256 equality
4. unresolved or ambiguous item shown for manual resolution

The importer must never choose arbitrarily between two candidates. An import
report shows matched, ambiguous, missing, skipped, and invalid record counts.

Media can be copied from Android before or after exporting the archive, but it
should not be renamed until the first Windows import finishes. Hash matching is
available when timestamps are changed during transfer.

## Compatibility

- New Windows versions import the dedicated migration archive.
- The legacy `gallery_backup.json` remains supported for settings and favorite
  artists/sites only.
- Unknown fields are ignored.
- Unsupported future `formatVersion` values fail before database changes.
- Re-importing the same archive is idempotent and recorded in `migration_runs`.

## Atomicity

Import has three stages:

1. Validate archive shape, counts and checksums.
2. Dry-run matching and present the report.
3. Commit all accepted metadata in one SQLite transaction.

If any commit step fails, the transaction is rolled back and the source archive
remains untouched.
