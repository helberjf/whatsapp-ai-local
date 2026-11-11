$projectRoot=Split-Path -Parent $PSScriptRoot
$certDirectory=Join-Path $projectRoot 'data\certs'
$certPath=Join-Path $certDirectory 'windows-ca.pem'
New-Item -ItemType Directory -Path $certDirectory -Force | Out-Null
if(-not (Test-Path -LiteralPath $certPath)) {[IO.File]::WriteAllText($certPath,'')}
$tcp=$null
$ssl=$null
$rootCertificate=$null
try {
  # Reutiliza a mesma confianca ja aplicada pelo Windows, incluindo inspecao HTTPS do antivirus.
  # AuthenticateAsClient valida nome, validade e cadeia; nenhuma verificacao TLS e desativada.
  $tcp=New-Object System.Net.Sockets.TcpClient
  $connection=$tcp.BeginConnect('web.whatsapp.com',443,$null,$null)
  if(-not $connection.AsyncWaitHandle.WaitOne(10000)) {throw 'Tempo excedido ao verificar a cadeia HTTPS.'}
  $tcp.EndConnect($connection)
  $tcp.ReceiveTimeout=10000
  $tcp.SendTimeout=10000
  $ssl=New-Object System.Net.Security.SslStream($tcp.GetStream(),$false)
  $ssl.AuthenticateAsClient('web.whatsapp.com')
  $certificate=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
  $chain=New-Object System.Security.Cryptography.X509Certificates.X509Chain
  if(-not $chain.Build($certificate)) {throw 'A cadeia HTTPS nao foi validada pelo Windows.'}
  $rootCertificate=$chain.ChainElements[$chain.ChainElements.Count-1].Certificate
} catch {Write-Warning ('Nao foi possivel verificar a cadeia HTTPS local: '+$_.Exception.Message)}
finally {if($ssl) {$ssl.Dispose()};if($tcp) {$tcp.Dispose()}}

try {
  $trusted=@{}
  # X509Store funciona tambem quando o iniciador nao carrega o provedor Cert: do PowerShell.
  foreach($storeLocation in @([System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser,[System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)) {
    $rootStore=[System.Security.Cryptography.X509Certificates.X509Store]::new('Root',$storeLocation)
    try {
      $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
      foreach($candidate in $rootStore.Certificates) {
        # O Avast pode inspecionar o Docker mesmo quando a sondagem no Windows recebe a cadeia publica.
        $avast=$candidate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -eq 'Avast Web/Mail Shield Root'
        if($candidate.Thumbprint -eq $rootCertificate.Thumbprint -or ($avast -and $candidate.NotBefore -le (Get-Date) -and $candidate.NotAfter -gt (Get-Date))) {
          $trusted[$candidate.Thumbprint]=$candidate
        }
      }
    } finally {$rootStore.Close()}
  }
  if(-not $trusted.Count) {throw 'Raiz HTTPS nao encontrada no repositorio confiavel do Windows.'}
  $previous=[IO.File]::ReadAllText($certPath)
  $pem=''
  if(-not $rootCertificate -or -not $trusted.ContainsKey($rootCertificate.Thumbprint)) {$pem=$previous}
  foreach($thumbprint in ($trusted.Keys | Sort-Object)) {
    $base64=[Convert]::ToBase64String($trusted[$thumbprint].RawData,[Base64FormattingOptions]::InsertLineBreaks)
    if(($pem -replace '\s','').Contains(($base64 -replace '\s',''))) {continue}
    if($pem) {$pem=$pem.TrimEnd()+"`n"}
    $pem+="-----BEGIN CERTIFICATE-----`n"+$base64+"`n-----END CERTIFICATE-----`n"
  }
  if($pem -ne $previous) {[IO.File]::WriteAllText($certPath,$pem,[Text.Encoding]::ASCII)}
  Write-Output 'Cadeia HTTPS do Windows preparada para o conector.'
} catch {Write-Warning ('Nao foi possivel atualizar a cadeia HTTPS local: '+$_.Exception.Message)}
