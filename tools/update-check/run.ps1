# The update checks of `ssd update`, against a feed served from this PC (nothing leaves it, nothing is installed):
# same version, newer version, unsigned agent without update.signer (refused), the right signer (accepted), another signer, a wrong hash and a
# package altered after signing (the last three refused). Needs agent\target-pkg\release\ssd.exe (or -Exe) and dist\SelfStreamDeck-*.msi
# (made by agent\scripts\msi\build-msi.ps1). It creates the self-signed "CN=Self Stream Deck" certificate of sign.ps1 if there is none yet.
#
#   powershell -File tools/update-check/run.ps1 [-Exe path\to\ssd.exe]
param([string]$Exe = '')

$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$exe = if ($Exe) { $Exe } else { "$root\agent\target-pkg\release\ssd.exe" }
$feed = "$env:TEMP\ssd-feed"; $data = "$env:TEMP\ssd-update-data"
$msi = Get-ChildItem "$root\dist\SelfStreamDeck-*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not (Test-Path $exe)) { throw "ssd.exe not found at $exe" }
if (-not $msi) { throw 'no dist\SelfStreamDeck-*.msi: run agent\scripts\msi\build-msi.ps1 first' }

Remove-Item $feed, $data -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $feed, $data | Out-Null
Copy-Item $msi.FullName "$feed\SelfStreamDeck-0.2.0.msi"

$failures = 0
$server = Start-Process python -ArgumentList '-m http.server 8765 --bind 127.0.0.1' -WorkingDirectory $feed -PassThru -WindowStyle Hidden
Start-Sleep 2

function Write-Feed($sha, $version) {
    @{ channels = @{ stable = @{ version = $version; url = 'http://127.0.0.1:8765/SelfStreamDeck-0.2.0.msi'; sha256 = $sha } } } |
        ConvertTo-Json -Depth 5 | Set-Content "$feed\manifest.json" -Encoding ascii
}
function Write-Config($signer) {
    $u = @{ url = 'http://127.0.0.1:8765/manifest.json' }
    if ($signer) { $u.signer = $signer }
    @{ token = 'a' * 32; port = 7999; update = $u } | ConvertTo-Json -Depth 5 | Set-Content "$data\config.json" -Encoding ascii
}
# runs `ssd update` and checks that the output has (or lacks) a piece of text
function Expect($label, $extra, $contains) {
    $text = (& $exe update --data-dir $data @extra 2>&1 | ForEach-Object { "$_" }) -join "`n"
    if ($text -match [regex]::Escape($contains)) { Write-Host "ok     $label" }
    else { $script:failures += 1; Write-Host "FAIL   $label`n$text" }
}

try {
    $sha = (Get-FileHash "$feed\SelfStreamDeck-0.2.0.msi" -Algorithm SHA256).Hash.ToLower()
    Write-Config $null
    Write-Feed $sha '0.1.0'
    Expect 'the same version is the newest' @() 'newest version'
    Write-Feed $sha '0.2.0'
    Expect 'a newer version is announced' @() '0.2.0 is available'
    Expect 'an unsigned agent with no update.signer refuses to update' @('--apply', '--no-install') 'is not signed and no "update.signer"'

    powershell -NoProfile -File "$root\agent\scripts\sign.ps1" -File "$feed\SelfStreamDeck-0.2.0.msi" | Out-Null
    $thumb = (Get-AuthenticodeSignature "$feed\SelfStreamDeck-0.2.0.msi").SignerCertificate.Thumbprint
    $signed = (Get-FileHash "$feed\SelfStreamDeck-0.2.0.msi" -Algorithm SHA256).Hash.ToLower()
    Write-Feed $signed '0.2.0'
    Write-Config $thumb
    Expect 'a package signed by the configured signer is accepted' @('--apply', '--no-install') 'downloaded and checked'
    Write-Config ('0' * 40)
    Expect 'a package signed by someone else is refused' @('--apply', '--no-install') 'not by'
    Write-Config $thumb
    Write-Feed ('0' * 64) '0.2.0'
    Expect 'a package that is not the one in the manifest is refused' @('--apply', '--no-install') 'does not match the manifest'

    # altered after signing, with the manifest updated to the new hash: only the signature can catch it
    [IO.File]::AppendAllText("$feed\SelfStreamDeck-0.2.0.msi", 'x')
    Write-Feed ((Get-FileHash "$feed\SelfStreamDeck-0.2.0.msi" -Algorithm SHA256).Hash.ToLower()) '0.2.0'
    Expect 'a package altered after signing is refused by its signature' @('--apply', '--no-install') 'HashMismatch'
}
finally {
    Stop-Process $server.Id -Force -ErrorAction SilentlyContinue
}
if ($failures) { Write-Host "`n$failures failed"; exit 1 }
Write-Host "`nall passed"
