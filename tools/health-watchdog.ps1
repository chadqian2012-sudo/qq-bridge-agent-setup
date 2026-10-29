# health-watchdog.ps1
# Keeps the QQ <-> DSH stack alive. Runs every 5 minutes (scheduled task
# "QQDSH-HealthWatchdog", launched windowless via tools\run-hidden.vbs) and restarts
# whatever is missing:
#
#   SnowLuma  (ports 3000/3001/5099) -> hidden launch, re-attaches to QQ by itself
#   DSH       (port 3080)            -> launched DIRECTLY from the npx cache (no npx,
#                                       which hung once and never bound the port)
#   qq-bridge (port 3100)            -> via start.bat (guard mode), hidden
#
# Escalation (added 2026-09-30 after a missed recovery):
#   A component whose port is down is not always "gone" - it can be a zombie/hung
#   process (external killers such as game boosters can leave one behind), and then
#   the old "process exists -> leave it alone" rule skipped the restart forever.
#   Now a component that is down for two consecutive runs - or whose process is older
#   than 3 minutes while its port stays down - gets its stale process killed and is
#   started fresh. Counter lives in state\watchdog-state.json.
#
# Quiet by design: writes to state\watchdog.log only when it acts, watches, or fails.

$ErrorActionPreference = 'SilentlyContinue'

$root        = Split-Path -Parent $PSScriptRoot
$logFile     = Join-Path $root 'state\watchdog.log'
$stateFile   = Join-Path $root 'state\watchdog-state.json'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
$stuckAfterMin = 3
# Test hook: WATCHDOG_STUCK_MIN overrides the staleness threshold so the escalation
# path can be exercised in seconds instead of waiting 3+ minutes.
if ($env:WATCHDOG_STUCK_MIN) { $stuckAfterMin = [double]$env:WATCHDOG_STUCK_MIN }

function Write-Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $pending = $client.BeginConnect('127.0.0.1', $port, $null, $null); if (-not $pending.AsyncWaitHandle.WaitOne(1000)) { return $false }; $client.EndConnect($pending); return $true }
  catch { return $false } finally { $client.Close() }
}

function Get-NodeProcs([string]$pattern) {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern -and (
      ($pattern -eq 'index\.mjs' -and $_.ExecutablePath -eq $snowNode) -or
      ($pattern -eq [regex]::Escape($dshBin) -and $_.CommandLine.Contains($dshBin)) -or
      ($pattern -eq 'bridge\.js' -and $_.CommandLine.Contains($root))
    ) })
}

function Get-CmdProcs([string]$pattern) {
  return @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern -and $_.CommandLine.Contains($root) })
}

# oldest matching process age in minutes (null when none)
function Get-ProcAgeMin($procs) {
  if (-not $procs -or $procs.Count -eq 0) { return $null }
  $ages = @($procs | ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.StartTime) { ((Get-Date) - $p.StartTime).TotalMinutes }
  }) | Where-Object { $_ -ne $null }
  if ($ages.Count -eq 0) { return $null }
  return ($ages | Measure-Object -Minimum).Minimum
}

# ---- 保活设施自检（互为兜底）------------------------------------------------
# watchdog 救不了被禁用的自己。每次运行时顺手把保活任务重新启用一遍：
# 它若被禁用，QQDSH-TaskGuard（登录时 + 每 30 分钟）会把它拉回来；反之亦然。
# 子进程调用而不是点源：脚本里有 exit，点源会把 watchdog 一起带走。
$guardScript = Join-Path $PSScriptRoot 'ensure-keepalive.ps1'
if (Test-Path -LiteralPath $guardScript) {
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath $psExe -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $guardScript, '-Quiet'
  ) | Out-Null
}

# ---- OneBot 真探活 ----------------------------------------------------------
# 注入白名单（权威来源，与 SnowLuma 的 hook 过滤同源）
function Get-AllowedUins {
  $f = Join-Path $snowDir 'config\hook-only-uins.json'
  if (-not (Test-Path -LiteralPath $f)) { return @() }
  try {
    $j = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json
    return @($j.uins | Where-Object { $_ } | ForEach-Object { [string]$_ })
  } catch { return @() }
}

