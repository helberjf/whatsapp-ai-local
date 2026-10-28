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
& docker compose -f (Join-Path $projectRoot 'infra\compose.yaml') stop
if($LASTEXITCODE -ne 0) {exit $LASTEXITCODE}
Write-Output 'Central parada. Sessão e histórico preservados.'
