param(
  [string]$TaskName = "VERIDIA Background Service"
)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$launcher = Join-Path $projectRoot "scripts\windows\veridia-autostart.vbs"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Start the local VERIDIA production server through PM2 after Windows sign-in." `
  -User $currentUser `
  -RunLevel Limited `
  -Force | Out-Null

Write-Output "Scheduled task '$TaskName' installed for $currentUser."
