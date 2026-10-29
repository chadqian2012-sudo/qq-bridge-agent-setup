# Local paths and account are supplied by the installer and never committed.
$installFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'state\install.json'
if (-not (Test-Path -LiteralPath $installFile)) { throw 'Missing state/install.json. Run install.ps1 first.' }
$runtime = Get-Content -LiteralPath $installFile -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($name in @('nodeExe', 'snowDir', 'dshBin', 'botUin')) {
  if (-not $runtime.$name) { throw "Missing runtime setting: $name" }
}
$nodeExe = $runtime.nodeExe
$snowDir = $runtime.snowDir
$snowNode = Join-Path $snowDir 'node.exe'
$dshBin = $runtime.dshBin
$botUin = [string]$runtime.botUin
$profile = if ($runtime.profile) { [string]$runtime.profile } else { 'web' }
if ($runtime.dshHome) { $env:DSH_HOME = [string]$runtime.dshHome }
