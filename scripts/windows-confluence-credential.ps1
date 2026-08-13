param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('store', 'lookup', 'delete')]
  [string] $Action
)

$ErrorActionPreference = 'Stop'
$Resource = 'project-context-confluence'
$UserName = 'CONFLUENCE_PERSONAL_TOKEN'

[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
[void][Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType = WindowsRuntime]
$Vault = [Windows.Security.Credentials.PasswordVault]::new()

function Find-Credential {
  try {
    return $Vault.Retrieve($Resource, $UserName)
  }
  catch {
    return $null
  }
}

if ($Action -eq 'store') {
  $SecureSecret = Read-Host -Prompt 'Confluence Personal Access Token' -AsSecureString
  $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
  try {
    $Secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    if ([string]::IsNullOrWhiteSpace($Secret)) {
      throw 'The Confluence token cannot be empty.'
    }
    $Existing = Find-Credential
    if ($null -ne $Existing) {
      $Vault.Remove($Existing)
    }
    $Credential = [Windows.Security.Credentials.PasswordCredential]::new($Resource, $UserName, $Secret)
    $Vault.Add($Credential)
  }
  finally {
    if ($Bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
    }
    $Secret = $null
  }
  exit 0
}

$Stored = Find-Credential
if ($null -eq $Stored) {
  exit 3
}

if ($Action -eq 'lookup') {
  $Stored.RetrievePassword()
  [Console]::Out.Write($Stored.Password)
  exit 0
}

$Vault.Remove($Stored)
exit 0
