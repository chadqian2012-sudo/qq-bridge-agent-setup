# boot-all.ps1
# QQ-DSH 统一入口：保活自检 → 启动全部组件 → 健康检查。
#
# 为什么需要它：在这之前，「把整套东西拉起来」需要人记住三件事——
#   1) 先跑 tools\ensure-keepalive（否则计划任务被禁用时没人拉活）
#   2) 用 tools\start-and-selfcheck.ps1 启动三个组件
#   3) 别忘了 SnowLuma 要重新挂上 QQ 钩子
# 任何一步漏掉，症状都是「看起来起来了，其实收发全废」。这里把它们串成一个动作。
#
# 组成：
#   [1/3] 保活自检  —— 重新启用被禁用的计划任务；安装/修复启动文件夹兜底
#   [2/3] 组件启动  —— 复用 tools\start-and-selfcheck.ps1（它已经处理好启动顺序、
#                      重复实例清理、DSH 带令牌地址、控制台打开）
#   [3/3] 健康检查  —— 同样由 start-and-selfcheck.ps1 完成
#
# 用法（双击仓库根的 boot-all.bat 即可）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\tools\boot-all.ps1
# 可选参数：
#   -KeepAliveOnly   只做保活自检（修计划任务 + 装启动兜底），不碰任何组件。
#                    用于排查/验收，避免顺手重启服务或弹出控制台页面。
#   -SkipSelfCheck   仍然启动组件，但跳过最耗时的适配层兼容性检查（快，约 15 秒）

param([switch]$SkipSelfCheck, [switch]$KeepAliveOnly)

$ErrorActionPreference = 'SilentlyContinue'

$root    = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root 'state'
$logFile = Join-Path $stateDir 'boot-all.log'
$psExe   = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$startup = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $startup 'QQDSH-Keepalive.vbs'
$loopScript = Join-Path $PSScriptRoot 'keepalive-loop.vbs'
$offSwitch  = Join-Path $stateDir 'keepalive-off'

function Write-Section([string]$text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
function Write-Item([string]$name, [string]$detail) { Write-Host ('  {0,-12} {1}' -f $name, $detail) }
function Write-Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

Write-Host ''
Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host ' QQ-DSH 统一入口：保活自检 / 启动全部 / 健康检查' -ForegroundColor Cyan
Write-Host (' 时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
Write-Host '==========================================================' -ForegroundColor Cyan

# ═══════════════════════════════════════════════════ [1/3] 保活自检
Write-Section '[1/3] 保活自检'

# 1a. 把被禁用的保活任务重新启用（2026-10-03 空窗 7 小时的根因就是它们被禁用）
$ensure = Join-Path $PSScriptRoot 'ensure-keepalive.ps1'
if (Test-Path -LiteralPath $ensure) {
  $out = & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ensure 2>&1
  $lines = @($out | Where-Object { $_ -and ([string]$_).Trim() })
  if ($lines.Count -eq 0) { Write-Item '保活任务' '均处于启用状态' }
  else { foreach ($l in $lines) { Write-Item '保活任务' ([string]$l) } }
} else {
  Write-Item '保活任务' ('缺少脚本：' + $ensure)
}

# 1b. 安装/修复启动文件夹兜底。
# 为什么用启动文件夹而不是新计划任务：创建计划任务需要管理员权限
# （本机实测 Register-ScheduledTask -> Access denied），启动文件夹是用户级等价入口。
if (Test-Path -LiteralPath $offSwitch) {
  Write-Item '启动兜底' 'state\keepalive-off 存在 —— 你已明确关闭保活，跳过安装'
} elseif (-not (Test-Path -LiteralPath $loopScript)) {
  Write-Item '启动兜底' ('缺少循环脚本：' + $loopScript)
} else {
  # 纯 ASCII：VBScript 按 ANSI 读取，非 ASCII 注释会被误解码并可能破坏解析。
  $desired = @(
    "' QQDSH-Keepalive.vbs - autostart entry for the keep-alive backstop (hidden)."
    "' Installed/verified by qq-bridge\tools\boot-all.ps1."
    "' Logic lives in qq-bridge\tools\keepalive-loop.vbs (loops every 30 minutes)."
    "' To disable keep-alive: create qq-bridge\state\keepalive-off and delete this file."
    ('CreateObject("WScript.Shell").Run "' + $loopScript + '", 0, False')
  ) -join "`r`n"
  $current = ''
  if (Test-Path -LiteralPath $launcher) { $current = (Get-Content -LiteralPath $launcher -Raw) }
  if ($current.Trim() -eq $desired.Trim()) {
    Write-Item '启动兜底' '已就位（QQDSH-Keepalive.vbs）'
  } else {
    try {
      Set-Content -LiteralPath $launcher -Value $desired -Encoding ASCII
      Write-Log ('installed: startup backstop -> {0}' -f $launcher)
      Write-Item '启动兜底' $(if ($current) { '已修复（路径或内容有变）' } else { '已安装（登录时自动拉活）' })
    } catch {
      Write-Item '启动兜底' ('安装失败：' + $_.Exception.Message)
    }
  }
}

# 循环进程是否在跑（登录后由启动项拉起；这里只报告，不强行再起一个）
$loopProcs = @(Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'keepalive-loop\.vbs' })
Write-Item '保活循环' $(if ($loopProcs.Count -gt 0) { '运行中（每 30 分钟自检一次）' } else { '未运行 —— 下次登录时由启动项拉起' })

# ═══════════════════════════════════════════════════ [2/3] + [3/3]
if ($KeepAliveOnly) {
  Write-Host ''
  Write-Host '（-KeepAliveOnly：保活自检完成，未触碰任何组件。）' -ForegroundColor DarkGray
  Write-Log 'boot-all: keep-alive only, skipped component handoff'
  exit 0
}

$selfCheck = Join-Path $PSScriptRoot 'start-and-selfcheck.ps1'
if (-not (Test-Path -LiteralPath $selfCheck)) {
  Write-Host ''
  Write-Host ('未找到 ' + $selfCheck + '，无法继续启动流程。') -ForegroundColor Red
  Write-Log 'fail: start-and-selfcheck.ps1 missing'
  exit 1
}

Write-Section '[2/3] 组件启动 + [3/3] 健康检查'
Write-Host '  交给 tools\start-and-selfcheck.ps1（启动顺序、重复实例清理、控制台地址都由它处理）…' -ForegroundColor DarkGray
Write-Log 'boot-all: handing off to start-and-selfcheck.ps1'

# 不设 QQ_SELFCHECK_NO_PAUSE：让它的「按任意键退出」保留，窗口不会一闪而过。
$args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $selfCheck)
if ($SkipSelfCheck) { $args += '-Quick' }
& $psExe @args
