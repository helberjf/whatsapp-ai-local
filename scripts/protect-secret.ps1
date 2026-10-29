param([ValidateSet('protect','unprotect')][string]$Operation)
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $entropy=[Text.Encoding]::UTF8.GetBytes('WhatsAppCentral|credenciais|v1')
  $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser
  if($Operation -eq 'protect') {$result=[Security.Cryptography.ProtectedData]::Protect($inputBytes,$entropy,$scope)}
  else {$result=[Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$entropy,$scope)}
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {exit 1}
