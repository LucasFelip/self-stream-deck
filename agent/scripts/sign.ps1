# Signs a file (ssd.exe) with Authenticode so SmartScreen and antivirus tools can tell who made it.
#
#   powershell -File agent/scripts/sign.ps1 -File path\to\ssd.exe [-Pfx cert.pfx -Password ...]
#
# Without -Pfx it uses (and creates, once) a self-signed code-signing certificate named "Self Stream Deck" in the current user's store. That
# identifies the build as yours on this PC, but Windows will not trust it on other PCs: for public distribution use a certificate from a
# certificate authority and pass it with -Pfx.

param(
    [Parameter(Mandatory)][string]$File,
    [string]$Pfx = '',
    [string]$Password = ''
)

$ErrorActionPreference = 'Stop'
if ($Pfx) {
    $certificate = Get-PfxCertificate -FilePath $Pfx -Password (ConvertTo-SecureString $Password -AsPlainText -Force)
} else {
    $certificate = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq 'CN=Self Stream Deck' -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
    if (-not $certificate) {
        $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Self Stream Deck' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(3)
        Write-Host "Made a self-signed code-signing certificate ($($certificate.Thumbprint))."
    }
}
$result = Set-AuthenticodeSignature -FilePath $File -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
Write-Host "$($result.Status): $File"
if ($result.Status -notin 'Valid', 'UnknownError') { Write-Host $result.StatusMessage }