# OneBot 是否真的在服务（而不只是端口在听）。
# 逐个候选配置试 token —— **绝不能只取第一个 onebot_*.json**：本机存在多个账号，
# 其中 onebot_9000000014.json 的 httpServers 是空数组，取到 null token 会得到 401，
# 把完全健康的网关判成故障，进而触发无意义的重启。
function Test-OneBotAlive {
  param([string[]]$PreferUins = @())

  if (-not (Test-Port 3000)) { return @{ ok = $false; reason = 'port 3000 not listening'; selfId = $null; nickname = $null } }

  $candidates = @()
  foreach ($u in $PreferUins) {
    $p = Join-Path $snowDir ('config\onebot_{0}.json' -f $u)
    if (Test-Path -LiteralPath $p) { $candidates += $p }
  }

  $lastErr = 'no candidate config with an http token'
  foreach ($p in $candidates) {
    $token = $null
    try {
      $j = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
      $servers = @($j.networks.httpServers)
      if ($servers.Count -gt 0) { $token = [string]$servers[0].accessToken }
    } catch { continue }
    if ([string]::IsNullOrWhiteSpace($token)) { continue }
    try {
      $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post -TimeoutSec 8 `
        -Headers @{ authorization = "Bearer $token"; 'content-type' = 'application/json' } -Body '{}'
      if ($r.status -eq 'ok' -and $r.data.user_id -and [string]$r.data.user_id -ne $botUin) {
        return @{ ok = $false; reason = 'wrong-account'; selfId = [string]$r.data.user_id; nickname = $null }
      }
      if ($r.status -eq 'ok' -and $r.data.user_id) {
        return @{ ok = $true; reason = 'ok'; selfId = [string]$r.data.user_id; nickname = [string]$r.data.nickname }
      }
      $lastErr = 'status=' + [string]$r.status
    } catch { $lastErr = $_.Exception.Message }
  }
  return @{ ok = $false; reason = $lastErr; selfId = $null; nickname = $null }
}

# 桥接控制台令牌（判定「桥接是否真的接上了 QQ 网关」要读 /api/status）
function Get-ConsoleToken {
  $f = Join-Path $root 'state\console-token'
  if (-not (Test-Path -LiteralPath $f)) { return '' }
  return (Get-Content -LiteralPath $f -Raw).Trim()
}

# ---- consecutive-down counters (persisted between runs) --------------------
$state = @{}
if (Test-Path -LiteralPath $stateFile) {
  $raw = Get-Content -LiteralPath $stateFile -Raw
  try {
    (ConvertFrom-Json $raw).PSObject.Properties | ForEach-Object { $state[$_.Name] = [int]$_.Value }
  } catch { }
}
function Save-State() {
  $ordered = [ordered]@{}
  foreach ($k in @('snowluma','dsh','bridge')) { $ordered[$k] = [int]($state[$k]) }
  ($ordered | ConvertTo-Json) | Set-Content -LiteralPath $stateFile -Encoding UTF8
}
function Set-Down([string]$name, [bool]$up) {
  if ($up) { $state[$name] = 0 } else { $state[$name] = [int]($state[$name]) + 1 }
  return [int]$state[$name]
}

# ---- 重启预算（防抖动）------------------------------------------------------
# 为什么需要：2026-10-03 把 SnowLuma 的判定从「有端口在听」收紧成「OneBot 真的能应答」之后，
# 出现了新的抖动风险 —— 如果 QQ 客户端压根没登录，OneBot 3000/3001 永远起不来，
# 但 SnowLuma 进程活得好好的，于是「检测到不健康 → 重启 → 还是起不来 → 再重启」无限循环。
# 所以给每个组件一个**滚动窗口内的重启次数上限**；用完就停下来只记日志，
# 等人来看（这才是有意义的保活：会自愈，但不会疯）。
$restartFile   = Join-Path $root 'state\watchdog-restarts.json'
$restartBudget = 4        # 窗口内最多重启几次
$restartWindowMin = 60    # 滚动窗口（分钟）
$suppressLogMin = 30      # 被抑制时的日志最小间隔（不然每 5 分钟刷一条，QQ 没登录时会刷几天）
$restarts = @{ snowluma = @(); dsh = @(); bridge = @() }
$suppress = @{ snowluma = 0; dsh = 0; bridge = 0 }
if (Test-Path -LiteralPath $restartFile) {
  try {
    $rj = ConvertFrom-Json (Get-Content -LiteralPath $restartFile -Raw)
    foreach ($k in @('snowluma','dsh','bridge')) {
      if ($rj.PSObject.Properties.Name -contains $k) { $restarts[$k] = @($rj.$k | Where-Object { $_ }) }
    }
    if ($rj.PSObject.Properties.Name -contains 'suppress') {
      foreach ($k in @('snowluma','dsh','bridge')) {
        if ($rj.suppress.PSObject.Properties.Name -contains $k) { $suppress[$k] = [double]$rj.suppress.$k }
      }
    }
  } catch { }
}
function Save-Restarts() {
  $obj = [ordered]@{
    snowluma = @($restarts['snowluma']); dsh = @($restarts['dsh']); bridge = @($restarts['bridge'])
    suppress = [ordered]@{ snowluma = [double]$suppress['snowluma']; dsh = [double]$suppress['dsh']; bridge = [double]$suppress['bridge'] }
  }
  ($obj | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $restartFile -Encoding UTF8
}
# 窗口内还剩几次重启额度（顺带把出窗口的旧记录丢掉）
function Get-RestartBudget([string]$name) {
  $cut = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - ($restartWindowMin * 60000)
  $recent = @($restarts[$name] | Where-Object { [double]$_ -gt $cut })
  $restarts[$name] = $recent
  return ($restartBudget - $recent.Count)
}
function Note-Restart([string]$name) {
  $list = @($restarts[$name])
  $list += [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $restarts[$name] = $list
  Save-Restarts
}
# 预算耗尽时的日志限流：返回 $true 表示这次该写
function Test-SuppressLogDue([string]$name) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (($now - [double]$suppress[$name]) -lt ($suppressLogMin * 60000)) { return $false }
  $suppress[$name] = $now
  Save-Restarts
  return $true
}

# ---------------------------------------------------------------- SnowLuma
# 健康 ≠ 有端口在听。旧判定是 (Test-Port 3001) -or (Test-Port 3000) -or (Test-Port 5099)：
# 只要 WebUI(5099) 活着就算健康，于是「QQ 钩子掉了、OneBot 3000/3001 根本没起来」
# 这种**最需要自愈**的状态反而被判成正常，watchdog 只能干看着。
# 现在要求：OneBot 的 HTTP(3000) 与 WS(3001) 都在听，**且** get_login_info 真的能应答。
$allowedUins = @($botUin)
$ob = Test-OneBotAlive -PreferUins $allowedUins
$slPortsUp = (Test-Port 3000) -and (Test-Port 3001)
$slUp = $slPortsUp -and $ob.ok
$slProcs = Get-NodeProcs 'index\.mjs'
$slAge = Get-ProcAgeMin $slProcs
$slDown = 0
if ($slUp) {
  $slDown = Set-Down 'snowluma' $true
} else {
  if ($null -eq $slAge) { $slDown = Set-Down 'snowluma' $false }
  elseif ($slAge -gt $stuckAfterMin) { $slDown = Set-Down 'snowluma' $false }
}

if ($ob.reason -eq 'wrong-account') {
  Write-Log 'SnowLuma is connected to a different QQ account; leaving it untouched.'
} elseif (-not $slUp -and $slDown -gt 0) {
  if ($slDown -ge 1 -and ($null -eq $slAge -or $slDown -ge 2)) {
    if ((Get-RestartBudget 'snowluma') -le 0) {
      if (Test-SuppressLogDue 'snowluma') {
        Write-Log ("suppress: SnowLuma 仍不健康，但 {0} 分钟内已重启 {1} 次，暂停自动重启以免抖动 —— 请检查 QQ 客户端是否已登录、以及注入白名单（hook-only-uins）是否与登录账号一致" -f $restartWindowMin, $restartBudget)
      }
    } else {
    Note-Restart 'snowluma'
    foreach ($p in $slProcs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Process -FilePath $snowNode -ArgumentList '.\index.mjs' -WorkingDirectory $snowDir `
      -RedirectStandardOutput (Join-Path $snowDir 'logs\snowluma.out.log') `
      -RedirectStandardError  (Join-Path $snowDir 'logs\snowluma.err.log') `
      -WindowStyle Hidden | Out-Null
    $why = if ($slPortsUp) { 'OneBot ports up but get_login_info failed: ' + $ob.reason } else { 'OneBot ports 3000/3001 not listening' }
    Write-Log ("restart: SnowLuma (down {0} run(s), stale procs killed: {1}; {2}; hidden, re-attaches to QQ)" -f $slDown, @($slProcs).Count, $why)
    $state['snowluma'] = 0
    }
  } else {
    Write-Log ("watch: SnowLuma unhealthy (ports={0} api={1}) while process alive {2:N1} min (run {3}/2), waiting one more cycle" -f $slPortsUp, $ob.reason, $slAge, $slDown)
  }
}

