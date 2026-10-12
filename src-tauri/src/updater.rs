//! Portable updates. Only authenticated metadata can select an executable.
use crate::{MaintenanceGuard, NoWindowCommand, ProcessManager};
use fs2::FileExt;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, process::{Child, Command}, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager, State};

const ENDPOINT: &str = "https://github.com/vitkrv/dune-drop/releases/latest/download/update.json";
const PUBLIC_KEY: &str = include_str!("../update-public-key.txt");
const MAX_METADATA: u64 = 64 * 1024;
const MAX_ARTIFACT: u64 = 512 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;
fn io_error(_: impl std::fmt::Display) -> String { "appUpdateIo".into() }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub version: String,
    pub platform: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub notes: String,
}
#[derive(Clone)]
struct Verified { manifest: Manifest, bytes: Vec<u8>, signature: String }
#[derive(Default)]
pub struct UpdateState {
    operation: Mutex<()>,
    verified: Mutex<Option<Verified>>,
    cancelled: AtomicBool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo { current_version: String, update: Option<Manifest>, recovery: bool }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { downloaded: u64, total: u64 }

fn root() -> Result<PathBuf> {
    static ROOT: std::sync::OnceLock<Result<PathBuf>> = std::sync::OnceLock::new();
    ROOT.get_or_init(secure_root).clone()
}
fn secure_root() -> Result<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("appUpdateIo")?).join("DuneDrop/updates");
    fs::create_dir_all(&dir).map_err(io_error)?;
    #[cfg(windows)] {
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $p=$env:DUNEDROP_UPDATES_DIR; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($sid); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)"])
            .env_remove("PSModulePath").env("DUNEDROP_UPDATES_DIR", &dir).creation_flags_no_window().output().map_err(io_error)?;
        if !output.status.success() { return Err("appUpdateIo".into()); }
    }
    Ok(dir)
}
fn lock_root(dir: &Path) -> Result<File> {
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(dir.join("operation.lock")).map_err(io_error)?;
    file.try_lock_exclusive().map_err(|_| "appUpdateBusy".to_owned())?;
    Ok(file)
}
fn parse_key(key: &str) -> Result<PublicKey> {
    let base64 = key.lines().find(|s| s.starts_with("RW")).ok_or("appUpdateUnconfigured")?;
    PublicKey::from_base64(base64.trim()).map_err(|_| "appUpdateUnconfigured".into())
}
fn authenticate(bytes: &[u8], signature: &str, key: &str) -> Result<Manifest> {
    if bytes.len() as u64 > MAX_METADATA || signature.len() > 4096 { return Err("appUpdateInvalid".into()); }
    let signature = Signature::decode(signature).map_err(|_| "appUpdateSignature")?;
    parse_key(key)?.verify(bytes, &signature, false).map_err(|_| "appUpdateSignature")?;
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|_| "appUpdateInvalid")?;
    validate(&manifest)?;
    Ok(manifest)
}
fn validate(m: &Manifest) -> Result<()> {
    let version = semver::Version::parse(&m.version).map_err(|_| "appUpdateInvalid")?;
    if m.schema_version != 1 || m.platform != "windows-x86_64" || !version.pre.is_empty() || !version.build.is_empty()
        || m.size == 0 || m.size > MAX_ARTIFACT || m.sha256.len() != 64 || !m.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("appUpdateInvalid".into());
    }
    let expected = format!("https://github.com/vitkrv/dune-drop/releases/download/v{}/DuneDrop.exe", m.version);
    if m.url != expected { return Err("appUpdateInvalid".into()); }
    Ok(())
}
fn newer(version: &str, current: &str) -> Result<bool> {
    Ok(semver::Version::parse(version).map_err(|_| "appUpdateInvalid")? > semver::Version::parse(current).map_err(|_| "appUpdateInvalid")?)
}
fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder().user_agent("DuneDrop-updater")
        .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let host = attempt.url().host_str().unwrap_or("");
            if attempt.previous().len() >= 8 || attempt.url().scheme() != "https" || !(host == "github.com" || host == "release-assets.githubusercontent.com" || host == "objects.githubusercontent.com") {
                attempt.error("Unexpected update redirect")
            } else { attempt.follow() }
        })).build().map_err(|_| "appUpdateNetwork".into())
}
fn fetch(client: &reqwest::blocking::Client, url: &str, limit: u64) -> Result<Vec<u8>> {
    let response = client.get(url).send().and_then(|r| r.error_for_status()).map_err(|_| "appUpdateNetwork")?;
    let mut bytes = Vec::new();
    response.take(limit + 1).read_to_end(&mut bytes).map_err(|_| "appUpdateNetwork")?;
    if bytes.len() as u64 > limit { return Err("appUpdateInvalid".into()); }
    Ok(bytes)
}
fn verify_file(path: &Path, m: &Manifest) -> Result<()> {
    if fs::metadata(path).map_err(io_error)?.len() != m.size { return Err("appUpdateIntegrity".into()); }
    if hash_file(path)? != m.sha256.to_ascii_lowercase() { return Err("appUpdateIntegrity".into()); }
    Ok(())
}
fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(io_error)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop { let n = file.read(&mut buffer).map_err(io_error)?; if n == 0 { break; } hash.update(&buffer[..n]); }
    Ok(format!("{:x}", hash.finalize()))
}

