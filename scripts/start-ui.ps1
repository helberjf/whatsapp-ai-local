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
        Title="Whats AI" Width="440" Height="330" WindowStartupLocation="CenterScreen"
        ResizeMode="NoResize" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ShowInTaskbar="True">
  <Border CornerRadius="26" Background="#111714" BorderBrush="#26372E" BorderThickness="1" Padding="34">
    <Border.Effect><DropShadowEffect BlurRadius="30" ShadowDepth="8" Opacity="0.45" Color="#050806"/></Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
        <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/>
      </Grid.RowDefinitions>
      <Grid Width="92" Height="92" HorizontalAlignment="Center">
        <Ellipse Stroke="#25372E" StrokeThickness="4"/>
        <Ellipse x:Name="Spinner" Stroke="#25D366" StrokeThickness="4" StrokeDashArray="4 3" StrokeStartLineCap="Round" StrokeEndLineCap="Round" RenderTransformOrigin="0.5,0.5">
          <Ellipse.RenderTransform><RotateTransform x:Name="SpinnerRotation" Angle="0"/></Ellipse.RenderTransform>
        </Ellipse>
        <Border Margin="13" CornerRadius="34" Background="#173E2B">
          <Image x:Name="Logo" Width="50" Height="50" Stretch="Uniform"/>
        </Border>
      </Grid>
      <TextBlock Grid.Row="1" Text="Whats AI" Margin="0,18,0,0" HorizontalAlignment="Center" Foreground="#F4F8F5" FontFamily="Segoe UI" FontSize="26" FontWeight="SemiBold"/>
      <TextBlock Grid.Row="2" Text="CENTRAL LOCAL" Margin="0,4,0,0" HorizontalAlignment="Center" Foreground="#79A98C" FontFamily="Segoe UI" FontSize="10" FontWeight="SemiBold"/>
      <ProgressBar x:Name="Progress" Grid.Row="3" Height="6" Margin="0,24,0,0" Minimum="0" Maximum="100" Value="25" Foreground="#25D366" Background="#24342C" BorderThickness="0"/>
      <TextBlock x:Name="Status" Grid.Row="4" Text="Preparando configurações..." Margin="0,14,0,0" HorizontalAlignment="Center" Foreground="#B8C7BE" FontFamily="Segoe UI" FontSize="14"/>
      <StackPanel x:Name="ErrorPanel" Grid.Row="5" Visibility="Collapsed" Margin="0,14,0,0">
        <TextBlock Text="Os detalhes foram salvos em data\launcher.log" HorizontalAlignment="Center" Foreground="#F3A7A7" FontFamily="Segoe UI" FontSize="12"/>
        <Button x:Name="CloseButton" Content="Fechar" Width="110" Height="34" Margin="0,14,0,0" HorizontalAlignment="Center" Foreground="#FFFFFF" Background="#B73E48" BorderThickness="0" FontWeight="SemiBold"/>
      </StackPanel>
    </Grid>
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
$spinnerRotation=$window.FindName('SpinnerRotation')
$logo=$window.FindName('Logo')

try {$logo.Source=[System.Windows.Media.Imaging.BitmapFrame]::Create([Uri]$iconPath)} catch {}
$closeButton.Add_Click({$window.Close()})

$spinTimer=New-Object Windows.Threading.DispatcherTimer
$spinTimer.Interval=[TimeSpan]::FromMilliseconds(30)
$spinTimer.Add_Tick({$spinnerRotation.Angle=($spinnerRotation.Angle+5)%360})
$spinTimer.Start()

function Add-UiLog([string]$message) {
  $folder=Split-Path -Parent $logPath
  if(-not (Test-Path -LiteralPath $folder)) {New-Item -ItemType Directory -Path $folder -Force | Out-Null}
  Add-Content -LiteralPath $logPath -Value ('['+[DateTime]::UtcNow.ToString('o')+'] [ui] '+$message) -Encoding utf8
}

function Show-Failure([string]$detail) {
  Add-UiLog $detail
  $spinTimer.Stop()
  $status.Text='Não foi possível abrir o Whats AI.'
  $status.Foreground='#F3A7A7'
  $progress.Foreground='#E45D68'
  $errorPanel.Visibility='Visible'
}

try {
  $info=New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName=$nodePath
  $info.Arguments='"'+(Join-Path $PSScriptRoot 'launcher-ui.cjs')+'"'+$(if($NoBrowser){' -NoBrowser'}else{''})
  $info.WorkingDirectory=$projectRoot
  $info.UseShellExecute=$false
  $info.RedirectStandardOutput=$true
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
            $progress.Value=[Math]::Min(100,[Math]::Max(25,[int]$event.step*25))
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
        $progress.Value=100;$status.Text='Central pronta.';$spinTimer.Stop()
        $closeTimer=New-Object Windows.Threading.DispatcherTimer
        $closeTimer.Interval=[TimeSpan]::FromMilliseconds(500)
        $closeTimer.Add_Tick({$closeTimer.Stop();$window.Close()})
        $closeTimer.Start()
      } else {Show-Failure ('launcher encerrado com código '+$process.ExitCode)}
    }
  })
  $pollTimer.Start()
} catch {Show-Failure $_.Exception.Message}

$null=$window.ShowDialog()
