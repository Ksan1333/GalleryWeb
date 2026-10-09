$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\src-tauri\windows\install-vcredist.ps1" -FunctionsOnly
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
$script:ready = $true
$script:launches = 0
$script:code = 0
$script:validHash = $true
$script:validSignature = $true
$script:after = $true
function Test-PixVaultVCRuntime { return $script:ready }
function Get-FileHash { return @{ Hash = $(if ($script:validHash) { '843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C' } else { 'bad' }) } }
function Get-AuthenticodeSignature { return @{Status=$(if($script:validSignature){'Valid'}else{'NotSigned'});SignerCertificate=@{Subject='CN=Microsoft Corporation, O=Microsoft Corporation, C=US'}} }
function Start-Process {
    param($FilePath,$ArgumentList,$Verb,$WindowStyle,[switch]$Wait,[switch]$PassThru)
    Assert ($Verb -eq 'RunAs' -and $WindowStyle -eq 'Hidden' -and $Wait -and $PassThru) 'Require elevation and await result'
    Assert (($ArgumentList -join ' ') -eq '/install /quiet /norestart') 'Must not restart Windows'
    $script:launches++; $script:ready=$script:after
    return @{ExitCode=$script:code}
}
Assert ((Install-PixVaultVCRuntime 'fixture') -eq 0 -and $script:launches -eq 0) 'Installed runtime should be skipped'
foreach($code in @(0,1638,3010)) {
    $script:ready=$false;$script:code=$code
    $result=Install-PixVaultVCRuntime 'fixture'
    Assert ($result -eq $(if($code -eq 3010){3010}else{0})) "Unexpected exit handling: $code"
}
foreach($case in @('hash','signature','cancel','missing')) {
    $script:ready=$false;$script:code=0;$script:after=$true
    $script:validHash=$case -ne 'hash';$script:validSignature=$case -ne 'signature'
    if($case -eq 'cancel'){$script:code=1223}
    if($case -eq 'missing'){$script:after=$false}
    $failed=$false
    try { Install-PixVaultVCRuntime 'fixture' | Out-Null } catch { $failed=$true }
    Assert $failed "Must reject $case"
}
Write-Output 'PASS runtime skip/install/newer/reboot/cancel/hash/signature/post-install verification'