#[tauri::command]
pub fn app_update_info() -> Result<UpdateInfo> {
    Ok(UpdateInfo { current_version: env!("CARGO_PKG_VERSION").into(), update: None, recovery: root()?.join("recovery.txt").exists() })
}
#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<UpdateInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<UpdateState>();
        let _operation = state.operation.try_lock().map_err(|_| "appUpdateBusy")?;
        *state.verified.lock().map_err(io_error)? = None;
        parse_key(PUBLIC_KEY)?;
        let http = client()?;
        let bytes = fetch(&http, ENDPOINT, MAX_METADATA)?;
        let signature = String::from_utf8(fetch(&http, &format!("{ENDPOINT}.minisig"), 4096)?).map_err(|_| "appUpdateInvalid")?;
        let manifest = authenticate(&bytes, &signature, PUBLIC_KEY)?;
        let mut info = app_update_info()?;
        if newer(&manifest.version, &info.current_version)? {
            info.update = Some(manifest.clone());
            *state.verified.lock().map_err(io_error)? = Some(Verified { manifest, bytes, signature });
        }
        Ok(info)
    }).await.map_err(io_error)?
}

#[tauri::command]
pub fn cancel_app_update(state: State<'_, UpdateState>) { state.cancelled.store(true, Ordering::SeqCst); }

fn copy_stream(mut input: impl Read, mut output: impl Write, total: u64, cancel: &AtomicBool, mut progress: impl FnMut(u64)) -> Result<()> {
    let mut received = 0;
    let mut buffer = [0u8; 65536];
    loop {
        if cancel.load(Ordering::SeqCst) { return Err("appUpdateCancelled".into()); }
        let n = input.read(&mut buffer).map_err(|_| "appUpdateNetwork")?;
        if n == 0 { break; }
        received += n as u64;
        if received > total { return Err("appUpdateIntegrity".into()); }
        output.write_all(&buffer[..n]).map_err(io_error)?;
        progress(received);
    }
    if received != total { return Err("appUpdateIntegrity".into()); }
    Ok(())
}
#[tauri::command]
pub async fn download_app_update(app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<UpdateState>();
        let _operation = state.operation.try_lock().map_err(|_| "appUpdateBusy")?;
        let dir = root()?;
        let _lock = lock_root(&dir)?;
        if dir.join("transaction.json").exists() { return Err("appUpdateRecovery".into()); }
        state.cancelled.store(false, Ordering::SeqCst);
        let verified = state.verified.lock().map_err(io_error)?.clone().ok_or("appUpdateCheckFirst")?;
        let path = dir.join("download.exe");
        let temp = crate::auth::TempFile::new(&dir, "part");
        let _ = fs::remove_file(&path);
        let response = client()?.get(&verified.manifest.url).send().and_then(|r| r.error_for_status()).map_err(|_| "appUpdateNetwork")?;
        let mut file = File::create(&temp.0).map_err(io_error)?;
        copy_stream(response, &mut file, verified.manifest.size, &state.cancelled, |downloaded| {
            let _ = app.emit("app-update-progress", Progress { downloaded, total: verified.manifest.size });
        })?;
        file.sync_all().map_err(io_error)?; drop(file);
        verify_file(&temp.0, &verified.manifest)?;
        if state.cancelled.load(Ordering::SeqCst) { return Err("appUpdateCancelled".into()); }
        fs::rename(&temp.0, path).map_err(io_error)?;
        Ok(())
    }).await.map_err(io_error)?
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transaction {
    target: PathBuf,
    original_sha256: String,
    parent_pid: u32,
    manifest: Vec<u8>,
    signature: String,
    phase: String,
}
fn backup(t: &Transaction) -> PathBuf { t.target.with_file_name(format!("{}.dunedrop-backup", t.target.file_name().unwrap().to_string_lossy())) }
fn sibling(t: &Transaction) -> PathBuf { t.target.with_file_name(format!("{}.dunedrop-new", t.target.file_name().unwrap().to_string_lossy())) }
fn write_transaction(dir: &Path, t: &Transaction) -> Result<()> {
    let temp = dir.join("transaction.tmp");
    let mut file = File::create(&temp).map_err(io_error)?;
    file.write_all(&serde_json::to_vec(t).map_err(io_error)?).map_err(io_error)?;
    file.sync_all().map_err(io_error)?; drop(file);
    crate::auth::atomic_replace(&temp, &dir.join("transaction.json")).map_err(io_error)
}
fn read_transaction(dir: &Path) -> Result<Transaction> {
    let bytes = File::open(dir.join("transaction.json")).map_err(io_error)?;
    let mut data = Vec::new(); bytes.take(MAX_METADATA * 4).read_to_end(&mut data).map_err(io_error)?;
    let t: Transaction = serde_json::from_slice(&data).map_err(io_error)?;
    if !t.target.is_absolute() || t.target.file_name().is_none() { return Err("appUpdateInvalid".into()); }
    Ok(t)
}
fn preflight(t: &Transaction, size: u64) -> Result<()> {
    let parent = t.target.parent().ok_or("appUpdateIo")?;
    if backup(t).exists() || sibling(t).exists() { return Err("appUpdateRecovery".into()); }
    if fs2::available_space(parent).map_err(io_error)? < size.saturating_mul(2) + 16 * 1024 * 1024 { return Err("appUpdateDisk".into()); }
    let probe = crate::auth::TempFile::new(parent, "probe");
    OpenOptions::new().write(true).create_new(true).open(&probe.0).map_err(|_| "appUpdateUnwritable")?;
    if fs::metadata(&t.target).map_err(io_error)?.permissions().readonly() { return Err("appUpdateUnwritable".into()); }
    Ok(())
}
#[tauri::command]
pub fn apply_app_update(app: AppHandle, state: State<'_, UpdateState>, manager: State<'_, ProcessManager>, queue_empty: bool) -> Result<()> {
    if !queue_empty { return Err("appUpdateQueue".into()); }
    let _operation = state.operation.try_lock().map_err(|_| "appUpdateBusy")?;
    let _gate = manager.gate.lock().map_err(io_error)?;
    let _cookies = manager.cookies.try_lock().map_err(|_| "appUpdateBusy")?;
    crate::ensure_idle(&manager).map_err(|_| "appUpdateBusy")?;
    let dir = root()?;
    let _lock = lock_root(&dir)?;
    if dir.join("transaction.json").exists() { return Err("appUpdateRecovery".into()); }
    let verified = state.verified.lock().map_err(io_error)?.clone().ok_or("appUpdateCheckFirst")?;
    verify_file(&dir.join("download.exe"), &verified.manifest)?;
    let target = std::env::current_exe().map_err(io_error)?;
    let t = Transaction { original_sha256: hash_file(&target)?, target, parent_pid: std::process::id(), manifest: verified.bytes, signature: verified.signature, phase: "prepared".into() };
    preflight(&t, verified.manifest.size)?;
    let helper = dir.join("helper.exe");
    fs::copy(&t.target, &helper).map_err(io_error)?;
    let _ = fs::remove_file(dir.join("ack"));
    write_transaction(&dir, &t)?;
    manager.maintenance.store(true, Ordering::SeqCst);
    let guard = MaintenanceGuard(std::sync::Arc::clone(&manager.maintenance));
    if Command::new(&helper).arg("--dunedrop-update-helper").creation_flags_no_window().spawn().is_err() {
        let _ = fs::remove_file(dir.join("transaction.json"));
        return Err("appUpdateIo".into());
    }
    // The helper takes the cross-process lock after this command returns.
    std::mem::forget(guard);
    app.exit(0);
    Ok(())
}
#[tauri::command]
pub async fn save_app_update(app: AppHandle, destination: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<UpdateState>();
        let _operation = state.operation.try_lock().map_err(|_| "appUpdateBusy")?;
        let dir = root()?; let _lock = lock_root(&dir)?;
        let verified = state.verified.lock().map_err(io_error)?.clone().ok_or("appUpdateCheckFirst")?;
        let source = dir.join("download.exe"); verify_file(&source, &verified.manifest)?;
        let target = PathBuf::from(destination);
        // Never overwrite any existing file, particularly a running or unrelated executable.
        let mut out = OpenOptions::new().create_new(true).write(true).open(&target).map_err(io_error)?;
        let result = (|| { std::io::copy(&mut File::open(source).map_err(io_error)?, &mut out).map_err(io_error)?; out.sync_all().map_err(io_error)?; verify_file(&target, &verified.manifest) })();
        drop(out);
        if result.is_err() { let _ = fs::remove_file(&target); }
        result
    }).await.map_err(io_error)?
}

