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
    /// PCI vendor id (0x10DE NVIDIA, 0x1002 AMD, 0x8086 Intel); 0 unknown.
    pub gpu_vendor_id: u32,
    /// PCI device id; 0 unknown.
    pub gpu_device_id: u32,
    /// Dedicated video memory in MiB; 0 when unknown or shared.
    pub gpu_memory_mb: u64,
    /// "DirectX 12 (12_1)" or empty when the feature level cannot be read.
    pub directx: String,
    /// Highest D3D12/D3D11 feature level: 122, 121, 120, 111, 110… / 0.
    pub directx_level: u32,
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

    let (gpu, gpu_memory_mb, gpu_vendor_id, gpu_device_id, directx, directx_level) =
        gpu_and_directx();

    PcCheckSystem {
        os,
        os_version,
        arch: std::env::consts::ARCH.to_string(),
        cpu,
        physical_cores,
        logical_cores,
        memory_mb: system.total_memory() / (1024 * 1024),
        gpu,
        gpu_vendor_id,
        gpu_device_id,
        gpu_memory_mb: nominal_vram_mb(gpu_memory_mb),
        directx,
        directx_level,
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

/// The GPU a game would actually use, plus the DirectX level of that adapter.
/// DXGI picks the adapter with the most dedicated VRAM, so a laptop's discrete
/// GPU wins over the integrated one; registry text is only a fallback.
#[cfg(windows)]
fn gpu_and_directx() -> (String, u64, u32, u32, String, u32) {
    if let Some((name, vendor, device, memory_mb, adapter)) = dxgi_gpu() {
        let (directx, level) = directx_info(Some(&adapter));
        return (name, memory_mb, vendor, device, directx, level);
    }
    let (gpu, memory_mb) = gpu_adapters();
    let (directx, level) = directx_info(None);
    (gpu, memory_mb, 0, 0, directx, level)
}

#[cfg(not(windows))]
fn gpu_and_directx() -> (String, u64, u32, u32, String, u32) {
    let (gpu, memory_mb) = gpu_adapters();
    (gpu, memory_mb, 0, 0, String::new(), 0)
}

#[cfg(windows)]
fn dxgi_gpu() -> Option<(
    String,
    u32,
    u32,
    u64,
    windows::Win32::Graphics::Dxgi::IDXGIAdapter1,
)> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_DESC1,
        DXGI_ADAPTER_FLAG_SOFTWARE,
    };

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    let mut best: Option<(IDXGIAdapter1, DXGI_ADAPTER_DESC1)> = None;
    for index in 0..16 {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
            break;
        };
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        if best
            .as_ref()
            .map_or(true, |(_, current)| {
                desc.DedicatedVideoMemory > current.DedicatedVideoMemory
            })
        {
            best = Some((adapter, desc));
        }
    }

    let (adapter, desc) = best?;
    let name = String::from_utf16_lossy(&desc.Description)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    if name.is_empty() {
        return None;
    }
    Some((
        name,
        desc.VendorId,
        desc.DeviceId,
        (desc.DedicatedVideoMemory as u64) / (1024 * 1024),
        adapter,
    ))
}

#[cfg(windows)]
fn directx_info(
    adapter: Option<&windows::Win32::Graphics::Dxgi::IDXGIAdapter1>,
) -> (String, u32) {
    let level = d3d12_feature_level(adapter).max(d3d11_feature_level(adapter));
    (directx_name(level), level)
}

/// DXGI reports a little less than the physical chips (driver-reserved memory),
/// so an 8 GB card lands around 7891 MiB. Report the size the card is sold as;
/// 7.7 GB is not a real SKU and makes the comparison look wrong.
fn nominal_vram_mb(reported_mb: u64) -> u64 {
    if reported_mb == 0 {
        return 0;
    }
    const SIZES_GB: [u64; 12] = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32];
    let reported_gb = reported_mb as f64 / 1024.0;
    for size in SIZES_GB {
        let tolerance = (size as f64 * 0.08).max(0.5);
        if (reported_gb - size as f64).abs() <= tolerance {
            return size * 1024;
        }
    }
    reported_mb
}

