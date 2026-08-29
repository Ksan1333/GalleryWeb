param(
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$backupPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "layout-backups\PixVault-layout-source-0.1.27-pre-square-book-cache.zip"))
$expectedHash = "C672ED2E987DB0942D651F7DC23EFCC39F4E4E481D33670DF24D32641260AFAA"
$targets = [ordered]@{
  "MediaCollection.tsx" = "src\components\MediaCollection.tsx"
  "App.css" = "src\App.css"
  "MediaViewer.tsx" = "src\components\MediaViewer.tsx"
  "MediaViewer.css" = "src\components\MediaViewer.css"
  "App.tsx" = "src\App.tsx"
  "check-layout-contract.mjs" = "scripts\check-layout-contract.mjs"
}

if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
  throw "Gallery and book-viewer backup was not found: $backupPath"
}

$actualHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
  throw "Gallery and book-viewer backup hash mismatch. Expected $expectedHash but found $actualHash."
}

$resolvedTargets = foreach ($relativeTarget in $targets.Values) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $relativeTarget))
  if (-not $target.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Restore target is outside the project: $target"
  }
  $target
}

Write-Host "Verified gallery and book-viewer backup: $backupPath"
Write-Host "The following source files will be restored:"
$resolvedTargets | ForEach-Object { Write-Host "  $_" }

if (-not $Apply) {
  Write-Host "Preview only. Run again with -Apply to restore the pre-0.1.28 gallery and book viewer."
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
    $temporaryDestination = "$destination.square-book-restore.tmp"
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

Write-Host "PixVault gallery and book viewer were restored to the 0.1.27 checkpoint."
