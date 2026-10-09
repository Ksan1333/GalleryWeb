param([string]$Source)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $projectRoot 'src-tauri\target\vcredist'
$destination = Join-Path $directory 'vc_redist.x64.exe'
$expected = '843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C'
$url = 'https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
if (-not (Test-Path -LiteralPath $destination) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) {
    if ($Source) { Copy-Item -LiteralPath $Source -Destination "$destination.partial" }
    else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$destination.partial"
    }
    if ((Get-FileHash -LiteralPath "$destination.partial" -Algorithm SHA256).Hash -ne $expected) { throw 'VC runtime SHA-256 mismatch' }
    Move-Item -LiteralPath "$destination.partial" -Destination $destination -Force
}
if ($PSVersionTable.PSVersion.Major -le 5) {
    Import-Module "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -Force
}
$signature = Get-AuthenticodeSignature -LiteralPath $destination
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'VC runtime Microsoft signature validation failed' }
Write-Output "Verified Microsoft VC++ x64 14.51.36247.0: $destination"