fn directx_name(level: u32) -> String {
    match level {
        122 => "DirectX 12 (12_2)".to_string(),
        121 => "DirectX 12 (12_1)".to_string(),
        120 => "DirectX 12 (12_0)".to_string(),
        111 => "DirectX 11.1".to_string(),
        110 => "DirectX 11".to_string(),
        101 => "DirectX 10.1".to_string(),
        100 => "DirectX 10".to_string(),
        93 => "DirectX 9.3".to_string(),
        92 => "DirectX 9.2".to_string(),
        91 => "DirectX 9.1".to_string(),
        _ => String::new(),
    }
}

#[cfg(windows)]
fn d3d12_feature_level(adapter: Option<&windows::Win32::Graphics::Dxgi::IDXGIAdapter1>) -> u32 {
    use windows::core::Interface;
    use windows::Win32::Graphics::Direct3D::{
        D3D_FEATURE_LEVEL_12_0, D3D_FEATURE_LEVEL_12_1, D3D_FEATURE_LEVEL_12_2,
    };
    use windows::Win32::Graphics::Direct3D12::{D3D12CreateDevice, ID3D12Device};

    let device_owner = adapter.and_then(|adapter| adapter.cast::<windows::core::IUnknown>().ok());
    for (level, value) in [
        (D3D_FEATURE_LEVEL_12_2, 122u32),
        (D3D_FEATURE_LEVEL_12_1, 121u32),
        (D3D_FEATURE_LEVEL_12_0, 120u32),
    ] {
        let mut device: Option<ID3D12Device> = None;
        if unsafe { D3D12CreateDevice(device_owner.as_ref(), level, &mut device) }.is_ok() {
            return value;
        }
    }
    0
}

#[cfg(windows)]
fn d3d11_feature_level(adapter: Option<&windows::Win32::Graphics::Dxgi::IDXGIAdapter1>) -> u32 {
    use windows::core::Interface;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0,
        D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_9_1, D3D_FEATURE_LEVEL_9_2, D3D_FEATURE_LEVEL_9_3,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_CREATE_DEVICE_FLAG, D3D11_SDK_VERSION, ID3D11Device,
        ID3D11DeviceContext,
    };
    use windows::Win32::Graphics::Dxgi::IDXGIAdapter;

    let adapter = adapter.and_then(|adapter| adapter.cast::<IDXGIAdapter>().ok());
    let levels = [
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
        D3D_FEATURE_LEVEL_9_3,
        D3D_FEATURE_LEVEL_9_2,
        D3D_FEATURE_LEVEL_9_1,
    ];
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let mut found = D3D_FEATURE_LEVEL(0);
    let result = unsafe {
        D3D11CreateDevice(
            adapter.as_ref(),
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut found),
            Some(&mut context),
        )
    };
    if result.is_err() {
        return 0;
    }
    if found == D3D_FEATURE_LEVEL_11_1 {
        111
    } else if found == D3D_FEATURE_LEVEL_11_0 {
        110
    } else if found == D3D_FEATURE_LEVEL_10_1 {
        101
    } else if found == D3D_FEATURE_LEVEL_10_0 {
        100
    } else if found == D3D_FEATURE_LEVEL_9_3 {
        93
    } else if found == D3D_FEATURE_LEVEL_9_2 {
        92
    } else if found == D3D_FEATURE_LEVEL_9_1 {
        91
    } else {
        0
    }
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
    fn directx_feature_levels_are_named() {
        assert_eq!(super::directx_name(122), "DirectX 12 (12_2)");
        assert_eq!(super::directx_name(120), "DirectX 12 (12_0)");
        assert_eq!(super::directx_name(110), "DirectX 11");
        assert_eq!(super::directx_name(0), "");
    }

    #[test]
    fn vram_is_reported_as_the_nominal_size() {
        assert_eq!(super::nominal_vram_mb(7891), 8192);
        assert_eq!(super::nominal_vram_mb(8151), 8192);
        assert_eq!(super::nominal_vram_mb(6144), 6144);
        assert_eq!(super::nominal_vram_mb(0), 0);
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
