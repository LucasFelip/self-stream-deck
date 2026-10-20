# Creates the certificate the deck serves over Wi-Fi: self-signed, valid for 5 years, written to a PFX file (for the server)
# and a DER .cer file (to compute its fingerprint). The phone app pins that fingerprint instead of trusting any certificate
# authority, so the names inside do not matter and an IP change never needs a new certificate. The private key is created
# in the user's store only long enough to export it, then removed from there.
param(
    [Parameter(Mandatory)][string]$PfxPath,
    [Parameter(Mandatory)][string]$CerPath,
    [Parameter(Mandatory)][string]$Password
)

$ErrorActionPreference = 'Stop'

$cert = New-SelfSignedCertificate `
    -Subject 'CN=Self Stream Deck' `
    -DnsName 'localhost', 'self-stream-deck' `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(5) `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')

try {
    $secret = ConvertTo-SecureString -String $Password -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $secret -CryptoAlgorithmOption AES256_SHA256 | Out-Null
    Export-Certificate -Cert $cert -FilePath $CerPath -Type CERT | Out-Null
}
finally {
    Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
}