# ---------------------------------------------------------------- DSH
$dshUp = Test-Port 3080
$direct = Get-NodeProcs ([regex]::Escape($dshBin))
$npx    = Get-NodeProcs 'npx-cli'
$dshAge = Get-ProcAgeMin $direct
$dshDown = 0
if (-not $dshUp) {
  if ($null -eq $dshAge) { $dshDown = Set-Down 'dsh' $false }
  elseif ($dshAge -gt $stuckAfterMin) { $dshDown = Set-Down 'dsh' $false }
} else { $dshDown = Set-Down 'dsh' $true }

if (-not $dshUp -and $dshDown -gt 0) {
  $mayAct = (@($direct).Count -eq 0) -or ($dshDown -ge 2)
  if ($mayAct) {
   if ((Get-RestartBudget 'dsh') -le 0) {
    if (Test-SuppressLogDue 'dsh') {
      Write-Log ("suppress: DSH 仍不可用，但 {0} 分钟内已重启 {1} 次，暂停自动重启以免抖动 —— 请手动运行 DSH_Starter" -f $restartWindowMin, $restartBudget)
    }
   } else {
    # clear a hung dsh, and any npx wrapper that never produced a dsh process
    foreach ($p in $direct) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    $npxAge = Get-ProcAgeMin $npx
    if (@($npx).Count -gt 0 -and ($null -ne $npxAge) -and $npxAge -gt $stuckAfterMin) {
      foreach ($p in $npx) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
      foreach ($c in (Get-CmdProcs 'DSH_Starter')) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue }
      Write-Log 'stuck: npx launch had no dsh process -> killed'
    }
    if (@(Get-NodeProcs 'npx-cli').Count -eq 0) {
      if (Test-Path -LiteralPath $dshBin) {
        # --no-open: the desktop shortcut opens the UI itself, so the watchdog must not
        #            pop browser tabs; stdout is kept so the launch token (the
        #            "dsh web: http://127.0.0.1:3080/?token=..." line) stays discoverable.
        Note-Restart 'dsh'
        Start-Process -FilePath $nodeExe -ArgumentList @('"' + $dshBin + '"', '--profile', $profile, '--no-open') `
          -WorkingDirectory $root `
          -RedirectStandardOutput (Join-Path $root 'state\dsh-web.log') `
          -RedirectStandardError  (Join-Path $root 'state\dsh-web.err.log') `
          -WindowStyle Hidden | Out-Null
        Write-Log ("restart: DSH (down {0} run(s); direct from npx cache, hidden)" -f $dshDown)
        $state['dsh'] = 0
      } else {
        Write-Log 'fail: DSH binary not found in npx cache; run the DSH_Starter shortcut manually'
      }
    }
   }
  } else {
    Write-Log ("watch: DSH port down while process alive {0:N1} min (run {1}/2), waiting one more cycle" -f $dshAge, $dshDown)
  }
}

