# ensure-keepalive.ps1
# 确保保活设施**自身**处于启用状态。
#
# 为什么需要它：2026-10-03 两个计划任务（QQDSH-HealthWatchdog / QQDSH-AI-Scheduler）
# 被置为 Disabled，于是 11:47 全链路挂掉后再没人拉起，空窗 7 小时。
# watchdog 每 5 分钟检查一次 QQ/DSH，却**检查不了自己被禁用**——
# 一个不运行的脚本什么也救不了。所以需要另一个入口来做这件事。
#
# 三层兜底（互为保险，任一层活着就能把其它层拉回来）：
#   1. QQDSH-TaskGuard（本脚本的任务）：登录时 + 每 30 分钟 → 重新启用 1/2
#   2. QQDSH-HealthWatchdog：每次运行开头也调一次本脚本 → 重新启用 1/2/3
#   3. tools\boot-all.ps1：用户手动启动全部时调用 → 重新启用 1/2
#
# 幂等、只读判断、绝不阻断：任何路径都以 0 退出（它是被计划任务调的，
# 非零退出码会把任务标成失败并污染历史记录）。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\tools\ensure-keepalive.ps1 [-Quiet]

param([switch]$Quiet)

$ErrorActionPreference = 'SilentlyContinue'

$root    = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $root 'state\keepalive.log'

# ── 退出口（kill switch）─────────────────────────────────────────────────────
# 这个脚本会**主动**把被禁用的计划任务重新启用。如果有一天你是**故意**关掉保活的，
# 它就会一直跟你对着干。所以留一个明确的退出开关：存在这个文件就完全停手。
#   彻底关闭保活：新建空文件 qq-bridge\state\keepalive-off
#                 + 删除启动文件夹里的 QQDSH-Keepalive.vbs
$offSwitch = Join-Path $root 'state\keepalive-off'
if (Test-Path -LiteralPath $offSwitch) {
  if (-not $Quiet) { Write-Host '检测到 state\keepalive-off：保活自检已按你的要求停手。' }
  exit 0
}

# TaskGuard 自己也在名单里：它被禁用了同样需要有人拉回来。
$tasks = @('QQDSH-HealthWatchdog', 'QQDSH-AI-Scheduler', 'QQDSH-TaskGuard')

function Write-Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

$fixed = @()
$missing = @()

foreach ($name in $tasks) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { $missing += $name; continue }
  if ($task.State -eq 'Disabled') {
    try {
      Enable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
      $fixed += $name
      Write-Log ("enabled: {0} (was Disabled -> re-enabled)" -f $name)
    } catch {
      Write-Log ("fail: 无法启用 {0}：{1}" -f $name, $_.Exception.Message)
    }
  }
}

# 缺失的任务记一笔（不重建：重建需要知道当时的路径/触发器意图，脚本自己不假装知道）。
#
# ⚠️ 必须限流：本脚本被 watchdog 每 5 分钟调一次 + 保活循环每 30 分钟调一次，
# 而 QQDSH-TaskGuard 在**没有管理员权限时永远建不出来**（Register-ScheduledTask → Access denied），
# 于是这条消息会一天写几百遍，把 keepalive.log 淹掉、真正的"重新启用"记录被埋在下面。
# 规则：缺失集合变了 → 立刻记；集合没变 → 最多每 6 小时记一次。
$kaStateFile = Join-Path $root 'state\keepalive-state.json'
$kaState = @{ missingLoggedAt = 0; missingLoggedSet = '' }
if (Test-Path -LiteralPath $kaStateFile) {
  try {
    $kj = ConvertFrom-Json (Get-Content -LiteralPath $kaStateFile -Raw)
    if ($kj.PSObject.Properties.Name -contains 'missingLoggedAt') { $kaState.missingLoggedAt = [double]$kj.missingLoggedAt }
    if ($kj.PSObject.Properties.Name -contains 'missingLoggedSet') { $kaState.missingLoggedSet = [string]$kj.missingLoggedSet }
  } catch { }
}
function Save-KaState {
  ([ordered]@{ missingLoggedAt = [double]$kaState.missingLoggedAt; missingLoggedSet = [string]$kaState.missingLoggedSet } | ConvertTo-Json) |
    Set-Content -LiteralPath $kaStateFile -Encoding UTF8
}

if ($missing.Count -gt 0) {
  $sig = (($missing | Sort-Object) -join ',')
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $changed = ($sig -ne [string]$kaState.missingLoggedSet)
  $stale = (($nowMs - [double]$kaState.missingLoggedAt) -gt (6 * 3600 * 1000))
  if ($changed -or $stale) {
    Write-Log ("missing: {0}（未注册；创建计划任务需管理员权限，日常兜底由启动项 keepalive-loop.vbs 承担）" -f $sig)
    $kaState.missingLoggedSet = $sig
    $kaState.missingLoggedAt = $nowMs
    Save-KaState
  }
}

if (-not $Quiet) {
  if ($fixed.Count -gt 0) { Write-Host ('已重新启用：' + ($fixed -join '、')) }
  else { Write-Host '保活任务均处于启用状态。' }
  if ($missing.Count -gt 0) { Write-Host ('未注册：' + ($missing -join '、')) }
}

exit 0
