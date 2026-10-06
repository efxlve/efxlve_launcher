//! Network path diagnostics for cloud saves.
//!
//! A path that carries smaller packets than the interface MTU black-holes
//! large uploads while handshakes and downloads still work: the user sees
//! Epic's `CS-UL-0` or a stalling sync. The probe measures the real path MTU
//! with `ping -f` (the exit code is language-independent), and the fix applies
//! the standard `netsh` change with one elevated command.

use std::process::Stdio;

use serde::Serialize;

/// Epic's save storage: the host the sync uploads chunks to.
const SAVE_HOST: &str = "datastorage-public-service-liveegs.live.use1a.on.epicgames.com";
/// Fallback probe target when the save host cannot be resolved.
const FALLBACK_IP: &str = "1.1.1.1";
/// Smallest payload assumed to fit everywhere; a path below this is not a
/// black hole but a broken link.
const MIN_PAYLOAD: u32 = 1200;
/// Probe granularity: MTUs are reported in 8-byte steps.
const STEP: u32 = 8;
/// Per-ping wait; a dropped packet answers after this.
const PING_TIMEOUT_MS: &str = "1500";

/// Result of a path-MTU probe.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MtuProbe {
    /// Interface the default route uses.
    pub interface: String,
    /// MTU the interface advertises.
    pub interface_mtu: u32,
    /// Largest IP packet the path actually carries; 0 when the probe found
    /// nothing (the host may simply not answer ICMP).
    pub path_mtu: u32,
    /// True when the interface sends bigger packets than the path carries.
    pub broken: bool,
    /// Interface MTU that fixes it (the measured path MTU).
    pub suggested_mtu: u32,
}

/// Runs `ping -f` once; exit code 0 means the packet fit the path.
async fn ping_fits(ip: &str, payload: u32) -> bool {
    let mut cmd = tokio::process::Command::new("ping");
    cmd.args(["-n", "1", "-w", PING_TIMEOUT_MS, "-f", "-l", &payload.to_string(), ip]);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    matches!(cmd.status().await, Ok(status) if status.success())
}

/// Default-route interface name and its configured MTU.
async fn default_route() -> Result<(String, u32), String> {
    let script = "$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1; \
                  $i = Get-NetIPInterface -InterfaceAlias $r.InterfaceAlias -AddressFamily IPv4 | Select-Object -First 1; \
                  [pscustomobject]@{ iface = $r.InterfaceAlias; mtu = [int]$i.NlMtu } | ConvertTo-Json -Compress";
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim()).map_err(|e| e.to_string())?;
    let interface = value.get("iface").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mtu = value.get("mtu").and_then(|v| v.as_u64()).unwrap_or(1500) as u32;
    if interface.is_empty() || mtu < MIN_PAYLOAD {
        return Err("no default route".into());
    }
    Ok((interface, mtu))
}

/// IPv4 address of the save host, resolved without the async net feature.
fn resolve_save_host() -> Option<String> {
    use std::net::ToSocketAddrs;
    (SAVE_HOST, 443u16)
        .to_socket_addrs()
        .ok()?
        .find(|addr| addr.is_ipv4())
        .map(|addr| addr.ip().to_string())
}

/// Largest payload the path carries between the known-good floor and `max`.
async fn measure(ip: &str, max: u32) -> u32 {
    if !ping_fits(ip, MIN_PAYLOAD).await {
        return 0;
    }
    if max <= MIN_PAYLOAD || ping_fits(ip, max).await {
        return max.max(MIN_PAYLOAD);
    }
    // Binary search the boundary; `ok` always fits, `bad` never does.
    let mut ok = MIN_PAYLOAD;
    let mut bad = max;
    while bad - ok > STEP {
        let mid = ok + ((bad - ok) / 2 / STEP) * STEP;
        if mid <= ok {
            break;
        }
        if ping_fits(ip, mid).await {
            ok = mid;
        } else {
            bad = mid;
        }
    }
    ok
}

/// Measures the real path MTU and whether the interface overshoots it.
#[tauri::command]
pub async fn net_mtu_probe() -> Result<MtuProbe, String> {
    let (interface, interface_mtu) = default_route().await?;
    let ip = tokio::task::spawn_blocking(resolve_save_host)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| FALLBACK_IP.to_string());
    // The interface may advertise 1500 while the path only carries less; the
    // probe measures the IP packet size the path really accepts.
    let payload = measure(&ip, interface_mtu.saturating_sub(28)).await;
    let path_mtu = if payload == 0 { 0 } else { payload + 28 };
    let broken = path_mtu > 0 && path_mtu < interface_mtu;
    Ok(MtuProbe {
        interface,
        interface_mtu,
        path_mtu,
        broken,
        suggested_mtu: path_mtu,
    })
}

/// GUID of the adapter behind one interface alias, for the registry MTU.
async fn interface_guid(interface: &str) -> Option<String> {
    let alias = interface.replace('\'', "''");
    let script = format!("(Get-NetAdapter -InterfaceAlias '{alias}' -ErrorAction SilentlyContinue).InterfaceGuid");
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.ok()?;
    let guid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`
    (guid.len() == 38 && guid.starts_with('{') && guid.ends_with('}')).then_some(guid)
}

/// Applies the interface MTU with one elevated `netsh` run (UAC prompt).
#[tauri::command]
pub async fn net_mtu_fix(interface: String, mtu: u32) -> Result<(), String> {
    if !(MIN_PAYLOAD + 28..=1500).contains(&mtu) {
        return Err("invalid MTU".into());
    }
    if interface.trim().is_empty() || interface.contains(['"', '\'', '\r', '\n', '&', '|', '<', '>', '^']) {
        return Err("invalid interface".into());
    }
    // A temp script keeps the elevated command free of quoting problems.
    let script = std::env::temp_dir().join("efxlve-set-mtu.cmd");
    let mut body =
        format!("netsh interface ipv4 set subinterface \"{interface}\" mtu={mtu} store=persistent\r\n");
    // Network services can revert the netsh value on a reconnect; the registry
    // entry survives and is re-applied when the interface comes up.
    if let Some(guid) = interface_guid(&interface).await {
        body.push_str(&format!(
            "reg add \"HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{guid}\" /v MTU /t REG_DWORD /d {mtu} /f\r\n"
        ));
    }
    std::fs::write(&script, body).map_err(|e| e.to_string())?;
    let ps = format!(
        "$p = Start-Process -FilePath '{}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
        script.display()
    );
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if detail.is_empty() { "elevation declined".into() } else { detail })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_ceiling_leaves_room_for_the_ip_header() {
        // A 1500-byte interface asks for a 1472-byte payload (20 IP + 8 ICMP).
        assert_eq!(1500u32.saturating_sub(28), 1472);
        assert!(MIN_PAYLOAD < 1472);
        assert_eq!(STEP % 8, 0);
    }
}
