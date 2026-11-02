//! The machine fingerprint EA's license service expects.
//!
//! Modern EA titles (Battlefield 2042 among them) ship `Core/Activation.dll`
//! with an activation version. Version 4 hashes the board, BIOS, C: volume,
//! GPU PNP id and CPU identity into the `machineHash` query parameter of the
//! license request. The parts and separators follow the EA client, not a
//! format of our own; a different string produces a license the game rejects.
//! The layout follows Maxima (GPL-3.0), checked against a license the EA app
//! wrote on the same machine.

use std::path::Path;

use sha1::{Digest, Sha1};

/// Hash string EA expects for one activation version.
pub(crate) fn hardware_hash(version: u32) -> Result<String, String> {
    let data = hash_input(version)?;
    let digest = Sha1::digest(data.as_bytes());
    Ok(if version < 4 {
        // The old EA builds formatted each SHA-1 byte without a leading zero.
        digest.iter().map(|byte| format!("{byte:x}")).collect()
    } else {
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    })
}

/// The exact semicolon-separated input to SHA-1.
pub(crate) fn hash_input(version: u32) -> Result<String, String> {
    let hardware = super::pcsign::hardware()?;
    let cpu = cpu_details();
    let gpu = gpu_id(&hardware.gpu_pnp_id);
    let volume = if hardware.volume_sn.is_empty() {
        "00000000".to_string()
    } else {
        hardware.volume_sn.to_ascii_lowercase()
    };

    let mut parts = vec![
        hardware.board_manufacturer,
        hardware.board_sn,
        hardware.bios_manufacturer,
        hardware.bios_sn,
    ];

    match version {
        1 => {
            parts.push(std::env::var("COMPUTERNAME").unwrap_or_default());
            parts.push(hardware.os_install_date);
            parts.push(hardware.os_sn);
        }
        2 => {
            parts.push(hardware.os_install_date);
            parts.push(hardware.os_sn);
            parts.push(volume);
            parts.push(gpu);
            parts.push(cpu.manufacturer);
            parts.push(format!("{:08x}", cpu.edx));
            parts.push(format!("{:08x}", cpu.ecx));
        }
        3 => {
            parts.push(volume);
            parts.push(gpu);
            parts.push(cpu.manufacturer);
            parts.push(format!("{:08x}", cpu.edx));
            parts.push(format!("{:08x}", cpu.ecx));
        }
        4.. => {
            parts.push(volume);
            parts.push(gpu);
            parts.push(cpu.manufacturer);
            parts.push(format!("{:08X}{:08X}", cpu.edx, cpu.eax));
        }
        _ => return Err("EA activation version 0 is not supported".into()),
    }

    let mut data = parts.join(";");
    data.push(';');
    if version >= 2 {
        data.push_str(&cpu.brand);
        data.push(';');
    }
    Ok(data)
}

/// The version of `Core/Activation.dll`, mapped to EA's hash generation.
pub(crate) fn activation_version(root: &Path) -> Result<u32, String> {
    let dll = root.join("Core/Activation.dll");
    if !dll.is_file() {
        return Ok(1);
    }
    version_from_path(&dll)
}

#[cfg(windows)]
fn version_from_path(dll: &Path) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;

    let script = format!(
        "(Get-Item '{}').VersionInfo.ProductVersion",
        dll.display()
    );
    let mut cmd = std::process::Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &script,
    ]);
    cmd.creation_flags(0x0800_0000);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("EA activation version query failed".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(version_from_text(&text))
}

#[cfg(not(windows))]
fn version_from_path(_dll: &Path) -> Result<u32, String> {
    Err("EA activation is Windows-only".into())
}

/// `5,02,19,131` or `5.2.19.131` to the hash generation.
fn version_from_text(text: &str) -> u32 {
    let mut parts = text
        .trim()
        .split(|c: char| c == ',' || c == '.')
        .filter_map(|part| part.trim().parse::<u32>().ok());
    let major = parts.next().unwrap_or(1);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);

    if major >= 5 {
        4
    } else if major == 4 && (minor > 7 || (minor == 7 && patch >= 6)) {
        3
    } else if major == 4 && minor == 7 {
        2
    } else if major == 4 {
        1
    } else {
        0
    }
}

struct CpuDetails {
    eax: u32,
    ecx: u32,
    edx: u32,
    manufacturer: String,
    brand: String,
}

#[cfg(target_arch = "x86_64")]
fn cpu_details() -> CpuDetails {
    use core::arch::x86_64::__cpuid;

    let manufacturer_leaf = __cpuid(0);
    let flags = __cpuid(1);

    let mut manufacturer = Vec::new();
    for value in [
        manufacturer_leaf.ebx,
        manufacturer_leaf.edx,
        manufacturer_leaf.ecx,
    ] {
        manufacturer.extend_from_slice(&value.to_ne_bytes());
    }

    let mut brand = Vec::with_capacity(47);
    'outer: for leaf in [0x8000_0002, 0x8000_0003, 0x8000_0004] {
        let part = __cpuid(leaf);
        for value in [part.eax, part.ebx, part.ecx, part.edx] {
            for byte in value.to_ne_bytes() {
                if byte == 0 {
                    break 'outer;
                }
                brand.push(byte);
            }
        }
    }
    brand.resize(47, 0);
    let brand = String::from_utf8_lossy(&brand)
        .trim_end_matches('\0')
        .to_string();

    CpuDetails {
        eax: flags.eax,
        ecx: flags.ecx,
        edx: flags.edx,
        manufacturer: String::from_utf8_lossy(&manufacturer).to_string(),
        brand,
    }
}

#[cfg(not(target_arch = "x86_64"))]
fn cpu_details() -> CpuDetails {
    CpuDetails {
        eax: 0,
        ecx: 0,
        edx: 0,
        manufacturer: "Unknown".into(),
        brand: "Unknown".into(),
    }
}

/// `PCI\VEN_...&DEV_...&SUBSYS_...&REV_...\4&...` keeps the device prefix.
fn gpu_id(pnp: &str) -> String {
    if pnp.trim().is_empty() {
        return "None".into();
    }
    pnp.rsplit_once('\\')
        .map(|(head, _)| head.to_string())
        .unwrap_or_else(|| pnp.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "prints the machine hash inputs for this machine"]
    fn manual_hash_parts() {
        for version in 1..=4 {
            match hash_input(version) {
                Ok(input) => {
                    println!("v{version} input: {input:?}");
                    println!(
                        "v{version} hash: {}",
                        hardware_hash(version).unwrap_or_default()
                    );
                }
                Err(err) => println!("v{version} err: {err}"),
            }
        }
    }

    #[test]
    fn activation_versions_map_to_the_hash_generation() {
        assert_eq!(version_from_text("5,02,19,131"), 4);
        assert_eq!(version_from_text("5.0.0.0"), 4);
        assert_eq!(version_from_text("4,7,6,0"), 3);
        assert_eq!(version_from_text("4,7,0,0"), 2);
        assert_eq!(version_from_text("4,0,0,0"), 1);
        assert_eq!(version_from_text("3,9,0,0"), 0);
    }

    #[test]
    fn a_gpu_pnp_id_keeps_only_the_device_prefix() {
        assert_eq!(
            gpu_id(r"PCI\VEN_10DE&DEV_2504&SUBSYS_00000000&REV_A1\4&2B3E"),
            r"PCI\VEN_10DE&DEV_2504&SUBSYS_00000000&REV_A1"
        );
        assert_eq!(gpu_id(""), "None");
    }
}
