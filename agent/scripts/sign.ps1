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
    [string]$Password = '',
    [switch]$Timestamp   # also asks a timestamp server (http://timestamp.digicert.com) so the signature outlives the certificate; sends only the hash
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
$extra = @{}
if ($Timestamp) { $extra.TimestampServer = 'http://timestamp.digicert.com' }
$result = Set-AuthenticodeSignature -FilePath $File -Certificate $certificate -HashAlgorithm SHA256 @extra
# a self-signed certificate is signed but not trusted (UnknownError / "root not trusted"): that is expected, the signature is there
if ($result.SignerCertificate) { Write-Host "Signed by $($result.SignerCertificate.Subject) ($($result.Status)): $File" }
else { throw "not signed: $($result.StatusMessage)" }
