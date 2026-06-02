use serde::{Deserialize, Serialize};
use std::{
    env,
    fs,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const EMBEDDED_YTDLP: &[u8] = include_bytes!("../resources/bin/yt-dlp.exe");
const YTDLP_NAME: &str = "yt-dlp.exe";
const DANGEROUS_FLAGS: &[&str] = &[
    "--exec",
    "--plugin-dirs",
    "--external-downloader",
    "--external-downloader-args",
    "--enable-file-urls",
    "--netrc-cmd",
    "--alias",
    "--use-postprocessor",
];
const SENSITIVE_FLAGS: &[&str] = &[
    "--password",
    "--twofactor",
    "--video-password",
    "--ap-password",
    "--client-certificate-password",
    "--username",
    "--ap-username",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogOption {
    flags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    argument: Option<String>,
    description: String,
    dangerous: bool,
    sensitive: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSection {
    name: String,
    options: Vec<CatalogOption>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolInfo {
    version: String,
    executable_path: String,
    tools_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ffmpeg_directory: Option<String>,
    ffmpeg_available: bool,
    catalog: Vec<CatalogSection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRequest {
    job_id: String,
    urls: Vec<String>,
    destination: String,
    preset: String,
    ffmpeg_directory: Option<String>,
    advanced_args: Vec<String>,
    raw_args: String,
    allow_dangerous_options: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadLogEvent {
    job_id: String,
    stream: String,
    chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadDoneEvent {
    job_id: String,
    success: bool,
    cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UtilityResponse {
    stdout: String,
    stderr: String,
    success: bool,
}

#[derive(Default)]
struct ProcessManager {
    active: Arc<Mutex<Option<ActiveProcess>>>,
}

struct ActiveProcess {
    job_id: String,
    job: Arc<JobHandle>,
    cancelled: bool,
}

#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(not(windows))]
struct JobHandle;

#[cfg(windows)]
impl JobHandle {
    fn create() -> Result<Self, String> {
        use std::{mem, ptr};
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        unsafe {
            let handle = CreateJobObjectW(ptr::null(), ptr::null());
            if handle.is_null() {
                return Err(io::Error::last_os_error().to_string());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0 {
                CloseHandle(handle);
                return Err(io::Error::last_os_error().to_string());
            }
            Ok(Self(handle))
        }
    }

    fn assign(&self, child: &tokio::process::Child) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        let child_handle = child.raw_handle().ok_or("Unable to access yt-dlp process handle")?;
        let assigned = unsafe { AssignProcessToJobObject(self.0, child_handle as _) };
        if assigned == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    fn terminate(&self) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        let terminated = unsafe { TerminateJobObject(self.0, 1) };
        if terminated == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(())
    }
}

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
impl JobHandle {
    fn create() -> Result<Self, String> {
        Ok(Self)
    }

    fn assign(&self, _child: &tokio::process::Child) -> Result<(), String> {
        Ok(())
    }

    fn terminate(&self) -> Result<(), String> {
        Err("Cancellation is only supported on Windows".into())
    }
}

fn app_tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local_app_data).join("DuneDrop").join("tools"));
    }
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("DuneDrop").join("tools"))
        .map_err(|error| error.to_string())
}

fn managed_ytdlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_tools_dir(app)?.join(YTDLP_NAME))
}

fn ensure_managed_ytdlp(app: &AppHandle) -> Result<PathBuf, String> {
    let path = managed_ytdlp_path(app)?;
    ensure_embedded_at(&path)?;
    Ok(path)
}

fn ensure_embedded_at(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let parent = path.parent().ok_or("Managed yt-dlp path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    fs::write(&path, EMBEDDED_YTDLP).map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_idle(manager: &ProcessManager) -> Result<(), String> {
    if manager.active.lock().map_err(|_| "Process lock poisoned")?.is_some() {
        return Err("Wait for the active download to finish first".into());
    }
    Ok(())
}

fn command_output(path: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new(path)
        .args(args)
        .creation_flags_no_window()
        .output()
        .map_err(|error| error.to_string())
}

trait NoWindowCommand {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

impl NoWindowCommand for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

fn ytdlp_version(path: &Path) -> Result<String, String> {
    let output = command_output(path, &["--version"])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn ytdlp_catalog(path: &Path) -> Result<Vec<CatalogSection>, String> {
    let output = command_output(path, &["--help"])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(parse_help(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_help(help: &str) -> Vec<CatalogSection> {
    let mut sections: Vec<CatalogSection> = Vec::new();
    let mut current_section = String::from("General");
    let mut current_option: Option<CatalogOption> = None;

    let flush_option = |sections: &mut Vec<CatalogSection>,
                        section_name: &str,
                        option: &mut Option<CatalogOption>| {
        if let Some(option) = option.take() {
            if let Some(section) = sections.iter_mut().find(|section| section.name == section_name) {
                section.options.push(option);
            } else {
                sections.push(CatalogSection {
                    name: section_name.to_owned(),
                    options: vec![option],
                });
            }
        }
    };

    for line in help.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush_option(&mut sections, &current_section, &mut current_option);
            continue;
        }
        if trimmed.ends_with(':') && !trimmed.starts_with('-') && !line.starts_with("    ") {
            flush_option(&mut sections, &current_section, &mut current_option);
            current_section = trimmed.trim_end_matches(':').to_owned();
            continue;
        }
        if line.starts_with("    -") {
            flush_option(&mut sections, &current_section, &mut current_option);
            let (signature, description) = split_signature_description(trimmed);
            let (flags, argument) = parse_signature(signature);
            let dangerous = flags.iter().any(|flag| is_dangerous_flag(flag));
            let sensitive = flags.iter().any(|flag| is_sensitive_flag(flag));
            current_option = Some(CatalogOption {
                flags,
                argument,
                description: description.to_owned(),
                dangerous,
                sensitive,
            });
            continue;
        }
        if let Some(option) = current_option.as_mut() {
            if !option.description.is_empty() {
                option.description.push(' ');
            }
            option.description.push_str(trimmed);
        }
    }
    flush_option(&mut sections, &current_section, &mut current_option);
    sections
}

fn split_signature_description(line: &str) -> (&str, &str) {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] == b' ' && bytes[index + 1] == b' ' {
            return (&line[..index], line[index..].trim());
        }
        index += 1;
    }
    (line, "")
}

fn parse_signature(signature: &str) -> (Vec<String>, Option<String>) {
    let mut flags = Vec::new();
    let mut argument = None;
    for part in signature.split(',').map(str::trim) {
        let mut words = part.split_whitespace();
        if let Some(flag) = words.next() {
            flags.push(flag.to_owned());
            let rest = words.collect::<Vec<_>>().join(" ");
            if !rest.is_empty() {
                argument = Some(rest);
            }
        }
    }
    (flags, argument)
}

fn is_dangerous_flag(flag: &str) -> bool {
    DANGEROUS_FLAGS.contains(&flag)
}

fn is_sensitive_flag(flag: &str) -> bool {
    SENSITIVE_FLAGS.contains(&flag)
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    env::split_paths(&paths)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn detect_ffmpeg(configured_directory: Option<&str>) -> Option<PathBuf> {
    if let Some(directory) = configured_directory.filter(|value| !value.trim().is_empty()) {
        let directory = PathBuf::from(directory);
        if directory.join("ffmpeg.exe").is_file() && directory.join("ffprobe.exe").is_file() {
            return Some(directory);
        }
        return None;
    }
    let ffmpeg = find_executable("ffmpeg.exe")?;
    let ffprobe = find_executable("ffprobe.exe")?;
    let ffmpeg_parent = ffmpeg.parent()?;
    if ffprobe.parent() == Some(ffmpeg_parent) {
        Some(ffmpeg_parent.to_owned())
    } else {
        None
    }
}

fn tool_info(app: &AppHandle, ffmpeg_directory: Option<&str>) -> Result<ToolInfo, String> {
    let path = ensure_managed_ytdlp(app)?;
    let tools_directory = app_tools_dir(app)?;
    let detected_ffmpeg = detect_ffmpeg(ffmpeg_directory);
    Ok(ToolInfo {
        version: ytdlp_version(&path)?,
        executable_path: path.to_string_lossy().into_owned(),
        tools_directory: tools_directory.to_string_lossy().into_owned(),
        ffmpeg_directory: detected_ffmpeg.as_ref().map(|path| path.to_string_lossy().into_owned()),
        ffmpeg_available: detected_ffmpeg.is_some(),
        catalog: ytdlp_catalog(&path)?,
    })
}

fn parse_raw_args(input: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();

    while let Some(character) = chars.next() {
        match character {
            '"' | '\'' if quote == Some(character) => quote = None,
            '"' | '\'' if quote.is_none() => quote = Some(character),
            '\\' if matches!(chars.peek(), Some('\\' | '"' | '\'')) => {
                current.push(chars.next().expect("peeked character exists"));
            }
            value if value.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            value => current.push(value),
        }
    }
    if quote.is_some() {
        return Err("Raw arguments contain an unclosed quote".into());
    }
    if !current.is_empty() {
        args.push(current);
    }
    Ok(args)
}

fn validate_args(args: &[String], allow_dangerous_options: bool) -> Result<(), String> {
    if allow_dangerous_options {
        return Ok(());
    }
    if let Some(flag) = args.iter().find(|arg| is_dangerous_flag(arg)) {
        return Err(format!("{flag} requires the Advanced Mode acknowledgement"));
    }
    Ok(())
}

fn build_download_args(request: &DownloadRequest) -> Result<Vec<String>, String> {
    if request.urls.is_empty() {
        return Err("At least one URL is required".into());
    }
    if request.destination.trim().is_empty() {
        return Err("A destination folder is required".into());
    }
    let mut args = vec!["--paths".into(), request.destination.clone()];
    match request.preset.as_str() {
        "video" => args.extend(["-t".into(), "mp4".into()]),
        "mp3" => {
            if detect_ffmpeg(request.ffmpeg_directory.as_deref()).is_none() {
                return Err("MP3 downloads require ffmpeg.exe and ffprobe.exe".into());
            }
            args.extend(["-t".into(), "mp3".into()]);
        }
        _ => return Err("Unknown download preset".into()),
    }
    if let Some(directory) = request.ffmpeg_directory.as_deref().filter(|value| !value.trim().is_empty()) {
        args.extend(["--ffmpeg-location".into(), directory.to_owned()]);
    }
    args.extend(request.advanced_args.clone());
    args.extend(parse_raw_args(&request.raw_args)?);
    validate_args(&args, request.allow_dangerous_options)?;
    args.push("--".into());
    args.extend(request.urls.clone());
    Ok(args)
}

async fn stream_output<R: AsyncRead + Unpin>(
    mut reader: R,
    app: AppHandle,
    job_id: String,
    stream: &'static str,
) -> io::Result<()> {
    let mut buffer = vec![0_u8; 4096];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let event = DownloadLogEvent {
            job_id: job_id.clone(),
            stream: stream.into(),
            chunk: String::from_utf8_lossy(&buffer[..read]).into_owned(),
        };
        let _ = app.emit("download-log", event);
    }
    Ok(())
}

#[tauri::command]
fn initialize(app: AppHandle, ffmpeg_directory: Option<String>) -> Result<ToolInfo, String> {
    tool_info(&app, ffmpeg_directory.as_deref())
}

#[tauri::command]
fn preview_download_args(request: DownloadRequest) -> Result<Vec<String>, String> {
    build_download_args(&request)
}

#[tauri::command]
async fn start_download(
    app: AppHandle,
    manager: State<'_, ProcessManager>,
    request: DownloadRequest,
) -> Result<(), String> {
    ensure_idle(&manager)?;
    let path = ensure_managed_ytdlp(&app)?;
    let args = build_download_args(&request)?;
    let job_id = request.job_id.clone();
    let mut command = Command::new(path);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or("Unable to capture yt-dlp stdout")?;
    let stderr = child.stderr.take().ok_or("Unable to capture yt-dlp stderr")?;
    let job = Arc::new(JobHandle::create()?);
    job.assign(&child)?;
    manager.active.lock().map_err(|_| "Process lock poisoned")?.replace(ActiveProcess {
        job_id: job_id.clone(),
        job: Arc::clone(&job),
        cancelled: false,
    });
    let manager_inner = Arc::clone(&app.state::<ProcessManager>().inner().active);
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let stdout_task = tokio::spawn(stream_output(stdout, app_for_task.clone(), job_id.clone(), "stdout"));
        let stderr_task = tokio::spawn(stream_output(stderr, app_for_task.clone(), job_id.clone(), "stderr"));
        let status = child.wait().await;
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let cancelled = manager_inner
            .lock()
            .ok()
            .and_then(|mut active| active.take())
            .map(|active| active.cancelled && active.job_id == job_id)
            .unwrap_or(false);
        drop(job);
        let event = match status {
            Ok(status) => DownloadDoneEvent {
                job_id,
                success: status.success() && !cancelled,
                cancelled,
                exit_code: status.code(),
                error: None,
            },
            Err(error) => DownloadDoneEvent {
                job_id,
                success: false,
                cancelled,
                exit_code: None,
                error: Some(error.to_string()),
            },
        };
        let _ = app_for_task.emit("download-done", event);
    });
    Ok(())
}

#[tauri::command]
fn cancel_download(manager: State<'_, ProcessManager>) -> Result<(), String> {
    let mut active = manager.active.lock().map_err(|_| "Process lock poisoned")?;
    if let Some(active) = active.as_mut() {
        active.cancelled = true;
        active.job.terminate()?;
    }
    Ok(())
}

#[tauri::command]
fn reveal_tools_folder(app: AppHandle) -> Result<(), String> {
    let tools = app_tools_dir(&app)?;
    fs::create_dir_all(&tools).map_err(|error| error.to_string())?;
    std::process::Command::new("explorer.exe")
        .arg(tools)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_log_file(path: String, contents: String) -> Result<(), String> {
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn replace_ytdlp(
    app: AppHandle,
    manager: State<'_, ProcessManager>,
    source_path: String,
    ffmpeg_directory: Option<String>,
) -> Result<ToolInfo, String> {
    ensure_idle(&manager)?;
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("Choose an existing yt-dlp.exe file".into());
    }
    let destination = managed_ytdlp_path(&app)?;
    if source == destination {
        return tool_info(&app, ffmpeg_directory.as_deref());
    }
    let staged = destination.with_extension("replacement.exe");
    fs::copy(&source, &staged).map_err(|error| error.to_string())?;
    if let Err(error) = ytdlp_version(&staged) {
        let _ = fs::remove_file(&staged);
        return Err(format!("The replacement executable failed validation: {error}"));
    }
    if destination.exists() {
        fs::remove_file(&destination).map_err(|error| error.to_string())?;
    }
    fs::rename(staged, destination).map_err(|error| error.to_string())?;
    tool_info(&app, ffmpeg_directory.as_deref())
}

#[tauri::command]
fn update_ytdlp(app: AppHandle, manager: State<'_, ProcessManager>) -> Result<UtilityResponse, String> {
    ensure_idle(&manager)?;
    let path = ensure_managed_ytdlp(&app)?;
    let output = command_output(&path, &["--update"])?;
    Ok(UtilityResponse {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        success: output.status.success(),
    })
}

#[tauri::command]
fn run_utility(
    app: AppHandle,
    manager: State<'_, ProcessManager>,
    raw_args: String,
    allow_dangerous_options: bool,
) -> Result<UtilityResponse, String> {
    ensure_idle(&manager)?;
    let path = ensure_managed_ytdlp(&app)?;
    let args = parse_raw_args(&raw_args)?;
    validate_args(&args, allow_dangerous_options)?;
    let string_args = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = command_output(&path, &string_args)?;
    Ok(UtilityResponse {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        success: output.status.success(),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ProcessManager::default())
        .invoke_handler(tauri::generate_handler![
            initialize,
            preview_download_args,
            start_download,
            cancel_download,
            reveal_tools_folder,
            write_log_file,
            replace_ytdlp,
            update_ytdlp,
            run_utility,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DuneDrop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("dunedrop-{name}-{unique}"))
    }

    fn video_request() -> DownloadRequest {
        DownloadRequest {
            job_id: "test".into(),
            urls: vec!["https://example.test/video".into()],
            destination: r"C:\Downloads".into(),
            preset: "video".into(),
            ffmpeg_directory: None,
            advanced_args: vec!["--no-playlist".into()],
            raw_args: r#"--proxy "http://localhost:8080""#.into(),
            allow_dangerous_options: false,
        }
    }

    #[test]
    fn parses_quoted_raw_arguments_without_losing_windows_backslashes() {
        assert_eq!(
            parse_raw_args(r#"--proxy "http://localhost:8080" --ffmpeg-location C:\Tools\ffmpeg"#).unwrap(),
            vec!["--proxy", "http://localhost:8080", "--ffmpeg-location", r"C:\Tools\ffmpeg"]
        );
    }

    #[test]
    fn rejects_unclosed_raw_argument_quote() {
        assert!(parse_raw_args(r#"--proxy "unfinished"#).is_err());
    }

    #[test]
    fn requires_acknowledgement_for_dangerous_options() {
        let args = vec!["--exec".into(), "echo done".into()];
        assert!(validate_args(&args, false).is_err());
        assert!(validate_args(&args, true).is_ok());
    }

    #[test]
    fn parses_help_sections_and_option_metadata() {
        let sections = parse_help(
            "Options:\n\n  General Options:\n    --version                       Print version\n    --plugin-dirs DIR               Load plugins\n",
        );
        assert_eq!(sections[0].name, "General Options");
        assert_eq!(sections[0].options[0].flags, vec!["--version"]);
        assert_eq!(sections[0].options[1].argument.as_deref(), Some("DIR"));
        assert!(sections[0].options[1].dangerous);
    }

    #[test]
    fn detects_sensitive_flags() {
        assert!(is_sensitive_flag("--password"));
        assert!(!is_sensitive_flag("--proxy"));
    }

    #[test]
    fn embedded_tool_does_not_overwrite_existing_copy() {
        let directory = temp_directory("extract");
        let path = directory.join(YTDLP_NAME);
        fs::create_dir_all(&directory).unwrap();
        fs::write(&path, b"manual update").unwrap();
        ensure_embedded_at(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"manual update");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn builds_download_arguments_in_stable_order() {
        let args = build_download_args(&video_request()).unwrap();
        assert_eq!(
            args,
            vec![
                "--paths",
                r"C:\Downloads",
                "-t",
                "mp4",
                "--no-playlist",
                "--proxy",
                "http://localhost:8080",
                "--",
                "https://example.test/video"
            ]
        );
    }
}
