//! One-shot elevated EA installs and updates.
//!
//! The EA App writes its games under `Program Files` through a privileged
//! service. The launcher does not install a service: when the chosen folder is
//! not writable, it starts one copy of itself through the Windows `runas` verb
//! and lets that copy run the same content installer with administrator rights.
//!
//! The elevated copy receives only a library id and a locale. It resolves the
//! offer and the install folder from the linked account and the local library,
//! so a caller cannot point an elevated touchup at an arbitrary directory.
//! Progress travels through a small JSON state file under the user's data
//! folder; cancelling writes a marker next to it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::ea_install;

/// Library id → job id for the installs this process started elevated.
static JOBS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobState {
    pub phase: String,
    pub files: usize,
    pub bytes: u64,
    pub skipped: usize,
    pub skipped_bytes: u64,
    pub done_bytes: u64,
    pub total_files: usize,
    pub total_bytes: u64,
    pub done: bool,
    pub error: Option<String>,
    pub version: String,
    pub build_id: String,
    pub mode: String,
    pub touchup_error: Option<String>,
}

fn jobs_dir() -> PathBuf {
    super::accounts::data_dir().join("ea-jobs")
}

fn state_path(job_id: &str) -> PathBuf {
    jobs_dir().join(format!("{job_id}.json"))
}

fn cancel_path(job_id: &str) -> PathBuf {
    jobs_dir().join(format!("{job_id}.cancel"))
}

fn job_id_ok(job_id: &str) -> bool {
    job_id.len() == 32 && job_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn new_job_id() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_state(job_id: &str, state: &JobState) {
    let path = state_path(job_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(text) = serde_json::to_vec(state) else {
        return;
    };
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, text).is_ok() {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::rename(&temp, &path);
    }
}

fn read_state(job_id: &str) -> Option<JobState> {
    let text = std::fs::read(state_path(job_id)).ok()?;
    serde_json::from_slice(&text).ok()
}

fn register(game_id: &str, job_id: &str) {
    let mut jobs = JOBS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    jobs.get_or_insert_with(HashMap::new)
        .insert(game_id.to_string(), job_id.to_string());
}

fn unregister(game_id: &str) {
    if let Some(jobs) = JOBS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_mut()
    {
        jobs.remove(game_id);
    }
}

/// Asks the elevated worker to stop after the files in flight finish.
pub(crate) fn cancel(game_id: &str) {
    let job = JOBS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|jobs| jobs.get(game_id).cloned());
    if let Some(job) = job {
        if job_id_ok(&job) {
            let _ = std::fs::write(cancel_path(&job), b"cancel");
        }
    }
}

pub(crate) fn supported() -> bool {
    cfg!(windows)
}

/// Reads `--ea-content-worker <job> <game> <locale> <mbps>` before Tauri
/// starts. The cap travels on the command line because the elevated worker
/// never builds an `AppHandle` and cannot read the settings file.
pub(crate) fn worker_args(
    args: impl Iterator<Item = String>,
) -> Option<(String, String, String, f64)> {
    let mut args = args.skip_while(|arg| arg != "--ea-content-worker");
    if args.next().is_none() {
        return None;
    }
    let job = args.next()?;
    let game = args.next()?;
    let locale = args.next().unwrap_or_else(|| "en_US".into());
    let limit = args
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    Some((job, game, locale, limit))
}

fn clean_game_id(game_id: &str) -> bool {
    !game_id.is_empty()
        && game_id.len() <= 200
        && !game_id
            .chars()
            .any(|ch| ch == '"' || ch.is_control())
}

fn clean_locale(locale: &str) -> bool {
    !locale.is_empty()
        && locale.len() <= 16
        && locale
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'_' || byte == b'-')
}

