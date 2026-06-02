# DuneDrop

DuneDrop is a Windows 11 x64 desktop GUI for [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#usage-and-options). It provides a native folder picker, sequential download queue, MP4 video and MP3 audio presets, raw process logs, English and Ukrainian UI text, and a searchable catalog generated from the bundled downloader's current `--help` output.

## Runtime behavior

- The release is one portable `DuneDrop.exe`.
- The embedded `src-tauri/resources/bin/yt-dlp.exe` is extracted on first launch to `%LOCALAPPDATA%\DuneDrop\tools\yt-dlp.exe`.
- An existing extracted executable is never overwritten automatically. Use Settings to reveal the managed tools folder, replace the executable, or explicitly invoke its updater.
- MP3 extraction requires `ffmpeg.exe` and `ffprobe.exe` on `PATH` or in the configured ffmpeg folder. They are intentionally not bundled.
- Ordinary settings are persisted locally. Passwords, two-factor values, and raw argument text are not persisted.

## Prerequisites

- Windows 11 x64
- Node.js 20 or later with npm
- Rust stable MSVC toolchain
- Microsoft WebView2 Runtime, included with Windows 11

## Build

Run:

```powershell
.\scripts\build.ps1
```

The script installs JavaScript dependencies, runs tests, builds the Tauri release without an installer bundle, and creates:

```text
dist\DuneDrop.exe
```

The `dist` directory is cleared before the portable executable is copied, so the release folder contains one file.

## Development

```powershell
npm install
npm run tauri dev
```

The Rust backend owns child-process execution. It constructs an argument array without a shell, streams raw `stdout` and `stderr` into the Logs tab, and assigns downloads to a Windows Job Object so cancellation terminates child processes such as ffmpeg.
