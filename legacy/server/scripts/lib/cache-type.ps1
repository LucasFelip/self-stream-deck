# Add-Type recompiles its C# on every start of a helper. Add-CachedType compiles it once into a DLL (named after a hash of the
# source, so any edit compiles again) in data\cache and loads that DLL from then on, which makes helpers start noticeably faster.
function Add-CachedType {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string]$Source,
        # a .cs file to compile instead of an inline $Source: the native helper is built from the same file, so there is one copy
        [string]$Path,
        [string[]]$ReferencedAssemblies = @()
    )

    if ($Path) { $Source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path).ProviderPath) }
    if (-not $Source) { throw 'Add-CachedType needs -Source or -Path' }

    $dir = if ($env:SSD_CACHE_DIR) { $env:SSD_CACHE_DIR } else { Join-Path $PSScriptRoot '..\..\data\cache' }
    try {
        [void][IO.Directory]::CreateDirectory($dir)
        $sha = [Security.Cryptography.SHA256]::Create()
        $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Source + '|' + $PSVersionTable.PSVersion))) -replace '-', '').Substring(0, 16).ToLowerInvariant()
        $dll = Join-Path $dir "$Name-$hash.dll"

        if (-not (Test-Path -LiteralPath $dll)) {
            # compile beside the final name and move it in, so two helpers starting together never load a half-written file
            $temporary = Join-Path $dir "$Name-$hash.$PID.tmp"
            Add-Type -TypeDefinition $Source -ReferencedAssemblies $ReferencedAssemblies -OutputAssembly $temporary -OutputType Library
            try { Move-Item -LiteralPath $temporary -Destination $dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue }
            Get-ChildItem -LiteralPath $dir -Filter "$Name-*.dll" -ErrorAction SilentlyContinue | Where-Object { $_.FullName -ne $dll } | Remove-Item -ErrorAction SilentlyContinue
        }
        Add-Type -Path $dll
    }
    catch {
        # no usable cache (read-only folder, antivirus...): compile in memory as before
        Add-Type -TypeDefinition $Source -ReferencedAssemblies $ReferencedAssemblies
    }
}
