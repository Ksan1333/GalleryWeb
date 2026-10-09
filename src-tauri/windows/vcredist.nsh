; Resolve these files relative to this include, not makensis' working directory.
!define PIXVAULT_RUNTIME_SOURCE "${__FILEDIR__}\..\target\vcredist\vc_redist.x64.exe"
!define PIXVAULT_RUNTIME_SCRIPT "${__FILEDIR__}\install-vcredist.ps1"
!macro PIXVAULT_ENSURE_VCRUNTIME
  InitPluginsDir
  File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${PIXVAULT_RUNTIME_SOURCE}"
  File "/oname=$PLUGINSDIR\install-vcredist.ps1" "${PIXVAULT_RUNTIME_SCRIPT}"
  ; NSIS is a 32-bit process. Sysnative invokes the 64-bit runtime checker.
  StrCpy $R7 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  DetailPrint "Checking Microsoft Visual C++ x64 runtime..."
  nsExec::ExecToStack '"$R7" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-vcredist.ps1" -InstallerPath "$PLUGINSDIR\vc_redist.x64.exe"'
  Pop $R8
  Pop $R9
  ${If} $R8 == 3010
    SetRebootFlag true
    ; Do not launch the app before Windows has replaced locked runtime DLLs.
    MessageBox MB_OK "Microsoft Visual C++ requires a Windows restart before starting PixVault. Restart Windows, then run this installer again." /SD IDOK
    SetErrorLevel 3010
    Quit
  ${ElseIf} $R8 != 0
    DetailPrint "$R9"
    MessageBox MB_OK|MB_ICONSTOP "Microsoft Visual C++ x64 runtime installation failed or was cancelled. PixVault setup cannot continue.$\r$\n$R9" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
