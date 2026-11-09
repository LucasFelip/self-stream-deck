# Builds the interface, then the agent with it inside, and makes dist\SelfStreamDeck-<version>.zip: ssd.exe, install.ps1, uninstall.ps1,
# launch-hidden.vbs and a SHA-256 file. With -Sign the exe is signed first (see sign.ps1).
#
#   powershell -File agent/scripts/package.ps1 [-Sign] [-SkipWeb]
#
# It builds in agent\target-pkg so it works while an installed/running agent holds agent\target\release\ssd.exe.

param([switch]$Sign, [switch]$SkipWeb)

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$env:Path += ";$env:USERPROFILE\.cargo\bin"

if (-not $SkipWeb) {
    Push-Location (Join-Path $root 'web'); try { npm run build; if ($LASTEXITCODE) { throw 'web build failed' } } finally { Pop-Location }
}
Push-Location (Join-Path $root 'agent')
try {
    cargo build --release --target-dir target-pkg
    if ($LASTEXITCODE) { throw 'cargo build failed' }
} finally { Pop-Location }

$exe = Join-Path $root 'agent\target-pkg\release\ssd.exe'
if ($Sign) { & (Join-Path $PSScriptRoot 'sign.ps1') -File $exe }

$version = ((& $exe --version) -replace 'Self Stream Deck ', '').Trim()
$stage = Join-Path $root "dist\SelfStreamDeck-$version"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item $exe $stage
foreach ($name in 'install.ps1', 'uninstall.ps1', 'launch-hidden.vbs') { Copy-Item (Join-Path $PSScriptRoot $name) $stage }

$zip = "$stage.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$stage\*" -DestinationPath $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $zip -Leaf)" | Set-Content "$zip.sha256" -Encoding ascii
Write-Host "Package: $zip"
Write-Host "SHA-256: $hash"
Write-Host ("ssd.exe: {0:N1} MB" -f ((Get-Item $exe).Length / 1MB))
