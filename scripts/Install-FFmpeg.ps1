$ErrorActionPreference = "Stop"

$url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
$installRoot = Join-Path $env:LOCALAPPDATA "FFmpeg"
$tempRoot = Join-Path $env:TEMP "ffmpeg-install"
$archive = Join-Path $tempRoot "ffmpeg.zip"
$extract = Join-Path $tempRoot "extract"

Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $extract | Out-Null

Write-Host "Downloading latest stable FFmpeg..."
Invoke-WebRequest -Uri $url -OutFile $archive

Write-Host "Extracting..."
Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force

$sourceBin = Get-ChildItem $extract -Directory -Recurse |
    Where-Object {
        (Test-Path (Join-Path $_.FullName "ffmpeg.exe")) -and
        (Test-Path (Join-Path $_.FullName "ffprobe.exe"))
    } |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $sourceBin) {
    throw "ffmpeg.exe and ffprobe.exe were not found in the downloaded archive."
}

Remove-Item $installRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
Copy-Item "$sourceBin\*" $installRoot -Recurse -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @($userPath -split ";" | Where-Object { $_ })
if ($parts -notcontains $installRoot) {
    [Environment]::SetEnvironmentVariable(
        "Path",
        (($parts + $installRoot) -join ";"),
        "User"
    )
}

$env:Path = "$installRoot;$env:Path"

Write-Host ""
Write-Host "Installed successfully:"
& "$installRoot\ffmpeg.exe" -version | Select-Object -First 1
& "$installRoot\ffprobe.exe" -version | Select-Object -First 1
Write-Host ""
Write-Host "DuneDrop ffmpeg folder:"
Write-Host $installRoot

