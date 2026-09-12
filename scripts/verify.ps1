$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$taskCargoBin = Join-Path $env:USERPROFILE ".cargo\bin"

if (Test-Path -LiteralPath $taskCargoBin) {
    $env:PATH = "$taskCargoBin;$env:PATH"
}

Push-Location $projectRoot
try {
    & pnpm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend build failed with exit code $LASTEXITCODE"
    }

    & pnpm.cmd run perf:budget
    if ($LASTEXITCODE -ne 0) {
        throw "Static performance budget check failed with exit code $LASTEXITCODE"
    }

    & pnpm.cmd run test:themes
    if ($LASTEXITCODE -ne 0) {
        throw "Theme regression check failed with exit code $LASTEXITCODE"
    }

    & pnpm.cmd run test:layout
    if ($LASTEXITCODE -ne 0) {
        throw "Layout contract check failed with exit code $LASTEXITCODE"
    }

    & cargo fmt --manifest-path "src-tauri\Cargo.toml" --all -- --check
    if ($LASTEXITCODE -ne 0) {
        throw "Rust formatting check failed with exit code $LASTEXITCODE"
    }

    & cargo test --manifest-path "src-tauri\Cargo.toml"
    if ($LASTEXITCODE -ne 0) {
        throw "Rust tests failed with exit code $LASTEXITCODE"
    }

    & cargo check --manifest-path "src-tauri\Cargo.toml"
    if ($LASTEXITCODE -ne 0) {
        throw "Rust check failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
