param(
    [Parameter(Mandatory = $true)][string]$IconDir
)

# Lists the shortcuts pinned to the Windows taskbar and extracts one PNG icon per
# shortcut into $IconDir. Prints a JSON array on stdout.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class IconNative {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy,
        IntPtr[] phicon, uint[] piconid, uint nIcons, uint flags);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
'@

function Save-Icon([string]$source, [string]$out) {
    if (-not $source -or -not (Test-Path -LiteralPath $source)) { return $false }
    try {
        $handles = New-Object IntPtr[] 1
        $ids = New-Object uint32[] 1
        $n = [IconNative]::PrivateExtractIcons($source, 0, 128, 128, $handles, $ids, 1, 0)
        if ($n -ge 1 -and $handles[0] -ne [IntPtr]::Zero) {
            try {
                $icon = [System.Drawing.Icon]::FromHandle($handles[0])
                $bmp = $icon.ToBitmap()
                $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
                $bmp.Dispose()
                return $true
            }
            finally { [void][IconNative]::DestroyIcon($handles[0]) }
        }
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($source)
        if ($icon) {
            $bmp = $icon.ToBitmap()
            $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            return $true
        }
    }
    catch { }
    return $false
}

$taskbarDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
New-Item -ItemType Directory -Force -Path $IconDir | Out-Null

$shell = New-Object -ComObject WScript.Shell
$sha = [Security.Cryptography.SHA1]::Create()
$explorer = Join-Path $env:WINDIR 'explorer.exe'
$items = @()

if (Test-Path -LiteralPath $taskbarDir) {
    foreach ($file in Get-ChildItem -LiteralPath $taskbarDir -Filter *.lnk -File) {
        $lnk = $shell.CreateShortcut($file.FullName)
        $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($file.Name.ToLowerInvariant()))
        $id = ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant().Substring(0, 10)

        $iconSource = $null
        if ($lnk.IconLocation -and $lnk.IconLocation.Split(',')[0]) {
            $iconSource = [Environment]::ExpandEnvironmentVariables($lnk.IconLocation.Split(',')[0])
        }
        if (-not $iconSource -or -not (Test-Path -LiteralPath $iconSource)) { $iconSource = $lnk.TargetPath }
        if (-not $iconSource) { $iconSource = $explorer }

        # wt.exe is an app execution alias with no icon of its own; use the packaged exe instead.
        if ((Split-Path $iconSource -Leaf) -ieq 'wt.exe') {
            $pkg = Get-AppxPackage -Name 'Microsoft.WindowsTerminal*' | Select-Object -First 1
            if ($pkg) {
                $packaged = Join-Path $pkg.InstallLocation 'WindowsTerminal.exe'
                if (Test-Path -LiteralPath $packaged) { $iconSource = $packaged }
            }
        }

        $iconFile = Join-Path $IconDir "$id.png"
        $hasIcon = Save-Icon $iconSource $iconFile
        if (-not $hasIcon) { $hasIcon = Save-Icon $file.FullName $iconFile }

        $iconHash = $null
        if ($hasIcon) {
            $iconHash = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($iconFile))) -replace '-', '').ToLowerInvariant()
        }

        $items += [pscustomobject]@{
            id      = $id
            file    = $file.Name
            lnk     = $file.FullName
            target  = $lnk.TargetPath
            args    = $lnk.Arguments
            hasIcon = [bool]$hasIcon
            iconHash = $iconHash
        }
    }
}

ConvertTo-Json -InputObject @($items) -Compress
