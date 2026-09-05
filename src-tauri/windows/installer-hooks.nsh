; Complete Tauri's basic extension registration with Windows Default Apps /
; Open With discovery, and quote both the executable and selected file.
!include "LogicLib.nsh"

!macro PIXVAULT_BACKUP_FILE_TYPE EXT PROGID
  ; The separate sentinel distinguishes "captured and originally empty" from
  ; "not captured yet". Keep this durable value across repair/update installs.
  ReadRegStr $R9 SHELL_CONTEXT "Software\PixVault\AssociationBackups" ".${EXT}.captured"
  ${If} $R9 != "1"
    ReadRegStr $R8 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ; A legacy/partial PixVault install is not a safe previous default.
    ${If} $R8 == "${PROGID}"
      StrCpy $R8 ""
    ${EndIf}
    WriteRegStr SHELL_CONTEXT "Software\PixVault\AssociationBackups" ".${EXT}" "$R8"
    WriteRegStr SHELL_CONTEXT "Software\PixVault\AssociationBackups" ".${EXT}.captured" "1"
  ${EndIf}
!macroend

!macro PIXVAULT_REGISTER_FILE_TYPE EXT PROGID
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr SHELL_CONTEXT "Software\PixVault\Capabilities\FileAssociations" ".${EXT}" "${PROGID}"
  ReadRegStr $R9 SHELL_CONTEXT "Software\PixVault\AssociationBackups" ".${EXT}.captured"
  ${If} $R9 == "1"
    ReadRegStr $R8 SHELL_CONTEXT "Software\PixVault\AssociationBackups" ".${EXT}"
    ; Tauri's APP_ASSOCIATE temporarily makes PixVault the default. Restore
    ; the captured value immediately so install only adds an Open With choice.
    ${If} $R8 == ""
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" "${PROGID}_backup"
    ${Else}
      WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "$R8"
      WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "${PROGID}_backup" "$R8"
    ${EndIf}
  ${EndIf}
!macroend

!macro PIXVAULT_UNREGISTER_FILE_TYPE EXT PROGID
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids"
!macroend

!macro PIXVAULT_QUOTE_OPEN_COMMAND PROGID
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "jpg" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "jpeg" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "png" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "webp" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "bmp" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "heic" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "heif" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "avif" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "tif" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "tiff" "PixVault.Image"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "gif" "PixVault.GIF"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "mp4" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "m4v" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "mov" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "mkv" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "webm" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "avi" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "wmv" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "mpeg" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "mpg" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "ts" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "m2ts" "PixVault.Video"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "zip" "PixVault.BookArchive"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "cbz" "PixVault.BookArchive"
  !insertmacro PIXVAULT_BACKUP_FILE_TYPE "pdf" "PixVault.PDF"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "PixVault for Windows" "Software\PixVault\Capabilities"
  WriteRegStr SHELL_CONTEXT "Software\PixVault\Capabilities" "ApplicationName" "PixVault for Windows"
  WriteRegStr SHELL_CONTEXT "Software\PixVault\Capabilities" "ApplicationDescription" "Local image, GIF, video and book viewer"
  WriteRegStr SHELL_CONTEXT "Software\PixVault\Capabilities" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"

  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "jpg" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "jpeg" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "png" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "webp" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "bmp" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "heic" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "heif" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "avif" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "tif" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "tiff" "PixVault.Image"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "gif" "PixVault.GIF"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "mp4" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "m4v" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "mov" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "mkv" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "webm" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "avi" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "wmv" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "mpeg" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "mpg" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "ts" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "m2ts" "PixVault.Video"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "zip" "PixVault.BookArchive"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "cbz" "PixVault.BookArchive"
  !insertmacro PIXVAULT_REGISTER_FILE_TYPE "pdf" "PixVault.PDF"

  !insertmacro PIXVAULT_QUOTE_OPEN_COMMAND "PixVault.Image"
  !insertmacro PIXVAULT_QUOTE_OPEN_COMMAND "PixVault.GIF"
  !insertmacro PIXVAULT_QUOTE_OPEN_COMMAND "PixVault.Video"
  !insertmacro PIXVAULT_QUOTE_OPEN_COMMAND "PixVault.BookArchive"
  !insertmacro PIXVAULT_QUOTE_OPEN_COMMAND "PixVault.PDF"
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "PixVault for Windows"
  DeleteRegKey SHELL_CONTEXT "Software\PixVault\Capabilities"

  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "jpg" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "jpeg" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "png" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "webp" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "bmp" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "heic" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "heif" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "avif" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "tif" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "tiff" "PixVault.Image"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "gif" "PixVault.GIF"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "mp4" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "m4v" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "mov" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "mkv" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "webm" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "avi" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "wmv" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "mpeg" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "mpg" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "ts" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "m2ts" "PixVault.Video"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "zip" "PixVault.BookArchive"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "cbz" "PixVault.BookArchive"
  !insertmacro PIXVAULT_UNREGISTER_FILE_TYPE "pdf" "PixVault.PDF"
  DeleteRegKey SHELL_CONTEXT "Software\PixVault\AssociationBackups"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\PixVault"
  !insertmacro UPDATEFILEASSOC
!macroend
