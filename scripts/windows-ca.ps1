$projectRoot=Split-Path -Parent $PSScriptRoot
$certDirectory=Join-Path $projectRoot 'data\certs'
$certPath=Join-Path $certDirectory 'windows-ca.pem'
New-Item -ItemType Directory -Path $certDirectory -Force | Out-Null
if(-not (Test-Path -LiteralPath $certPath)) {[IO.File]::WriteAllText($certPath,'')}
$tcp=$null
$ssl=$null
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
  $trusted=$null
  # X509Store funciona tambem quando o iniciador nao carrega o provedor Cert: do PowerShell.
  foreach($storeLocation in @([System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser,[System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)) {
    $rootStore=[System.Security.Cryptography.X509Certificates.X509Store]::new('Root',$storeLocation)
    try {
      $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
      $trusted=$rootStore.Certificates | Where-Object {$_.Thumbprint -eq $rootCertificate.Thumbprint} | Select-Object -First 1
    } finally {$rootStore.Close()}
    if($trusted) {break}
  }
  if(-not $trusted) {throw 'Raiz HTTPS nao encontrada no repositorio confiavel do Windows.'}
  $pem="-----BEGIN CERTIFICATE-----`n"+[Convert]::ToBase64String($trusted.RawData,[Base64FormattingOptions]::InsertLineBreaks)+"`n-----END CERTIFICATE-----`n"
  [IO.File]::WriteAllText($certPath,$pem,[Text.Encoding]::ASCII)
  Write-Output 'Cadeia HTTPS do Windows preparada para o conector.'
} catch {Write-Warning ('Nao foi possivel atualizar a cadeia HTTPS local: '+$_.Exception.Message)}
finally {if($ssl) {$ssl.Dispose()};if($tcp) {$tcp.Dispose()}}
