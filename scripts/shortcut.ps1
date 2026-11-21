param([string]$DesktopPath=[Environment]::GetFolderPath('DesktopDirectory'))
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$shortcutPath=Join-Path $desktopPath 'Whats AI.lnk'
$alternatePath=Join-Path $desktopPath 'Whats AI - Central.lnk'
$legacyPath=Join-Path $desktopPath 'WhatsApp Central.lnk'
$launcherPath=Join-Path $PSScriptRoot 'launcher-ui.cjs'
if(-not (Test-Path -LiteralPath $launcherPath)) {throw 'Iniciador da central nao encontrado.'}
$nodePath=Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
function Get-LaunchArguments([string]$executable) {
  $command="& '{0}' '{1}'" -f $executable.Replace("'","''"),$launcherPath.Replace("'","''")
  return '-NoProfile -NonInteractive -WindowStyle Hidden -Command "'+$command+'"'
}
$arguments=Get-LaunchArguments $nodePath
$brokenArguments=Get-LaunchArguments 'System.Object[]'
$legacyLauncher=Join-Path $PSScriptRoot 'open-central-ui.vbs'
$legacyLauncherArguments='"'+$legacyLauncher+'"'
$cmdLauncher=Join-Path $projectRoot 'Iniciar WhatsApp Central.cmd'
$cmdArguments='/d /c ""'+$cmdLauncher+'""'
$oldLauncher=Join-Path $PSScriptRoot 'start.ps1'
$oldArguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$oldLauncher+'"'
$previousArguments='"'+(Join-Path $projectRoot 'Abrir WhatsApp.vbs')+'"'
$knownArguments=@($arguments,$brokenArguments,$legacyLauncherArguments,$cmdArguments,$oldArguments,$previousArguments)
$shell=New-Object -ComObject WScript.Shell
function Save-CentralShortcut([string]$file) {
  $shortcut=$shell.CreateShortcut($file)
  if((Test-Path -LiteralPath $file) -and $shortcut.Arguments -notin $knownArguments) {
    throw 'Ja existe outro atalho com esse nome na area de trabalho.'
  }
  $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $shortcut.Arguments=$arguments
  $shortcut.WorkingDirectory=$projectRoot
  $shortcut.WindowStyle=7
  $shortcut.IconLocation=(Join-Path $projectRoot 'public\icons\whats-ai.ico')+',0'
  $shortcut.Description='Abre Whats AI e inicia os servicos locais automaticamente.'
  $shortcut.Save()
}
try {
  if(-not (Test-Path -LiteralPath $shortcutPath) -and (Test-Path -LiteralPath $alternatePath)) {
    $shortcutPath=$alternatePath
  }
  Save-CentralShortcut $shortcutPath
} catch [System.UnauthorizedAccessException] {
  if($shortcutPath -eq $alternatePath) {throw}
  $shortcutPath=$alternatePath
  Save-CentralShortcut $shortcutPath
}
if(Test-Path -LiteralPath $legacyPath) {
  $legacy=$shell.CreateShortcut($legacyPath)
  if($legacy.Arguments -in $knownArguments -and $legacy.WorkingDirectory -eq $projectRoot) {Remove-Item -LiteralPath $legacyPath}
}
Write-Output ('Atalho pronto: '+$shortcutPath)
