<#
.SYNOPSIS
  Captures the app's screens on an Android phone over adb, for before/after comparisons of the redesign.

.DESCRIPTION
  Open the Self Stream Deck app on the phone first. For each orientation the script locks the rotation, visits every
  destination and saves <orientation>_<destination>.png in -OutDir (land_apps.png, port_monitor.png, ...).

  Landscape: taps the tabs at fixed pixel positions (-TabX), calibrated for a Galaxy A31 (1080x2400).
  Portrait: the tabs move (only the active one shows its label), so there is nothing fixed to tap. The script swipes
  sideways through the pager instead, one page per swipe, and names the shots after -Tabs in order. Sections with more
  than one page (Apps, Atalhos, Som) make the names drift; check the PNGs. Phase 2 changes the navigation and this
  script is adapted then.

  The rotation is always handed back to the phone (automatic) at the end, even on failure. It never touches anything on
  the Energia page: it only navigates there (it is a real PC).
  The PNG comes from screencap on the phone + adb pull. Never redirect `exec-out screencap` through PowerShell: it corrupts the file.
#>
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Adb = 'E:\Workspace\self-stream-deck\.tools\platform-tools\adb.exe',
  [string[]]$Orientations = @('land', 'port'),
  [string[]]$Tabs = @('apps', 'shortcuts', 'sound', 'monitor', 'power', 'processes'),
  # landscape tab positions (x, y in real pixels), in the order of -Tabs; menu at 2310,60
  [hashtable]$TabX = @{
    land = @(@(576, 60), @(804, 60), @(1032, 60), @(1302, 60), @(1596, 60), @(1896, 60))
  }
)

$ErrorActionPreference = 'Stop'
$remote = '/sdcard/ssd-shot.png'

if (-not (Test-Path $Adb)) { Write-Host "adb not found at $Adb"; exit 1 }
$devices = @(& $Adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\tdevice$' })
if ($devices.Count -eq 0) { Write-Host 'No phone connected (adb devices is empty). Plug it in with USB debugging on.'; exit 1 }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$savedRotation = (& $Adb shell settings get system accelerometer_rotation | Out-String).Trim()
if ($savedRotation -notmatch '^[01]$') { $savedRotation = '1' }

function Shot($name) {
  Start-Sleep -Milliseconds 900 # the page slide and first render
  & $Adb shell screencap -p $remote | Out-Null
  & $Adb pull $remote (Join-Path $OutDir "$name.png") | Out-Null
  Write-Host "  $name.png"
}

try {
  foreach ($orientation in $Orientations) {
    Write-Host "== $orientation"
    & $Adb shell cmd window user-rotation lock $(if ($orientation -eq 'land') { 1 } else { 0 }) | Out-Null
    Start-Sleep -Seconds 2
    $size = ((& $Adb shell wm size | Out-String) -replace '.*: ', '').Trim() -split 'x'
    $short = [int]($size | Measure-Object -Minimum).Minimum
    $long = [int]($size | Measure-Object -Maximum).Maximum

    if ($orientation -eq 'land') {
      for ($i = 0; $i -lt $Tabs.Count; $i++) {
        $p = $TabX.land[$i]
        & $Adb shell input tap $p[0] $p[1]
        Shot "land_$($Tabs[$i])"
      }
    } else {
      $y = [int]($long / 2); $left = [int]($short * 0.15); $right = [int]($short * 0.85)
      for ($i = 0; $i -lt 8; $i++) { & $Adb shell input swipe $left $y $right $y 150; Start-Sleep -Milliseconds 300 } # to the first page
      for ($i = 0; $i -lt $Tabs.Count; $i++) {
        Shot "port_$($Tabs[$i])"
        & $Adb shell input swipe $right $y $left $y 150
      }
    }
  }
} finally {
  & $Adb shell cmd window user-rotation free | Out-Null
  & $Adb shell settings put system accelerometer_rotation $savedRotation | Out-Null
  & $Adb shell rm -f $remote | Out-Null
}
Write-Host "Done: $OutDir"
