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
