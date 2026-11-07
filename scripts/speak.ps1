# Gera fala com as vozes instaladas no Windows (SAPI). Nada é enviado para a internet.
# Uso: speak.ps1 -TextFile texto.txt -Output voz.wav [-Voice "Microsoft Maria Desktop"] [-Rate 0]
#      speak.ps1 -List
param(
  [string]$TextFile,
  [string]$Output,
  [string]$Voice = '',
  [int]$Rate = 0,
  [switch]$List
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $installed = $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo }
  if ($List) {
    $rows = @($installed | ForEach-Object { [pscustomobject]@{ name = $_.Name; culture = $_.Culture.Name; gender = $_.Gender.ToString() } })
    ConvertTo-Json -InputObject $rows -Compress
    exit 0
  }
  if (-not $TextFile -or -not $Output) { throw 'Informe -TextFile e -Output.' }
  $chosen = $null
  if ($Voice) { $chosen = $installed | Where-Object { $_.Name -eq $Voice } | Select-Object -First 1 }
  if (-not $chosen) { $chosen = $installed | Where-Object { $_.Culture.Name -eq 'pt-BR' } | Select-Object -First 1 }
  if (-not $chosen) { $chosen = $installed | Where-Object { $_.Culture.Name -like 'pt-*' } | Select-Object -First 1 }
  if ($chosen) { $synth.SelectVoice($chosen.Name) }
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  $synth.SetOutputToWaveFile($Output)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  exit 0
} finally {
  $synth.Dispose()
}
