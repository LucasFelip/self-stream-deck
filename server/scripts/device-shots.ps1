<#
.SYNOPSIS
  Captures the app's screens on an Android phone over adb, for before/after comparisons of the redesign.

.DESCRIPTION
  Open the Self Stream Deck app on the phone first. For each orientation the script locks the rotation, visits every
  destination and saves <orientation>_<destination>.png in -OutDir (land_apps.png, port_monitor.png, ...).

  Landscape: taps the items of the navigation rail on the left (72 dp wide; a 24 dp status row, then six 48 dp items).
  Portrait: taps the six equal slots of the bottom bar (56 dp high). Positions are computed in dp from the CSS constants
  (style.css: --rail-w, --bar-h, --touch) times the phone's density (wm density / 160) and screen size (wm size), so
  nothing is calibrated per phone. If the app's window does not start at the top of the screen, pass -TopInsetDp; with a
  gesture bar under the window, -BottomInsetDp. Taps never go near the buttons of the Energia page: they only hit the nav.

  The rotation is always handed back to the phone (automatic) at the end, even on failure. It never touches anything on
  the Energia page: it only navigates there (it is a real PC).
  The PNG comes from screencap on the phone + adb pull. Never redirect `exec-out screencap` through PowerShell: it corrupts the file.
#>
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Adb = 'E:\Workspace\self-stream-deck\.tools\platform-tools\adb.exe',
  [string[]]$Orientations = @('land', 'port'),
  [string[]]$Tabs = @('apps', 'shortcuts', 'sound', 'monitor', 'power', 'processes'),
  # layout constants of the navigation, in dp (keep in step with style.css)
  [double]$StatusRowDp = 24,   # landscape: the status light row above the first rail item
  [double]$TouchDp = 48,       # --touch: one rail item
  [double]$BarDp = 56,         # --bar-h
  [double]$TopInsetDp = 0,     # where the app window starts, if not at the very top
  [double]$BottomInsetDp = 0   # what sits under the app window (gesture bar), if anything
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
    $densityText = (& $Adb shell wm density | Out-String)
    $dpi = if ($densityText -match '(\d+)\s*$') { [double]$Matches[1] } else { 420 }
    $px = $dpi / 160 # pixels per dp

    if ($orientation -eq 'land') {
      # rail item i is centred at status row + (i + 0.5) items; x = 56 dp is inside the rail with or without a cut-out inset on the left
      $x = [int](56 * $px)
      for ($i = 0; $i -lt $Tabs.Count; $i++) {
        $y = [int](($TopInsetDp + $StatusRowDp + ($i + 0.5) * $TouchDp) * $px)
        & $Adb shell input tap $x $y
        Shot "land_$($Tabs[$i])"
      }
    } else {
      # the bar spans the width in six equal slots; its middle is half a bar above the bottom of the window
      $y = [int](($long - (($BottomInsetDp + $BarDp / 2) * $px)))
      for ($i = 0; $i -lt $Tabs.Count; $i++) {
        $x = [int]($short * ($i + 0.5) / $Tabs.Count)
        & $Adb shell input tap $x $y
        Shot "port_$($Tabs[$i])"
      }
    }
  }
} finally {
  & $Adb shell cmd window user-rotation free | Out-Null
  & $Adb shell settings put system accelerometer_rotation $savedRotation | Out-Null
  & $Adb shell rm -f $remote | Out-Null
}
Write-Host "Done: $OutDir"
