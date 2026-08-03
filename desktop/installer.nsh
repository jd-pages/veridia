!macro customInit
  # electron-builder normally restores the previous directory from
  # Software\${APP_GUID}. Fall back to the standard uninstall entry so a
  # manual upgrade also keeps the existing directory if the primary value is
  # missing but Windows still knows where VERIDIA is installed.
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation

  ${If} $R8 == ""
  ${AndIf} $R9 == ""
    ReadRegStr $R8 HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R8 != ""
      StrCpy $hasPerUserInstallation "1"
      StrCpy $hasPerMachineInstallation "0"
      !insertmacro setInstallModePerUser
      StrCpy $INSTDIR $R8
    ${Else}
      ReadRegStr $R9 HKLM "${UNINSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R9 != ""
        StrCpy $hasPerUserInstallation "0"
        StrCpy $hasPerMachineInstallation "1"
        !insertmacro setInstallModePerAllUsers
        StrCpy $INSTDIR $R9
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  # Keep InstallLocation visible in Windows' standard uninstall metadata as a
  # durable fallback for future manual and automatic upgrades.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
!macroend

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除本机 VERIDIA 数据？$\r$\n$\r$\n选择“否”将保留数据库、审核结果、设置和小红书登录会话，重新安装或升级后可继续使用。" \
    /SD IDNO \
    IDNO keep_veridia_data

  ReadINIStr $0 "$LOCALAPPDATA\VERIDIA\config\data-location.ini" "VERIDIA" "DataDirectory"
  StrCmp $0 "" delete_default_data
  IfFileExists "$0\.veridia-data-root" 0 delete_default_data
  RMDir /r "$0"

  delete_default_data:
  RMDir /r "$LOCALAPPDATA\VERIDIA"

  keep_veridia_data:
!macroend
