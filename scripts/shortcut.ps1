$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$desktopPath=[Environment]::GetFolderPath('Desktop')
$shortcutPath=Join-Path $desktopPath 'Whats AI.lnk'
$legacyPath=Join-Path $desktopPath 'WhatsApp Central.lnk'
$launcherPath=Join-Path $projectRoot 'Iniciar WhatsApp Central.cmd'
if(-not (Test-Path -LiteralPath $launcherPath)) {throw 'Iniciador da central nao encontrado.'}
$arguments='/d /c ""'+$launcherPath+'""'
$oldLauncher=Join-Path $PSScriptRoot 'start.ps1'
$oldArguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$oldLauncher+'"'
$previousArguments='"'+(Join-Path $projectRoot 'Abrir WhatsApp.vbs')+'"'
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($shortcutPath)
if((Test-Path -LiteralPath $shortcutPath) -and $shortcut.Arguments -notin @($arguments,$oldArguments,$previousArguments)) {
  throw 'Ja existe outro atalho Whats AI na area de trabalho. Renomeie-o antes de continuar.'
}
$shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\cmd.exe'
$shortcut.Arguments=$arguments
$shortcut.WorkingDirectory=$projectRoot
$shortcut.WindowStyle=7
$shortcut.IconLocation=(Join-Path $projectRoot 'public\icons\whats-ai.ico')+',0'
$shortcut.Description='Abre Whats AI e inicia os servicos locais automaticamente.'
$shortcut.Save()
if(Test-Path -LiteralPath $legacyPath) {
  $legacy=$shell.CreateShortcut($legacyPath)
  if($legacy.Arguments -in @($arguments,$oldArguments,$previousArguments) -and $legacy.WorkingDirectory -eq $projectRoot) {Remove-Item -LiteralPath $legacyPath}
}
Write-Output ('Atalho pronto: '+$shortcutPath)
