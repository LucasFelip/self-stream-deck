# Direct virtual camera feeder.
#
# Reads frames from stdin (a 4-byte little-endian length, then that many bytes of JPEG; length 0 = quit), decodes them
# and hands them to the "Stream Deck Camera" DirectShow device, which is the UnityCapture filter. The filter and this
# script talk through the shared memory the filter publishes while some app (Discord, Zoom, a browser...) has the camera
# open; with nobody watching there is nothing to write to and frames are simply dropped.
#
# Protocol (UnityCapture, Source/shared.inl): named mutex "UnityCapture_Mutx", events "UnityCapture_Want" and
# "UnityCapture_Sent" and the mapping "UnityCapture_Data", whose header is
#   DWORD maxSize; int width, height, stride(pixels), format(0 = RGBA 8 bit), resizemode, mirrormode, timeout(ms); pixels...
# Writes one JSON line to stdout about once a second: {"ready":bool,"sent":n}.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

. "$PSScriptRoot\lib\cache-type.ps1"

# The C# lives in native/VCam.cs, the one copy: the native helper (ssd-helper.exe) is built from the same file.

Add-CachedType -Name 'deck-vcam' -Path "$PSScriptRoot\..\native\VCam.cs" -ReferencedAssemblies System.Drawing

$stdin = [Console]::OpenStandardInput()
$header = New-Object byte[] 4
$lastReport = [DateTime]::UtcNow

function Read-Exact([byte[]]$buffer, [int]$count) {
    $got = 0
    while ($got -lt $count) {
        $n = $stdin.Read($buffer, $got, $count - $got)
        if ($n -le 0) { return $false }
        $got += $n
    }
    return $true
}

while ($true) {
    if (-not (Read-Exact $header 4)) { break }
    $length = [BitConverter]::ToInt32($header, 0)
    if ($length -le 0) { break }
    if ($length -gt 4MB) { break } # never trust a length that large: something is wrong, stop
    $frame = New-Object byte[] $length
    if (-not (Read-Exact $frame $length)) { break }

    $ok = $false
    try { $ok = [VCam]::Send($frame) } catch { }

    if (([DateTime]::UtcNow - $lastReport).TotalMilliseconds -ge 1000) {
        $lastReport = [DateTime]::UtcNow
        [Console]::Out.WriteLine(('{{"ready":{0},"sent":{1}}}' -f $ok.ToString().ToLower(), [VCam]::Sent))
        [Console]::Out.Flush()
    }
}
