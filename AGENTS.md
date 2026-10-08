# Instructions for AI agents

## Project and scope

DuneDrop is a portable Windows 11 x64 desktop GUI for yt-dlp. The frontend uses React, TypeScript, and Vite; the native backend uses Rust and Tauri 2. The release artifact is `dist/DuneDrop.exe`.

- Read this file and the relevant source before editing. Follow more specific instructions in nested `AGENTS.md` files if present.
- Keep changes focused on the user request. Preserve existing work in the checkout; do not reset, discard, or overwrite unrelated changes.
- Preserve the sequential queue, MP4/MP3 presets, cancellation, saved-file reporting, and existing appearance unless the request changes them.
- Do not commit, push, publish, install user-wide tools, or modify the user's real browser sessions just to verify a code change unless that action is part of the request.
- Treat source code as the current implementation truth. Check official upstream documentation before changing assumptions about yt-dlp, YouTube, Firefox cookies, or Deno.

## Architecture

- `src/App.tsx`: application state, queue scheduling, Tauri commands/events, settings, and tool actions.
- `src/CookieControls.tsx` and `src/recovery.ts`: cookie controls, failed-download recovery panels, and recovery state helpers.
- `src/types.ts`: frontend settings, requests, responses, and event contracts.
- `src/settings.ts`: persistent settings and filtering of sensitive advanced options.
- `src/i18n.ts`: English and Ukrainian UI strings. Add every user-facing label, instruction, status, and error in both languages.
- `src/logs.ts`: terminal-output normalization. Preserve streaming behavior and carriage-return handling.
- `src/styles.css`: shared desktop styling and responsive layout.
- `src-tauri/src/lib.rs`: native commands, argument construction, tool management, process lifecycle, logs, and Windows Job Objects.
- `src-tauri/src/auth.rs`: Firefox discovery, cookie export/storage, per-job copies, and diagnostic classification.
- `src-tauri/src/runtime.rs`: Deno discovery, version validation, and runtime-option injection.
- `scripts/Install-Deno.ps1`: embedded installer helper. Rust includes its source at compile time; installer changes require rebuilding the app.
- `scripts/build.ps1`: dependency installation, icon generation, tests, release build, and portable artifact copying.

When changing a Tauri interface, update Rust serialization, TypeScript types, every caller, and relevant tests together. Contracts use camelCase. Default new persisted settings so older settings files continue to load.

## Downloader and process rules

- Execute yt-dlp with an argument array, without a shell. Keep URL arguments behind `--` and preserve Windows paths containing spaces.
- Preserve advanced-mode acknowledgement for dangerous options and the filtering of sensitive persisted values. Do not persist passwords, two-factor values, or raw argument text.
- Keep argument previews consistent with execution, including managed cookies, runtime defaults, and explicit advanced overrides. Previewing must not create cookie exports or start downloads.
- Preserve streaming stdout/stderr and per-job event identity. Keep diagnostic capture bounded and handle terminal escapes and split messages.
- Preserve Windows Job Object cancellation so child processes such as ffmpeg terminate too. Clean temporary files on completion, cancellation, and failure.
- Coordinate downloads, tool replacement, updates, and Deno installation so executables cannot be replaced while downloader processes use them. Do not introduce automatic retries or change queue scheduling unintentionally.
- The bundled `src-tauri/resources/bin/yt-dlp.exe` is extracted to `%LOCALAPPDATA%\DuneDrop\tools`. Do not automatically overwrite an existing extracted downloader or update the bundled binary as an unrelated change.
- FFmpeg and ffprobe are external dependencies. Preserve configured-folder and PATH detection; MP3 requires both.

## Firefox cookies and recovery

