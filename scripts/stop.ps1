$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$pidFile=Join-Path $projectRoot 'data\server.pid'
if(Test-Path -LiteralPath $pidFile) {
  $serverPid=[int](Get-Content -LiteralPath $pidFile)
  $process=Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
  $expected=Join-Path $projectRoot 'server.cjs'
  if($process -and $process.Name -eq 'node.exe' -and $process.CommandLine.Contains($expected)) {Stop-Process -Id $serverPid}
  Remove-Item -LiteralPath $pidFile
}
# Central aberta sem arquivo de processo (por exemplo, iniciada à mão ou por uma versão anterior): usa o processo informado por ela.
try {
  $health=Invoke-RestMethod -Uri 'http://127.0.0.1:8766/health' -TimeoutSec 2
  if($health.service -eq 'whatsapp-local' -and $health.pid) {
    $process=Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$health.pid)" -ErrorAction SilentlyContinue
    if($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -and $process.CommandLine.Contains('server.cjs')) {Stop-Process -Id ([int]$health.pid) -Force}
  }
} catch {}
& docker compose -f (Join-Path $projectRoot 'infra\compose.yaml') stop
if($LASTEXITCODE -ne 0) {exit $LASTEXITCODE}
Write-Output 'Central parada. Sessão e histórico preservados.'
