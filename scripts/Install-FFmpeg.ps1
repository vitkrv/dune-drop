param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'

function Add-FFmpegUserPath([string]$ExistingPath, [string]$Directory) {
    $entries = @($ExistingPath -split ';' | Where-Object { $_.Trim() })
    if ($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\') -ieq $Directory.TrimEnd('\') }) { return $ExistingPath }
    return (($entries + $Directory) -join ';')
}

function Assert-FFmpegArchiveHash([string]$Archive, [string]$ExpectedHash) {
    if ($ExpectedHash -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ine $ExpectedHash) { throw 'FFmpeg archive checksum verification failed.' }
}

function Install-FFmpegPair([string]$Ffmpeg, [string]$Ffprobe, [string]$Destination) {
    foreach ($item in @(@($Ffmpeg, 'ffmpeg'), @($Ffprobe, 'ffprobe'))) {
        $output = @(& $item[0] -version)
        if ($LASTEXITCODE -ne 0 -or @($output).Count -eq 0 -or $output[0] -notmatch ('^' + $item[1] + ' version \S+')) { throw ('Downloaded ' + $item[1] + ' did not pass validation.') }
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $id = [guid]::NewGuid().ToString()
    $entries = @(
        @{ Source = $Ffmpeg; Target = (Join-Path $Destination 'ffmpeg.exe'); Replaced = $false },
        @{ Source = $Ffprobe; Target = (Join-Path $Destination 'ffprobe.exe'); Replaced = $false }
    )
    foreach ($entry in $entries) {
        $entry.Stage = $entry.Target + '.' + $id + '.new'
        $entry.Backup = $entry.Target + '.' + $id + '.bak'
        $entry.Existed = Test-Path -LiteralPath $entry.Target
    }
    try {
        foreach ($entry in $entries) { Copy-Item -LiteralPath $entry.Source -Destination $entry.Stage }
        foreach ($entry in $entries) {
            if ($entry.Existed) { [IO.File]::Replace($entry.Stage, $entry.Target, $entry.Backup) }
            else { [IO.File]::Move($entry.Stage, $entry.Target) }
            $entry.Replaced = $true
        }
    } catch {
        foreach ($entry in $entries) {
            if ($entry.Replaced) {
                if ($entry.Existed) { [IO.File]::Replace($entry.Backup, $entry.Target, [NullString]::Value) }
                else { [IO.File]::Delete($entry.Target) }
            }
        }
        throw
    } finally {
        foreach ($entry in $entries) {
            if (Test-Path -LiteralPath $entry.Stage) { Remove-Item -LiteralPath $entry.Stage -Force }
        }
    }
    # Keep backups if rollback itself fails; otherwise both tools are now installed.
    foreach ($entry in $entries) {
        if (Test-Path -LiteralPath $entry.Backup) { Remove-Item -LiteralPath $entry.Backup -Force }
    }
}

if ($FunctionsOnly) { return }
$installRoot = Join-Path $env:LOCALAPPDATA 'FFmpeg'
$stageDirectory = Join-Path ([IO.Path]::GetTempPath()) ('dunedrop-ffmpeg-' + [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $stageDirectory | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    Write-Output 'Downloading latest release FFmpeg and ffprobe from Gyan...'
    $checksum = (Invoke-WebRequest -UseBasicParsing -Uri ($url + '.sha256') -TimeoutSec 60).Content
    if ($checksum -notmatch '^\s*([a-fA-F0-9]{64})(?:\s|$)') { throw 'The release does not provide a valid SHA256 digest.' }
    $expectedHash = $Matches[1]
    $archive = Join-Path $stageDirectory 'ffmpeg.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive -TimeoutSec 600
    Write-Output 'Verifying SHA256 and extracting archive...'
    Assert-FFmpegArchiveHash $archive $expectedHash
    $extract = Join-Path $stageDirectory 'extract'
    Expand-Archive -LiteralPath $archive -DestinationPath $extract
    $bins = @(Get-ChildItem -LiteralPath $extract -Directory -Recurse | Where-Object {
        (Test-Path -LiteralPath (Join-Path $_.FullName 'ffmpeg.exe')) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'ffprobe.exe'))
    })
    if ($bins.Count -ne 1) { throw 'Expected one directory containing ffmpeg.exe and ffprobe.exe.' }
    Write-Output 'Validating and installing both executables...'
    Install-FFmpegPair (Join-Path $bins[0].FullName 'ffmpeg.exe') (Join-Path $bins[0].FullName 'ffprobe.exe') $installRoot
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $updatedPath = Add-FFmpegUserPath $userPath $installRoot
    if ($updatedPath -cne $userPath) { [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User') }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DuneDropFFmpegEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'
    $broadcastResult = [UIntPtr]::Zero
    [void][DuneDropFFmpegEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$broadcastResult)
    Write-Output ('Installed to ' + $installRoot + '. DuneDrop can use it immediately. Reopen existing terminals to refresh PATH.')
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stageDirectory)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedStage.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside TEMP.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
