; Installer for the payment machines add-on (id edc). Built by scripts/installer.mjs (makensis from electron-builder's cache).
; Installs for the current Windows user (no administrator), next to an installed Tiffin POS:
;   %LOCALAPPDATA%\TiffinPOS\addons\edc\  (signed package: the POS checks it before loading it)
; Defines passed in: VERSION, SRC (built package folder), OUTFILE, ICON.
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define NAME "Tiffin POS - Payment machines"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TiffinPOS-PaymentMachines"

Name "${NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\TiffinPOS\addons\edc"
BrandingText "Tiffin POS"
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Payment machines for Tiffin POS"
!define MUI_WELCOMEPAGE_TEXT "This adds card machines (EDC) to Tiffin POS on this PC:$\r$\n$\r$\n- Settings > Payment machines: Paytm and Pine Labs, wireless (internet) or wired (USB or LAN cable)$\r$\n- At the counter: Card and UPI payments sent to the machine; the bill is saved when it approves$\r$\n- Orders: reverse a machine payment; a daily match of machine payments and bills$\r$\n$\r$\nTiffin POS 0.3.8 or newer must already be installed. Your bills and data are not changed."
!define MUI_FINISHPAGE_TITLE "Payment machines is installed"
!define MUI_FINISHPAGE_TEXT "Restart Tiffin POS to use it. If the POS is open, it will ask you to restart."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${NAME}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${NAME} installer"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026"

Function .onInit
  ; the add-on needs an installed POS (per-user install from TiffinPOS-Setup)
  ${IfNot} ${FileExists} "$LOCALAPPDATA\Programs\TiffinPOS\TiffinPOS.exe"
    MessageBox MB_ICONSTOP|MB_OK "Install Tiffin POS first (version 0.3.8 or newer), then run this installer again." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Section "Payment machines"
  SetOutPath "$INSTDIR"
  ; remove the old signature first and write the new one last: the POS never sees a half-copied package as valid
  Delete "$INSTDIR\manifest.json"
  File "${SRC}\backend.cjs"
  File "${SRC}\ui.js"
  File "${SRC}\manifest.json"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${NAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "Tiffin POS"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; signature first, so the POS stops loading it at once; machine settings and payment records in the POS database are kept
  Delete "$INSTDIR\manifest.json"
  Delete "$INSTDIR\backend.cjs"
  Delete "$INSTDIR\ui.js"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd
