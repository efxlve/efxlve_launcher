//! EA's PC signature for the login URL.
//!
//! EA asks every PC login to carry a hardware signature: a base64url JSON
//! payload (BIOS, board, disk and OS ids) plus an HMAC-SHA256 with a key that
//! ships inside the EA app. The fields, the key and the wire shape follow the
//! Galaxy EA Desktop integration; the launcher only reads what Windows already
//! exposes and never sends anything except this signature.

use base64::Engine;
use serde_json::json;
use sha2::{Digest, Sha256};

/// Signing keys used by the EA app builds (`v1`/`v2` payload versions).
const SIGN_KEY_V1: &[u8] = b"ISa3dpGOc8wW7Adn4auACSQmaccrOyR2";

const POWERSHELL_SCRIPT: &str = r#"
$ErrorActionPreference = "SilentlyContinue"
$bios = Get-CimInstance Win32_BIOS
$board = Get-CimInstance Win32_BaseBoard
$os = Get-CimInstance Win32_OperatingSystem
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -match "DEV_[0-9A-F]+" } | Select-Object -First 1
$disk = Get-CimInstance Win32_DiskDrive | Select-Object -First 1
$nic = Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True AND NetEnabled=True" | Where-Object { $_.MACAddress -and $_.ServiceName -notmatch "vmnetadapter|vboxnetadp|ndisip|tap|hyperv|loopback" } | Select-Object -First 1
$gid = 0
if ($gpu -and $gpu.PNPDeviceID -match "DEV_([0-9A-Fa-f]+)") { $gid = [Convert]::ToInt32($Matches[1], 16) }
$mac = ""
if ($nic -and $nic.MACAddress) { $clean = $nic.MACAddress -replace "[:\-]", ""; if ($clean) { $mac = "`$$($clean.ToLower())" } }
$osi = "1970-01-0100:00:00.000000000+0000"
try {
  $wmiOs = ([wmiclass]"Win32_OperatingSystem").GetInstances() | Select-Object -First 1
  if ($wmiOs) { $osi = $wmiOs.InstallDate }
} catch {}
[ordered]@{
  bbm = if ($bios.Manufacturer) { $bios.Manufacturer.Trim() } else { "None" }
  bsn = if ($bios.SerialNumber) { $bios.SerialNumber.Trim() } else { "None" }
  gid = $gid
  hsn = if ($disk.SerialNumber) { $disk.SerialNumber.Trim() } else { "None" }
  mac = $mac
  mbm = if ($board.Manufacturer) { $board.Manufacturer.Trim() } else { "None" }
  msn = if ($board.SerialNumber) { $board.SerialNumber.Trim() } else { "None" }
  osi = $osi
  osn = if ($os.SerialNumber) { $os.SerialNumber.Trim() } else { "None" }
} | ConvertTo-Json -Compress
"#;

/// FNV-1a 64-bit, the hash EA uses for the machine id.
pub(crate) fn fnv1a(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// HMAC-SHA256; the key is the short fixed EA key, so one block is enough.
pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key_block = [0u8; 64];
    if key.len() > 64 {
        key_block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    let mut outer = Sha256::new();
    let mut ipad = [0u8; 64];
    let mut opad = [0u8; 64];
    for i in 0..64 {
        ipad[i] = key_block[i] ^ 0x36;
        opad[i] = key_block[i] ^ 0x5c;
    }
    inner.update(ipad);
    inner.update(message);
    let digest = inner.finalize();
    outer.update(opad);
    outer.update(digest);
    outer.finalize().into()
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// UTC `YYYY-MM-DD HH:MM:SS:mmm`, the timestamp format EA expects.
pub(crate) fn timestamp(now: std::time::SystemTime) -> String {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let millis = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_millis())
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let day_secs = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = day_secs / 3600;
    let minute = (day_secs % 3600) / 60;
    let second = day_secs % 60;
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}:{millis:03}")
}

/// Howard Hinnant's civil-from-days, so the date math needs no extra crate.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Hardware ids collected in one PowerShell call.
#[derive(Debug, Clone, Default)]
pub(crate) struct Hardware {
    pub board_manufacturer: String,
    pub board_sn: String,
    pub bios_manufacturer: String,
    pub bios_sn: String,
    pub os_install_date: String,
    pub os_sn: String,
    pub disk_sn: String,
    pub gid: u32,
    pub mac: String,
}

impl Hardware {
    /// `mid`: FNV-1a over the board, BIOS, OS and MAC strings, decimal.
    pub(crate) fn mid(&self) -> String {
        let mut parts = format!(
            "{}{}{}{}{}{}",
            self.board_manufacturer,
            self.board_sn,
            self.bios_manufacturer,
            self.bios_sn,
            self.os_install_date,
            self.os_sn
        );
        if !self.mac.is_empty() {
            parts.push_str(&self.mac);
        }
        fnv1a(parts.as_bytes()).to_string()
    }
}

#[cfg(windows)]
pub(crate) fn hardware() -> Result<Hardware, String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        POWERSHELL_SCRIPT,
    ]);
    cmd.creation_flags(0x0800_0000);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("EA hardware query failed".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim()).map_err(|e| e.to_string())?;
    let field = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    Ok(Hardware {
        board_manufacturer: or_default(field("mbm"), "Microsoft Corporation"),
        board_sn: or_default(field("msn"), "None"),
        bios_manufacturer: or_default(field("bbm"), "Microsoft Corporation"),
        bios_sn: or_default(field("bsn"), "None"),
        os_install_date: or_default(field("osi"), "1970-01-0100:00:00.000000000+0000"),
        os_sn: or_default(field("osn"), "None"),
        disk_sn: or_default(field("hsn"), "None"),
        gid: value.get("gid").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        mac: field("mac"),
    })
}

#[cfg(not(windows))]
pub(crate) fn hardware() -> Result<Hardware, String> {
    Err("EA sign-in is Windows-only".into())
}

fn or_default(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

/// The `pc_sign` query parameter for `accounts.ea.com/connect/auth`.
pub(crate) fn generate() -> Result<String, String> {
    let hardware = hardware()?;
    let mut payload = json!({
        "av": "v1",
        "bsn": hardware.bios_sn,
        "gid": hardware.gid,
        "hsn": hardware.disk_sn,
        "mid": hardware.mid(),
        "msn": hardware.board_sn,
        "sv": "v1",
        "ts": timestamp(std::time::SystemTime::now()),
    });
    if !hardware.mac.is_empty() {
        payload["mac"] = serde_json::Value::String(hardware.mac.clone());
    }
    let body = b64(payload.to_string().as_bytes());
    let signature = hmac_sha256(SIGN_KEY_V1, body.as_bytes());
    Ok(format!("{body}.{}", b64(&signature)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231_case_1() {
        let key = [0x0bu8; 20];
        let expected = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";
        let digest = hmac_sha256(&key, b"Hi There");
        assert_eq!(digest.iter().map(|b| format!("{b:02x}")).collect::<String>(), expected);
    }

    #[test]
    fn machine_id_is_the_fnv1a_of_the_parts() {
        // Values captured from the reference plugin on the same machine.
        let hardware = Hardware {
            board_manufacturer: "Standard".into(),
            board_sn: "Standard".into(),
            bios_manufacturer: "American Megatrends International, LLC.".into(),
            bios_sn: "X6RP55712254606062".into(),
            os_install_date: "20260628195217.000000+180".into(),
            os_sn: "00330-80000-00000-AA666".into(),
            disk_sn: "0000_0000_0000_0001_00A0_7525_5486_DF4D.".into(),
            gid: 42891,
            mac: "$381868d51eb1".into(),
        };
        assert_eq!(hardware.mid(), "4036799374369070529");
    }

    #[test]
    fn timestamp_uses_utc_calendar_fields() {
        let unix = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_767_225_600_123);
        assert_eq!(timestamp(unix), "2026-01-01 00:00:00:123");
    }

    #[test]
    fn sign_has_a_decodable_payload_and_signature() {
        let hardware = Hardware {
            board_manufacturer: "Board".into(),
            board_sn: "SN1".into(),
            bios_manufacturer: "Bios".into(),
            bios_sn: "SN2".into(),
            os_install_date: "20260628195217.000000+180".into(),
            os_sn: "OS".into(),
            disk_sn: "DISK".into(),
            gid: 7,
            mac: "$001122334455".into(),
        };
        let body = b64(
            json!({
                "av": "v1",
                "bsn": hardware.bios_sn,
                "gid": hardware.gid,
                "hsn": hardware.disk_sn,
                "mid": hardware.mid(),
                "msn": hardware.board_sn,
                "sv": "v1",
                "ts": timestamp(std::time::SystemTime::now()),
                "mac": hardware.mac,
            })
            .to_string()
            .as_bytes(),
        );
        let signature = hmac_sha256(SIGN_KEY_V1, body.as_bytes());
        let sign = format!("{body}.{}", b64(&signature));
        let (payload, sig) = sign.split_once('.').unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(parsed["gid"], 7);
        assert_eq!(parsed["sv"], "v1");
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(sig).unwrap();
        assert_eq!(raw, signature.to_vec());
    }
}