- Managed cookies are opt-in and refreshed only by an explicit resync action. Chrome can remain open; do not bypass Chrome encryption or modify browser security settings.
- Discover standard and Microsoft Store Firefox profiles, including registered custom paths. Automatically select only a sole discovered profile; otherwise require a selection. Keep custom-folder selection available.
- Export through yt-dlp without network extraction or media downloads. Validate Netscape format and retain only unexpired YouTube-domain cookies, including supported HttpOnly records. Reject lookalike domains.
- Keep cookie values in backend-managed files under `%LOCALAPPDATA%\DuneDrop\auth` with protected current-user access. Never send their contents to the frontend, settings store, logs, fixtures, or repository.
- Stage exports and atomically replace the saved snapshot only after successful validation. Failed syncs preserve the last successful snapshot and timestamp. Changing profiles requires a matching successful sync before use.
- Give each download a disposable cookie copy. Resync and clear operations must not alter an active job's copy. Prevent duplicate syncs and clean intermediate exports.
- Explicit advanced cookie options override managed cookies. Explain that precedence in recovery UI and link to the relevant options.
- Classify cookie/authorization failures only for failed, non-cancelled YouTube jobs. Successful jobs with warnings must not show recovery prompts.
- Recognize sign-in, bot-verification, age-confirmation, and explicit invalid/expired-cookie errors conservatively. Generic HTTP 403, network, unavailable-format, JavaScript-runtime/challenge, and PO-token errors are insufficient evidence of stale cookies.
- Explain that private and members-only content requires account access. A sync timestamp proves cookies were copied, not that login or content access succeeded.
- Keep recovery attached to the failed item across tab changes. Offer setup when unconfigured, otherwise resync, settings, and logs. Show sync failures inline and offer explicit retry after successful sync. Do not automatically refresh cookies or retry.

## Deno installation

- Use official stable Windows x64 Deno release assets. Verify the published SHA256 digest and validate the executable/version before replacing an existing installation.
- Install for the current user in `%USERPROFILE%\.deno\bin`, respecting `DENO_INSTALL`. Preserve an existing working executable on download, checksum, or validation failure.
- Preserve user PATH entries and avoid duplicates. No administrator rights or machine-wide PATH changes. Existing terminals may need reopening.
- Detect the installed executable immediately and pass its absolute path with `--js-runtimes deno:<path>`. Explicit runtime arguments override defaults. Apply the same rule to utility commands.
- The current minimum is Deno 2.3.0; verify upstream requirements before changing it. Official yt-dlp executables include EJS scripts; do not enable remote solver downloads without a requirement.
- Run installation asynchronously with a hidden console, progress/log output, duplicate-operation protection, and actionable localized errors. Preserve cleanup and maintenance guards on failure.
- Keep PowerShell helpers compatible with Windows PowerShell 5.1. Avoid inheriting incompatible PowerShell module paths when launching helpers from Rust.

## Verification

Run checks appropriate to the change. Documentation-only edits do not require builds. For application behavior changes, run the frontend tests, Rust tests, and production frontend build:

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

For cookie or installer changes, also run the offline checks:

```powershell
python scripts/Test-CookieExport.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Test-DenoInstaller.ps1
```

These checks use synthetic cookies and a fake runtime. They must not read real browser sessions, install Deno, or change user PATH. Test relevant failure paths: invalid/empty exports, profile mismatch, failed-sync preservation, cleanup, argument overrides, authorization classification, installer validation, repeated installation, and paths containing spaces.

For requested release delivery, use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1
```

This script refreshes dependencies, regenerates icons, and clears `dist` before copying the portable executable. Review generated changes and preserve unrelated files.

If npm is unavailable but Node and dependencies exist, use direct local CLIs:

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle --config '{"build":{"beforeBuildCommand":""}}'
```

Run the TypeScript and Vite commands successfully before the Tauri fallback, which skips its normal frontend build hook. Cargo must be on PATH; Windows release builds require the MSVC C++ toolchain. Locate available tool executables rather than hardcoding another user's installation paths. Stop after failed prerequisites instead of packaging stale output. Copy a successfully built `src-tauri/target/release/dunedrop.exe` to `dist/DuneDrop.exe` when using the fallback for release delivery.

Check the final diff for unintended changes and whitespace errors. Do not commit generated build directories, real cookies, credentials, or temporary exports. Review intentional lockfile changes when dependencies change.

## Completion report

State what changed, which checks passed, and any checks that remain unverified. Distinguish synthetic/offline tests from live authenticated YouTube downloads and online Deno installation. Do not claim native UI, browser-session, or network validation without performing it. Link the portable executable when a release was produced, and update README setup/troubleshooting guidance when user workflows change.
