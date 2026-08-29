$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$taskCargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

if (Test-Path -LiteralPath $taskCargoBin) {
    $env:PATH = "$taskCargoBin;$env:PATH"
}

Push-Location $projectRoot
try {
    & npm.cmd run tauri dev
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri development run failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
