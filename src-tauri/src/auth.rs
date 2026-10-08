use serde::{Deserialize, Serialize};
use std::{env, fs, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};
use crate::{command_output, NoWindowCommand};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirefoxProfile { pub name: String, pub path: String }

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieStatus { pub profile: Option<String>, pub synced_at: Option<u64> }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot { profile: String, synced_at: u64, cookies: String }

pub fn discover_profiles() -> Vec<FirefoxProfile> {
    let mut roots = Vec::new();
    if let Some(root) = env::var_os("APPDATA") { roots.push(PathBuf::from(root).join("Mozilla/Firefox")); }
    if let Some(root) = env::var_os("LOCALAPPDATA") { roots.push(PathBuf::from(root).join("Packages/Mozilla.Firefox_n80bbvh6b1yt2/LocalCache/Roaming/Mozilla/Firefox")); }
    discover_in(roots)
}

fn discover_in(roots: Vec<PathBuf>) -> Vec<FirefoxProfile> {
    let mut profiles = Vec::new();
    for root in roots {
        // profiles.ini also lists profiles stored outside the default Profiles folder.
        if let Ok(ini) = fs::read_to_string(root.join("profiles.ini")) {
            for section in ini.split('[') {
                let value = |key: &str| section.lines().find_map(|line| line.trim().strip_prefix(key).map(str::to_owned));
                if let Some(path) = value("Path=") {
                    let path = if value("IsRelative=").as_deref() == Some("0") { PathBuf::from(path) } else { root.join(path) };
                    push_profile(&mut profiles, path, value("Name="));
                }
            }
        }
        if let Ok(entries) = fs::read_dir(root.join("Profiles")) {
            for entry in entries.flatten() { push_profile(&mut profiles, entry.path(), None); }
        }
    }
    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    profiles
}

fn push_profile(profiles: &mut Vec<FirefoxProfile>, path: PathBuf, name: Option<String>) {
    if !path.join("cookies.sqlite").is_file() { return; }
    let Ok(path) = fs::canonicalize(path) else { return; };
    let text = path.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
    if profiles.iter().any(|p| p.path.eq_ignore_ascii_case(&text)) { return; }
    profiles.push(FirefoxProfile { name: name.unwrap_or_else(|| path.file_name().unwrap_or_default().to_string_lossy().into_owned()), path: text });
}

pub fn private_dir(base: &Path) -> Result<PathBuf, String> {
    let dir = base.join("auth");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)] {
        // Set a protected ACL before any cookie contents are written.
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $p=$env:DUNEDROP_AUTH_DIR; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)"])
            .env_remove("PSModulePath")
            .env("DUNEDROP_AUTH_DIR", &dir).creation_flags_no_window().output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            #[cfg(test)] eprintln!("Cookie ACL diagnostic: {}", String::from_utf8_lossy(&output.stderr));
            return Err("cookie_storage_failed".into());
        }
    }
    Ok(dir)
}

