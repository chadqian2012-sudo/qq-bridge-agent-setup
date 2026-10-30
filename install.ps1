param(
  [Parameter(Mandatory=$true)][string]$SnowLumaDir,
  [Parameter(Mandatory=$true)][string]$DshBin,
  [Parameter(Mandatory=$true)][string]$BotQQ,
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'web',
  [string]$OwnerQQ = '',
  [string[]]$GroupIds = @(),
  [switch]$NoTasks,
  [switch]$SkipDshInstall,
  [switch]$NoStartLoop,
  [switch]$Resume
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ($Profile -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid DSH profile name.' }
foreach ($id in @($BotQQ, $OwnerQQ) + $GroupIds) {
  if ($id -and $id -notmatch '^[1-9][0-9]{4,11}$') { throw 'QQ and group identifiers must be 5–12 digits.' }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$SnowLumaDir = (Resolve-Path -LiteralPath $SnowLumaDir).Path
$DshBin = (Resolve-Path -LiteralPath $DshBin).Path
$DshHome = (Resolve-Path -LiteralPath $DshHome).Path
if (-not (Test-Path -LiteralPath (Join-Path $SnowLumaDir 'index.mjs'))) { throw 'SnowLuma index.mjs not found. Install SnowLuma separately first.' }
if (-not (Test-Path -LiteralPath (Join-Path $DshHome "profiles\$Profile\package.json"))) { throw 'DSH profile not found. Install DSH and create the profile first.' }
$onebotFile = Join-Path $SnowLumaDir "config\onebot_$BotQQ.json"
if (-not (Test-Path -LiteralPath $onebotFile)) { throw 'The selected bot OneBot configuration was not found.' }
$onebot = Get-Content -LiteralPath $onebotFile -Raw -Encoding UTF8 | ConvertFrom-Json
$http = @($onebot.networks.httpServers) | Where-Object { $_.port -eq 3000 } | Select-Object -First 1
$ws = @($onebot.networks.wsServers) | Where-Object { $_.port -eq 3001 } | Select-Object -First 1
if (-not $http -or -not $ws -or -not $http.accessToken -or -not $ws.accessToken) {
  throw 'Configure local OneBot HTTP 3000 and WebSocket 3001 with nonempty tokens first.'
}
$configPath = Join-Path $root 'config.json'
$runtimePath = Join-Path $root 'state\install.json'
if ((Test-Path -LiteralPath $configPath) -and -not $Resume) { throw 'config.json already exists; use -Resume to continue an interrupted installation without overwriting it.' }
if ($Resume -and (Test-Path -LiteralPath $runtimePath)) {
  $previous = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($previous.botUin -ne $BotQQ -or $previous.snowDir -ne $SnowLumaDir -or $previous.dshBin -ne $DshBin -or $previous.dshHome -ne $DshHome -or $previous.profile -ne $Profile) {
    throw 'Existing installation paths or account differ; use a separate checkout.'
  }
}
New-Item -ItemType Directory -Force -Path (Join-Path $root 'state') | Out-Null
& $npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
$config = Get-Content -LiteralPath (Join-Path $root 'config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$config.snowluma.accessToken = $http.accessToken
$config.snowluma | Add-Member -MemberType NoteProperty -Name wsAccessToken -Value $ws.accessToken -Force
$config.snowluma | Add-Member -MemberType NoteProperty -Name expectedSelfId -Value $BotQQ -Force
$config.snowluma.homeDir = $SnowLumaDir
$config.ownerQQ = if ($OwnerQQ) { $OwnerQQ } else { $null }
$config.allow.groups = @($GroupIds | ForEach-Object { [long]$_ })
$config.allow.private = @()
$config.groupStats | Add-Member -MemberType NoteProperty -Name groupIds -Value @($config.allow.groups) -Force
$config.groupStats.groupId = if ($config.allow.groups.Count -gt 0) { $config.allow.groups[0] } else { 0 }
$config.violationReport.groups = @($config.allow.groups)
$config | Add-Member -MemberType NoteProperty -Name allowAllPrivate -Value $false -Force
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path -LiteralPath $configPath)) { [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 100), $utf8) }
$runtime = @{ nodeExe=$node; snowDir=$SnowLumaDir; dshBin=$DshBin; botUin=$BotQQ; dshHome=$DshHome; profile=$Profile }
[IO.File]::WriteAllText((Join-Path $root 'state\install.json'), ($runtime | ConvertTo-Json), $utf8)
$rolePath = Join-Path $root 'state\current-role.json'
if (-not (Test-Path -LiteralPath $rolePath)) { [IO.File]::WriteAllText($rolePath, '{"role":"普瑞赛斯","mode":"active"}', $utf8) }
$socialPath = Join-Path $root 'state\social-v2.json'
if (-not (Test-Path -LiteralPath $socialPath)) { [IO.File]::WriteAllText($socialPath, '{"paused":true,"conversations":{}}', $utf8) }
$oldDshHome = $env:DSH_HOME
$oldSkip = $env:QQ_BRIDGE_SKIP_DSH_INSTALL
try {
  $env:DSH_HOME = $DshHome
  $env:QQ_BRIDGE_SKIP_DSH_INSTALL = '1'
  & $node (Join-Path $root 'scripts\setup-dsh.mjs') $Profile
  if ($LASTEXITCODE -ne 0) { throw 'DSH profile setup failed.' }
  if (-not $SkipDshInstall) {
    & $node $DshBin plugin --profile $Profile install
    if ($LASTEXITCODE -ne 0) { throw 'DSH plugin installation failed; consult DSH output and rerun after correcting the problem.' }
  }
} finally { $env:DSH_HOME = $oldDshHome; $env:QQ_BRIDGE_SKIP_DSH_INSTALL = $oldSkip }
if (-not $NoTasks) {
  $tasks = @(
    @{ name='QQDSH-HealthWatchdog'; script='health-watchdog.ps1'; minutes=5 },
    @{ name='QQDSH-AI-Scheduler'; script='ai-night-schedule.ps1'; minutes=60 }
  )
  foreach ($task in $tasks) {
    $existing = Get-ScheduledTask -TaskName $task.name -ErrorAction SilentlyContinue
    if ($existing) {
      $expected = Join-Path $root ('tools\' + $task.script)
      if (-not $Resume -or @($existing.Actions).Count -ne 1 -or -not $existing.Actions[0].Arguments.Contains($expected)) {
        throw "Task $($task.name) exists and does not belong to this installation; refusing to replace it."
      }
      $task.reuse = $true
    }
  }
  foreach ($task in $tasks) {
    if ($task.reuse) { continue }
    $script = Join-Path $root ('tools\' + $task.script)
    $vbs = Join-Path $root 'tools\run-hidden.vbs'
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B "{0}" "{1}"' -f $vbs, $script)
    if ($task.minutes -eq 60) {
      $china = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
      $chinaNow = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $china)
      $nextChina = $chinaNow.Date.AddHours($chinaNow.Hour + 1)
      $next = [TimeZoneInfo]::ConvertTimeFromUtc([TimeZoneInfo]::ConvertTimeToUtc($nextChina, $china), [TimeZoneInfo]::Local)
    } else { $next = (Get-Date).AddMinutes(1) }
    $trigger = New-ScheduledTaskTrigger -Once -At $next -RepetitionInterval (New-TimeSpan -Minutes $task.minutes) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $task.name -Action $action -Trigger $trigger -Settings $settings -Description 'QQ Bridge local service' | Out-Null
  }
  $startup = [Environment]::GetFolderPath('Startup')
  $launcher = Join-Path $startup 'QQDSH-Keepalive.vbs'
  $loop = Join-Path $root 'tools\keepalive-loop.vbs'
  $expression = ($loop.ToCharArray() | ForEach-Object { 'ChrW({0})' -f [int]$_ }) -join ' & '
  $launcherText = 'CreateObject("WScript.Shell").Run ' + $expression + ', 0, False' + "`r`n"
  if (Test-Path -LiteralPath $launcher) {
    if ((Get-Content -LiteralPath $launcher -Raw) -ne $launcherText) { throw 'A different QQDSH-Keepalive startup entry already exists; refusing to replace it.' }
  } else { [IO.File]::WriteAllText($launcher, $launcherText, [Text.Encoding]::ASCII) }
  $running = @(Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($loop) })
  if (-not $NoStartLoop -and $running.Count -eq 0) { Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', ('"{0}"' -f $launcher)) -WindowStyle Hidden | Out-Null }
}
Write-Host 'Installation complete. Restart DSH, start SnowLuma and QQ, then run tools/start-and-selfcheck.ps1.'
