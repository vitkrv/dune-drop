param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'

function Add-DenoUserPath([string]$ExistingPath, [string]$BinDirectory) {
    $entries = @($ExistingPath -split ';' | Where-Object { $_.Trim() })
    $normalized = $BinDirectory.TrimEnd('\')
    if ($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\') -ieq $normalized }) { return $ExistingPath }
    return (($entries + $BinDirectory) -join ';')
}

function Install-DenoArchive([string]$Candidate, [string]$TargetExecutable) {
    $version = & $Candidate --version
    if ($LASTEXITCODE -ne 0 -or $version[0] -notmatch '^deno (\d+)\.(\d+)\.') { throw 'Downloaded Deno did not pass validation.' }
    if ([int]$Matches[1] -lt 2 -or ([int]$Matches[1] -eq 2 -and [int]$Matches[2] -lt 3)) { throw 'Deno 2.3.0 or newer is required.' }
    $destinationDirectory = Split-Path -Parent $TargetExecutable
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    $replacement = Join-Path $destinationDirectory ('deno-' + [guid]::NewGuid() + '.exe')
    $backup = Join-Path $destinationDirectory ('deno-' + [guid]::NewGuid() + '.bak')
    try {
        Copy-Item -LiteralPath $Candidate -Destination $replacement
        if (Test-Path -LiteralPath $TargetExecutable) { [IO.File]::Replace($replacement, $TargetExecutable, $backup) }
        else { [IO.File]::Move($replacement, $TargetExecutable) }
    } finally {
        if (Test-Path -LiteralPath $replacement) { Remove-Item -LiteralPath $replacement -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
    return $version
}

function Assert-DenoArchiveHash([string]$Archive, [string]$ExpectedHash) {
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ine $ExpectedHash) { throw 'Deno archive checksum verification failed.' }
}

if ($FunctionsOnly) { return }
$installRoot = if ($env:DENO_INSTALL) { $env:DENO_INSTALL } else { Join-Path $env:USERPROFILE '.deno' }
$binDirectory = Join-Path $installRoot 'bin'
$stageDirectory = Join-Path ([IO.Path]::GetTempPath()) ('dunedrop-deno-' + [guid]::NewGuid())
$targetExecutable = Join-Path $binDirectory 'deno.exe'
try {
    New-Item -ItemType Directory -Path $stageDirectory -Force | Out-Null
    Write-Output 'Resolving latest stable Deno release...'
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/denoland/deno/releases/latest' -Headers @{ 'User-Agent' = 'DuneDrop'; Accept = 'application/vnd.github+json' } -TimeoutSec 60
    $asset = $release.assets | Where-Object { $_.name -eq 'deno-x86_64-pc-windows-msvc.zip' } | Select-Object -First 1
    if (-not $asset -or $asset.browser_download_url -notlike 'https://github.com/denoland/deno/releases/download/*') { throw 'Official Windows x64 Deno release was not found.' }
    if ($asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'The release does not provide a SHA256 digest. Installation stopped before replacing Deno.' }
    $expectedHash = $Matches[1]
    $archive = Join-Path $stageDirectory 'deno.zip'
    Write-Output ('Downloading Deno ' + $release.tag_name + '...')
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $archive -TimeoutSec 300
    Assert-DenoArchiveHash $archive $expectedHash
    Expand-Archive -LiteralPath $archive -DestinationPath $stageDirectory
    $candidate = Join-Path $stageDirectory 'deno.exe'
    Write-Output 'Installing validated executable...'
    $version = Install-DenoArchive $candidate $targetExecutable
    $existingUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $updatedUserPath = Add-DenoUserPath $existingUserPath $binDirectory
    if ($updatedUserPath -cne $existingUserPath) { [Environment]::SetEnvironmentVariable('Path', $updatedUserPath, 'User') }
    # Notify Explorer so subsequently opened terminals inherit the new user PATH.
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DuneDropEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'
    $broadcastResult = [UIntPtr]::Zero
    [void][DuneDropEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
    Write-Output ($version -join [Environment]::NewLine)
    Write-Output ('Installed to ' + $targetExecutable + '. Reopen existing terminals to refresh PATH.')
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stageDirectory)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedStage.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to clean a directory outside TEMP.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
