param([switch]$Quick)

$ErrorActionPreference = 'SilentlyContinue'


$root       = Split-Path -Parent $PSScriptRoot
$stateDir   = Join-Path $root 'state'
$logFile    = Join-Path $stateDir 'selfcheck.log'
$dshLog     = Join-Path $stateDir 'dsh-web.log'
$dshErrLog  = Join-Path $stateDir 'dsh-web.err.log'
$tokenFile  = Join-Path $stateDir 'console-token'
. (Join-Path $PSScriptRoot 'runtime-config.ps1')
$dshBase    = 'http://127.0.0.1:3080'
$bridgeBase = 'http://127.0.0.1:3100'
$snowUiBase = 'http://127.0.0.1:5099'

$results = New-Object System.Collections.Generic.List[object]


try {
  $rawUi = $Host.UI.RawUI
  $minWidth = 100
  if ($rawUi.BufferSize.Width -lt $minWidth) {
    $rawUi.BufferSize = New-Object Management.Automation.Host.Size($minWidth, [Math]::Max($rawUi.BufferSize.Height, 300))
  }
  if ($rawUi.WindowSize.Width -lt $minWidth) {
    $rawUi.WindowSize = New-Object Management.Automation.Host.Size($minWidth, $rawUi.WindowSize.Height)
  }
} catch { }


$consoleInfo = ''
try {
  $consoleInfo = ('console={0}x{1} cp={2}' -f $Host.UI.RawUI.WindowSize.Width, $Host.UI.RawUI.WindowSize.Height, [Console]::OutputEncoding.CodePage)
} catch { }


function Write-Section([string]$text) {
  Write-Host ''
  Write-Host $text -ForegroundColor Cyan
}

function Write-Item([string]$name, [string]$detail, [string]$mark = '·') {
  Write-Host ('  {0} {1,-20} {2}' -f $mark, $name, $detail)
}

function Add-Result([string]$name, [bool]$ok, [string]$detail) {
  $results.Add([pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail })
  Write-Item $name $detail $(if ($ok) { '[通过]' } else { '[异常]' })
}

function Write-Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}


function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $pending = $client.BeginConnect('127.0.0.1', $port, $null, $null); if (-not $pending.AsyncWaitHandle.WaitOne(1000)) { return $false }; $client.EndConnect($pending); return $true }
  catch { return $false } finally { $client.Close() }
}

function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Seconds 1
  }
  return (Test-Port $port)
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

function Stop-Procs($procs) {
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}


function Remove-DuplicateInstances {
  param([string]$Pattern, [int]$Port, [string]$Label)
  $procs = @(Get-NodeProcs $Pattern)
  if ($procs.Count -le 1) { return }
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return }
  $owner = $conn.OwningProcess
  $removed = 0
  foreach ($p in $procs) {
    if ($p.ProcessId -ne $owner) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      $removed++
    }
  }
  if ($removed -gt 0) {
    Write-Item $Label ('检测到 {0} 个同名实例，已清理空转实例 {1} 个' -f $procs.Count, $removed)
  }
}


function Invoke-NodeScript {
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [string]$OutName = 'node-task.out.log',
    [int]$TimeoutSec = 180
  )
  $outFile = Join-Path $stateDir $OutName
  $errFile = Join-Path $stateDir ([IO.Path]::GetFileNameWithoutExtension($OutName) + '.err.log')
  $proc = Start-Process -FilePath $nodeExe -ArgumentList $Script -WorkingDirectory $root `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru

  $exited = $proc.WaitForExit($TimeoutSec * 1000)
  if (-not $exited) {
    try { $proc.Kill() } catch { }
    try { $null = $proc.WaitForExit() } catch { }
  }
  $exitCode = -1
  try { $exitCode = [int]$proc.ExitCode } catch { $exitCode = -1 }
  $lines = @()
  foreach ($f in @($outFile, $errFile)) {
    if (Test-Path -LiteralPath $f) {
      try { $lines += (Get-Content -LiteralPath $f -Encoding UTF8) } catch { }
    }
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Lines = $lines }
}


function Start-SnowLuma {
  Start-Process -FilePath $snowNode -ArgumentList '.\index.mjs' -WorkingDirectory $snowDir `
    -RedirectStandardOutput (Join-Path $snowDir 'logs\snowluma.out.log') `
    -RedirectStandardError  (Join-Path $snowDir 'logs\snowluma.err.log') -WindowStyle Hidden | Out-Null
}

function Start-Dsh {
  Start-Process -FilePath $nodeExe -ArgumentList @('"' + $dshBin + '"', '--profile', $profile, '--no-open') `
    -WorkingDirectory $root -RedirectStandardOutput $dshLog -RedirectStandardError $dshErrLog -WindowStyle Hidden | Out-Null
}

