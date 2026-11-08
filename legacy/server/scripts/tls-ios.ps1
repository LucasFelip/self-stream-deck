# Certificates for the iPhone (Safari). Safari checks the names inside the certificate, so unlike the Android one this one lists
# this PC's name and its current IP addresses, and it is signed by a small certificate authority of its own:
#   ca.pfx / ca.cer   the authority (10 years). Installed on the iPhone ONCE; the private key stays here and is never served.
#   leaf.pfx / leaf.cer   the server certificate (1 year), signed by the authority and made again whenever the addresses change.
# Keys live in the user's store only long enough to be used, then are removed from there. Windows also files a public copy of the
# authority under "Intermediate Certification Authorities" while signing, and Node treats that store as trusted, so it is removed too.
param(
    [Parameter(Mandatory)][string]$Dir,
    [Parameter(Mandatory)][string]$Password,
    [Parameter(Mandatory)][string]$Names,   # comma-separated DNS names
    [string]$Ips = ''                       # comma-separated IPv4 addresses
)

$ErrorActionPreference = 'Stop'
$store = 'Cert:\CurrentUser\My'
$secret = ConvertTo-SecureString -String $Password -AsPlainText -Force
$caPfx = Join-Path $Dir 'ca.pfx'
$caCer = Join-Path $Dir 'ca.cer'
$created = @()

try {
    if ((Test-Path $caPfx) -and (Test-Path $caCer)) {
        $ca = Import-PfxCertificate -FilePath $caPfx -CertStoreLocation $store -Password $secret -Exportable
        $created += $ca
    }
    else {
        $ca = New-SelfSignedCertificate `
            -Type Custom `
            -Subject 'CN=Self Stream Deck CA' `
            -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
            -KeyExportPolicy Exportable `
            -NotAfter (Get-Date).AddYears(10) `
            -CertStoreLocation $store `
            -KeyUsage CertSign, CRLSign, DigitalSignature `
            -TextExtension @('2.5.29.19={critical}{text}CA=true&pathlength=0')
        $created += $ca
        Export-PfxCertificate -Cert $ca -FilePath $caPfx -Password $secret -CryptoAlgorithmOption AES256_SHA256 | Out-Null
        Export-Certificate -Cert $ca -FilePath $caCer -Type CERT | Out-Null
    }

    $san = @()
    foreach ($name in ($Names -split ',' | Where-Object { $_ })) { $san += "DNS=$name" }
    foreach ($ip in ($Ips -split ',' | Where-Object { $_ })) { $san += "IPAddress=$ip" }

    $leaf = New-SelfSignedCertificate `
        -Type Custom `
        -Subject 'CN=Self Stream Deck' `
        -Signer $ca `
        -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears(1) `
        -CertStoreLocation $store `
        -KeyUsage DigitalSignature, KeyEncipherment `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1', ('2.5.29.17={text}' + ($san -join '&')))
    $created += $leaf

    Export-PfxCertificate -Cert $leaf -FilePath (Join-Path $Dir 'leaf.pfx') -Password $secret -ChainOption EndEntityCertOnly -CryptoAlgorithmOption AES256_SHA256 | Out-Null
    Export-Certificate -Cert $leaf -FilePath (Join-Path $Dir 'leaf.cer') -Type CERT | Out-Null
}
finally {
    foreach ($cert in $created) {
        Remove-Item -Path "$store\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
        Remove-Item -Path "Cert:\CurrentUser\CA\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
    }
}
