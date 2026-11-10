# Writes the update manifest that `ssd update` reads, for a package made by build-msi.ps1 (sign it first: build-msi.ps1 -Sign).
# Put the .msi and the manifest.json this prints on any HTTPS server, and set "update": { "url": "https://.../manifest.json" } in the
# config.json of the PCs that should follow it. Keeps the other channels of an existing manifest.
#
#   powershell -File agent/scripts/make-manifest.ps1 -Msi dist\SelfStreamDeck-0.2.0.msi -BaseUrl https://example.com/ssd [-Channel stable] [-Out dist\manifest.json]
param(
    [Parameter(Mandatory)][string]$Msi,
    [Parameter(Mandatory)][string]$BaseUrl,
    [string]$Channel = 'stable',
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
if (-not $BaseUrl.StartsWith('https://')) { throw 'the base address must be https://' }
$file = Get-Item $Msi
if ($file.Name -notmatch '^SelfStreamDeck-(?<version>[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?)\.msi$') { throw "the file name must be SelfStreamDeck-<version>.msi (got $($file.Name))" }
$version = $Matches.version
$signature = Get-AuthenticodeSignature $file.FullName
if (-not $signature.SignerCertificate) { Write-Warning 'the package is not signed: agents will refuse it (build with -Sign)' }
if (-not $Out) { $Out = Join-Path $file.DirectoryName 'manifest.json' }

$manifest = @{ channels = @{} }
if (Test-Path $Out) {
    $old = Get-Content $Out -Raw | ConvertFrom-Json
    foreach ($p in $old.channels.PSObject.Properties) { $manifest.channels[$p.Name] = $p.Value }
}
$manifest.channels[$Channel] = [ordered]@{
    version = $version
    url     = "$($BaseUrl.TrimEnd('/'))/$($file.Name)"
    sha256  = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content $Out -Encoding ascii
Write-Host "Wrote $Out (channel $Channel = $version)."
if ($signature.SignerCertificate) { Write-Host "Signer thumbprint (for update.signer on agents that are not signed themselves): $($signature.SignerCertificate.Thumbprint)" }
