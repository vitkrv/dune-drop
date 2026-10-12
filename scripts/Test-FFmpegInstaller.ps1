$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-FFmpeg.ps1') -FunctionsOnly
function Assert-Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'" } }
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid installation was accepted.' }
}
Assert-Equal (Add-FFmpegUserPath 'C:\Existing;C:\My Tools\' 'C:\MY TOOLS') 'C:\Existing;C:\My Tools\'
Assert-Equal (Add-FFmpegUserPath 'C:\Existing' 'C:\My Tools') 'C:\Existing;C:\My Tools'
Assert-Equal (Add-FFmpegUserPath '' 'C:\My Tools') 'C:\My Tools'
$stage = Join-Path ([IO.Path]::GetTempPath()) ('dunedrop-ffmpeg-test-' + [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    $ffmpeg = Join-Path $stage 'fake ffmpeg.cmd'
    $ffprobe = Join-Path $stage 'fake ffprobe.cmd'
    $target = Join-Path $stage 'User tools'
    [IO.File]::WriteAllText($ffmpeg, "@echo off`r`necho ffmpeg version test`r`nexit /b 0`r`n")
    [IO.File]::WriteAllText($ffprobe, "@echo off`r`necho ffprobe version test`r`nexit /b 0`r`n")
    Install-FFmpegPair $ffmpeg $ffprobe $target
    $original = [IO.File]::ReadAllText((Join-Path $target 'ffmpeg.exe'))
    $probeOriginal = [IO.File]::ReadAllText((Join-Path $target 'ffprobe.exe'))
    $sentinel = Join-Path $target 'keep.txt'
    [IO.File]::WriteAllText($sentinel, 'unrelated')
    Install-FFmpegPair $ffmpeg $ffprobe $target
    Assert-Equal ([IO.File]::ReadAllText($sentinel)) 'unrelated'
    Assert-FFmpegArchiveHash $ffmpeg (Get-FileHash -LiteralPath $ffmpeg -Algorithm SHA256).Hash
    Assert-Rejected { Assert-FFmpegArchiveHash $ffmpeg ('0' * 64) }
    Assert-Rejected { Assert-FFmpegArchiveHash $ffmpeg 'invalid digest' }
    Assert-Rejected { Install-FFmpegPair $ffmpeg (Join-Path $stage 'missing.exe') $target }
    [IO.File]::WriteAllText($ffprobe, "@echo off`r`necho invalid version`r`nexit /b 0`r`n")
    Assert-Rejected { Install-FFmpegPair $ffmpeg $ffprobe $target }
    [IO.File]::WriteAllText($ffprobe, "@echo off`r`necho ffprobe version test`r`nexit /b 1`r`n")
    Assert-Rejected { Install-FFmpegPair $ffmpeg $ffprobe $target }
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $target 'ffmpeg.exe'))) $original
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $target 'ffprobe.exe'))) $probeOriginal
    # Fail the second replacement after the first succeeds, then verify pair rollback.
    [IO.File]::WriteAllText($ffmpeg, "@echo off`r`necho ffmpeg version updated`r`nexit /b 0`r`n")
    [IO.File]::WriteAllText($ffprobe, "@echo off`r`necho ffprobe version updated`r`nexit /b 0`r`n")
    $locked = [IO.File]::Open((Join-Path $target 'ffprobe.exe'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Assert-Rejected { Install-FFmpegPair $ffmpeg $ffprobe $target } } finally { $locked.Dispose() }
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $target 'ffmpeg.exe'))) $original
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $target 'ffprobe.exe'))) $probeOriginal
    if (Get-ChildItem -LiteralPath $target | Where-Object { $_.Name -match '\.(new|bak)$' }) { throw 'Temporary replacements were not cleaned.' }
    Write-Output 'FFmpeg offline tests passed: checksums, validation, repeated install, spaces, pair rollback, cleanup, PATH preservation.'
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedStage.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside TEMP.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
