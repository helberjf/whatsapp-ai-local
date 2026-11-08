param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'start-central.ps1') -NoBrowser:$NoBrowser
exit $LASTEXITCODE
