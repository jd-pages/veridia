param(
  [string]$Url = "http://localhost:3100/login",
  [int]$TimeoutSeconds = 60
)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$lastError = $null

while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
      exit 0
    }
  } catch {
    $lastError = $_.Exception.Message
  }
  Start-Sleep -Milliseconds 750
}

if ($lastError) {
  [Console]::Error.WriteLine("VERIDIA was not ready within ${TimeoutSeconds} seconds: $lastError")
} else {
  [Console]::Error.WriteLine("VERIDIA was not ready within ${TimeoutSeconds} seconds.")
}
exit 1