# ---------------------------------------------------------------- qq-bridge
# 同样地：端口在听 ≠ 桥接可用。2026-10-03 桥接进程一直活着、3100 也在听，
# 却在对着一个已经不存在的 SnowLuma 无限重连（bridge.log 里刷满 code=1006 重连），
# 只按端口判定的话这种状态永远不会被自愈。
$brUp = Test-Port 3100
$brProcs = Get-NodeProcs 'bridge\.js'
$brGuards = Get-CmdProcs 'start\.bat'
$brAge = Get-ProcAgeMin $brProcs

$brApiOk = $false
$brSnowOk = $null
$brApiWhy = 'not checked (port 3100 down)'
if ($brUp) {
  $consoleToken = Get-ConsoleToken
  if ($consoleToken) {
    try {
      $st = Invoke-RestMethod -Uri 'http://127.0.0.1:3100/api/status' -TimeoutSec 8 -Headers @{ 'x-console-token' = $consoleToken }
      $brApiOk = $true
      # ⚠️ 必须区分「字段存在且为 false」和「字段根本不存在」。
      # PowerShell 里 [bool]$null 就是 $false，直接写 [bool]$st.snowlumaConnected
      # 会把**旧版桥接**（/api/status 还没有这个字段）判成「已断连」并去重启它。
      # 实测踩过：日志出现 snowlumaConnected= 空值 + "bridge unhealthy"。
      if ($st.PSObject.Properties.Name -contains 'snowlumaConnected') {
        $brSnowOk = [bool]$st.snowlumaConnected
      } else {
        $brSnowOk = $null
      }
      $brApiWhy = ("mode={0} dshReady={1} snowlumaConnected={2} selfId={3}" -f $st.mode, $st.dshReady, $st.snowlumaConnected, $st.snowlumaSelfId)
    } catch { $brApiWhy = 'console api error: ' + $_.Exception.Message }
  } else { $brApiWhy = 'state\console-token missing' }
}