/// The elevated half of `ea_content_install`. It runs the normal installer and
/// writes one state file the parent process reads.
pub(crate) fn run_worker(job_id: &str, game_id: &str, locale: &str) -> i32 {
    if !job_id_ok(job_id) || !clean_game_id(game_id) || !clean_locale(locale) {
        return 2;
    }

    let mut state = JobState {
        phase: "planning".into(),
        ..JobState::default()
    };
    write_state(job_id, &state);

    let cancelled = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let cancel_file = cancel_path(job_id);
    let watcher = {
        let cancelled = cancelled.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if cancel_file.is_file() {
                    cancelled.store(true, Ordering::Relaxed);
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        })
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build();
    let result = match runtime {
        Ok(runtime) => runtime.block_on(async {
            let (game, owned, root) = super::ea_content_target(game_id, None)?;
            if game.install_path.is_empty() || !ea_install::has_install(&root) {
                return Err("No existing EA install to update".to_string());
            }
            let access = super::ea_login::ensure_access().await?;
            let mut last_write = Instant::now();
            let install = ea_install::install_with_progress(
                &access,
                &owned.id,
                &root,
                locale,
                &cancelled,
                |tick| {
                    let changed = state.phase != tick.phase;
                    state.phase = tick.phase.to_string();
                    if let Some(progress) = tick.progress {
                        state.files = progress.files;
                        state.bytes = progress.bytes;
                        state.skipped = progress.skipped;
                        state.skipped_bytes = progress.skipped_bytes;
                        state.done_bytes = progress.done_bytes;
                        state.total_files = progress.total_files;
                        state.total_bytes = progress.total_bytes;
                    }
                    if changed || last_write.elapsed() >= Duration::from_millis(200) {
                        write_state(job_id, &state);
                        last_write = Instant::now();
                    }
                },
            )
            .await?;
            Ok::<_, String>(install)
        }),
        Err(error) => Err(format!("EA worker runtime: {error}")),
    };
    stop.store(true, Ordering::Relaxed);
    let _ = watcher.join();

    match result {
        Ok(report) => {
            state.phase = "done".into();
            state.done = true;
            state.version = report.version;
            state.build_id = report.build_id;
            state.mode = report.mode.as_str().to_string();
            state.touchup_error = report.touchup_error;
            state.error = None;
            write_state(job_id, &state);
            0
        }
        Err(error) => {
            state.phase = "failed".into();
            state.done = true;
            state.error = Some(error);
            write_state(job_id, &state);
            1
        }
    }
}

/// Starts the elevated worker and monitors its state file.
pub(crate) async fn install(
    app: tauri::AppHandle,
    game_id: String,
    name: String,
    locale: String,
) {
    use tauri::Emitter;

    let job_id = new_job_id();
    register(&game_id, &job_id);
    let _ = std::fs::create_dir_all(jobs_dir());
    let _ = std::fs::remove_file(cancel_path(&job_id));

    let spawn_job = job_id.clone();
    let spawn_game = game_id.clone();
    let spawn_locale = locale.clone();
    let launched = tokio::task::spawn_blocking(move || {
        launch_worker(&spawn_job, &spawn_game, &spawn_locale)
    })
    .await;
    let exit = match launched {
        Ok(Ok(exit)) => exit,
        Ok(Err(error)) => {
            unregister(&game_id);
            let _ = app.emit(
                "ea-content-failed",
                serde_json::json!({ "id": game_id, "name": name, "error": error }),
            );
            return;
        }
        Err(error) => {
            unregister(&game_id);
            let _ = app.emit(
                "ea-content-failed",
                serde_json::json!({
                    "id": game_id,
                    "name": name,
                    "error": format!("EA worker: {error}")
                }),
            );
            return;
        }
    };

    let wait = tokio::task::spawn_blocking(move || exit.recv().unwrap_or(-1));
    let mut last: Option<JobState> = None;
    loop {
        if let Some(state) = read_state(&job_id) {
            if state != *last.as_ref().unwrap_or(&JobState::default()) {
                if !state.done {
                    let _ = app.emit(
                        "ea-content-progress",
                        super::EaContentProgress {
                            id: game_id.clone(),
                            offer_id: String::new(),
                            name: name.clone(),
                            phase: state.phase.clone(),
                            files: state.files,
                            bytes: state.bytes,
                            skipped: state.skipped,
                            skipped_bytes: state.skipped_bytes,
                            done_bytes: state.done_bytes,
                            total_files: state.total_files,
                            total_bytes: state.total_bytes,
                        },
                    );
                }
                last = Some(state);
            }
        }
        if wait.is_finished() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let code = wait.await.unwrap_or(-1);
    unregister(&game_id);

    let final_state = read_state(&job_id).unwrap_or_default();
    if final_state.done {
        if let Some(error) = final_state.error {
            let _ = app.emit(
                "ea-content-failed",
                serde_json::json!({ "id": game_id, "name": name, "error": error }),
            );
        } else {
            let _ = app.emit(
                "ea-content-done",
                serde_json::json!({
                    "id": game_id,
                    "name": name,
                    "version": final_state.version,
                    "buildId": final_state.build_id,
                    "mode": final_state.mode,
                    "files": final_state.files,
                    "bytes": final_state.bytes,
                    "skipped": final_state.skipped,
                    "touchupError": final_state.touchup_error,
                }),
            );
        }
    } else {
        let _ = app.emit(
            "ea-content-failed",
            serde_json::json!({
                "id": game_id,
                "name": name,
                "error": format!("EA worker exited with {code}")
            }),
        );
    }
    let _ = std::fs::remove_file(state_path(&job_id));
    let _ = std::fs::remove_file(cancel_path(&job_id));
}

/// Runs one command through UAC and waits for it. Used by uninstall, where the
/// cleanup tool lives under `Program Files` and the launcher itself is not
/// elevated.
pub(crate) fn run_elevated(program: &std::path::Path, args: &[String]) -> Result<i32, String> {
    #[cfg(windows)]
    {
        let params = args
            .iter()
            .map(|arg| quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let exit = shell_process(program, &params, "runas")?;
        exit.recv()
            .map_err(|_| "EA elevated command closed without an exit code".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (program, args);
        Err("@t:ea.elevationUnsupported".into())
    }
}

#[cfg(windows)]
fn quote_arg(arg: &str) -> String {
    if arg.is_empty() || arg.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

#[cfg(windows)]
fn launch_worker(
    job_id: &str,
    game_id: &str,
    locale: &str,
) -> Result<std::sync::mpsc::Receiver<i32>, String> {
    let exe = std::env::current_exe().map_err(|error| format!("EA elevation: {error}"))?;
    let limit = crate::download_limit::rate_mbps();
    let params = format!("--ea-content-worker {job_id} \"{game_id}\" \"{locale}\" {limit:.3}");
    shell_process(&exe, &params, "runas")
}

#[cfg(windows)]
fn shell_process(
    exe: &std::path::Path,
    params: &str,
    verb: &str,
) -> Result<std::sync::mpsc::Receiver<i32>, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::mpsc;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    // ShellExecuteEx expects COM on its calling thread; the launcher's worker
    // may run on a fresh async-runtime thread.
    let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };

    let exe_wide: Vec<u16> = exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params_wide: Vec<u16> = params
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let verb_wide: Vec<u16> = verb.encode_utf16().chain(std::iter::once(0)).collect();

    let mut info = SHELLEXECUTEINFOW::default();
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = PCWSTR(verb_wide.as_ptr());
    info.lpFile = PCWSTR(exe_wide.as_ptr());
    info.lpParameters = PCWSTR(params_wide.as_ptr());
    info.nShow = SW_HIDE.0;
    let shell = unsafe { ShellExecuteExW(&mut info) };
    if com {
        unsafe { CoUninitialize() };
    }
    if let Err(error) = shell {
        let code = error.code().0 as u32;
        if code == 0x8007_04C7 {
            return Err("@t:ea.elevationDenied".into());
        }
        return Err(format!("@t:ea.elevationFailed\u{1f}{error}"));
    }
    let raw = info.hProcess.0 as isize;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let handle = HANDLE(raw as *mut core::ffi::c_void);
        unsafe {
            let _ = WaitForSingleObject(handle, u32::MAX);
            let mut code = 0u32;
            let _ = GetExitCodeProcess(handle, &mut code);
            let _ = CloseHandle(handle);
            let _ = sender.send(code as i32);
        }
    });
    Ok(receiver)
}

