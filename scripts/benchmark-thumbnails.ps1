param(
    [ValidateRange(1, 100)]
    [int]$Rounds = 7,

    [ValidateRange(1, 1000)]
    [int]$BatchItems = 16,

    [string]$JsonPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot "src-tauri\Cargo.toml"
$taskCargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

if (Test-Path -LiteralPath $taskCargoBin) {
    $env:PATH = "$taskCargoBin;$env:PATH"
}

$benchmarkArguments = @(
    "run",
    "--release",
    "--manifest-path", $manifestPath,
    "--example", "thumbnail_benchmark",
    "--",
    "--rounds", $Rounds,
    "--batch-items", $BatchItems
)

if ($JsonPath.Trim()) {
    $resolvedJsonPath = if ([System.IO.Path]::IsPathRooted($JsonPath)) {
        [System.IO.Path]::GetFullPath($JsonPath)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $projectRoot $JsonPath))
    }
    $benchmarkArguments += @("--json", $resolvedJsonPath)
}

Push-Location $projectRoot
try {
    & cargo @benchmarkArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Thumbnail benchmark failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