# 只有「网关自己健康、桥接却报告没连上」才算桥接的错。
# 网关本来就挂着时不能重启桥接：那会和 SnowLuma 的重启互相打架（各重启各的，抖动不停）。
# $brSnowOk 为 $null（旧版 /api/status 还没有 snowlumaConnected 字段，或 API 没读通）时不据此判定，
# 退回「只看端口」的原行为，避免升级过程中误重启。
$brDisconnected = $brUp -and $brApiOk -and ($brSnowOk -eq $false) -and $slUp
$brHealthy = $brUp -and (-not $brDisconnected)

$brDown = 0
if ($brHealthy) {
  $brDown = Set-Down 'bridge' $true
} else {
  # 进程刚起来时给它 stuckAfterMin 的宽限期：WebSocket 握手 + token 自愈需要几秒，
  # 别在握手中途把它打断（那会变成「重启→没连上→再重启」的循环）。
  if ($null -eq $brAge) { $brDown = Set-Down 'bridge' $false }
  elseif ($brAge -gt $stuckAfterMin) { $brDown = Set-Down 'bridge' $false }
}

if (-not $brHealthy -and $brDown -gt 0) {
  if ($brDown -ge 1 -and ($null -eq $brAge -or $brDown -ge 2)) {
   if ((Get-RestartBudget 'bridge') -le 0) {
    if (Test-SuppressLogDue 'bridge') {
      Write-Log ("suppress: qq-bridge 仍不健康（{0}），但 {1} 分钟内已重启 {2} 次，暂停自动重启以免抖动" -f $brApiWhy, $restartWindowMin, $restartBudget)
    }
   } else {
    Note-Restart 'bridge'
    foreach ($p in $brProcs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    foreach ($g in $brGuards) { Stop-Process -Id $g.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath (Join-Path $root 'state\bridge.lock') -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', ('"{0}"' -f (Join-Path $PSScriptRoot 'start-hidden.vbs')), ('"{0}"' -f (Join-Path $root 'start.bat'))) -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    $why = if ($brDisconnected) { 'up but not connected to SnowLuma (' + $brApiWhy + ')' } else { 'port 3100 not listening' }
    Write-Log ("restart: qq-bridge (down {0} run(s); {1}; hidden guard window)" -f $brDown, $why)
    $state['bridge'] = 0
   }
  } else {
    Write-Log ("watch: bridge unhealthy ({0}) while process alive {1:N1} min (run {2}/2), waiting one more cycle" -f $brApiWhy, $brAge, $brDown)
  }
}

Save-State

# ------------------------------------------- 账号正确性（**只告警，不自动重启**）
# 旧实现在这里重打一次 get_login_info，但用的是
#   Get-ChildItem config -Filter 'onebot_*.json' | Select-Object -First 1
# —— **任取一个**账号配置。本机有两个账号，其中 onebot_9000000014.json 的 httpServers 是空数组，
# 一旦取到它，token 就是 null，请求必然 401，于是报出假警
# "OneBot HTTP is listening but get_login_info failed"。
# 现在复用上面 Test-OneBotAlive 的结果（它已经逐个候选试过 token），不再重复请求。
#
# 注入白名单之外的账号被钩住时 OneBot 会**正常应答**，但那是错的号。
# 这里刻意只告警不重启：若 SnowLuma 升级导致 hook-only-uins 补丁丢失，
# 重启并不会修好它，反而会退化成每 5 分钟重启一次的抖动。
if ($slUp -and $ob.selfId -and $allowedUins.Count -gt 0 -and ($allowedUins -notcontains $ob.selfId)) {
  Write-Log ("warn: OneBot answers as {0}（{1}）which is NOT in hook-only-uins（{2}）；检查 SnowLuma 的注入白名单补丁是否还在（tools\patch-snowluma-hook-filter.mjs）" -f $ob.selfId, $ob.nickname, ($allowedUins -join ', '))
}
