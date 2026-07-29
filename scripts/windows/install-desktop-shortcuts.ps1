param(
  [string]$DesktopPath = [Environment]::GetFolderPath("Desktop")
)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$icon = Join-Path $projectRoot "assets\veridia.ico"
$shell = New-Object -ComObject WScript.Shell

$shortcuts = @(
  @{
    Name = "VERIDIA.lnk"
    Script = "veridia-open-hidden.vbs"
    Description = "Open VERIDIA"
  }
)

foreach ($item in $shortcuts) {
  $shortcutPath = Join-Path $DesktopPath $item.Name
  $scriptPath = Join-Path $projectRoot "scripts\windows\$($item.Script)"
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = "`"$scriptPath`""
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.Description = $item.Description
  if (Test-Path $icon) {
    $shortcut.IconLocation = "$icon,0"
  }
  $shortcut.Save()
}

Write-Output "VERIDIA desktop shortcuts installed in $DesktopPath."