pub struct TempFile(pub PathBuf);
impl TempFile {
    pub fn new(dir: &Path, extension: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        Self(dir.join(format!("temp-{}-{nanos}-{}.{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed), extension)))
    }
}
impl Drop for TempFile { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }

pub fn filter_cookies(text: &str, now: u64) -> Result<String, String> {
    if !matches!(text.lines().next(), Some("# Netscape HTTP Cookie File" | "# HTTP Cookie File")) { return Err("cookie_invalid_export".into()); }
    let mut result = String::from("# Netscape HTTP Cookie File\n");
    let mut count = 0;
    for line in text.lines().skip(1) {
        if line.starts_with('#') && !line.starts_with("#HttpOnly_") || line.trim().is_empty() { continue; }
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 7 { return Err("cookie_invalid_export".into()); }
        let domain = fields[0].trim_start_matches("#HttpOnly_").trim_start_matches('.').to_ascii_lowercase();
        if domain != "youtube.com" && !domain.ends_with(".youtube.com") { continue; }
        if !matches!(fields[1], "TRUE" | "FALSE") || !matches!(fields[3], "TRUE" | "FALSE") || !fields[2].starts_with('/') || fields[5].is_empty() { return Err("cookie_invalid_export".into()); }
        let expiry: u64 = fields[4].parse().map_err(|_| "cookie_invalid_export")?;
        if expiry != 0 && expiry <= now { continue; }
        result.push_str(line); result.push('\n'); count += 1;
    }
    if count == 0 { return Err("cookie_no_youtube".into()); }
    Ok(result)
}

fn read_snapshot(dir: &Path) -> Option<Snapshot> {
    serde_json::from_slice(&fs::read(dir.join("youtube.json")).ok()?).ok()
}
pub fn status(dir: &Path) -> CookieStatus {
    read_snapshot(dir).map(|s| CookieStatus { profile: Some(s.profile), synced_at: Some(s.synced_at) }).unwrap_or_default()
}
pub fn clear(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join("youtube.json")) { Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(e) => Err(e.to_string()) }
}

pub fn sync(dir: &Path, executable: &Path, profile: &str) -> Result<CookieStatus, String> {
    if !Path::new(profile).join("cookies.sqlite").is_file() { return Err("cookie_profile_missing".into()); }
    let exported = TempFile::new(dir, "txt");
    let local_info = TempFile::new(dir, "json");
    fs::write(&local_info.0, r#"{"id":"cookie-sync","title":"Cookie sync","formats":[{"url":"https://example.invalid/cookie-sync.mp4","ext":"mp4","format_id":"sync"}]}"#).map_err(|e| e.to_string())?;
    // Simulate a complete local info record, without format checks or network extraction.
    let output = command_output(executable, &["--ignore-config", "--no-plugin-dirs", "--cookies-from-browser", &format!("firefox:{profile}"), "--cookies", &exported.0.to_string_lossy(), "--simulate", "--skip-download", "--no-check-formats", "--load-info-json", &local_info.0.to_string_lossy()])?;
    if !output.status.success() { return Err("cookie_extract_failed".into()); }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let cookies = filter_cookies(&fs::read_to_string(&exported.0).map_err(|_| "cookie_invalid_export")?, now)?;
    let snapshot = Snapshot { profile: profile.to_owned(), synced_at: now, cookies };
    let staged = TempFile::new(dir, "json");
    fs::write(&staged.0, serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    atomic_replace(&staged.0, &dir.join("youtube.json"))?;
    Ok(status(dir))
}

fn atomic_replace(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        Ok(())
    }
    #[cfg(not(windows))] { fs::rename(source, target).map_err(|e| e.to_string()) }
}

pub fn job_copy(dir: &Path, profile: &str) -> Result<TempFile, String> {
    let snapshot = read_snapshot(dir).ok_or("cookie_sync_required")?;
    if !snapshot.profile.eq_ignore_ascii_case(profile) { return Err("cookie_sync_required".into()); }
    let temp = TempFile::new(dir, "txt");
    fs::write(&temp.0, snapshot.cookies).map_err(|e| e.to_string())?;
    Ok(temp)
}

pub fn is_youtube(url: &str) -> bool {
    tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .map(|h| h == "youtu.be" || h == "youtube.com" || h.ends_with(".youtube.com") || h == "youtube-nocookie.com" || h.ends_with(".youtube-nocookie.com")).unwrap_or(false)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryReason { Authorization, AccountAccess, RuntimeUnsupported }

#[derive(Default)]
pub struct Diagnostics { text: String, escape: u8 }
impl Diagnostics {
    pub fn push(&mut self, chunk: &str) {
        for ch in chunk.chars() {
            match self.escape {
                1 => { self.escape = if ch == '[' { 2 } else { 0 }; continue; },
                2 => { if ('@'..='~').contains(&ch) { self.escape = 0; } continue; },
                _ => (),
            }
            if ch == '\x1b' { self.escape = 1; }
            else if ch == '\r' { self.text.push('\n'); }
            else if ch == '\n' || !ch.is_control() { self.text.push(ch); }
        }
        if self.text.len() > 65536 {
            let mut start = self.text.len() - 65536;
            while !self.text.is_char_boundary(start) { start += 1; }
            self.text.drain(..start);
        }
    }
    pub fn recovery(&self, youtube: bool, success: bool, cancelled: bool) -> Option<RecoveryReason> {
        if success || cancelled { return None; }
        let text = self.text.to_lowercase().replace('’', "'");
        if text.lines().any(|l| l.contains("no such option") && l.contains("--js-runtimes")) { return Some(RecoveryReason::RuntimeUnsupported); }
        if !youtube { return None; }
        for line in text.lines().filter(|line| line.trim_start().starts_with("error:")) {
            if line.contains("private video") || line.contains("members-only") || line.contains("join this channel") || line.contains("members of this channel") { return Some(RecoveryReason::AccountAccess); }
            if line.contains("sign in") || line.contains("sign-in") || line.contains("login required") || line.contains("log in") || line.contains("confirm your age") || line.contains("authentication required") || (line.contains("cookie") && ["expired", "invalid", "no longer valid", "rotated"].iter().any(|s| line.contains(s))) { return Some(RecoveryReason::Authorization); }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn filters_domains_expiry_and_httponly() {
        let text = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t9999\tSID\tsecret\n#HttpOnly_www.youtube.com\tFALSE\t/\tTRUE\t0\tSSID\tsecret\n.evil-youtube.com\tTRUE\t/\tTRUE\t0\tx\ty\n.google.com\tTRUE\t/\tTRUE\t0\tx\ty\n.youtube.com\tTRUE\t/\tTRUE\t1\told\ty\n";
        let result = filter_cookies(text, 100).unwrap();
        assert!(result.contains("SSID")); assert!(!result.contains("google")); assert!(!result.contains("evil")); assert!(!result.contains("old"));
        assert!(filter_cookies("invalid", 0).is_err());
        assert!(filter_cookies("# Netscape HTTP Cookie File\n", 0).is_err());
    }
    #[test] fn diagnostics_recover_only_relevant_failures() {
        let mut d = Diagnostics::default();
        d.push("\x1b[31mERR"); d.push("OR:\x1b[0m [youtube] Sign in to confirm you're not a bot\n");
        assert_eq!(d.recovery(true, false, false), Some(RecoveryReason::Authorization));
        assert_eq!(d.recovery(true, true, false), None); assert_eq!(d.recovery(true, false, true), None); assert_eq!(d.recovery(false, false, false), None);
        for message in ["ERROR: HTTP Error 403: Forbidden", "ERROR: Video unavailable", "ERROR: PO Token required", "ERROR: JavaScript challenge failed", "ERROR: No supported JavaScript runtime", "WARNING: cookies have expired\nERROR: network timeout"] {
            let mut d = Diagnostics::default(); d.push(message); assert_eq!(d.recovery(true, false, false), None, "{message}");
        }
        for message in ["ERROR: cookies are no longer valid", "ERROR: Sign in to confirm your age", "ERROR: Login required"] {
            let mut d = Diagnostics::default(); d.push(message); assert_eq!(d.recovery(true, false, false), Some(RecoveryReason::Authorization));
        }
        let mut d = Diagnostics::default(); d.push("ERROR: Private video. Sign in"); assert_eq!(d.recovery(true, false, false), Some(RecoveryReason::AccountAccess));
    }
    #[test] fn youtube_host_validation() { assert!(is_youtube("https://youtu.be/abc")); assert!(is_youtube("https://www.youtube.com/watch?v=x")); assert!(!is_youtube("https://youtube.com.evil.test")); }
    #[test] fn bounded_diagnostics() { let mut d = Diagnostics::default(); d.push(&"ї".repeat(70000)); assert!(d.text.len() <= 65536); }
    #[test] fn snapshot_copy_and_failure_preservation() {
        let dir = TempFile::new(&env::temp_dir(), "dir"); fs::create_dir(&dir.0).unwrap();
        let snapshot = Snapshot { profile: "profile".into(), synced_at: 1, cookies: "original".into() };
        fs::write(dir.0.join("youtube.json"), serde_json::to_vec(&snapshot).unwrap()).unwrap();
        assert!(job_copy(&dir.0, "other").is_err());
        let copy = job_copy(&dir.0, "profile").unwrap(); fs::write(&copy.0, "changed").unwrap();
        assert_eq!(read_snapshot(&dir.0).unwrap().cookies, "original");
        assert!(sync(&dir.0, Path::new("missing.exe"), "missing").is_err()); assert_eq!(status(&dir.0).synced_at, Some(1));
        let path = copy.0.clone(); drop(copy); assert!(!path.exists());
        clear(&dir.0).unwrap(); fs::remove_dir(&dir.0).unwrap();
    }
    #[test] fn discovers_registered_and_store_style_profiles_without_duplicates() {
        let base = TempFile::new(&env::temp_dir(), "profiles");
        let classic = base.0.join("classic"); let store = base.0.join("store");
        fs::create_dir_all(classic.join("Profiles/default")).unwrap(); fs::create_dir_all(store.join("Profiles/store")).unwrap();
        fs::write(classic.join("Profiles/default/cookies.sqlite"), "").unwrap(); fs::write(store.join("Profiles/store/cookies.sqlite"), "").unwrap();
        fs::write(classic.join("profiles.ini"), "[Profile0]\nName=Personal\nIsRelative=1\nPath=Profiles/default\n").unwrap();
        let profiles = discover_in(vec![classic, store]);
        assert_eq!(profiles.len(), 2); assert!(profiles.iter().any(|p| p.name == "Personal"));
        fs::remove_dir_all(&base.0).unwrap();
    }
    #[test] fn protected_storage_and_atomic_replacement() {
        let base = TempFile::new(&env::temp_dir(), "private");
        let dir = private_dir(&base.0).unwrap();
        let target = dir.join("youtube.json"); let staged = TempFile::new(&dir, "json");
        fs::write(&target, "old").unwrap(); fs::write(&staged.0, "new").unwrap();
        atomic_replace(&staged.0, &target).unwrap(); assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(atomic_replace(&dir.join("missing"), &target).is_err()); assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        #[cfg(windows)] {
            let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "$a=[IO.Directory]::GetAccessControl($env:DUNEDROP_AUTH_DIR); if (-not $a.AreAccessRulesProtected -or $a.Access.Count -ne 1 -or $a.Access[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { exit 1 }"]).env_remove("PSModulePath").env("DUNEDROP_AUTH_DIR", &dir).creation_flags_no_window().output().unwrap();
            assert!(output.status.success(), "Cookie directory must grant access only to the current user");
        }
        fs::remove_dir_all(&base.0).unwrap();
    }
}
