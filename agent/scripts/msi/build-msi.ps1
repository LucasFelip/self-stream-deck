# Builds dist\SelfStreamDeck-<version>.msi with the WiX Toolset 3.14 (not part of the repository: unzip wix314-binaries.zip from
# https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm into .tools\wix, or pass -Wix).
#
#   powershell -File agent/scripts/msi/build-msi.ps1 [-Sign] [-SkipBuild] [-Wix path\to\wix]
#
# The agent is built in agent\target-pkg (like package.ps1). With -Sign the exe and the MSI are signed with sign.ps1.

param([switch]$Sign, [switch]$SkipBuild, [string]$Wix = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
if (-not $Wix) { $Wix = Join-Path $root '.tools\wix' }
foreach ($tool in 'candle.exe', 'light.exe') { if (-not (Test-Path (Join-Path $Wix $tool))) { throw "$tool not found in $Wix (see the header of this script)" } }
$env:Path += ";$env:USERPROFILE\.cargo\bin"

if (-not $SkipBuild) {
    Push-Location (Join-Path $root 'web'); try { npm run build; if ($LASTEXITCODE) { throw 'web build failed' } } finally { Pop-Location }
    Push-Location (Join-Path $root 'agent'); try { cargo build --release --target-dir target-pkg; if ($LASTEXITCODE) { throw 'cargo build failed' } } finally { Pop-Location }
}
$exe = Join-Path $root 'agent\target-pkg\release\ssd.exe'
if ($Sign) { & (Join-Path $root 'agent\scripts\sign.ps1') -File $exe }
$version = ((& $exe --version) -replace 'Self Stream Deck ', '').Trim()

$out = Join-Path $root 'dist'
$work = Join-Path $out 'msi-work'
New-Item -ItemType Directory -Force $work | Out-Null
$scripts = Join-Path $root 'agent\scripts'
$source = Join-Path $scripts 'msi\ssd.wxs'

& (Join-Path $Wix 'candle.exe') -nologo -arch x64 -ext WixUtilExtension "-dVersion=$version" "-dExe=$exe" "-dScripts=$scripts" -out "$work\ssd.wixobj" $source
if ($LASTEXITCODE) { throw 'candle failed' }
$msi = Join-Path $out "SelfStreamDeck-$version.msi"
& (Join-Path $Wix 'light.exe') -nologo -ext WixUtilExtension -cultures:pt-BR -out $msi "$work\ssd.wixobj"
if ($LASTEXITCODE) { throw 'light failed' }
if ($Sign) { & (Join-Path $root 'agent\scripts\sign.ps1') -File $msi }

$hash = (Get-FileHash $msi -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $msi -Leaf)" | Set-Content "$msi.sha256" -Encoding ascii
Write-Host "MSI: $msi"
Write-Host "SHA-256: $hash"
Write-Host ("size: {0:N1} MB" -f ((Get-Item $msi).Length / 1MB))
