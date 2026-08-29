param(
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$backupPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "layout-backups\PixVault-layout-source-0.1.26-pre-gallery-tuning.zip"))
$expectedHash = "224236990510B13AFA8EEFD90B4E33CD6A5718FA722EAFDAD575E6B5356C7D57"
$targets = [ordered]@{
  "App.tsx" = "src\App.tsx"
  "App.css" = "src\App.css"
  "MediaCollection.tsx" = "src\components\MediaCollection.tsx"
  "MediaViewer.css" = "src\components\MediaViewer.css"
  "GalleryDisplaySettings.tsx" = "src\components\GalleryDisplaySettings.tsx"
  "SearchAndGroupingSettings.tsx" = "src\components\SearchAndGroupingSettings.tsx"
  "FirstRunTutorial.tsx" = "src\components\FirstRunTutorial.tsx"
}

if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
  throw "Gallery layout backup was not found: $backupPath"
}

$actualHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
  throw "Gallery layout backup hash mismatch. Expected $expectedHash but found $actualHash."
}

$resolvedTargets = foreach ($relativeTarget in $targets.Values) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $relativeTarget))
  if (-not $target.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Restore target is outside the project: $target"
  }
  $target
}

Write-Host "Verified gallery layout backup: $backupPath"
Write-Host "The following source files will be restored:"
$resolvedTargets | ForEach-Object { Write-Host "  $_" }

if (-not $Apply) {
  Write-Host "Preview only. Run again with -Apply to restore the pre-tuning 0.1.26 gallery layout."
  exit 0
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($backupPath)
try {
  foreach ($entryName in $targets.Keys) {
    $entry = $archive.Entries | Where-Object { $_.FullName -eq $entryName } | Select-Object -First 1
    if ($null -eq $entry) {
      throw "Required backup entry is missing: $entryName"
    }

    $destination = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $targets[$entryName]))
    $temporaryDestination = "$destination.gallery-layout-restore.tmp"
    $sourceStream = $entry.Open()
    $destinationStream = [System.IO.File]::Open($temporaryDestination, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $sourceStream.CopyTo($destinationStream)
    } finally {
      $destinationStream.Dispose()
      $sourceStream.Dispose()
    }
    Move-Item -LiteralPath $temporaryDestination -Destination $destination -Force
  }
} finally {
  $archive.Dispose()
}

Write-Host "PixVault gallery layout source was restored to the pre-tuning 0.1.26 checkpoint."
