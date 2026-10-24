//! Offline system facts for Settings > System > PC check.
//!
//! The check never uploads anything. This module only reads what the OS already
//! exposes; the frontend adds the browser-side checks (WebView2, storage,
//! network) and renders the report.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcCheckSystem {
    /// "Windows 11 Pro" or the kernel name on other platforms.
    pub os: String,
    /// "24H2 (build 26100)" when the OS reports it.
    pub os_version: String,
    /// "x86_64", "aarch64"…
    pub arch: String,
    /// CPU brand string; empty when the OS does not expose it.
    pub cpu: String,
    pub physical_cores: usize,
    pub logical_cores: usize,
    /// Installed memory in MiB.
    pub memory_mb: u64,
    /// Display adapter name; empty when it cannot be read.
    pub gpu: String,
    /// Dedicated video memory in MiB; 0 when unknown or shared.
    pub gpu_memory_mb: u64,
    pub app_version: String,
}

#[tauri::command]
pub fn pc_check_system() -> PcCheckSystem {
    let mut system = sysinfo::System::new();
    system.refresh_cpu_all();
    system.refresh_memory();

    let os = sysinfo::System::long_os_version()
        .filter(|value| !value.trim().is_empty())
        .or_else(sysinfo::System::name)
        .unwrap_or_default();
    let version = sysinfo::System::os_version().unwrap_or_default();
    let kernel = sysinfo::System::kernel_version().unwrap_or_default();
    let os_version = if cfg!(windows) {
        let (display, build) = windows_release();
        match (display.is_empty(), build.is_empty()) {
            (false, false) => format!("{display} (build {build})"),
            (false, true) => display,
            (true, false) => format!("build {build}"),
            (true, true) => String::new(),
        }
    } else {
        match (version.is_empty(), kernel.is_empty()) {
            (false, false) => format!("{version} (kernel {kernel})"),
            (false, true) => version,
            (true, false) => format!("kernel {kernel}"),
            (true, true) => String::new(),
        }
    };

    let cpus = system.cpus();
    let cpu = cpus
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .unwrap_or_default();
    let logical_cores = cpus.len();
    let physical_cores = system.physical_core_count().unwrap_or(logical_cores);

    let (gpu, gpu_memory_mb) = gpu_adapters();

    PcCheckSystem {
        os,
        os_version,
        arch: std::env::consts::ARCH.to_string(),
        cpu,
        physical_cores,
        logical_cores,
        memory_mb: system.total_memory() / (1024 * 1024),
        gpu,
        gpu_memory_mb,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[cfg(windows)]
fn windows_release() -> (String, String) {
    let key = r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let read = |value: &str| {
        crate::winreg::query(key, Some(value))
            .map(|output| crate::winreg::parse_reg_sz(&output))
            .unwrap_or_default()
    };
    (read("DisplayVersion"), read("CurrentBuild"))
}

#[cfg(not(windows))]
fn windows_release() -> (String, String) {
    (String::new(), String::new())
}

/// Reads the display adapters from the Windows display class key.
///
/// `reg query` is already the project's registry tool: it needs no new crate and
/// no elevation. Virtual and fallback adapters are skipped so the report names
/// the GPU a game would actually use.
#[cfg(windows)]
fn gpu_adapters() -> (String, u64) {
    const DISPLAY_CLASS: &str =
        r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let mut names: Vec<String> = Vec::new();
    if let Some(output) = crate::winreg::query_all(DISPLAY_CLASS, "DriverDesc") {
        for line in output.lines() {
            let name = crate::winreg::parse_reg_sz(line);
            if name.is_empty() || is_virtual_adapter(&name) {
                continue;
            }
            if !names.iter().any(|known| known.eq_ignore_ascii_case(&name)) {
                names.push(name);
            }
        }
    }

    let mut vram = 0u64;
    for value in ["HardwareInformation.qwMemorySize", "HardwareInformation.MemorySize"] {
        if let Some(output) = crate::winreg::query_all(DISPLAY_CLASS, value) {
            vram = vram.max(parse_reg_memory(&output));
        }
    }

    // A laptop reports both its discrete and integrated adapter; the first
    // non-integrated one is the GPU a game uses.
    let primary = names
        .iter()
        .find(|name| !is_integrated_adapter(name))
        .or_else(|| names.first());
    (primary.cloned().unwrap_or_default(), vram / (1024 * 1024))
}

#[cfg(windows)]
fn is_integrated_adapter(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["uhd graphics", "hd graphics", "iris", "vega", "radeon(tm) graphics"]
        .iter()
        .any(|marker| lower.contains(marker))
}

#[cfg(windows)]
fn is_virtual_adapter(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "basic display",
        "basic render",
        "remote display",
        "indirect display",
        "virtual",
        "parsec",
        "spacedesk",
        "idd",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

/// Highest `REG_QWORD`/`REG_DWORD` value in `reg query` output, in bytes.
///
/// `reg` prints both as `0x…`; older drivers store a DWORD where newer ones use
/// a QWORD, so both names are read and the largest wins.
#[cfg(windows)]
fn parse_reg_memory(output: &str) -> u64 {
    output
        .lines()
        .filter_map(|line| line.split_once("REG_").map(|(_, rest)| rest))
        .filter_map(|rest| {
            let data = rest.split_whitespace().nth(1)?;
            let raw = data.trim().trim_start_matches("0x");
            u64::from_str_radix(raw, 16).ok()
        })
        .max()
        .unwrap_or(0)
}

#[cfg(not(windows))]
fn gpu_adapters() -> (String, u64) {
    (String::new(), 0)
}

#[cfg(all(test, windows))]
mod tests {
    use super::parse_reg_memory;

    #[test]
    fn the_largest_memory_value_wins() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\...\\0000\r\n    HardwareInformation.MemorySize    REG_DWORD    0x80000000\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x0000000140000000\r\n";
        assert_eq!(parse_reg_memory(output), 0x1_4000_0000);
    }

    #[test]
    fn a_missing_memory_value_is_zero() {
        assert_eq!(parse_reg_memory("no value here"), 0);
    }

    #[test]
    fn system_facts_are_read() {
        let info = super::pc_check_system();
        assert!(!info.os.is_empty());
        assert!(info.logical_cores > 0);
        assert!(info.memory_mb > 0);
        println!("{info:?}");
    }
}
