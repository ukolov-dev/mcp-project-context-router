param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('store', 'lookup', 'delete')]
  [string] $Action
)

$ErrorActionPreference = 'Stop'
$Resource = 'vincenzo-context-hub'
$UserName = 'VINCENZO_CONTEXT_HUB_TOKEN'

[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
[void][Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType = WindowsRuntime]
$Vault = [Windows.Security.Credentials.PasswordVault]::new()

function Find-Credential {
  try { return $Vault.Retrieve($Resource, $UserName) }
  catch { return $null }
}

if ($Action -eq 'store') {
  $Bstr = [IntPtr]::Zero
  try {
    if ([Console]::IsInputRedirected) {
      $Secret = [Console]::In.ReadToEnd().TrimEnd("`r", "`n")
    }
    else {
      $SecureSecret = Read-Host -Prompt 'Context Hub credential' -AsSecureString
      $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
      $Secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    }
    if ([string]::IsNullOrWhiteSpace($Secret)) { throw 'The access token cannot be empty.' }
    $Existing = Find-Credential
    if ($null -ne $Existing) { $Vault.Remove($Existing) }
    $Vault.Add([Windows.Security.Credentials.PasswordCredential]::new($Resource, $UserName, $Secret))
  }
  finally {
    if ($Bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }
    $Secret = $null
  }
  exit 0
}

$Stored = Find-Credential
if ($null -eq $Stored) { exit 3 }
if ($Action -eq 'lookup') {
  $Stored.RetrievePassword()
  [Console]::Out.Write($Stored.Password)
  exit 0
}
$Vault.Remove($Stored)
exit 0
