//! Suspend and resume a Windows process tree (GOG download pause).
//!
//! gogdl can spawn worker processes; pausing only the parent leaves them
//! writing. The tree is walked from Toolhelp, then `NtSuspendProcess` /
//! `NtResumeProcess` is applied to every process we can open.
//!
//! FFI signatures match `legendary::transfers` so the two modules do not clash.

#![cfg(windows)]

use std::collections::HashSet;
use std::mem::{size_of, zeroed};

type HANDLE = *mut std::ffi::c_void;
type BOOL = i32;
type DWORD = u32;

const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
const TH32CS_SNAPPROCESS: DWORD = 0x0000_0002;
const PROCESS_SUSPEND_RESUME: DWORD = 0x0800;

#[repr(C)]
struct PROCESSENTRY32W {
    dw_size: DWORD,
    cnt_usage: DWORD,
    th32_process_id: DWORD,
    th32_default_heap_id: usize,
    th32_module_id: DWORD,
    cnt_threads: DWORD,
    th32_parent_process_id: DWORD,
    pc_pri_class_base: i32,
    dw_flags: DWORD,
    sz_exe_file: [u16; 260],
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(dwFlags: DWORD, th32ProcessID: DWORD) -> HANDLE;
    fn Process32FirstW(hSnapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
    fn Process32NextW(hSnapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
    fn CloseHandle(hObject: HANDLE) -> BOOL;
    fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
}

#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(process_handle: HANDLE) -> i32;
    fn NtResumeProcess(process_handle: HANDLE) -> i32;
}

fn process_tree(root: u32) -> Vec<u32> {
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return vec![root];
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dw_size = size_of::<PROCESSENTRY32W>() as DWORD;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                pairs.push((entry.th32_process_id, entry.th32_parent_process_id));
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }

    let mut keep = HashSet::from([root]);
    let mut grew = true;
    while grew {
        grew = false;
        for (pid, ppid) in &pairs {
            if keep.contains(ppid) && keep.insert(*pid) {
                grew = true;
            }
        }
    }
    let mut out: Vec<u32> = keep.into_iter().collect();
    if !out.contains(&root) {
        out.push(root);
    }
    out
}

fn apply(pids: &[u32], suspend: bool) -> Result<(), String> {
    let mut opened = 0u32;
    for pid in pids {
        unsafe {
            let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, *pid);
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                continue;
            }
            opened += 1;
            let status = if suspend {
                NtSuspendProcess(handle)
            } else {
                NtResumeProcess(handle)
            };
            CloseHandle(handle);
            if status != 0 && *pid == pids[0] {
                return Err(format!("process control failed (0x{status:x})"));
            }
        }
    }
    if opened == 0 {
        return Err("@t:gog.notDownloading".to_string());
    }
    Ok(())
}

pub fn suspend_tree(root: u32) -> Result<(), String> {
    apply(&process_tree(root), true)
}

pub fn resume_tree(root: u32) -> Result<(), String> {
    apply(&process_tree(root), false)
}
