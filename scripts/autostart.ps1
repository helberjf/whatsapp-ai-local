param([switch]$Remove)
$ErrorActionPreference='Stop'
$startupPath=[Environment]::GetFolderPath('Startup')
$shortcutPath=Join-Path $startupPath 'Whats AI.lnk'
$projectRoot=Split-Path -Parent $PSScriptRoot
$launcherPath=Join-Path $projectRoot 'Iniciar WhatsApp Central.cmd'
if(-not (Test-Path -LiteralPath $launcherPath)) {throw 'Iniciador da central nao encontrado.'}
$arguments='/d /c ""'+$launcherPath+'" -NoBrowser"'
$oldArguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $PSScriptRoot 'start.ps1')+'" -NoBrowser'
$shell=New-Object -ComObject WScript.Shell
$ownedPaths=@()
foreach($name in @('Whats AI.lnk','WhatsApp Local.lnk')) {
  $candidate=Join-Path $startupPath $name
  if(Test-Path -LiteralPath $candidate) {
    $existing=$shell.CreateShortcut($candidate)
    if($existing.Arguments -in @($arguments,$oldArguments) -and $existing.WorkingDirectory -eq $projectRoot) {$ownedPaths+=$candidate}
    elseif($candidate -eq $shortcutPath) {throw 'Ja existe outro atalho Whats AI na inicializacao do Windows.'}
  }
}
if($Remove) {
  foreach($ownedPath in $ownedPaths) {Remove-Item -LiteralPath $ownedPath}
  Write-Output 'Inicialização automática desativada.'
} else {
  $shortcut=$shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\cmd.exe'
  $shortcut.Arguments=$arguments
  $shortcut.WorkingDirectory=$projectRoot
  $shortcut.WindowStyle=7
  $shortcut.IconLocation=(Join-Path $projectRoot 'public\icons\whats-ai.ico')+',0'
  $shortcut.Description='Inicia Whats AI ao entrar no Windows, sem abrir navegador.'
  $shortcut.Save()
  foreach($ownedPath in $ownedPaths) {if($ownedPath -ne $shortcutPath) {Remove-Item -LiteralPath $ownedPath}}
  Write-Output 'Whats AI iniciará automaticamente ao entrar no Windows.'
}
