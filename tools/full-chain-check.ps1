# full-chain-check.ps1
# QQ-DSH 全链路体检：**只读**，不启动组件、不开浏览器、不发任何 QQ 消息。
#
# 与 tools\start-and-selfcheck.ps1 的分工：
#   start-and-selfcheck.ps1 = 启动器（缺啥拉啥 + 开控制台页面 + 顺带体检）
#   本脚本                  = 纯体检（对"现在这套东西到底通不通"给一个明确结论）
# 两者互补：排查「看起来起着、实际不通」时用本脚本；要一键把东西拉起来用那个。
#
# 检查范围（覆盖 2026-10-03 出过问题的每一个环节）：
#   1. 进程与端口        SnowLuma / DSH / 桥接 / 三个 MCP server
#   2. DSH profile 完整性 bundle 注册、MCP 区块、preset 清单、--dump-config 能否组合
#   3. QQ 网关            OneBot 是否应答、登录账号是否与注入白名单一致、群列表
#   4. 桥接运行参数       模式 / 人格 / 静默 / SnowLuma 连通性 / 白名单
#   5. 群聊可用性         目标群有没有会话、唤醒概率与潜水设置、生效人格
#   6. 群活跃日报         调度开关、消息库可达性、覆盖日与数据量
#   7. 保活              三个计划任务、启动兜底、重启预算、watchdog 最近动作
#   8. 模型链路（可选）   src\self-test.js：建会话→推理→响应→归档
#   9. 适配层（可选）     scripts\verify-dsh-015-adaptation.mjs
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\tools\full-chain-check.ps1
# 可选参数：
#   -SkipModel       跳过模型调用链路（省 token / 省时间）
#   -SkipAdaptation  跳过适配层兼容性检查（57 项，约 6 秒）
#   -Quiet           只输出结论与失败项

param([switch]$SkipModel, [switch]$SkipAdaptation, [switch]$Quiet)

$ErrorActionPreference = 'SilentlyContinue'

$root     = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root 'state'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
$dshHome  = $env:DSH_HOME
$profileDir = Join-Path $dshHome "profiles\$profile"
$bridgeBase = 'http://127.0.0.1:3100'
$configAtStart = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$targetGroups = @($configAtStart.allow.groups)
$keepaliveTasks = @('QQDSH-HealthWatchdog', 'QQDSH-AI-Scheduler', 'QQDSH-TaskGuard')

$script:results = New-Object System.Collections.Generic.List[object]

