param(
    [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$packageLockText = Get-Content -LiteralPath (Join-Path $projectRoot "package-lock.json") -Raw
$packageLockMatches = [regex]::Matches($packageLockText, '"version"\s*:\s*"([^"]+)"')
$tauri = Get-Content -LiteralPath (Join-Path $projectRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$cargoText = Get-Content -LiteralPath (Join-Path $projectRoot "src-tauri\Cargo.toml") -Raw
$cargoMatch = [regex]::Match($cargoText, '(?m)^version = "([^"]+)"$')

if (-not $cargoMatch.Success) {
    throw "Cargo package version was not found"
}
if ($packageLockMatches.Count -lt 2) {
    throw "npm lock versions were not found"
}

$versions = @(
    $package.version,
    $packageLockMatches[0].Groups[1].Value,
    $packageLockMatches[1].Groups[1].Value,
    $tauri.version,
    $cargoMatch.Groups[1].Value
)
$uniqueVersions = @($versions | Sort-Object -Unique)
if ($uniqueVersions.Count -ne 1) {
    throw "Release versions are inconsistent: $($versions -join ', ')"
}

$version = $uniqueVersions[0]
$bundleDirectory = Join-Path $projectRoot "src-tauri\target\release\bundle\nsis"
$expectedName = "PixVault for Windows_${version}_x64-setup.exe"
$installerPath = Join-Path $bundleDirectory $expectedName
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Expected installer was not found: $installerPath"
}

$installer = Get-Item -LiteralPath $installerPath
if ($installer.Length -lt 1MB) {
    throw "Installer is unexpectedly small: $($installer.Length) bytes"
}
if ($installer.VersionInfo.FileVersion -ne $version -or $installer.VersionInfo.ProductVersion -ne $version) {
    throw "Installer metadata does not match $version"
}

$signature = Get-AuthenticodeSignature -LiteralPath $installerPath
if ($RequireSignature -and $signature.Status -ne "Valid") {
    throw "A valid Authenticode signature is required; current status is $($signature.Status)"
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath
$manifest = [ordered]@{
    formatVersion = 1
    product = "PixVault for Windows"
    version = $version
    fileName = $installer.Name
    bytes = $installer.Length
    sha256 = $hash.Hash
    authenticodeStatus = [string]$signature.Status
    signed = $signature.Status -eq "Valid"
}
$manifestPath = Join-Path $bundleDirectory "release-manifest.json"
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host "Release artifact check passed: $expectedName"
Write-Host "SHA-256: $($hash.Hash)"
Write-Host "Authenticode: $($signature.Status)"
