; Included in the Windows installer by electron-builder (nsis.include).

; Closing the POS takes up to 20 s out of sight: the backend finishes the print queue step and takes a closing backup
; (desktop/src/main.ts, before-quit). An installer started right after closing the window would otherwise say the POS is
; still open. So wait for it (up to 30 s) before electron-builder's usual check, which asks to close it.
; electron-builder loads these only without a custom check; its usual check below needs them.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  StrCpy $R2 0
  tiffinWaitForClose:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
    ${andIf} $R2 < 30
      ${if} $R2 == 0
        DetailPrint "Waiting for Tiffin POS to finish closing (saving its closing backup)..."
      ${endIf}
      IntOp $R2 $R2 + 1
      Sleep 1000
      Goto tiffinWaitForClose
    ${endIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
