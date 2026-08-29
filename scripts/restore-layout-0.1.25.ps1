param(
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$backupPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "layout-backups\PixVault-layout-source-0.1.25-pre-overhaul.zip"))
$expectedHash = "8F7CD3DBE952CE55702933B7CAB4282E537C7520FE6D5273E81FB4F692C73E88"
$targets = [ordered]@{
  "App.tsx" = "src\App.tsx"
  "App.css" = "src\App.css"
  "HomeShelves.tsx" = "src\components\HomeShelves.tsx"
  "HomeShelves.css" = "src\components\HomeShelves.css"
}

if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
  throw "Layout backup was not found: $backupPath"
}

$actualHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
  throw "Layout backup hash mismatch. Expected $expectedHash but found $actualHash."
}

$resolvedTargets = foreach ($relativeTarget in $targets.Values) {
  $target = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $relativeTarget))
  if (-not $target.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Restore target is outside the project: $target"
  }
  $target
}

Write-Host "Verified layout backup: $backupPath"
Write-Host "The following source files will be restored:"
$resolvedTargets | ForEach-Object { Write-Host "  $_" }

if (-not $Apply) {
  Write-Host "Preview only. Run again with -Apply to restore the 0.1.25 layout."
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
    $temporaryDestination = "$destination.layout-restore.tmp"
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

Write-Host "PixVault layout source was restored to the 0.1.25 checkpoint."
