param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$dataPath=Join-Path $projectRoot 'data'
$launcherLog=Join-Path $dataPath 'launcher.log'
$nodeCaPath=Join-Path $dataPath 'certs\windows-ca.pem'

function Write-ServerLog([string]$message) {
  $entry='['+[DateTime]::UtcNow.ToString('o')+'] [server] '+$message+[Environment]::NewLine
  [IO.File]::AppendAllText($launcherLog,$entry)
}

try {
  if(-not $env:NODE_EXTRA_CA_CERTS -and (Test-Path -LiteralPath $nodeCaPath) -and (Get-Item -LiteralPath $nodeCaPath).Length -gt 0) {
    $env:NODE_EXTRA_CA_CERTS=$nodeCaPath
  }
  $serverScript=Join-Path $projectRoot 'server.cjs'
  $arguments='"'+$serverScript+'" --no-open'
  $server=Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server.err.log')
  $server.Id | Set-Content -LiteralPath (Join-Path $dataPath 'server.pid') -Encoding ascii
  $server.WaitForExit()
  Write-ServerLog ('Node PID '+$server.Id+' ended with exit code '+$server.ExitCode+'.')
  exit $server.ExitCode
} catch {
  Write-ServerLog $_.Exception.Message
  exit 1
}
