param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$centralUrl='http://127.0.0.1:8766/'
$composeFile=Join-Path $projectRoot 'infra\compose.yaml'
$dataPath=Join-Path $projectRoot 'data'
$nodePath=(Get-Command node -ErrorAction Stop).Source
function Get-Central {
  try { $response=Invoke-RestMethod -Uri ($centralUrl+'health') -TimeoutSec 2;if($response.service -eq 'whatsapp-local') {return $response} } catch {}
  return $null
}
function Test-Central { return $null -ne (Get-Central) }
# Uma central aberta antes de uma atualização continua rodando o código antigo com a página nova: para ela antes de abrir.
function Stop-OldCentral($running) {
  $candidates=@()
  if($running.pid) {$candidates+=[int]$running.pid}
  $pidFile=Join-Path $dataPath 'server.pid'
  if(Test-Path -LiteralPath $pidFile) {try {$candidates+=[int](Get-Content -LiteralPath $pidFile)} catch {}}
  try {$candidates+=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8766 -State Listen -ErrorAction Stop | ForEach-Object {[int]$_.OwningProcess})} catch {}
  foreach($candidate in ($candidates | Select-Object -Unique)) {
    $process=Get-CimInstance Win32_Process -Filter "ProcessId = $candidate" -ErrorAction SilentlyContinue
    if($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -and $process.CommandLine.Contains('server.cjs')) {Stop-Process -Id $candidate -Force -ErrorAction SilentlyContinue}
  }
  for($attempt=0;$attempt -lt 20;$attempt++) {if(-not (Test-Central)) {return $true};Start-Sleep -Milliseconds 500}
  return $false
}
$taskMutex=New-Object System.Threading.Mutex($false,'Local\WhatsAppLocalStart')
$hasMutex=$false
try {
  $hasMutex=$taskMutex.WaitOne(240000)
  if(-not $hasMutex) {throw 'Outra inicialização ainda está em andamento. Aguarde e abra a central novamente.'}
  & $nodePath (Join-Path $PSScriptRoot 'configure.cjs')
  if($LASTEXITCODE -ne 0) {throw 'A configuração não pôde ser preparada.'}
  & (Join-Path $PSScriptRoot 'windows-ca.ps1')
  Get-Command docker -ErrorAction Stop | Out-Null
  function Test-Docker {
    # Windows PowerShell 5 trata stderr nativo como erro terminante sob Stop.
    $previousPreference=$ErrorActionPreference
    try {$ErrorActionPreference='Continue'; & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null;return $LASTEXITCODE -eq 0}
    finally {$ErrorActionPreference=$previousPreference}
  }
  if(-not (Test-Docker)) {
    $dockerDesktop=Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if(-not (Test-Path -LiteralPath $dockerDesktop)) {throw 'Instale e abra o Docker Desktop para continuar.'}
    Write-Output 'Iniciando Docker Desktop…'
    Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
    $dockerReady=$false
    for($attempt=0;$attempt -lt 60;$attempt++) {
      Start-Sleep -Seconds 2
      if(Test-Docker) {$dockerReady=$true;break}
    }
    if(-not $dockerReady) {throw 'O Docker não iniciou. Abra Docker Desktop, resolva eventuais avisos e tente novamente.'}
  }
  Write-Output 'Preparando WhatsApp, banco e sessão persistente…'
  & docker compose -f $composeFile up -d --build --wait --wait-timeout 180
  if($LASTEXITCODE -ne 0) {throw 'A pilha local não ficou pronta. Consulte docker compose -f infra/compose.yaml logs --tail=50.'}
  # Banco da central no PostgreSQL: cria usuário e banco só se ainda não existirem; dados existentes não são alterados.
  & $nodePath (Join-Path $PSScriptRoot 'provision-database.cjs')
  if($LASTEXITCODE -ne 0) {throw 'O banco PostgreSQL da central não ficou pronto. Consulte docker compose -f infra/compose.yaml logs postgres --tail=50.'}
  $expectedBuild=(& $nodePath (Join-Path $projectRoot 'lib\build-id.cjs') | Out-String).Trim()
  $running=Get-Central
  if($running -and $running.build -and $running.build -eq $expectedBuild) {
    Write-Output 'Central ja iniciada. Reutilizando a sessao.'
    if(-not $NoBrowser) {Start-Process $centralUrl}
    exit 0
  }
  if($running) {
    Write-Output 'A central aberta e de uma versao anterior. Reiniciando com a atualizacao...'
    if(-not (Stop-OldCentral $running)) {throw 'A central anterior continua aberta. Use Parar WhatsApp.cmd e abra de novo.'}
  }
  # O auxiliar fica em segundo plano, sem depender de uma janela de terminal aberta.
  $scriptPath=Join-Path $projectRoot 'server.cjs'
  $nodeCaPath=Join-Path $dataPath 'certs\windows-ca.pem'
  if(-not $env:NODE_EXTRA_CA_CERTS -and (Test-Path -LiteralPath $nodeCaPath) -and (Get-Item -LiteralPath $nodeCaPath).Length -gt 0) {$env:NODE_EXTRA_CA_CERTS=$nodeCaPath}
  $arguments='"'+$scriptPath+'" --no-open'
  $process=Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server.err.log')
  $process.Id | Set-Content -LiteralPath (Join-Path $dataPath 'server.pid') -Encoding ascii
  $ready=$false
  for($attempt=0;$attempt -lt 30;$attempt++) {if(Test-Central) {$ready=$true;break};Start-Sleep -Milliseconds 500}
  if(-not $ready) {throw 'A central não respondeu na porta 8766. Consulte data/server.err.log.'}
  Write-Output ('Whats AI pronto: '+$centralUrl)
  if(-not $NoBrowser) {Start-Process ($centralUrl+'?conectar=1')}
} catch {Write-Error $_.Exception.Message;exit 1}
finally {if($hasMutex) {$taskMutex.ReleaseMutex()};$taskMutex.Dispose()}
