# DuneDrop

DuneDrop is a Windows 11 x64 desktop GUI for [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#usage-and-options). It provides a native folder picker, sequential download queue, MP4 video and MP3 audio presets, raw process logs, English and Ukrainian UI text, and a searchable catalog generated from the bundled downloader's current `--help` output.

## Runtime behavior

- The release is one portable `DuneDrop.exe`.
- The embedded `src-tauri/resources/bin/yt-dlp.exe` is extracted on first launch to `%LOCALAPPDATA%\DuneDrop\tools\yt-dlp.exe`.
- An existing extracted executable is never overwritten automatically. Use Settings to reveal the managed tools folder, replace the executable, or explicitly invoke its updater.
- MP3 extraction requires `ffmpeg.exe` and `ffprobe.exe` on `PATH` or in the configured ffmpeg folder. They are intentionally not bundled.
- Ordinary settings are persisted locally. Passwords, two-factor values, and raw argument text are not persisted.
- Firefox cookies are opt-in and refreshed manually. Only YouTube-domain cookies are saved in a protected current-user folder under `%LOCALAPPDATA%\DuneDrop\auth`. Each download uses a disposable copy.
- Deno is detected from its user installation and `PATH`, and its absolute path is passed to yt-dlp so it works immediately after installation.

## YouTube authorization and cookie recovery

1. Install Firefox if needed. Sign into YouTube in a **regular Firefox window** using the account that can access the video. Chrome can stay open.
2. In Settings, enable **Use saved Firefox cookies for YouTube** and choose a Firefox profile. A single discovered profile is selected automatically; custom profile folders are supported.
3. Click **Resync cookies**. The last-successful-sync time confirms that cookies were copied; it does not prove that YouTube accepted the session.
4. Download normally. Cookies refresh only when you click Resync. A failed sync preserves the previous saved copy. Changing profiles requires a new sync.

When a failed YouTube download reports a sign-in requirement or invalid cookies, its queue item offers setup or resync instructions and a link to logs. After successful resync, click **Retry download**. Retries are never automatic. Private and members-only content still requires an account with access. Generic network, format, Deno, and PO-token errors do not trigger cookie advice. Advanced cookie arguments override saved Firefox cookies; the recovery panel links to those options when applicable.

Use **Clear saved cookies** to delete the managed snapshot, or disable the cookie switch to download without it. An active job finishes using its own temporary copy. Cookie values never enter the settings store or cookie-sync logs. Treat browser session cookies as account credentials. See [yt-dlp's YouTube cookie guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).

## Install Deno

Open Settings and click **Install / Update Deno**. The app downloads and verifies the latest stable official Windows x64 release, validates it, then installs it into `%USERPROFILE%\.deno\bin` (or `%DENO_INSTALL%\bin`). It adds that directory to your user `PATH` without administrator rights. Before reporting success, DuneDrop refreshes the PATH inherited by subsequent downloader and utility processes. DuneDrop uses Deno immediately; separately opened terminals must still be reopened before running `deno --version` there.

Installation progress and errors appear in Logs. Installation is unavailable during an active download. A failed download, checksum check, or executable validation leaves a working installation intact. Deno 2.3.0 or newer is required. Keep yt-dlp updated using the existing Settings button; the official executable includes EJS solver scripts. See the [yt-dlp EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

The same installer can be run from this checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Deno.ps1
```

## YouTube: налаштування українською

1. Встановіть Firefox та увійдіть у YouTube у **звичайному вікні** з обліковим записом, який має доступ до відео. Chrome можна залишити відкритим.
2. У Налаштуваннях увімкніть cookies Firefox для YouTube, виберіть профіль і натисніть **Синхронізувати cookies**. Для іншого профілю потрібна нова синхронізація.
3. Якщо YouTube потребує авторизації або cookies застаріли, виконайте підказки в невдалому елементі черги. Після синхронізації натисніть **Повторити завантаження**. Автоматичної синхронізації та повторних спроб немає.
4. Для приватного відео або контенту для учасників обліковий запис повинен мати доступ. Якщо задано розширені параметри cookies, вони мають пріоритет над cookies Firefox.

Для JavaScript натисніть **Встановити / оновити Deno** у Налаштуваннях. Інсталяція для поточного користувача не потребує адміністратора. Перед повідомленням про успіх DuneDrop автоматично оновлює `PATH` для наступних команд завантажувача. Окремо відкриті термінали потрібно відкрити заново. Хід інсталяції та помилки доступні в Журналі. Також оновлюйте yt-dlp через Налаштування.

## Install FFmpeg for MP3 downloads

`ffprobe.exe` is included with FFmpeg. To install the latest stable Windows essentials build for the current user, close DuneDrop and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Install-FFmpeg.ps1
```

The script downloads the stable release from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), installs `ffmpeg.exe` and `ffprobe.exe` under `%LOCALAPPDATA%\FFmpeg`, adds that folder to the user `PATH`, and prints both installed versions.

In DuneDrop, open Settings and select this ffmpeg folder if automatic detection has not refreshed yet:

```text
%LOCALAPPDATA%\FFmpeg
```

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

Additional offline verification:

```powershell
python .\scripts\Test-CookieExport.py
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-DenoInstaller.ps1
```

These use synthetic cookies and a fake local runtime; they do not read your Firefox session, install Deno, or change your user PATH.
