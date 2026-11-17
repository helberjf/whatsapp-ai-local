param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$nodePath=(Get-Command node -ErrorAction Stop).Source
$launcherArgs=@()
if($NoBrowser) {$launcherArgs+='-NoBrowser'}
& $nodePath (Join-Path $PSScriptRoot 'open-central.cjs') @launcherArgs
exit $LASTEXITCODE
