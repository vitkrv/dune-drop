# DuneDrop

DuneDrop is a Windows 11 x64 desktop GUI for [`yt-dlp`](https://github.com/yt-dlp/yt-dlp#usage-and-options). It provides a native folder picker, sequential download queue, MP4 video and MP3 audio presets, raw process logs, English and Ukrainian UI text, and a searchable catalog generated from the bundled downloader's current `--help` output.

## Runtime behavior

- The release is one portable `DuneDrop.exe`.
- The embedded `src-tauri/resources/bin/yt-dlp.exe` is extracted on first launch to `%LOCALAPPDATA%\DuneDrop\tools\yt-dlp.exe`.
- An existing extracted executable is never overwritten automatically. Use Settings to reveal the managed tools folder, replace the executable, or explicitly invoke its updater.
- MP3 extraction requires `ffmpeg.exe` and `ffprobe.exe` installed through Settings, on `PATH`, or in the configured ffmpeg folder. They are intentionally not bundled.
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

## YouTube: setup summary

1. Install Firefox and sign into YouTube in a **regular window** using an account that can access the video. Chrome can stay open.
2. In Settings, enable Firefox cookies for YouTube, select a profile, and click **Resync cookies**. Selecting a different profile requires a new sync.
3. If YouTube requires authorization or the cookies have expired, follow the instructions in the failed queue item. After syncing, click **Retry download**. Cookies are never synced automatically, and downloads are never retried automatically.
4. Private videos and members-only content require an account with access. If advanced cookie options are specified, they take precedence over saved Firefox cookies.

For JavaScript support, click **Install / Update Deno** in Settings. Installation is for the current user and does not require administrator rights. Before reporting success, DuneDrop automatically refreshes `PATH` for subsequent downloader commands. Separately opened terminals must be reopened. Installation progress and errors appear in Logs. Also keep yt-dlp updated through Settings.

## Install FFmpeg for MP3 downloads

Open Settings and click **Install / Update FFmpeg**. The app downloads the latest Windows release essentials build from [Gyan](https://www.gyan.dev/ffmpeg/builds/), a Windows build provider linked by [FFmpeg](https://ffmpeg.org/download.html). It verifies the published SHA256 checksum and validates both `ffmpeg.exe` and `ffprobe.exe` before replacing them. Progress and errors appear in Logs, just like Deno. Installation is blocked during downloads or other tool maintenance.

Both tools are installed under `%LOCALAPPDATA%\FFmpeg` for the current user, without administrator rights. DuneDrop detects this folder immediately and passes it to yt-dlp, including argument previews and utility commands. A configured folder or explicit advanced `--ffmpeg-location` takes precedence. Clear the folder setting to use the installed tools. Failed downloads, checksum checks, validation, or replacement preserve the previous executables. Existing terminals need reopening to refresh user `PATH`.

For manual installation, close DuneDrop and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Install-FFmpeg.ps1
```

The script downloads the stable release from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), installs `ffmpeg.exe` and `ffprobe.exe` under `%LOCALAPPDATA%\FFmpeg`, adds that folder to the user `PATH`, and prints both installed versions.

The default installation folder is:

```text
%LOCALAPPDATA%\FFmpeg
```

## Update DuneDrop

In Settings, **DuneDrop updates → Check for updates** checks the latest published stable GitHub release. Checks and downloads happen only on request. Review the version and notes, click **Download update**, then **Update and restart**. Finish downloads and remove **all** queue items first, including completed items: queue history is not retained across restart. Settings, downloaded media, cookies, yt-dlp, FFmpeg, and Deno are preserved. The existing **Update yt-dlp** action is separate.

The app verifies a Minisign signature over the exact update metadata bytes and checks the executable against its signed SHA256 and size. Invalid, incomplete, unsupported-platform, and older updates are rejected. Downloads are staged in `%LOCALAPPDATA%\DuneDrop\updates` with current-user access. Cancelling deletes partial files; a blocked network read may take up to the network timeout before cancellation finishes.

Installation needs write access to the app's folder and free space for staging and backup. If the folder is read-only, choose **Save updated executable elsewhere**, select a **new filename**, and open that file manually. Existing files are never overwritten by this fallback. The portable executable can be renamed and placed in a path containing spaces.

A temporary helper replaces the executable only after DuneDrop exits. It keeps `<your-executable-name>.dunedrop-backup` next to the executable until the new app acknowledges startup. Failed replacement or startup restores the old version where possible. Startup acknowledgement detects launch failures, not every possible regression.

### Recover an interrupted update

Close every DuneDrop window and reopen the executable. An unfinished transaction is recovered rather than installed silently. A backup and transaction are retained if automatic recovery cannot safely finish. If the original executable is missing, or the app still cannot open:

1. Close DuneDrop and ensure its temporary helper is no longer running in Task Manager.
2. Find `<your-executable-name>.dunedrop-backup` beside the executable. Copy it to a separate safe location before changing anything, then restore it to the original executable name. Do not delete your only working copy.
3. Preserve `%LOCALAPPDATA%\DuneDrop\updates` for diagnosis. After restoring a working executable and preserving the backup, rename this **updates folder only** to `updates-recovery-backup` so the stale transaction is no longer retried.
4. Reopen DuneDrop and check for updates again. Do not remove the `auth` or `tools` folders.

### Publisher setup — manual actions required once

1. Confirm `vitkrv/dune-drop` and its release downloads are public. The updater does not embed an access token. Do not expose private source without reviewing it.
2. Generate a password-protected signing key outside the repository, in a private folder that already exists. Run from the repository root; Rust/MSVC prerequisites apply:

   ```powershell
   cargo run --manifest-path src-tauri/Cargo.toml --example release_sign -- generate "$env:USERPROFILE\dunedrop-update.key"
   ```

   Enter and confirm a nonempty password at the hidden prompts. Securely back up the `.key`, `.pub`, and password. Losing the private key prevents signing updates accepted by existing builds. Never commit the private key or send it through chat.
3. Copy **only the generated `.pub` contents** into `src-tauri/update-public-key.txt`. The committed `UNCONFIGURED` placeholder deliberately disables updates and prevents release publication. Include the public key in your reviewed implementation commit. Key rotation requires a separately planned migration; do not simply replace it for existing users.
4. In GitHub **Settings → Secrets and variables → Actions**, add `DUNEDROP_SIGNING_PRIVATE_KEY` containing the complete encrypted `.key` file and `DUNEDROP_SIGNING_PASSWORD` containing its password. Secrets are used only in the signing step, never printed or passed on the command line.
5. Enable Actions if necessary and allow the workflow's `contents: write` permission for draft releases. Review and merge the implementation before tagging. No paid update service or Windows publisher certificate is required; Windows Authenticode signing is separate from update authentication.

### Publish each version — manual actions

1. Edit `RELEASE_NOTES.md` with that version's notes. Choose a new stable semantic version and synchronize all manifests and lockfiles:

   ```powershell
   node scripts/release.mjs bump 1.1.0
   ```

2. Review and commit the changes, merge them into your release branch, then create and push the corresponding tag:

   ```powershell
   git tag v1.1.0
   git push origin v1.1.0
   ```

3. GitHub Actions validates matching versions, runs frontend/Rust and offline cookie/installer checks, builds the portable app, signs metadata, and uploads `DuneDrop.exe`, `update.json`, and `update.json.minisig` to a **draft release**. Checks fail closed; no stale artifact is published. Draft releases are not offered by the updater. Workflow actions are pinned to commit SHAs.
4. Download and smoke-test the draft executable on Windows 11. Verify Settings and downloader behavior, and test an update from the preceding updater-enabled version. Review all three assets and release notes, then **publish the draft as the latest stable release**. Do not edit signed metadata after signing.
5. For the **first updater-enabled release**, manually replace the old executable once. Subsequent versions can update through Settings.

The workflow deliberately leaves publication to you. This repository's automated native tests use disposable executable fixtures for replacement, startup acknowledgement, rollback, and cleanup, with sentinel files for unrelated state. They do not exercise a live GitHub download, a real WebView update between released versions, authenticated YouTube sessions, or online Deno installation. Run release-tooling checks locally with `node --test scripts/Test-Release.mjs`; they use temporary fixture manifests and leave the real versions unchanged.

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
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-FFmpegInstaller.ps1
```

These use synthetic cookies and fake local tools; they do not read your Firefox session, install Deno or FFmpeg, or change your user PATH.