function Start-Bridge {
  Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', ('"{0}"' -f (Join-Path $PSScriptRoot 'start-hidden.vbs')), ('"{0}"' -f (Join-Path $root 'start.bat'))) -WorkingDirectory $root -WindowStyle Hidden | Out-Null
}


function Get-DshLaunchUrl {
  if (-not (Test-Path -LiteralPath $dshLog)) { return '' }
  try {
    $text = Get-Content -LiteralPath $dshLog -Raw
    $m = [regex]::Match($text, 'http://127\.0\.0\.1:3080/\?token=[A-Za-z0-9_\-]+')
    if ($m.Success) { return $m.Value }
  } catch { }
  return ''
}

function Test-DshUrl([string]$url) {
  if (-not $url) { return $false }
  try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Wait-DshLaunchUrl([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    $u = Get-DshLaunchUrl
    if ($u -and (Test-DshUrl $u)) { return $u }
    Start-Sleep -Seconds 1
  }
  return ''
}


Write-Host ''
Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host ' QQ-DSH 链路：启动 / 检查 / 控制台' -ForegroundColor Cyan
Write-Host (' 时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
Write-Host '==========================================================' -ForegroundColor Cyan

# ---------------------------------------------------------------- 1. 组件启动
Write-Section '[1/3] 组件启动'


$dshPatchScript = Join-Path $PSScriptRoot 'patch-dsh-image-base64.mjs'
if (Test-Path -LiteralPath $dshPatchScript) {
  $patchOut = (& $nodeExe $dshPatchScript 2>&1) -join ' '
  Write-Item 'DSH 大图补丁' $(if ($patchOut) { $patchOut.Trim() } else { '已检查' })
}


$snowPatchScript = Join-Path $PSScriptRoot 'patch-snowluma-hook-filter.mjs'
if (Test-Path -LiteralPath $snowPatchScript) {
  $snowPatchOut = (& $nodeExe $snowPatchScript 2>&1) -join ' '
  Write-Item 'SnowLuma 注入白名单' $(if ($snowPatchOut) { $snowPatchOut.Trim() } else { '已检查' })
}

Remove-DuplicateInstances -Pattern 'index\.mjs' -Port 3000 -Label 'SnowLuma'
Remove-DuplicateInstances -Pattern ([regex]::Escape($dshBin)) -Port 3080 -Label 'DSH'
Remove-DuplicateInstances -Pattern 'bridge\.js' -Port 3100 -Label 'qq-bridge'

if ((Test-Port 3000) -and (Test-Port 5099)) {
  Write-Item 'SnowLuma' '运行中，端口 3000 / 5099 已监听'
} else {
  Write-Item 'SnowLuma' '未运行，正在启动'
  Stop-Procs (Get-NodeProcs 'index\.mjs')
  Start-SnowLuma
  $snowUiReady = Wait-Port 5099 60
  $snowOneBotReady = Wait-Port 3000 60
  if ($snowUiReady -and $snowOneBotReady) { Write-Item 'SnowLuma' '启动完成，QQ 钩子已自动注入' }
  else { Write-Item 'SnowLuma' ('启动超时：' + (($(@(5099, 3000) | Where-Object { -not (Test-Port $_) }) -join ' / ') + ' 未就绪')) }
}

if (-not (Test-Port 3080)) {
  Write-Item 'DSH' '未运行，正在启动'
  Stop-Procs (Get-NodeProcs ([regex]::Escape($dshBin)))
  if (Test-Path -LiteralPath $dshBin) {
    Start-Dsh
    if (Wait-Port 3080 60) { Write-Item 'DSH' '启动完成' }
    else { Write-Item 'DSH' '启动超时：60 秒内端口未就绪' }
  } else {
    Write-Item 'DSH' '未找到程序文件，已跳过'
  }
} else {
  Write-Item 'DSH' '运行中，端口 3080 已监听'
}

if (Test-Port 3100) {
  Write-Item 'qq-bridge' '运行中，端口 3100 已监听'
} else {
  Write-Item 'qq-bridge' '未运行，正在启动'
  Stop-Procs (Get-NodeProcs 'bridge\.js')
  Stop-Procs (Get-CmdProcs 'start\.bat')
  Start-Bridge
  if (Wait-Port 3100 60) { Write-Item 'qq-bridge' '启动完成' }
  else { Write-Item 'qq-bridge' '启动超时：60 秒内端口未就绪' }
}

# ---------------------------------------------------------------- 2. 访问地址
if (Test-Port 3100) {
  & (Join-Path $PSScriptRoot 'ai-night-schedule.ps1')
}
Write-Section '[2/3] 访问地址'

$dshUrl = Get-DshLaunchUrl
if (Test-DshUrl $dshUrl) {
  Write-Item 'DSH 访问令牌' '已取得（沿用当前进程签发的地址）'
} else {

  if (Test-Port 3080) {
    Write-Item 'DSH 访问令牌' '未取得，重启 DSH 以重新签发（约 5 秒）'
    Stop-Procs (Get-NodeProcs ([regex]::Escape($dshBin)))
    Start-Sleep -Seconds 2
  }
  Start-Dsh
  if (Wait-Port 3080 60) {
    $dshUrl = Wait-DshLaunchUrl 40
    if (Test-DshUrl $dshUrl) { Write-Item 'DSH 访问令牌' '已取得' }
    else { Write-Item 'DSH 访问令牌' '仍未取得，DSH 工作台将以无令牌地址打开' }
  } else {
    Write-Item 'DSH 访问令牌' 'DSH 未就绪，已跳过'
  }
}


Start-Sleep -Seconds 10

$consoleToken = ''
if (Test-Path -LiteralPath $tokenFile) { $consoleToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim() }
$bridgeConsoleUrl = if ($consoleToken) { "$bridgeBase/?token=$consoleToken" } else { "$bridgeBase/" }
$dshConsoleUrl    = if ($dshUrl) { $dshUrl } else { $dshBase }


Write-Section '[3/3] 健康检查'


$missingPorts = @()
foreach ($p in 3000, 3001, 3080, 3100, 5099) { if (-not (Test-Port $p)) { $missingPorts += $p } }
Add-Result '服务端口' ($missingPorts.Count -eq 0) $(if ($missingPorts.Count -eq 0) { '3000 / 3001 / 3080 / 3100 / 5099 均处于监听状态' } else { '未监听：' + ($missingPorts -join ' / ') })


$slCfgPath = Join-Path $snowDir ('config\onebot_{0}.json' -f $botUin)
$botOk = $false
$botDetail = '未找到账号配置：' + $slCfgPath
if (Test-Path -LiteralPath $slCfgPath) {
  $slCfg = Get-Content -LiteralPath $slCfgPath -Raw | ConvertFrom-Json
  $slToken = $slCfg.networks.httpServers[0].accessToken
  try {
    $login = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/get_login_info' -Method Post -TimeoutSec 15 `
      -Headers @{ authorization = "Bearer $slToken"; 'content-type' = 'application/json' } -Body '{}'
    if ($login.status -eq 'ok' -and [string]$login.data.user_id -eq [string]$botUin) {
      $botOk = $true
      $botDetail = ('已连接机器人账号 {0}（{1}）' -f $login.data.user_id, $login.data.nickname)
    } else {
      $botDetail = ('当前连接账号为 {0}（{1}），非机器人账号，请检查 SnowLuma 注入范围' -f $login.data.user_id, $login.data.nickname)
    }
  } catch {
    $botDetail = 'OneBot 接口无响应：' + $_.Exception.Message
  }
}
Add-Result 'QQ 机器人账号' $botOk $botDetail

$statusOk = $false
$statusDetail = '未找到控制台令牌文件'
if ($consoleToken) {
  try {
    $st = Invoke-RestMethod -Uri "$bridgeBase/api/status" -TimeoutSec 10 -Headers @{ 'x-console-token' = $consoleToken }
    $statusOk = ($st.dshReady -eq $true)
    $statusDetail = ('模式 {0} · DSH {1} · 角色 {2} · 白名单群 {3} 个 · 暂停 {4}' -f `
      $st.mode, $(if ($st.dshReady) { '就绪' } else { '未就绪' }), $st.role, @($st.allowGroups).Count, $(if ($st.socialV2Paused) { '是' } else { '否' }))
  } catch {
    $statusDetail = '控制台接口无响应：' + $_.Exception.Message
  }
}
Add-Result '桥接运行参数' $statusOk $statusDetail


$selfTestOk = $false
$selfTestLines = @()
for ($attempt = 1; $attempt -le 2; $attempt++) {
  $run = Invoke-NodeScript -Script 'src\self-test.js' -OutName 'selftest.out.log' -TimeoutSec 120
  $selfTestOk = ($run.ExitCode -eq 0)
  $selfTestLines = $run.Lines
  if ($selfTestOk) { break }
  if ($attempt -lt 2) {
    Write-Item '模型调用链路' '首次探测未通过，5 秒后重试（DSH 可能正忙）'
    Start-Sleep -Seconds 5
  }
}
Add-Result '模型调用链路' $selfTestOk $(if ($selfTestOk) { '会话创建 → 推理 → 响应 → 归档 全部成功' } else { (($selfTestLines | Select-Object -Last 2) -join ' / ') })


if (-not $Quick) {
  $adapt = Invoke-NodeScript -Script 'scripts\verify-dsh-015-adaptation.mjs' -OutName 'adaptation.out.log' -TimeoutSec 180
  $adaptLine = ($adapt.Lines | Select-String -Pattern '总计' | Select-Object -Last 1)
  Add-Result '适配层兼容性' ($adapt.ExitCode -eq 0) $(if ($adaptLine) { $adaptLine.Line.Trim() } else { '未取得检查结果' })
}


Write-Section '控制台'
$pages = @(
  [pscustomobject]@{ Name = '桥接控制台'; Url = $bridgeConsoleUrl },
  [pscustomobject]@{ Name = 'DSH 工作台'; Url = $dshConsoleUrl },
  [pscustomobject]@{ Name = 'SnowLuma 面板'; Url = $snowUiBase }
)
foreach ($page in $pages) {
  Start-Process $page.Url
  Write-Item $page.Name '已在浏览器打开（访问令牌不显示在日志中）'
}
Write-Host '  （已在默认浏览器中打开上述页面）' -ForegroundColor DarkGray


$failed = @($results | Where-Object { -not $_.Ok })
$passed = $results.Count - $failed.Count

Write-Host ''
if ($failed.Count -eq 0) {
  Write-Host ('检查结论：{0}/{1} 项通过，链路运行正常。' -f $passed, $results.Count) -ForegroundColor Green
} else {
  Write-Host ('检查结论：{0}/{1} 项通过，{2} 项异常：' -f $passed, $results.Count, $failed.Count) -ForegroundColor Red
  foreach ($f in $failed) { Write-Host ('   - {0}：{1}' -f $f.Name, $f.Detail) -ForegroundColor Red }
}

$summary = ($results | ForEach-Object { '{0}={1}' -f $_.Name, $(if ($_.Ok) { 'OK' } else { 'FAIL' }) }) -join '; '
Write-Log ('selfcheck: {0} | {1}{2}' -f $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' }), $summary, $(if ($consoleInfo) { ' | ' + $consoleInfo } else { '' }))
foreach ($f in $failed) { Write-Log ('  fail-detail: {0} -> {1}' -f $f.Name, $f.Detail) }

Write-Host ''
Write-Host ('检查日志：{0}' -f $logFile) -ForegroundColor DarkGray
Write-Host '按任意键退出…' -ForegroundColor DarkGray


if (-not $env:QQ_SELFCHECK_NO_PAUSE) {
  $waited = $false
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown'); $waited = $true } catch { }
  if (-not $waited) { try { $null = Read-Host; $waited = $true } catch { } }
  if (-not $waited) { Start-Sleep -Seconds 60 }
}
