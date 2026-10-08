use serde::Serialize;
use std::{env, ffi::{OsStr, OsString}, path::{Path, PathBuf}, sync::{OnceLock, RwLock}};
use crate::{command_output, find_executable};

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DenoInfo { pub path: Option<String>, pub version: Option<String>, pub available: bool }

static REFRESHED_DENO_DIRECTORY: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn merged_path(existing: &OsStr, directory: &Path) -> Result<OsString, String> {
    let normalized = |path: &Path| path.to_string_lossy().trim_end_matches(['\\', '/']).to_ascii_lowercase();
    let directory_key = normalized(directory);
    let paths = std::iter::once(directory.to_owned()).chain(env::split_paths(existing).filter(|path| normalized(path) != directory_key));
    env::join_paths(paths).map_err(|_| "deno_refresh_failed".into())
}

pub fn child_path() -> Option<OsString> {
    let directory = REFRESHED_DENO_DIRECTORY.get()?.read().ok()?.clone()?;
    merged_path(&env::var_os("PATH").unwrap_or_default(), &directory).ok()
}

pub fn refresh_environment() -> Result<(), String> {
    let info = detect();
    if !info.available { return Err("deno_refresh_failed".into()); }
    let directory = PathBuf::from(info.path.ok_or("deno_refresh_failed")?).parent().ok_or("deno_refresh_failed")?.to_owned();
    merged_path(&env::var_os("PATH").unwrap_or_default(), &directory)?;
    *REFRESHED_DENO_DIRECTORY.get_or_init(|| RwLock::new(None)).write().map_err(|_| "deno_refresh_failed")? = Some(directory);
    Ok(())
}

pub fn supported_version(version: &str) -> bool {
    // Deno appends release/build details after the semantic version.
    let Some(version) = version.split_whitespace().next() else { return false; };
    let Ok(parts) = version.split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>() else { return false; };
    parts.len() == 3 && (parts[0] > 2 || parts[0] == 2 && parts[1] >= 3)
}

pub fn detect() -> DenoInfo {
    let root = env::var_os("DENO_INSTALL").map(PathBuf::from).or_else(|| env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join(".deno")));
    let mut candidates: Vec<PathBuf> = root.map(|p| vec![p.join("bin/deno.exe")]).unwrap_or_default();
    if let Some(path) = find_executable("deno.exe") { candidates.push(path); }
    detect_candidates(candidates)
}

fn detect_candidates(candidates: Vec<PathBuf>) -> DenoInfo {
    let mut invalid = DenoInfo::default();
    for path in candidates {
        if !path.is_file() { continue; }
        if let Ok(output) = command_output(&path, &["--version"]) {
            let version = String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or_default().strip_prefix("deno ").unwrap_or_default().to_owned();
            let available = output.status.success() && supported_version(&version);
            let info = DenoInfo { path: Some(path.to_string_lossy().into_owned()), version: Some(version), available };
            if available { return info; } invalid = info;
        }
    }
    invalid
}

pub fn has_option(args: &[String], flags: &[&str]) -> bool {
    args.iter().take_while(|a| a.as_str() != "--").any(|a| flags.contains(&a.split('=').next().unwrap_or(a)))
}

pub fn add_deno(args: &mut Vec<String>, deno: &DenoInfo) {
    if !has_option(args, &["--js-runtimes", "--no-js-runtimes"]) && deno.available {
        if let Some(path) = &deno.path { args.extend(["--js-runtimes".into(), format!("deno:{path}")]); }
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn refreshed_path_preserves_entries_and_prioritizes_deno_without_duplicates() {
        let existing = env::join_paths([r"C:\Other Tools", r"C:\USER\Deno\bin\", r"C:\Windows"]).unwrap();
        let refreshed = merged_path(&existing, Path::new(r"C:\User\Deno\bin")).unwrap();
        let paths: Vec<_> = env::split_paths(&refreshed).collect();
        assert_eq!(paths, vec![PathBuf::from(r"C:\User\Deno\bin"), PathBuf::from(r"C:\Other Tools"), PathBuf::from(r"C:\Windows")]);
        assert_eq!(merged_path(&refreshed, Path::new(r"C:\User\Deno\bin")).unwrap(), refreshed);
        assert_eq!(env::split_paths(&merged_path(OsStr::new(""), Path::new(r"C:\Deno")).unwrap()).next().unwrap(), PathBuf::from(r"C:\Deno"));
    }
    #[test] fn version_and_override() {
        assert!(!supported_version("2.2.9")); assert!(supported_version("2.3.0")); assert!(supported_version("3.0.0")); assert!(!supported_version("invalid"));
        let info = DenoInfo { path: Some(r"C:\User Tools\deno.exe".into()), version: Some("2.3.0".into()), available: true };
        let mut args = vec!["--simulate".into()]; add_deno(&mut args, &info); assert_eq!(args[2], r"deno:C:\User Tools\deno.exe");
        for flag in ["--js-runtimes=node", "--no-js-runtimes"] { let mut args = vec![flag.into()]; add_deno(&mut args, &info); assert_eq!(args.len(), 1); }
        assert!(has_option(&["--cookies=x".into()], &["--cookies"]));
        assert!(!has_option(&["--".into(), "--cookies".into()], &["--cookies"]));
    }
    #[test] fn version_support_accepts_release_details_without_skipping_invalid_components() {
        assert!(supported_version("2.9.7 (stable, release, x86_64-pc-windows-msvc)"));
        assert!(supported_version("2.3.0 (stable, release, x86_64-pc-windows-msvc)"));
        assert!(!supported_version("2.2.9 (stable, release, x86_64-pc-windows-msvc)"));
        for invalid in ["", "2.9", "2.invalid.9.7", "2.9.7.1"] { assert!(!supported_version(invalid), "{invalid}"); }
    }
    #[cfg(windows)]
    #[test] fn detects_valid_runtime_with_spaces_and_falls_back_from_old_version() {
        let base = crate::auth::TempFile::new(&env::temp_dir(), "runtime test"); std::fs::create_dir(&base.0).unwrap();
        let old = base.0.join("old deno.cmd"); let valid = base.0.join("valid deno.cmd");
        std::fs::write(&old, "@echo off\r\necho deno 2.2.0\r\nexit /b 0\r\n").unwrap();
        std::fs::write(&valid, "@echo off\r\necho deno 2.9.7 (stable, release, x86_64-pc-windows-msvc)\r\nexit /b 0\r\n").unwrap();
        let info = detect_candidates(vec![old.clone(), valid.clone()]); assert!(info.available); assert_eq!(info.path.unwrap(), valid.to_string_lossy());
        assert_eq!(info.version.as_deref(), Some("2.9.7 (stable, release, x86_64-pc-windows-msvc)"));
        assert!(!detect_candidates(vec![old]).available);
        assert!(!detect_candidates(vec![base.0.join("missing.exe")]).available);
        std::fs::remove_dir_all(&base.0).unwrap();
    }
}
