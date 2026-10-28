$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$desktopPath=[Environment]::GetFolderPath('Desktop')
$shortcutPath=Join-Path $desktopPath 'WhatsApp Central.lnk'
$launcherPath=Join-Path $PSScriptRoot 'start.ps1'
if(-not (Test-Path -LiteralPath $launcherPath)) {throw 'Iniciador da central nao encontrado.'}
$arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$launcherPath+'"'
$previousArguments='"'+(Join-Path $projectRoot 'Abrir WhatsApp.vbs')+'"'
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($shortcutPath)
if((Test-Path -LiteralPath $shortcutPath) -and $shortcut.Arguments -notin @($arguments,$previousArguments)) {
  throw 'Ja existe outro atalho WhatsApp Central na area de trabalho. Renomeie-o antes de continuar.'
}
$shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments=$arguments
$shortcut.WorkingDirectory=$projectRoot
$shortcut.WindowStyle=7
$shortcut.IconLocation=(Join-Path $env:SystemRoot 'System32\shell32.dll')+',220'
$shortcut.Description='Abre WhatsApp Central e inicia os servicos locais automaticamente.'
$shortcut.Save()
Write-Output ('Atalho pronto: '+$shortcutPath)
