param([string]$InstallerPath, [switch]$CheckOnly, [switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'

function Test-PixVaultVCRuntime {
    # This script is invoked with 64-bit PowerShell, including from 32-bit NSIS.
    foreach ($name in @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
        $file = Join-Path $env:WINDIR "System32\$name"
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
        $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
        $version = [version]::new($info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart, $info.FilePrivatePart)
        if ($version -lt [version]'14.51.36247.0') { return $false }
    }
    return $true
}

function Install-PixVaultVCRuntime([string]$Path) {
    if (Test-PixVaultVCRuntime) { return 0 }
    $expected = '843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C'
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $expected) { throw 'VC runtime SHA-256 mismatch' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'VC runtime Microsoft signature validation failed' }
    # UAC approval is required if the runtime is missing. Never force a reboot.
    $process = Start-Process -FilePath $Path -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -eq 3010) { return 3010 }
    if ($process.ExitCode -notin @(0, 1638)) { throw "VC runtime installation failed: $($process.ExitCode)" }
    if (-not (Test-PixVaultVCRuntime)) { throw 'VC runtime installation did not provide the required x64 DLLs. Restart Windows or repair the installed Visual C++ runtime.' }
    return 0
}

if ($FunctionsOnly) { return }
try {
    if ($CheckOnly) { if (Test-PixVaultVCRuntime) { exit 0 } else { exit 1 } }
    exit (Install-PixVaultVCRuntime $InstallerPath)
} catch {
    Write-Output $_.Exception.Message
    exit 1
}