#[tauri::command]
pub fn acknowledge_app_update() -> Result<()> {
    if std::env::var_os("DUNEDROP_UPDATE_ACK").is_some() {
        let dir = root()?;
        if !dir.join("transaction.json").exists() { return Ok(()); }
        let t = read_transaction(&dir)?;
        if t.target == std::env::current_exe().map_err(io_error)? && t.phase == "installed" {
            let m = authenticate(&t.manifest, &t.signature, PUBLIC_KEY)?;
            if m.version != env!("CARGO_PKG_VERSION") { return Err("appUpdateInvalid".into()); }
            fs::write(dir.join("ack"), b"ready").map_err(io_error)?;
        }
    }
    Ok(())
}
fn rollback(dir: &Path, t: &Transaction) -> Result<()> {
    let old = backup(t);
    if old.exists() {
        // Never overwrite the target with an unrelated or damaged backup.
        if hash_file(&old)? != t.original_sha256 { return Err("appUpdateRecovery".into()); }
        if t.target.exists() { fs::remove_file(&t.target).map_err(io_error)?; }
        fs::rename(&old, &t.target).map_err(io_error)?;
    } else if t.phase != "prepared" { return Err("appUpdateRecovery".into()); }
    let _ = fs::remove_file(sibling(t));
    fs::write(dir.join("recovery.txt"), b"appUpdateRolledBack").map_err(io_error)?;
    fs::remove_file(dir.join("transaction.json")).map_err(io_error)?;
    Ok(())
}
fn replace(dir: &Path, t: &mut Transaction, m: &Manifest) -> Result<()> {
    verify_file(&dir.join("download.exe"), m)?;
    preflight(t, m.size)?;
    fs::copy(dir.join("download.exe"), sibling(t)).map_err(io_error)?;
    OpenOptions::new().write(true).open(sibling(t)).map_err(io_error)?.sync_all().map_err(io_error)?;
    verify_file(&sibling(t), m)?;
    fs::rename(&t.target, backup(t)).map_err(io_error)?;
    t.phase = "backedUp".into(); write_transaction(dir, t)?;
    fs::rename(sibling(t), &t.target).map_err(io_error)?;
    t.phase = "installed".into(); write_transaction(dir, t)
}
fn wait_ack(dir: &Path, child: &mut Child, timeout: Duration) -> Result<()> {
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(io_error)?.is_some() { return Err("appUpdateRecovery".into()); }
        if dir.join("ack").exists() { return Ok(()); }
        if start.elapsed() >= timeout { let _ = child.kill(); let _ = child.wait(); return Err("appUpdateRecovery".into()); }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn cleanup(dir: &Path, t: &Transaction) -> Result<()> {
    if backup(t).exists() { fs::remove_file(backup(t)).map_err(io_error)?; }
    for name in ["transaction.json", "download.exe", "ack", "recovery.txt"] { let _ = fs::remove_file(dir.join(name)); }
    Ok(())
}
#[cfg(windows)]
fn wait_parent(pid: u32) -> Result<()> {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() { return Ok(()); }
        let result = WaitForSingleObject(handle, 30000); CloseHandle(handle);
        if result != 0 { return Err("appUpdateBusy".into()); }
    }
    Ok(())
}
#[cfg(not(windows))]
fn wait_parent(_: u32) -> Result<()> { Err("appUpdateInvalid".into()) }

