$ErrorActionPreference = "Stop"

function Resolve-CommandPath {
    param([string]$Name, [string[]]$FallbackPaths, [string]$InstallHint)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    foreach ($path in $FallbackPaths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            return $path
        }
    }
    throw "Missing required command '$Name'. $InstallHint"
}

function Initialize-MsvcEnvironment {
    $vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        throw "Missing Visual Studio Build Tools. Install the Desktop development with C++ workload."
    }
    $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) {
        throw "Missing Visual Studio C++ Build Tools workload."
    }
    $vsDevCmd = Join-Path $installation "Common7\Tools\VsDevCmd.bat"
    if (-not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) {
        throw "Missing Visual Studio developer environment script: $vsDevCmd"
    }
    & "$env:ComSpec" /d /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set" | ForEach-Object {
        $name, $value = $_ -split "=", 2
        if ($name -and $value) {
            Set-Item -Path "Env:$name" -Value $value
        }
    }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resource = Join-Path $root "src-tauri\resources\bin\yt-dlp.exe"
$releaseExe = Join-Path $root "src-tauri\target\release\dunedrop.exe"
$dist = Join-Path $root "dist"
$portableExe = Join-Path $dist "DuneDrop.exe"

$node = Resolve-CommandPath "node" @("C:\Program Files\nodejs\node.exe") "Install Node.js 20 or later."
$npm = Resolve-CommandPath "npm" @("C:\Program Files\nodejs\npm.cmd") "Install npm with Node.js."
$cargo = Resolve-CommandPath "cargo" @("$env:USERPROFILE\.cargo\bin\cargo.exe") "Install the Rust stable MSVC toolchain from https://rustup.rs/."
Initialize-MsvcEnvironment
$env:PATH = "$(Split-Path -Parent $cargo);$(Split-Path -Parent $npm);$(Split-Path -Parent $node);$env:PATH"

if (-not (Test-Path -LiteralPath $resource -PathType Leaf)) {
    throw "Missing embedded downloader: $resource"
}

Push-Location $root
try {
    & (Join-Path $root "scripts\generate-icon.ps1")
    if (Test-Path -LiteralPath (Join-Path $root "package-lock.json")) {
        & $npm ci
    } else {
        & $npm install
    }
    & $npm run test
    & $cargo test --manifest-path (Join-Path $root "src-tauri\Cargo.toml")
    & $npm run tauri -- build --no-bundle

    if (-not (Test-Path -LiteralPath $releaseExe -PathType Leaf)) {
        throw "Tauri build completed without creating $releaseExe"
    }

    if (-not $dist.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a dist path outside the workspace: $dist"
    }
    if (Test-Path -LiteralPath $dist) {
        Remove-Item -LiteralPath $dist -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    Copy-Item -LiteralPath $releaseExe -Destination $portableExe
    Write-Host "Created portable executable: $portableExe"
} finally {
    Pop-Location
}
