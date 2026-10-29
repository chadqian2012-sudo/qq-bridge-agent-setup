# ai-night-schedule.ps1
# Global QQ assistant service window, evaluated in the machine's local timezone (Asia/Shanghai).
# Monday-Thursday: paused all day.
# Friday: active 16:00-22:00.
# Saturday/Sunday and official holiday dates below: active 10:00-22:00.
# The scheduler runs hourly, so each boundary (10:00, 16:00, 22:00) is applied at that minute.
# AI_SCHED_NOW="yyyy-MM-dd HH:mm" and AI_SCHED_DRY=1 are read-only decision hooks.

$ErrorActionPreference = 'SilentlyContinue'
$root      = Split-Path -Parent $PSScriptRoot
$logFile   = Join-Path $root 'state\ai-schedule.log'
$tokenFile = Join-Path $root 'state\console-token'
$baseUrl   = 'http://127.0.0.1:3100'

# Official 2026 holiday break dates (State Council General Office notice).
# Update this list after each year's official arrangement is announced.
$holidayDates = @(
  '2026-01-01','2026-01-02','2026-01-03',
  '2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23',
  '2026-04-04','2026-04-05','2026-04-06',
  '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
  '2026-06-19','2026-06-20','2026-06-21',
  '2026-09-25','2026-09-26','2026-09-27',
  '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07'
)

function Write-Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $tokenFile)) {
  Write-Log 'skip: console-token not found (bridge has never started)'
  exit 0
}
$token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
if (-not $token) {
  Write-Log 'skip: console-token is empty'
  exit 0
}

$now = if ($env:AI_SCHED_NOW) { Get-Date $env:AI_SCHED_NOW } else {
  $zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
  [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $zone)
}
$minuteOfDay = $now.Hour * 60 + $now.Minute
$dateKey = $now.ToString('yyyy-MM-dd')
$isHoliday = $holidayDates -contains $dateKey
$isWeekend = $now.DayOfWeek -eq [System.DayOfWeek]::Saturday -or $now.DayOfWeek -eq [System.DayOfWeek]::Sunday
$isFriday = $now.DayOfWeek -eq [System.DayOfWeek]::Friday
if ($isHoliday -or $isWeekend) {
  $desired = -not ($minuteOfDay -ge 600 -and $minuteOfDay -lt 1320)
  $windowLabel = '10:00-22:00'
} elseif ($isFriday) {
  $desired = -not ($minuteOfDay -ge 960 -and $minuteOfDay -lt 1320)
  $windowLabel = '16:00-22:00'
} else {
  $desired = $true
  $windowLabel = '周一至周四全天关闭'
}

if ($env:AI_SCHED_DRY) {
  Write-Output ('dry-run: now={0:yyyy-MM-dd HH:mm} holiday={1} weekend={2} friday={3} window={4} desiredPaused={5}' -f $now, $isHoliday, $isWeekend, $isFriday, $windowLabel, $desired)
  exit 0
}

$headers = @{ 'x-console-token' = $token }
$current = $null
for ($attempt = 1; $attempt -le 10; $attempt++) {
  try {
    $state = Invoke-RestMethod -Uri "$baseUrl/api/socialV2/activity" -Headers $headers -TimeoutSec 8
    if ($null -ne $state.paused) { $current = [bool]$state.paused; break }
  } catch { }
  Start-Sleep -Seconds 20
}
if ($null -eq $current) {
  Write-Log 'fail: bridge console unreachable, state unchanged'
  exit 1
}
if ($current -eq $desired) { exit 0 }
$body = @{ paused = $desired } | ConvertTo-Json -Compress
try {
  $null = Invoke-RestMethod -Uri "$baseUrl/api/socialV2/activity" -Method Post `
    -Headers ($headers + @{ 'content-type' = 'application/json' }) `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15
  if ($desired) { Write-Log ('changed: AI paused (schedule {0})' -f $windowLabel) }
  else { Write-Log ('changed: AI resumed (schedule {0})' -f $windowLabel) }
} catch {
  Write-Log ('error: ' + $_.Exception.Message)
  exit 1
}
