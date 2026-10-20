; -*- coding: utf-8 -*-
Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 32

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!ifndef APP_VERSION
  !error "Run build-installer.ps1 to provide the version and verified package paths."
!endif
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nivra"

Name "Nivra Private Messenger"
OutFile "${SETUP_PATH}"
InstallDir "$LOCALAPPDATA\Programs\Nivra"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
BrandingText "Nivra Private Messenger"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Nivra Private Messenger"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "Nivra Private Messenger Setup"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Nivra"

!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Nivra.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Nivra Private Messenger"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "Spanish"
!insertmacro MUI_LANGUAGE "English"

!macro APP_CLOSED_FUNCTION PREFIX
Function ${PREFIX}EnsureAppClosed
  IfFileExists "$INSTDIR\Nivra.exe" 0 app_closed
  check_app:
    ; An active executable cannot be opened for writing. Never terminate the app
    ; while it could be committing messages or encrypted profile data.
    System::Call 'kernel32::CreateFile(t "$INSTDIR\Nivra.exe", i 0x40000000, i 3, p 0, i 3, i 0, p 0) p.r0'
    ${If} $0 == -1
      IfSilent locked_silent locked_prompt
      locked_silent:
        SetErrorLevel 2
        Abort
      locked_prompt:
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Cierra Nivra antes de continuar. / Close Nivra before continuing." IDRETRY check_app
        Abort
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  app_closed:
FunctionEnd
!macroend
!insertmacro APP_CLOSED_FUNCTION ""
!insertmacro APP_CLOSED_FUNCTION "un."

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Nivra requiere Windows de 64 bits. / Nivra requires 64-bit Windows."
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Nivra requiere Windows 10 o posterior. / Nivra requires Windows 10 or later."
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetShellVarContext current
  ; Keep app installation separate from Electron's existing user profile.
  ; Fix the destination even if a caller passes NSIS's /D command-line option.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Nivra"
FunctionEnd

Section "Nivra" SEC_APP
  Call EnsureAppClosed
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${PACKAGE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall Nivra.exe"
  CreateDirectory "$SMPROGRAMS\Nivra"
  CreateShortcut "$SMPROGRAMS\Nivra\Nivra.lnk" "$INSTDIR\Nivra.exe" "" "$INSTDIR\Nivra.exe" 0
  CreateShortcut "$DESKTOP\Nivra.lnk" "$INSTDIR\Nivra.exe" "" "$INSTDIR\Nivra.exe" 0
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Nivra Private Messenger"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Nivra"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Nivra.exe,0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall Nivra.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall Nivra.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${INSTALLED_SIZE_KB}
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  ; A moved uninstaller must never remove files from a different folder.
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\Nivra" expected_location
    SetErrorLevel 1
    Abort
  expected_location:
    Call un.EnsureAppClosed
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Nivra.lnk"
  Delete "$SMPROGRAMS\Nivra\Nivra.lnk"
  RMDir "$SMPROGRAMS\Nivra"
  ; Generated from package files: no recursive removal and no userData deletion.
  !include "${UNINSTALL_MANIFEST}"
  Delete "$INSTDIR\Uninstall Nivra.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
