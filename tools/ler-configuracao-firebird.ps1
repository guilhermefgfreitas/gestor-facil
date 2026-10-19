param([Parameter(Mandatory = $true)][string]$Arquivo)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$protegido = [Convert]::FromBase64String([System.IO.File]::ReadAllText($Arquivo, [System.Text.Encoding]::ASCII).Trim())
try {
    $texto = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protegido,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
} catch {
    $texto = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protegido,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
}
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($texto))
