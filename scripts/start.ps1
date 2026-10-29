param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$centralUrl='http://127.0.0.1:8766/'
$composeFile=Join-Path $projectRoot 'infra\compose.yaml'
$dataPath=Join-Path $projectRoot 'data'
$nodePath=(Get-Command node -ErrorAction Stop).Source
function Test-Central {
  try { $response=Invoke-RestMethod -Uri ($centralUrl+'health') -TimeoutSec 2;return $response.service -eq 'whatsapp-local' } catch { return $false }
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
  & docker compose -f $composeFile up -d --wait --wait-timeout 180
  if($LASTEXITCODE -ne 0) {throw 'A pilha local não ficou pronta. Consulte docker compose -f infra/compose.yaml logs --tail=50.'}
  if(Test-Central) {
    Write-Output 'Central ja iniciada. Reutilizando a sessao.'
    if(-not $NoBrowser) {Start-Process $centralUrl}
    exit 0
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
  Write-Output ('WhatsApp Local pronto: '+$centralUrl)
  if(-not $NoBrowser) {Start-Process ($centralUrl+'?conectar=1')}
} catch {Write-Error $_.Exception.Message;exit 1}
finally {if($hasMutex) {$taskMutex.ReleaseMutex()};$taskMutex.Dispose()}
