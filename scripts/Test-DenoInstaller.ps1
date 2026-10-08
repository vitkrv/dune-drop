$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-Deno.ps1') -FunctionsOnly
function Assert-Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'" } }
Assert-Equal (Add-DenoUserPath 'C:\Existing;C:\My Deno\bin' 'C:\My Deno\bin') 'C:\Existing;C:\My Deno\bin'
Assert-Equal (Add-DenoUserPath 'C:\Existing;C:\MY DENO\bin\' 'C:\My Deno\bin') 'C:\Existing;C:\MY DENO\bin\'
Assert-Equal (Add-DenoUserPath 'C:\Existing' 'C:\My Deno\bin') 'C:\Existing;C:\My Deno\bin'
Assert-Equal (Add-DenoUserPath '' 'C:\My Deno\bin') 'C:\My Deno\bin'
$stage = Join-Path ([IO.Path]::GetTempPath()) ('dunedrop-installer-test-' + [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    $candidate = Join-Path $stage 'fake-deno.cmd'
    $target = Join-Path $stage 'User tools\deno.exe'
    # A local fake runtime exercises validation and replacement without network or PATH changes.
    [IO.File]::WriteAllText($candidate, "@echo off`r`necho deno 2.3.0`r`necho v8 test`r`nexit /b 0`r`n")
    $null = Install-DenoArchive $candidate $target
    Assert-Equal ([IO.File]::ReadAllText($target)) ([IO.File]::ReadAllText($candidate))
    $null = Install-DenoArchive $candidate $target
    $original = [IO.File]::ReadAllText($target)
    [IO.File]::WriteAllText($candidate, "@echo off`r`necho deno 2.2.0`r`necho v8 test`r`nexit /b 0`r`n")
    $rejected = $false
    try { $null = Install-DenoArchive $candidate $target } catch { $rejected = $true }
    if (-not $rejected) { throw 'Old runtime was accepted.' }
    Assert-Equal ([IO.File]::ReadAllText($target)) $original
    $rejected = $false
    try { Assert-DenoArchiveHash $candidate ('0' * 64) } catch { $rejected = $true }
    if (-not $rejected) { throw 'Corrupt download was accepted.' }
    Assert-Equal ([IO.File]::ReadAllText($target)) $original
    Assert-DenoArchiveHash $candidate (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
    $rejected = $false
    try { $null = Install-DenoArchive (Join-Path $stage 'missing.exe') $target } catch { $rejected = $true }
    if (-not $rejected) { throw 'Missing download was accepted.' }
    Assert-Equal ([IO.File]::ReadAllText($target)) $original
    if (Get-ChildItem -LiteralPath (Split-Path -Parent $target) -Filter 'deno-*.exe') { throw 'Replacement files were not cleaned.' }
    Write-Output 'Deno installer tests passed: validation, failed downloads, checksums, repeated install, spaces, PATH preservation.'
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedStage.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside TEMP.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