/// Called before WebView or Tauri initialization. Never accepts filesystem paths from argv.
pub fn early_start() -> bool {
    let helper = std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--dunedrop-update-helper"));
    let result = (|| -> Result<()> {
        let dir = root()?;
        if !dir.join("transaction.json").exists() {
            if let Ok(_lock) = lock_root(&dir) { let _ = fs::remove_file(dir.join("helper.exe")); }
            return Ok(());
        }
        if helper {
            let t = read_transaction(&dir)?;
            wait_parent(t.parent_pid)?;
        }
        let _lock = match lock_root(&dir) {
            Ok(lock) => lock,
            Err(_) if std::env::var_os("DUNEDROP_UPDATE_ACK").is_some() => return Ok(()),
            Err(e) => return Err(e),
        };
        let mut t = read_transaction(&dir)?;
        let m = authenticate(&t.manifest, &t.signature, PUBLIC_KEY)?;
        if helper && t.phase == "prepared" {
            let result = (|| {
                replace(&dir, &mut t, &m)?;
                let mut child = Command::new(&t.target).env("DUNEDROP_UPDATE_ACK", "1").creation_flags_no_window().spawn().map_err(io_error)?;
                let result = wait_ack(&dir, &mut child, Duration::from_secs(45));
                if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
                result
            })();
            if result.is_ok() { cleanup(&dir, &t)?; return Ok(()); }
            rollback(&dir, &t)?;
            Command::new(&t.target).env_remove("DUNEDROP_UPDATE_ACK").creation_flags_no_window().spawn().map_err(io_error)?;
            return Ok(());
        }
        if t.phase == "installed" && dir.join("ack").exists() { cleanup(&dir, &t)?; return Ok(()); }
        // A stale transaction is never silently installed on a later launch.
        // If running the target, let a helper recover it after this process exits.
        if std::env::current_exe().map_err(io_error)? == t.target && backup(&t).exists() {
            t.parent_pid = std::process::id();
            t.phase = "recover".into(); write_transaction(&dir, &t)?;
            let path = dir.join("helper.exe"); fs::copy(&t.target, &path).map_err(io_error)?;
            Command::new(path).arg("--dunedrop-update-helper").creation_flags_no_window().spawn().map_err(io_error)?;
            return Err("appUpdateRecovery".into());
        }
        rollback(&dir, &t)?;
        if helper { Command::new(&t.target).env_remove("DUNEDROP_UPDATE_ACK").creation_flags_no_window().spawn().map_err(io_error)?; }
        Ok(())
    })();
    if let Err(error) = result {
        if let Ok(dir) = root() { let _ = fs::write(dir.join("recovery.txt"), &error); }
        #[cfg(windows)] if error != "appUpdateBusy" {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK, MB_ICONERROR};
            let message: Vec<u16> = "DuneDrop could not finish or recover an update. Close all DuneDrop windows and try again. If it still cannot open, follow the README recovery instructions. Your backup has been preserved.\n\nНе вдалося завершити або відновити оновлення. Закрийте всі вікна DuneDrop та повторіть спробу. Якщо програма не відкривається, виконайте інструкції відновлення в README. Резервну копію збережено.".encode_utf16().chain(Some(0)).collect();
            let title: Vec<u16> = "DuneDrop".encode_utf16().chain(Some(0)).collect();
            unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR); }
        }
        // Do not initialize the app while another process owns an update transaction.
        return true;
    }
    helper
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest(data: &[u8]) -> Manifest { Manifest { schema_version: 1, version: "1.1.0".into(), platform: "windows-x86_64".into(), url: "https://github.com/vitkrv/dune-drop/releases/download/v1.1.0/DuneDrop.exe".into(), size: data.len() as u64, sha256: format!("{:x}", Sha256::digest(data)), notes: "Test".into() } }
    #[test] fn stable_versions_and_origin() {
        assert!(newer("1.10.0", "1.9.0").unwrap()); assert!(!newer("1.0.0", "1.0.0").unwrap()); assert!(!newer("0.9.0", "1.0.0").unwrap());
        let mut m = manifest(b"exe"); validate(&m).unwrap(); m.platform = "linux".into(); assert!(validate(&m).is_err());
        m.platform = "windows-x86_64".into(); m.url.push_str("?x"); assert!(validate(&m).is_err());
        m = manifest(b"exe"); m.version = "1.1.0-beta.1".into(); assert!(validate(&m).is_err());
    }
    #[test] fn signatures_authenticate_exact_bytes() {
        let keys = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let bytes = serde_json::to_vec(&manifest(b"exe")).unwrap();
        let signature = minisign::sign(None, &keys.sk, std::io::Cursor::new(&bytes), None, None).unwrap().to_string();
        let key = keys.pk.to_box().unwrap().to_string();
        authenticate(&bytes, &signature, &key).unwrap();
        let mut altered = bytes.clone(); altered.push(b' '); assert!(authenticate(&altered, &signature, &key).is_err());
        assert!(authenticate(&bytes, "invalid", &key).is_err());
        assert!(authenticate(&bytes, &signature, "UNCONFIGURED").is_err());
    }
    #[test] fn bounded_interrupted_and_cancelled_streams() {
        let cancel = AtomicBool::new(false);
        assert!(copy_stream(&b"short"[..], Vec::new(), 9, &cancel, |_| {}).is_err());
        assert!(copy_stream(&b"oversized"[..], Vec::new(), 3, &cancel, |_| {}).is_err());
        cancel.store(true, Ordering::SeqCst); assert_eq!(copy_stream(&b"abc"[..], Vec::new(), 3, &cancel, |_| {}).unwrap_err(), "appUpdateCancelled");
        cancel.store(false, Ordering::SeqCst); let mut out = Vec::new(); copy_stream(&b"abc"[..], &mut out, 3, &cancel, |_| {}).unwrap(); assert_eq!(out, b"abc");
    }
    #[test] fn replacement_rollback_and_cleanup_in_paths_with_spaces() {
        let temp = tempfile::Builder::new().prefix("DuneDrop update test ").tempdir().unwrap(); let dir = temp.path();
        let target = dir.join("Renamed app.exe"); fs::write(&target, b"old app").unwrap(); fs::write(dir.join("download.exe"), b"new app").unwrap();
        let mut t = Transaction { original_sha256: hash_file(&target).unwrap(), target, parent_pid: 0, manifest: vec![], signature: String::new(), phase: "prepared".into() };
        let m = manifest(b"new app"); replace(dir, &mut t, &m).unwrap(); assert_eq!(fs::read(&t.target).unwrap(), b"new app");
        rollback(dir, &t).unwrap(); assert_eq!(fs::read(&t.target).unwrap(), b"old app"); assert!(!backup(&t).exists());
        t.phase = "prepared".into(); replace(dir, &mut t, &m).unwrap(); cleanup(dir, &t).unwrap(); assert!(!backup(&t).exists()); assert!(!dir.join("download.exe").exists());
    }
    #[test] fn tampered_file_and_failed_replace_preserve_original() {
        let temp = tempfile::tempdir().unwrap(); let dir = temp.path(); let target = dir.join("app.exe"); fs::write(&target, b"old").unwrap();
        fs::write(dir.join("download.exe"), b"bad").unwrap(); let mut t = Transaction { original_sha256: hash_file(&target).unwrap(), target, parent_pid: 0, manifest: vec![], signature: String::new(), phase: "prepared".into() };
        assert!(replace(dir, &mut t, &manifest(b"new")).is_err()); assert_eq!(fs::read(&t.target).unwrap(), b"old");
        let _lock = lock_root(dir).unwrap(); assert!(lock_root(dir).is_err());
    }
    #[test] fn read_only_target_is_rejected_before_replacement() {
        let dir = tempfile::tempdir().unwrap(); let target = dir.path().join("app.exe"); fs::write(&target, b"old").unwrap();
        let t = Transaction { original_sha256: hash_file(&target).unwrap(), target: target.clone(), parent_pid: 0, manifest: vec![], signature: String::new(), phase: "prepared".into() };
        let original = fs::metadata(&target).unwrap().permissions(); let mut permissions = original.clone(); permissions.set_readonly(true); fs::set_permissions(&target, permissions).unwrap();
        assert_eq!(preflight(&t, 3).unwrap_err(), "appUpdateUnwritable");
        fs::set_permissions(target, original).unwrap();
    }
    #[test] fn recovery_preserves_an_unrelated_backup_and_recovers_a_crash_after_rename() {
        let temp = tempfile::tempdir().unwrap(); let dir = temp.path(); let target = dir.join("app.exe");
        fs::write(&target, b"old app").unwrap();
        let t = Transaction { original_sha256: hash_file(&target).unwrap(), target, parent_pid: 0, manifest: vec![], signature: String::new(), phase: "prepared".into() };
        write_transaction(dir, &t).unwrap();
        fs::write(backup(&t), b"unrelated").unwrap();
        assert!(rollback(dir, &t).is_err()); assert_eq!(fs::read(&t.target).unwrap(), b"old app");
        fs::remove_file(backup(&t)).unwrap();
        // Simulate power loss between renaming the old executable and persisting the next phase.
        fs::rename(&t.target, backup(&t)).unwrap();
        let recovered = read_transaction(dir).unwrap(); rollback(dir, &recovered).unwrap();
        assert_eq!(fs::read(&t.target).unwrap(), b"old app"); assert!(!dir.join("transaction.json").exists());
    }
    // Invoked as a disposable native child by the lifecycle test. No app state or browser access.
    #[test]
    fn fixture_process() {
        let Ok(dir) = std::env::var("DUNEDROP_TEST_ACK") else { return; };
        if std::env::var_os("DUNEDROP_TEST_FAIL").is_some() { std::process::exit(7); }
        fs::write(Path::new(&dir).join("ack"), "ready").unwrap();
        std::thread::sleep(Duration::from_secs(5));
    }
    #[test] fn native_startup_handshake_and_rollback() {
        let temp = tempfile::Builder::new().prefix("DuneDrop native test ").tempdir().unwrap(); let dir = temp.path();
        // Two distinct executable artifacts simulate old/new releases without touching the app.
        let target = dir.join("Old version.exe"); fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
        let mut updated = fs::read(&target).unwrap(); updated.extend_from_slice(b"DuneDrop test version two");
        fs::write(dir.join("download.exe"), &updated).unwrap(); let m = manifest(&updated);
        let mut t = Transaction { original_sha256: hash_file(&target).unwrap(), target, parent_pid: 0, manifest: vec![], signature: String::new(), phase: "prepared".into() };
        fs::write(dir.join("settings.sentinel"), "unchanged").unwrap(); fs::write(dir.join("tools.sentinel"), "unchanged").unwrap();
        replace(dir, &mut t, &m).unwrap();
        let launch = |fail: bool| {
            let mut cmd = Command::new(&t.target);
            cmd.args(["--exact", "updater::tests::fixture_process", "--nocapture"]).env("DUNEDROP_TEST_ACK", dir).creation_flags_no_window();
            if fail { cmd.env("DUNEDROP_TEST_FAIL", "1"); }
            cmd.spawn().unwrap()
        };
        let mut child = launch(false); wait_ack(dir, &mut child, Duration::from_secs(10)).unwrap(); let _ = child.kill(); child.wait().unwrap();
        fs::remove_file(dir.join("ack")).unwrap();
        let mut child = launch(true); assert!(wait_ack(dir, &mut child, Duration::from_secs(10)).is_err()); let _ = child.wait();
        rollback(dir, &t).unwrap(); assert_ne!(fs::read(&t.target).unwrap(), updated);
        for name in ["settings.sentinel", "tools.sentinel"] { assert_eq!(fs::read_to_string(dir.join(name)).unwrap(), "unchanged"); }
    }
}