function Add-Check([string]$group, [string]$name, [bool]$ok, [string]$detail) {
  $script:results.Add([pscustomobject]@{ Group = $group; Name = $name; Ok = $ok; Detail = $detail })
  if (-not $Quiet) {
    $mark = if ($ok) { '[通过]' } else { '[异常]' }
    $color = if ($ok) { 'Gray' } else { 'Red' }
    Write-Host ('    {0} {1,-22} {2}' -f $mark, $name, $detail) -ForegroundColor $color
  }
}
function Write-Group([string]$text) {
  if (-not $Quiet) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
}
function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $pending = $client.BeginConnect('127.0.0.1', $port, $null, $null); if (-not $pending.AsyncWaitHandle.WaitOne(1000)) { return $false }; $client.EndConnect($pending); return $true }
  catch { return $false } finally { $client.Close() }
}
function Get-NodeProcs([string]$pattern) {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern })
}
# node 输出落盘后按 UTF-8 读：直接管道会被 PowerShell 按控制台代码页解码，中文变乱码。
function Invoke-Node([string]$script, [string]$outName = 'check.out.log', [int]$timeoutSec = 180) {
  $outFile = Join-Path $stateDir $outName
  $errFile = Join-Path $stateDir ([IO.Path]::GetFileNameWithoutExtension($outName) + '.err.log')
  $proc = Start-Process -FilePath $nodeExe -ArgumentList $script -WorkingDirectory $root `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru
  $exited = $proc.WaitForExit($timeoutSec * 1000)
  if (-not $exited) { try { $proc.Kill() } catch { }; try { $null = $proc.WaitForExit() } catch { } }
  $code = -1
  try { $code = [int]$proc.ExitCode } catch { $code = -1 }
  $lines = @()
  foreach ($f in @($outFile, $errFile)) {
    if (Test-Path -LiteralPath $f) { try { $lines += (Get-Content -LiteralPath $f -Encoding UTF8) } catch { } }
  }
  return [pscustomobject]@{ ExitCode = $code; Lines = $lines }
}
function Read-Json([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return (Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

Write-Host ''
Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host ' QQ-DSH 全链路体检（只读，不启动、不发送）' -ForegroundColor Cyan
Write-Host (' 时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
Write-Host '==========================================================' -ForegroundColor Cyan

# ═══════════════════════════════════════════════ 1. 进程与端口
Write-Group '[1/9] 进程与端口'
$ports = @{ 3000 = 'SnowLuma OneBot HTTP'; 3001 = 'SnowLuma OneBot WS'; 5099 = 'SnowLuma WebUI'; 3080 = 'DSH'; 3100 = 'qq-bridge' }
$missing = @()
foreach ($p in 3000, 3001, 5099, 3080, 3100) { if (-not (Test-Port $p)) { $missing += "$p($($ports[$p]))" } }
Add-Check '进程与端口' '服务端口' ($missing.Count -eq 0) $(if ($missing.Count -eq 0) { '3000/3001/5099/3080/3100 均在监听' } else { '未监听：' + ($missing -join '、') })

$mcpProcs = @(Get-NodeProcs 'mcp-(snowluma-safe|host-server|web-search-safe)\.js')
Add-Check '进程与端口' 'MCP server' ($mcpProcs.Count -ge 3) $(if ($mcpProcs.Count -ge 3) { "3 个都在运行（$($mcpProcs.ProcessId -join ', ')）" } else { "只找到 $($mcpProcs.Count) 个（期望 3：snowluma / snowluma-host / web-search-safe）" })

$slProc = @(Get-NodeProcs 'index\.mjs')
$brProc = @(Get-NodeProcs 'bridge\.js')
$dshProc = @(Get-NodeProcs 'dsh\\lib\\bin\.js')
Add-Check '进程与端口' '主进程' (($slProc.Count -ge 1) -and ($brProc.Count -ge 1) -and ($dshProc.Count -ge 1)) `
  ("SnowLuma PID={0} · 桥接 PID={1} · DSH PID={2}" -f (@($slProc.ProcessId) -join ','), (@($brProc.ProcessId) -join ','), (@($dshProc.ProcessId) -join ','))

# ═══════════════════════════════════════════════ 2. DSH profile 完整性
Write-Group '[2/9] DSH profile 完整性（2026-10-03 群聊失效的根因就在这一层）'
$pkg = Read-Json (Join-Path $profileDir 'package.json')
$deps = if ($pkg) { @($pkg.dependencies.PSObject.Properties.Name) } else { @() }
$bundles = if ($pkg) { @($pkg.dsh.profile.bundles) } else { @() }
$needBundles = @('qq-mode-console', 'qq-agent-presets')
$missBundles = @($needBundles | Where-Object { $bundles -notcontains $_ })
Add-Check 'profile' 'bundle 注册' ($missBundles.Count -eq 0) $(if ($missBundles.Count -eq 0) { "bundles 含 $($needBundles -join ' + ')" } else { '缺少：' + ($missBundles -join '、') + '（跑 node scripts/setup-dsh.mjs）' })

$missDeps = @($needBundles | Where-Object { $deps -notcontains $_ })
Add-Check 'profile' 'link: 依赖' ($missDeps.Count -eq 0) $(if ($missDeps.Count -eq 0) { '两个 bundle 都以 link: 注册' } else { '缺少：' + ($missDeps -join '、') })

$pluginLinkOk = $true
foreach ($n in $needBundles) {
  if (-not (Test-Path -LiteralPath (Join-Path $dshHome "plugins\$n\package.json"))) { $pluginLinkOk = $false }
  if (-not (Test-Path -LiteralPath (Join-Path $profileDir "node_modules\$n\package.json"))) { $pluginLinkOk = $false }
}
Add-Check 'profile' 'bundle 链接' $pluginLinkOk $(if ($pluginLinkOk) { '~/.dsh/plugins 与 profile/node_modules 两层链都在' } else { 'links 缺失或未指向仓库（跑 setup-dsh.mjs）' })

$cpFile = Join-Path $profileDir 'cordis.patch.yml'
$cpText = if (Test-Path -LiteralPath $cpFile) { Get-Content -LiteralPath $cpFile -Raw -Encoding UTF8 } else { '' }
# profile 的这个块里**只应该有 3 个 MCP**。qq-mode 不在这里：它由 qq-mode-console bundle
# 自带的 patch 注册（该 bundle 的注释说明 id 必须等于设置命名空间名 `qq-mode`，否则
# 模式写穿 DSH 设置会抛 No configurable plugin entry）。把它算进这个块会得到一个假异常。
$mcpIds = @('mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe')
$missMcp = @($mcpIds | Where-Object { $cpText -notmatch [regex]::Escape($_) })
Add-Check 'profile' 'cordis.patch MCP 块' ($missMcp.Count -eq 0) $(if ($missMcp.Count -eq 0) { '3 个 MCP 均已挂载' } else { '缺少条目：' + ($missMcp -join '、') })

$bundlePatch = Join-Path $root 'plugins\qq-mode-console\cordis.patch.yml'
$bundleText = if (Test-Path -LiteralPath $bundlePatch) { Get-Content -LiteralPath $bundlePatch -Raw -Encoding UTF8 } else { '' }
$qqModeOk = [bool]($bundleText -match 'id:\s*qq-mode')
Add-Check 'profile' 'qq-mode 注册' $qqModeOk $(if ($qqModeOk) { '由 qq-mode-console bundle 自带 patch 注册' } else { 'bundle 的 patch 里没有 id: qq-mode —— 模式写穿 DSH 设置会失效' })

if (Test-Path -LiteralPath $dshBin) {
  $dump = & $nodeExe $dshBin --profile $profile --dump-config 2>&1
  $dumpOk = ($LASTEXITCODE -eq 0)
  $hasPreset = [bool]($dump | Select-String -Pattern 'preset-qq-chat-v2' -Quiet)
  Add-Check 'profile' '--dump-config 组合' ($dumpOk -and $hasPreset) $(if ($dumpOk -and $hasPreset) { "组合成功且含 preset-qq-chat-v2（$($dump.Count) 行）" } else { "退出码=$LASTEXITCODE，含 preset-qq-chat-v2=$hasPreset" })
} else {
  Add-Check 'profile' '--dump-config 组合' $false '找不到 dsh bin.js'
}

# ═══════════════════════════════════════════════ 3. QQ 网关
Write-Group '[3/9] QQ 网关（OneBot）'
$allowedUins = @()
$uinsFile = Join-Path $snowDir 'config\hook-only-uins.json'
$uinsJson = Read-Json $uinsFile
if ($uinsJson) { $allowedUins = @($uinsJson.uins | Where-Object { $_ } | ForEach-Object { [string]$_ }) }

$login = $null
$loginErr = ''
if (Test-Port 3000) {
  $cand = @()
  foreach ($u in @($botUin)) {
    $p = Join-Path $snowDir "config\onebot_$u.json"
    if (Test-Path -LiteralPath $p) { $cand += $p }
  }
  foreach ($p in $cand) {
    $token = ''
    try {
      $j = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
      $srv = @($j.networks.httpServers)
      if ($srv.Count -gt 0) { $token = [string]$srv[0].accessToken }
    } catch { continue }
    if ([string]::IsNullOrWhiteSpace($token)) { continue }
    try {
      $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post -TimeoutSec 8 `
        -Headers @{ authorization = "Bearer $token"; 'content-type' = 'application/json' } -Body '{}'
      if ($r.status -eq 'ok' -and $r.data.user_id) { $login = $r.data; break }
    } catch { $loginErr = $_.Exception.Message }
  }
}
Add-Check 'QQ 网关' 'OneBot 应答' ($null -ne $login) $(if ($login) { "账号 $($login.user_id)（$($login.nickname)）" } else { 'get_login_info 失败：' + $(if ($loginErr) { $loginErr } else { '无可用 token 或端口未监听' }) })

if ($login) {
  $inList = ([string]$login.user_id -eq $botUin) -and (($allowedUins.Count -eq 0) -or ($allowedUins -contains [string]$login.user_id))
  Add-Check 'QQ 网关' '账号符合注入白名单' $inList $(if ($inList) { "白名单（$($allowedUins -join ', ')）内" } else { "当前登录 $($login.user_id)，不在白名单（$($allowedUins -join ', ')）—— 钩子注入范围可能不对" })
}

$groups = @()
if ($login) {
  try {
    $cand0 = Join-Path $snowDir "config\onebot_$botUin.json"
    $t0 = (Get-Content -LiteralPath $cand0 -Raw -Encoding UTF8 | ConvertFrom-Json).networks.httpServers[0].accessToken
    $g = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_group_list' -Method Post -TimeoutSec 10 `
      -Headers @{ authorization = "Bearer $t0"; 'content-type' = 'application/json' } -Body '{}'
    $groups = @($g.data)
  } catch { }
}
$missingGroups = @($targetGroups | Where-Object { $gid = $_; -not ($groups | Where-Object { [string]$_.group_id -eq [string]$gid }) })
Add-Check 'QQ 网关' '目标群可见' (($targetGroups.Count -eq 0) -or ($groups.Count -gt 0 -and $missingGroups.Count -eq 0)) $(if ($targetGroups.Count -eq 0) { '未配置目标群，已跳过' } elseif ($groups.Count -eq 0) { '取不到群列表' } elseif ($missingGroups.Count -eq 0) { "白名单目标群均可见（共 $($groups.Count) 个群）" } else { '看不到：' + ($missingGroups -join '、') })

# ═══════════════════════════════════════════════ 4. 桥接运行参数
Write-Group '[4/9] 桥接运行参数'
$consoleToken = ''
$ctFile = Join-Path $stateDir 'console-token'
if (Test-Path -LiteralPath $ctFile) { $consoleToken = (Get-Content -LiteralPath $ctFile -Raw).Trim() }
$status = $null
if ($consoleToken) {
  try { $status = Invoke-RestMethod -Uri "$bridgeBase/api/status" -TimeoutSec 10 -Headers @{ 'x-console-token' = $consoleToken } } catch { }
}
Add-Check '桥接' '控制台可读' ($null -ne $status) $(if ($status) { 'api/status 正常' } else { '控制台接口无响应（端口 3100 / console-token？）' })

if ($status) {
  $modeOk = ($status.mode -eq 'reserved2')
  Add-Check '桥接' '模式' $modeOk ("mode=$($status.mode)" + $(if ($modeOk) { '' } else { '　（群聊需要 reserved2；closed-agent 会丢弃所有群消息）' }))

  $roleOk = ($status.role -eq '普瑞赛斯') -and ($status.roleMode -eq 'active')
  Add-Check '桥接' '人格与静默' $roleOk ("role=$($status.role) roleMode=$($status.roleMode)" + $(if ($status.roleMode -ne 'active') { '　（silent 下群友消息不投递给 AI）' } else { '' }))

  Add-Check '桥接' 'SnowLuma 连通' ([bool]$status.snowlumaConnected) $(if ($status.snowlumaConnected) { "已连上，机器人 selfId=$($status.snowlumaSelfId)" } else { '未连上 —— 进程活着但收发全废' })

  Add-Check '桥接' 'DSH 就绪' ([bool]$status.dshReady) "dshReady=$($status.dshReady)"

  $oldDry = $env:AI_SCHED_DRY
  try {
    $env:AI_SCHED_DRY = '1'
    $schedule = & (Join-Path $PSScriptRoot 'ai-night-schedule.ps1')
  } finally { $env:AI_SCHED_DRY = $oldDry }
  $expectedPaused = if ($schedule -match 'desiredPaused=True') { $true } elseif ($schedule -match 'desiredPaused=False') { $false } else { $null }
  $pausedOk = ($null -ne $expectedPaused) -and ([bool]$status.socialV2Paused -eq $expectedPaused)
  Add-Check '桥接' 'AI 定时状态' $pausedOk "socialV2Paused=$($status.socialV2Paused) expectedPaused=$expectedPaused"

  $cfgJson = Read-Json (Join-Path $root 'config.json')
  $deny = if ($cfgJson) { @($cfgJson.deny.groups) } else { @() }
  $allow = @($status.allowGroups)
  if ($allow.Count -eq 0) {
    # 群白名单可以为空 —— 那是"群聊下线、只留私聊"的合法状态（2026-10-06 起本机就是这么配的）。
    # 但必须同时满足 allowAllWhenEmpty=false，否则会变成"所有群全放行"的反向事故。
    $emptyOk = -not [bool]$cfgJson.allowAllWhenEmpty
    Add-Check '桥接' '群白名单' $emptyOk "群聊白名单为空（不读取/不回应任何群消息）allowAllWhenEmpty=$($cfgJson.allowAllWhenEmpty) 私聊 allowAllPrivate=$($cfgJson.allowAllPrivate)  deny=$(if ($deny.Count) { $deny -join ',' } else { '(空)' })"
  } else {
    $allowOk = ((@($allow) | ForEach-Object { [string]$_ } | Sort-Object -Unique) -join ',') -eq ((@($targetGroups) | ForEach-Object { [string]$_ } | Sort-Object -Unique) -join ',')
    Add-Check '桥接' '群白名单' $allowOk "allow=$($allow -join ',')  deny=$(if ($deny.Count) { $deny -join ',' } else { '(空)' })"
  }
}

# ═══════════════════════════════════════════════ 5. 群聊可用性
Write-Group '[5/9] 群聊可用性（当前白名单群）'
$sv2 = Read-Json (Join-Path $stateDir 'social-v2.json')
$ro = Read-Json (Join-Path $stateDir 'role-overrides.json')
$cr = Read-Json (Join-Path $stateDir 'current-role.json')

# 有些群的概率是**管理员故意固定**的，不等于全局推荐值（见 src/bridge.js 的 ADMIN_WAKE_POLICY）。
# 硬拿 0.04 去比会把**正确配置**误报成异常 —— 2026-10-03 就真的这样报了一次泰拉联合群。
# 所以这里直接从 bridge.js 把策略解析出来，作为该群的期望值。
$adminPolicy = @{}
$adminActive = @{}
$adminAdaptive = @{}
try {
  $bridgeSrc = Get-Content (Join-Path $root 'src\bridge.js') -Raw -Encoding UTF8
  foreach ($m in [regex]::Matches($bridgeSrc, "'(group:\d+)':\s*Object\.freeze\(\{[^}]*?probability:\s*([0-9.]+)")) {
    $adminPolicy[$m.Groups[1].Value] = [double]$m.Groups[2].Value
  }
  # active:true = 不潜水（活跃模式）：任何消息都唤醒，此时 infinite 必然为 true。
  # 不单独解析它的话，"必须不是无限潜水"那条判定会把**正确的活跃配置**误报成异常。
  foreach ($m in [regex]::Matches($bridgeSrc, "'(group:\d+)':\s*Object\.freeze\(\{[^}]*?active:\s*true")) {
    $adminActive[$m.Groups[1].Value] = $true
  }
  # adaptive:true = 自适应潜水（时长不限）：模式必须是潜水、anyMessage 必须关（否则概率失效），
  # 但 **infinite 不设预期** —— "无时间限制"正是允许它无限期或自定义时长。
  foreach ($m in [regex]::Matches($bridgeSrc, "'(group:\d+)':\s*Object\.freeze\(\{[^}]*?adaptive:\s*true")) {
    $adminAdaptive[$m.Groups[1].Value] = $true
  }
} catch {
  # 解析失败就当没有策略表：退回全局推荐值，不因为体检脚本自己出错而误报。
}

foreach ($gid in $targetGroups) {
  $key = "group:$gid"
  $conv = if ($sv2) { $sv2.conversations.$key } else { $null }
  if ($conv) {
    $prob = $conv.wakeConfig.triggers.probability
    $inf = $conv.wakeConfig.infinite
    $modeNow = $conv.wakeConfig.mode
    $anyMsg = $conv.wakeConfig.triggers.anyMessage
    if ($adminActive.ContainsKey($key)) {
      $convOk = ($modeNow -eq 'active') -and ([bool]$anyMsg)
      Add-Check '群聊' $key $convOk "已建会话 mode=$modeNow anyMessage=$anyMsg（期望 active/True，管理员指定：不潜水）"
    } elseif ($adminAdaptive.ContainsKey($key)) {
      $wantProb = $adminPolicy[$key]
      $convOk = ($modeNow -eq 'diving') -and (-not [bool]$anyMsg) -and ([double]$prob -eq [double]$wantProb)
      Add-Check '群聊' $key $convOk "已建会话 mode=$modeNow anyMessage=$anyMsg probability=$prob（期望 diving/False/$wantProb，管理员指定：自适应潜水、时长不限）"
    } else {
    $pinned = $adminPolicy.ContainsKey($key)
    $expected = if ($pinned) { $adminPolicy[$key] } else { [double]$configAtStart.socialV2.wake.recommendedProbability }
    $expectedInfinite = [bool]$configAtStart.socialV2.wake.recommendedDefaultInfinite
    $convOk = ($modeNow -eq 'diving') -and (-not [bool]$anyMsg) -and ([double]$prob -eq [double]$expected) -and ([bool]$inf -eq $expectedInfinite)
    $why = if ($pinned) { '，管理员指定' } else { '' }
    Add-Check '群聊' $key $convOk "已建会话 mode=$modeNow probability=$prob infinite=$inf（期望 diving / $expected / $expectedInfinite$why）"
    }
  } else {
    Add-Check '群聊' $key $true '尚无会话（该群还没来过消息，首条消息到达时创建）'
  }
  $roleHere = if ($ro -and $ro.PSObject.Properties.Name -contains $key) { $ro.$key } else { if ($cr) { $cr.role } else { '(未设置)' } }
  Add-Check '群聊' "$key 人格" ($roleHere -eq '普瑞赛斯') "生效人格 = $roleHere"
}
if ($cr) {
  Add-Check '群聊' '全局人格' ($cr.role -eq '普瑞赛斯') "current-role.json role=$($cr.role) mode=$($cr.mode)"
}

# ═══════════════════════════════════════════════ 6. 群活跃日报
Write-Group '[6/9] 群活跃日报'
$cfgJson2 = Read-Json (Join-Path $root 'config.json')
if ($cfgJson2 -and $cfgJson2.groupStats) {
  $gs = $cfgJson2.groupStats
  # 目标群：多群写法 groupIds 优先，旧的单值 groupId 作兼容（与 src\group-stats.js 的
  # normalizeReportGroupIds 同一套语义：写了数组就以数组为准，哪怕是空数组）。
  $gsIds = @()
  if ($gs.groupIds -is [System.Array]) {
    foreach ($v in $gs.groupIds) { $n = 0; if ([int]::TryParse([string]$v, [ref]$n) -and $n -gt 0 -and ($gsIds -notcontains $n)) { $gsIds += $n } }
  } elseif ($gs.groupId) {
    $gsIds = @([int]$gs.groupId)
  }
  if (-not [bool]$gs.enabled) {
    # 群聊下线后日报一并停发是**预期状态**（它本来就是往群里发消息的功能），不算异常。
    Add-Check '日报' '已关闭' $true "groupStats.enabled=false（群聊下线后不再发布；目标群仍记录为 $($gsIds -join '、')，随时可重新开启）"
    $gsIds = @()
  } else {
    Add-Check '日报' '已启用' $true "enabled=$($gs.enabled) 目标群=$($gsIds -join '、') reportAt=$($gs.reportAt)"
  }
  $schedFile = Join-Path $stateDir 'group-stats-schedule.json'
  $sched = Read-Json $schedFile
  # 多群记账：每组一份（顶层 groups.\<群号\>）；旧格式是扁平单群对象，会被 src 侧迁移。
  # 注意不能用 PS7 的 ?? 运算符：计划任务里跑的是 Windows PowerShell 5.1。
  $schedDetail = '尚无记账（首次触发后生成）'
  if ($sched -and $sched.groups) {
    $parts = @()
    foreach ($gid in $gsIds) {
      $rec = $null
      if ($sched.groups.PSObject.Properties.Name -contains "$gid") { $rec = $sched.groups."$gid" }
      $lastSent = if ($rec -and $rec.lastSentFor) { $rec.lastSentFor } else { '未发' }
      $parts += "$gid=$lastSent"
    }
    if ($parts.Count) { $schedDetail = ($parts -join ' ') }
  } elseif ($sched) {
    $schedDetail = "（旧格式）lastSentFor=$($sched.lastSentFor) outcome=$($sched.lastOutcome)"
  }
  Add-Check '日报' '发送记账' ($null -ne $sched) $schedDetail

  foreach ($gid in $gsIds) {
    $preview = Invoke-Node "scripts\preview-group-report.mjs --group $gid" "gs-preview-$gid.out.log" 60
    $okPreview = ($preview.ExitCode -eq 0)
    $head = @($preview.Lines | Where-Object { $_ -match '消息库|日期|数据:' }) -join ' | '
    Add-Check '日报' "消息库与统计（$gid）" $okPreview $(if ($okPreview) { $head } else { ($preview.Lines | Select-Object -Last 1) })
  }
} else {
  Add-Check '日报' '配置' $false 'config.json 里没有 groupStats 段'
}

# ═══════════════════════════════════════════════ 7. 保活
Write-Group '[7/9] 保活设施'
$disabled = @()
$absent = @()
foreach ($t in $keepaliveTasks) {
  $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  if (-not $task) { $absent += $t; continue }
  if ($task.State -eq 'Disabled') { $disabled += $t }
}
$registered = @($keepaliveTasks | Where-Object { $_ -notin $absent })
Add-Check '保活' '计划任务启用' (($disabled.Count -eq 0) -and ($registered.Count -ge 2)) $(if ($disabled.Count -gt 0) { '被禁用：' + ($disabled -join '、') + '（跑 tools\ensure-keepalive.ps1）' } elseif ($absent.Count -gt 0) { "已启用 $($registered.Count) 个；未注册：$($absent -join '、')（创建任务需管理员权限，改用启动兜底）" } else { '三个任务全部启用' })

$launcher = Join-Path ([Environment]::GetFolderPath('Startup')) 'QQDSH-Keepalive.vbs'
Add-Check '保活' '启动兜底' (Test-Path -LiteralPath $launcher) $(if (Test-Path -LiteralPath $launcher) { 'QQDSH-Keepalive.vbs 已安装（登录时拉起 30 分钟自检循环）' } else { '未安装（跑 tools\boot-all.ps1 安装）' })

$loopProcs = @(Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'keepalive-loop\.vbs' })
Add-Check '保活' '自检循环进程' ($loopProcs.Count -gt 0) $(if ($loopProcs.Count -gt 0) { "运行中（PID $($loopProcs.ProcessId -join ',')）" } else { '未运行（下次登录由启动项拉起；watchdog 自身也每 5 分钟调一次自检）' })

$offSwitch = Join-Path $stateDir 'keepalive-off'
Add-Check '保活' '退出口' (-not (Test-Path -LiteralPath $offSwitch)) $(if (Test-Path -LiteralPath $offSwitch) { 'state\keepalive-off 存在 —— 保活自检已按你的要求停手' } else { '未设置（保活自检处于工作状态）' })

$wdState = Read-Json (Join-Path $stateDir 'watchdog-state.json')
Add-Check '保活' '连续失败计数' ($null -ne $wdState) $(if ($wdState) { "snowluma=$($wdState.snowluma) dsh=$($wdState.dsh) bridge=$($wdState.bridge)（非 0 表示正在升级处理）" } else { '无 watchdog-state.json' })

$wdLog = Join-Path $stateDir 'watchdog.log'
if (Test-Path -LiteralPath $wdLog) {
  $last = @(Get-Content -LiteralPath $wdLog -Encoding UTF8 -Tail 3)
  Add-Check '保活' 'watchdog 最近动作' $true $(if ($last.Count) { ($last[-1] -replace '^\d{4}-\d{2}-\d{2} ', '') } else { '日志为空' })
}

# ═══════════════════════════════════════════════ 8. 模型链路
if (-not $SkipModel) {
  Write-Group '[8/9] 模型调用链路（会创建一个独立测试会话）'
  $st = Invoke-Node 'src\self-test.js' 'fullcheck-selftest.out.log' 150
  $stOk = ($st.ExitCode -eq 0)
  $tail = @($st.Lines | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 2) -join ' / '
  Add-Check '模型链路' '建会话→推理→归档' $stOk $(if ($stOk) { '全链路成功' } else { $tail })
} else {
  Write-Group '[8/9] 模型调用链路 —— 已跳过（-SkipModel）'
}

# ═══════════════════════════════════════════════ 9. 适配层
if (-not $SkipAdaptation) {
  Write-Group '[9/9] 适配层兼容性'
  $ad = Invoke-Node 'scripts\verify-dsh-015-adaptation.mjs' 'fullcheck-adapt.out.log' 200
  $adOk = ($ad.ExitCode -eq 0)
  $adLine = @($ad.Lines | Select-String -Pattern '总计' | Select-Object -Last 1)
  Add-Check '适配层' 'DSH 协议适配' $adOk $(if ($adLine) { ([string]$adLine).Trim() } elseif ($adOk) { '通过' } else { (@($ad.Lines | Select-Object -Last 1) -join '') })
} else {
  Write-Group '[9/9] 适配层兼容性 —— 已跳过（-SkipAdaptation）'
}

# ═══════════════════════════════════════════════ 结论
$failed = @($script:results | Where-Object { -not $_.Ok })
$passed = $script:results.Count - $failed.Count
Write-Host ''
Write-Host '==========================================================' -ForegroundColor Cyan
if ($failed.Count -eq 0) {
  Write-Host (" 结论：{0}/{1} 项通过，全链路正常。" -f $passed, $script:results.Count) -ForegroundColor Green
} else {
  Write-Host (" 结论：{0}/{1} 项通过，{2} 项异常：" -f $passed, $script:results.Count, $failed.Count) -ForegroundColor Red
  foreach ($f in $failed) { Write-Host ('   - [{0}] {1}：{2}' -f $f.Group, $f.Name, $f.Detail) -ForegroundColor Red }
}
Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host ''

exit ($(if ($failed.Count -gt 0) { 1 } else { 0 }))