#[cfg(not(windows))]
fn launch_worker(
    _job_id: &str,
    _game_id: &str,
    _locale: &str,
) -> Result<std::sync::mpsc::Receiver<i32>, String> {
    Err("@t:ea.elevationUnsupported".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_ids_and_arguments_are_validated_before_a_worker_runs() {
        assert!(job_id_ok("0123456789abcdef0123456789abcdef"));
        assert!(!job_id_ok("../escape"));
        assert!(!job_id_ok(""));
        assert!(clean_game_id("Origin.OFR.50.0002412"));
        assert!(!clean_game_id("bad\"quote"));
        assert!(clean_locale("pt_BR"));
        assert!(!clean_locale("en US"));
    }

    #[test]
    fn the_worker_argument_is_found_in_both_positions() {
        let parsed = worker_args(
            [
                "--other",
                "--ea-content-worker",
                "0123456789abcdef0123456789abcdef",
                "game",
                "tr_TR",
                "12.500",
            ]
            .iter()
            .map(|arg| arg.to_string()),
        );
        assert_eq!(
            parsed,
            Some((
                "0123456789abcdef0123456789abcdef".into(),
                "game".into(),
                "tr_TR".into(),
                12.5
            ))
        );
        assert!(worker_args(["--launch", "game"].iter().map(|arg| arg.to_string())).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn the_process_wait_returns_the_exit_code() {
        let exe = std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
        let exit = shell_process(&exe, "/c exit 7", "open").expect("process");
        assert_eq!(exit.recv_timeout(Duration::from_secs(30)), Ok(7));
    }

    #[test]
    fn a_state_round_trips_through_the_job_file() {        let job = "0123456789abcdef0123456789abcdef";
        let path = state_path(job);
        let previous = std::fs::read(&path).ok();
        let state = JobState {
            phase: "downloading".into(),
            files: 3,
            bytes: 42,
            skipped: 1,
            skipped_bytes: 7,
            done_bytes: 49,
            total_files: 4,
            total_bytes: 100,
            done: false,
            error: None,
            version: "1".into(),
            build_id: "b".into(),
            mode: "update".into(),
            touchup_error: None,
        };
        write_state(job, &state);
        assert_eq!(read_state(job), Some(state));
        match previous {
            Some(bytes) => {
                let _ = std::fs::write(&path, bytes);
            }
            None => {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(path.with_extension("json.tmp"));
            }
        }
    }
}
