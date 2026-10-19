# Test double for the UnityCapture filter's receiving side: publishes the same named objects, waits for one frame
# and prints what arrived as JSON. Used by vcam-host.test.js.
$ErrorActionPreference = 'Stop'
$mutex = New-Object Threading.Mutex($false, 'UnityCapture_Mutx')
$sent = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::AutoReset, 'UnityCapture_Sent')
$max = 1920 * 1080 * 4
# the real filter owns these names while any app has the camera open: this test then has nothing to stand in for
try { $map = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew('UnityCapture_Data', 32 + $max) } catch { [Console]::Out.WriteLine('BUSY'); exit 0 }
$view = $map.CreateViewAccessor()
$view.Write(0, [uint32]$max)
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()

if (-not $sent.WaitOne(30000)) { [Console]::Out.WriteLine('{"error":"no frame"}'); exit 1 }
[void]$mutex.WaitOne()
$w = $view.ReadInt32(4); $h = $view.ReadInt32(8); $stride = $view.ReadInt32(12); $format = $view.ReadInt32(16); $resize = $view.ReadInt32(20); $timeout = $view.ReadInt32(28)
$px = @($view.ReadByte(32), $view.ReadByte(33), $view.ReadByte(34), $view.ReadByte(35))
$mutex.ReleaseMutex()
[Console]::Out.WriteLine((@{ width = $w; height = $h; stride = $stride; format = $format; resize = $resize; timeout = $timeout; pixel = $px } | ConvertTo-Json -Compress))
