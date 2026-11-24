//! The legendary transfer process tree.
//!
//! An install is not one process: legendary starts a multiprocessing manager
//! and one download worker per slot. `kill_on_drop` reaps only the direct
//! child, so a failed or abandoned attempt can leave the workers writing into
//! the game folder and holding `installed.json.lock`. Every later update then
//! dies with "Failed to acquire installed data lock".
//!
//! On Windows every install joins one job object with `KILL_ON_JOB_CLOSE`, so
//! the tree dies with the launcher even when the UI process crashes. A boot
//! sweep also ends a transfer left behind by an older build. The other
//! platforms keep the normal-exit process-group kill.

use std::path::Path;

/// Puts an installer and the processes it creates into the transfer job.
pub(super) fn contain(pid: u32) {
    #[cfg(windows)]
    imp::contain(pid);
    #[cfg(not(windows))]
    let _ = pid;
}

/// Ends every process still in the transfer job. Empty after a clean exit.
pub(super) fn terminate() {
    #[cfg(windows)]
    imp::terminate();
}

/// Kills leftovers that run `bin`, this installation's legendary.
///
/// A transfer from a previous launcher session cannot be adopted by the new
/// one, and its lock blocks every update. Another launcher's legendary or a
/// system-installed one is left alone: the full image path has to match.
pub(crate) fn kill_stale_transfers(bin: &Path) -> usize {
    #[cfg(windows)]
    {
        imp::kill_matching(bin)
    }
    #[cfg(not(windows))]
    {
        let _ = bin;
        0
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::path::Path;
    use std::sync::OnceLock;

    use super::super::queue::kill_download_tree_blocking;

    type Handle = *mut c_void;
    type Bool = i32;
    type Dword = u32;

    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const TH32CS_SNAPPROCESS: Dword = 0x0000_0002;
    const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
    const PROCESS_SET_QUOTA: Dword = 0x0100;
    const PROCESS_TERMINATE: Dword = 0x0001;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    #[repr(C)]
    struct ProcessEntry32W {
        size: Dword,
        usage: Dword,
        process_id: Dword,
        default_heap_id: usize,
        module_id: Dword,
        threads: Dword,
        parent_process_id: Dword,
        pri_class_base: i32,
        flags: Dword,
        exe_file: [u16; 260],
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: Dword,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: Dword,
        affinity: usize,
        priority_class: Dword,
        scheduling_class: Dword,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: Dword, pid: Dword) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
        fn OpenProcess(access: Dword, inherit: Bool, pid: Dword) -> Handle;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: Dword,
            name: *mut u16,
            size: *mut Dword,
        ) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            len: Dword,
        ) -> Bool;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
        fn TerminateJobObject(job: Handle, code: Dword) -> Bool;
    }

    /// Lives as long as the launcher. `0` means the system refused a job (a
    /// restricted parent job); the transfer then falls back to the per-pid
    /// kill paths.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn job() -> Handle {
        *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() || job == INVALID_HANDLE_VALUE {
                return 0;
            }
            let mut info: ExtendedLimitInformation = zeroed();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &info as *const _ as *const c_void,
                size_of::<ExtendedLimitInformation>() as Dword,
            );
            if set == 0 {
                CloseHandle(job);
                return 0;
            }
            job as usize
        }) as Handle
    }

    pub(super) fn contain(pid: u32) {
        let job = job();
        if job.is_null() {
            return;
        }
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() || process == INVALID_HANDLE_VALUE {
                return;
            }
            let _ = AssignProcessToJobObject(job, process);
            CloseHandle(process);
        }
    }

    pub(super) fn terminate() {
        let job = JOB.get().copied().unwrap_or(0) as Handle;
        if !job.is_null() {
            unsafe {
                let _ = TerminateJobObject(job, 1);
            }
        }
    }

    pub(super) fn kill_matching(bin: &Path) -> usize {
        let wanted = normalize(&bin.to_string_lossy());
        if wanted.is_empty() {
            return 0;
        }
        let me = std::process::id();
        let mut pids = Vec::new();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
                return 0;
            }
            let mut entry: ProcessEntry32W = zeroed();
            entry.size = size_of::<ProcessEntry32W>() as Dword;
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let pid = entry.process_id;
                    if pid != me {
                        if let Some(image) = image_path(pid) {
                            if normalize(&image) == wanted {
                                pids.push(pid);
                            }
                        }
                    }
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
        for pid in &pids {
            kill_download_tree_blocking(*pid);
        }
        pids.len()
    }

    unsafe fn image_path(pid: u32) -> Option<String> {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() || process == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as Dword;
        let read = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(process);
        if read == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }

    /// One spelling for an image path: no `\\?\` prefix, no forward slashes,
    /// no trailing slash, case-insensitive.
    fn normalize(path: &str) -> String {
        path.trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }

    #[cfg(test)]
    mod tests {
        use super::normalize;

        #[test]
        fn one_image_path_spelling() {
            assert_eq!(
                normalize(
                    r"\\?\C:\Users\Efe\AppData\Roaming\com.efxlve.launcher\bin\legendary.exe"
                ),
                normalize(r"c:/users/efe/appdata/roaming/com.efxlve.launcher/bin/legendary.exe/")
            );
        }

        #[test]
        fn the_boot_sweep_ends_only_the_matching_binary() {
            use std::process::Command;
            use std::time::{Duration, Instant};

            let dir = std::env::temp_dir().join(format!("efxlve_sweep_{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            // A uniquely named copy, so the sweep cannot match a real process
            // on the machine (and the test cannot kill one).
            let copy = dir.join("legendary-leftover.exe");
            std::fs::copy(r"C:\Windows\System32\ping.exe", &copy).unwrap();
            let mut child = Command::new(&copy)
                .args(["-n", "30", "127.0.0.1"])
                .spawn()
                .expect("spawn the copy");
            let matched = super::kill_matching(&copy);
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut exited = false;
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    exited = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if !exited {
                let _ = child.kill();
            }
            let _ = std::fs::remove_dir_all(&dir);
            assert!(matched >= 1, "the sweep did not find the copied binary");
            assert!(exited, "the swept process survived");
        }

        #[test]
        fn the_job_ends_a_contained_child() {
            use std::process::Command;
            use std::time::{Duration, Instant};

            let mut child = Command::new("cmd")
                .args(["/C", "ping", "-n", "30", "127.0.0.1"])
                .spawn()
                .expect("spawn a long-running child");
            super::contain(child.id());
            super::terminate();
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut exited = false;
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    exited = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if !exited {
                let _ = child.kill();
            }
            assert!(exited, "the contained process survived job termination");
        }
    }
}
