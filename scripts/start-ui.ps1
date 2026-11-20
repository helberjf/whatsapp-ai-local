param([switch]$NoBrowser,[switch]$ValidateOnly)
$ErrorActionPreference='Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$projectRoot=Split-Path -Parent $PSScriptRoot
$logPath=Join-Path $projectRoot 'data\launcher.log'
$iconPath=Join-Path $projectRoot 'public\icons\whats-ai.ico'
$nodePath=(Get-Command node -ErrorAction Stop).Source

[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Whats AI" Width="420" SizeToContent="Height" WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ShowInTaskbar="True">
  <Border CornerRadius="22" Background="#13221E" BorderBrush="#304840" BorderThickness="1" Padding="32">
    <StackPanel TextElement.FontFamily="Segoe UI">
      <Image x:Name="Logo" Width="54" Height="54" HorizontalAlignment="Left" Stretch="Uniform"/>
      <TextBlock Text="Whats AI" Margin="0,16,0,0" Foreground="#F2F8F5" FontSize="28" FontWeight="SemiBold"/>
      <ProgressBar x:Name="Progress" Height="5" Margin="0,22,0,0" Minimum="0" Maximum="100" Value="12" Foreground="#40DF98" Background="#2B4038" BorderThickness="0"/>
      <TextBlock x:Name="Status" Text="Preparando configurações…" Margin="0,12,0,0" TextWrapping="Wrap" Foreground="#BCD0C7" FontSize="14"/>
      <StackPanel x:Name="ErrorPanel" Visibility="Collapsed" Margin="0,14,0,0">
        <TextBlock Text="Abra o atalho novamente para tentar de novo." TextWrapping="Wrap" Foreground="#BCD0C7" FontSize="13"/>
        <StackPanel Orientation="Horizontal" Margin="0,16,0,0">
          <Button x:Name="LogButton" Content="Ver registro" Width="110" Height="34" Margin="0,0,10,0" Foreground="#F2F8F5" Background="#2B4038" BorderThickness="0"/>
          <Button x:Name="CloseButton" Content="Fechar" Width="90" Height="34" Foreground="#10261D" Background="#60DCA4" BorderThickness="0" FontWeight="SemiBold"/>
        </StackPanel>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
'@

$reader=New-Object System.Xml.XmlNodeReader $xaml
$window=[Windows.Markup.XamlReader]::Load($reader)
if($ValidateOnly) {exit 0}
$progress=$window.FindName('Progress')
$status=$window.FindName('Status')
$errorPanel=$window.FindName('ErrorPanel')
$closeButton=$window.FindName('CloseButton')
$logo=$window.FindName('Logo')

try {$logo.Source=[System.Windows.Media.Imaging.BitmapFrame]::Create([Uri]$iconPath)} catch {}
$closeButton.Add_Click({$window.Close()})
$window.FindName('LogButton').Add_Click({Start-Process -FilePath notepad.exe -ArgumentList ('"'+$logPath+'"')})
if(-not $NoBrowser) {
  $window.Opacity=0
  $window.IsHitTestVisible=$false
  $window.ShowInTaskbar=$false
  $window.ShowActivated=$false
}

function Add-UiLog([string]$message) {
  $folder=Split-Path -Parent $logPath
  if(-not (Test-Path -LiteralPath $folder)) {New-Item -ItemType Directory -Path $folder -Force | Out-Null}
  Add-Content -LiteralPath $logPath -Value ('['+[DateTime]::UtcNow.ToString('o')+'] [ui] '+$message) -Encoding utf8
}

function Show-Failure([string]$detail) {
  Add-UiLog $detail
  $status.Text=if($status.Text -eq 'Aguardando Docker Desktop...') {'O Docker Desktop não ficou pronto.'} else {'Não foi possível abrir o Whats AI.'}
  $status.Foreground='#FFC1BD'
  $progress.Visibility='Collapsed'
  $errorPanel.Visibility='Visible'
  $window.Opacity=1
  $window.IsHitTestVisible=$true
  $window.ShowInTaskbar=$true
  $null=$window.Activate()
}

try {
  $info=New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName=$nodePath
  $info.Arguments='"'+(Join-Path $PSScriptRoot 'launcher-ui.cjs')+'"'+$(if($NoBrowser){' -NoBrowser'}else{''})
  $info.WorkingDirectory=$projectRoot
  $info.UseShellExecute=$false
  $info.RedirectStandardOutput=$true
  $info.StandardOutputEncoding=[System.Text.Encoding]::UTF8
  $info.RedirectStandardError=$true
  $info.CreateNoWindow=$true
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$info
  if(-not $process.Start()) {throw 'O processo de inicialização não pôde ser criado.'}
  $stdoutTask=$process.StandardOutput.ReadLineAsync()
  $stderrTask=$process.StandardError.ReadLineAsync()
  $stdoutDone=$false
  $stderrDone=$false
  $completed=$false
  $statusPrefix='@@WHATS_AI_STATUS '

  $pollTimer=New-Object Windows.Threading.DispatcherTimer
  $pollTimer.Interval=[TimeSpan]::FromMilliseconds(80)
  $pollTimer.Add_Tick({
    if(-not $stdoutDone -and $stdoutTask.IsCompleted) {
      $line=$stdoutTask.Result
      if($null -eq $line) {$stdoutDone=$true}
      else {
        if($line.StartsWith($statusPrefix)) {
          try {
            $event=$line.Substring($statusPrefix.Length) | ConvertFrom-Json
            $progress.Value=[Math]::Min(90,[Math]::Max(12,[int]$event.step*22))
            $status.Text=[string]$event.status
          } catch {Add-UiLog ('status inválido: '+$line)}
        }
        $script:stdoutTask=$process.StandardOutput.ReadLineAsync()
      }
    }
    if(-not $stderrDone -and $stderrTask.IsCompleted) {
      $line=$stderrTask.Result
      if($null -eq $line) {$stderrDone=$true}
      else {Add-UiLog ('stderr: '+$line);$script:stderrTask=$process.StandardError.ReadLineAsync()}
    }
    if(-not $completed -and $process.HasExited -and $stdoutDone -and $stderrDone) {
      $script:completed=$true
      $pollTimer.Stop()
      if($process.ExitCode -eq 0) {
        $progress.Value=100;$status.Text='Central pronta.'
        $window.Close()
      } else {Show-Failure ('launcher encerrado com código '+$process.ExitCode)}
    }
  })
  $pollTimer.Start()
} catch {Show-Failure $_.Exception.Message}

$null=$window.ShowDialog()
