param([switch]$Remove)
$ErrorActionPreference='Stop'
$startupPath=[Environment]::GetFolderPath('Startup')
$shortcutPath=Join-Path $startupPath 'WhatsApp Local.lnk'
if($Remove) {
  if(Test-Path -LiteralPath $shortcutPath) {Remove-Item -LiteralPath $shortcutPath}
  Write-Output 'Inicialização automática desativada.'
} else {
  $projectRoot=Split-Path -Parent $PSScriptRoot
  $shell=New-Object -ComObject WScript.Shell
  $shortcut=$shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $shortcut.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $PSScriptRoot 'start.ps1')+'" -NoBrowser'
  $shortcut.WorkingDirectory=$projectRoot
  $shortcut.WindowStyle=7
  $shortcut.Description='Inicia WhatsApp Local ao entrar no Windows, sem abrir navegador.'
  $shortcut.Save()
  Write-Output 'WhatsApp Local iniciará automaticamente ao entrar no Windows.'
}
