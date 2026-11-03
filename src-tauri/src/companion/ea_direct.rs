//! Direct launch for installed EA games.
//!
//! The EA app does three jobs a game expects: it authenticates the player, it
//! hands the game a license, and it sets a launch environment. This module
//! reuses the access token the companion login already stores, reads the
//! executable and content id from the game's own `installerdata.xml`, and sets
//! the same environment the EA client would set. It never writes the EA app's
//! registry keys, takes over a protocol or installs a service; the caller keeps
//! the `origin2://` handoff as the fallback when a fact is missing.
//!
//! Pre-DiP manifests (`<game>` roots) are rejected. DiP titles that still ship
//! `Core/activation.exe` get the same signed `.dlf` through EA's official
//! license service; this legacy activation path is experimental and falls back
//! to the EA App when the license call fails.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::FoundGame;

/// The launch facts one installed game carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LaunchPlan {
    pub exe: PathBuf,
    pub work_dir: PathBuf,
    pub args: Vec<String>,
    pub content_id: String,
    pub eaac: bool,
    /// The game ships the activation runtime that expects a license.
    pub ooa: bool,
}

/// Why a game cannot use the direct path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlanError {
    NotInstalled,
    NoManifest,
    UndecodableManifest,
    NoLauncher,
    MissingExe(String),
    OutsideInstall,
    NoContentId,
    OldDrm,
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::NotInstalled => write!(f, "the game folder is missing"),
            PlanError::NoManifest => write!(f, "installerdata.xml is missing"),
            PlanError::UndecodableManifest => write!(f, "installerdata.xml is not UTF-8 or UTF-16"),
            PlanError::NoLauncher => write!(f, "installerdata.xml has no runtime launcher"),
            PlanError::MissingExe(path) => write!(f, "the launcher `{path}` is missing"),
            PlanError::OutsideInstall => write!(f, "the launcher points outside the game folder"),
            PlanError::NoContentId => write!(f, "the game has no content id"),
            PlanError::OldDrm => write!(f, "the manifest uses the pre-DiP format"),
        }
    }
}

/// What the UI and the support report see: a plan, or the first missing fact.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EaDirectProbe {
    pub ok: bool,
    pub reason: String,
    pub exe: String,
    pub work_dir: String,
    pub content_id: String,
    pub eaac: bool,
    /// The game ships the activation runtime that expects a license.
    pub ooa: bool,
    pub args: Vec<String>,
    /// Environment variable names only; token values never leave Rust.
    pub env: Vec<String>,
}

/// Last direct-launch failure, kept for the Integrations page.
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn last_error() -> Option<String> {
    LAST_ERROR
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .filter(|text| !text.is_empty())
}

pub(crate) fn remember_error(message: &str) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = Some(message.to_string());
    }
}

fn clear_error() {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = None;
    }
}

/// Reads the launch facts out of `__Installer/installerdata.xml`.
///
/// The manifest is the game's own installer record: the EA app reads the same
/// file, so a game installed by either client resolves the same way. Old
/// activation-DRM titles are rejected until their license path exists.
pub(crate) fn plan(install_path: &str, store_id: &str) -> Result<LaunchPlan, PlanError> {
    let root = Path::new(install_path);
    if !root.is_dir() {
        return Err(PlanError::NotInstalled);
    }

    let manifest = root.join("__Installer").join("installerdata.xml");
    let bytes = std::fs::read(&manifest).map_err(|_| PlanError::NoManifest)?;
    let text = decode(&bytes).ok_or(PlanError::UndecodableManifest)?;

    let content_id = store_id
        .split(',')
        .map(str::trim)
        .find(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| {
            super::ea::content_ids(&text)
                .into_iter()
                .find(|id| !id.trim().is_empty())
        })
        .ok_or(PlanError::NoContentId)?;

    // Dead Space 2, BFBC2 and the other pre-DiP titles carry a `<game>` root
    // and an `<executable>` touchup, not the `<DiPManifest>` runtime record.
    if !is_dip_manifest(&text) {
        return Err(PlanError::OldDrm);
    }

    let (launcher, args) = launcher_entry(&text).ok_or(PlanError::NoLauncher)?;
    let relative = relative_path(&launcher);

    let root = root.canonicalize().map_err(|_| PlanError::NotInstalled)?;
    let exe = root.join(&relative);
    let exe = exe
        .canonicalize()
        .map_err(|_| PlanError::MissingExe(relative.to_string_lossy().to_string()))?;
    if !exe.starts_with(&root) {
        return Err(PlanError::OutsideInstall);
    }

    let ooa = ooa_state(&root)
        || exe
            .parent()
            .map(ooa_state)
            .unwrap_or(false);
    Ok(LaunchPlan {
        exe,
        work_dir: root.clone(),
        args,
        content_id,
        eaac: eaac_launcher(&root).is_some(),
        ooa,
    })
}

/// Builds the environment the EA app sets before it starts a game.
///
/// The values follow the EA client's own launch block. `EALicenseToken` is the
/// app's offline placeholder; the account token is what the game and EA's
/// backend use for entitlement and presence. No value is logged.
pub(crate) fn environment(
    access: &str,
    launch_token: &str,
    player: &str,
    locale: &str,
    plan: &LaunchPlan,
) -> Vec<(String, String)> {
    let player = if player.trim().is_empty() {
        "Player"
    } else {
        player.trim()
    };
    let locale = if locale.trim().is_empty() {
        "en_US"
    } else {
        locale.trim()
    };

    vec![
        ("EAAuthCode".into(), "NeedsAFreshAuthCode".into()),
        ("EAAccessTokenJWS".into(), access.into()),
        ("EAConnectionId".into(), plan.content_id.clone()),
        ("EAEntitlementSource".into(), "EA".into()),
        ("EAEgsProxyIpcPort".into(), "1705".into()),
        ("EAExternalSource".into(), "EA".into()),
        ("EAFreeTrialGame".into(), "false".into()),
        ("EAGameLocale".into(), locale.into()),
        ("EAGenericAuthToken".into(), access.into()),
        ("EALaunchCode".into(), "unavailable".into()),
        ("EALaunchEAID".into(), player.into()),
        ("EALaunchEnv".into(), "production".into()),
        ("EALaunchOfflineMode".into(), "false".into()),
        ("EALaunchOwner".into(), "EA".into()),
        ("EALaunchUserAuthToken".into(), launch_token.into()),
        ("EALicenseToken".into(), "Origin.OFR.50.0000721".into()),
        ("EALsxPort".into(), "3216".into()),
        ("EARtPLaunchCode".into(), rtp_handshake().to_string()),
        ("EASecureLaunchTokenTemp".into(), "1001006949032".into()),
        ("EASteamProxyIpcPort".into(), "1704".into()),
        ("EAUseIGOAPI".into(), "1".into()),
        ("ContentId".into(), plan.content_id.clone()),
        ("OPENSSL_ia32cap".into(), "~0x200000200000000".into()),
        ("OriginSessionKey".into(), session_key()),
    ]
}

/// Starts one game and returns its process id.
///
/// EAAC titles start through EA's own anti-cheat launcher, exactly as the EA
/// app does, so the signed component is the one that loads the game. The child
/// is detached: it outlives this call on Windows.
pub(crate) async fn launch(game: &FoundGame) -> Result<u32, String> {
    match plan(&game.install_path, &game.store_id) {
        Ok(plan) => launch_plan(plan).await,
        Err(PlanError::OldDrm) => {
            // Pre-DiP titles carry their executable in EA's legacy catalog
            // (`executePathOverride`), not in the local DiP manifest.
            let Some((execute, parameters)) = super::ea_login::legacy_launch_for(game) else {
                return Err(PlanError::OldDrm.to_string());
            };
            let plan = legacy_plan(&game.install_path, &game.store_id, &execute, &parameters)?;
            launch_plan(plan).await
        }
        Err(error) => Err(error.to_string()),
    }
}

/// The same launch from an install folder and a content id, for callers that
/// already resolved the game without a `FoundGame`.
pub(crate) async fn launch_path(install_path: &str, store_id: &str) -> Result<u32, String> {
    let plan = plan(install_path, store_id).map_err(|err| err.to_string())?;
    launch_plan(plan).await
}

/// Builds a launch plan from the legacy catalog's execute path and arguments.
fn legacy_plan(
    install_path: &str,
    store_id: &str,
    execute: &str,
    parameters: &str,
) -> Result<LaunchPlan, String> {
    let root = Path::new(install_path);
    let content_id = store_id
        .split(',')
        .map(str::trim)
        .find(|id| !id.is_empty())
        .ok_or_else(|| PlanError::NoContentId.to_string())?
        .to_string();
    let exe = resolve_legacy_path(root, execute)?;
    let work_dir = exe
        .parent()
        .ok_or_else(|| "EA legacy executable has no parent".to_string())?
        .to_path_buf();
    let parameters = parameters
        .replace("{installLocation}", &root.to_string_lossy())
        .replace("{locale}", "en_US");
    Ok(LaunchPlan {
        exe,
        work_dir,
        args: split_args(&parameters),
        content_id,
        eaac: eaac_launcher(root).is_some(),
        ooa: ooa_state(root),
    })
}

/// Reads a legacy registry value, trying the 32-bit view on 64-bit Windows.
fn legacy_registry_value(key: &str, value: &str) -> Option<String> {
    let alternate = key.replacen(r"\SOFTWARE\", r"\SOFTWARE\WOW6432Node\", 1);
    let mut keys = vec![key];
    if alternate != key && !key.contains("WOW6432Node") {
        keys.push(&alternate);
    }
    for key in keys {
        if let Some(output) = crate::winreg::query(key, Some(value)) {
            let text = crate::winreg::parse_reg_sz(&output);
            let text = text.trim_matches('"').trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

/// Resolves a plain, relative or `[registry key]suffix` legacy execute path.
fn resolve_legacy_path(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("EA legacy launcher path is empty".into());
    }
    let path = if let Some(rest) = raw.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or_else(|| "EA legacy registry path is malformed".to_string())?;
        let inside = &rest[..end];
        let split = inside
            .rfind('\\')
            .ok_or_else(|| "EA legacy registry path is malformed".to_string())?;
        let key = &inside[..split];
        let value = &inside[split + 1..];
        let suffix = rest[end + 1..].trim_start_matches(['\\', '/']);
        let base = legacy_registry_value(key, value)
            .ok_or_else(|| format!("EA legacy registry value not found: {key}\\{value}"))?;
        PathBuf::from(base).join(suffix.replace('/', std::path::MAIN_SEPARATOR_STR))
    } else {
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let path = path
        .canonicalize()
        .map_err(|error| format!("EA legacy executable: {error}"))?;
    if !path.is_file() {
        return Err(format!("EA legacy executable is missing: {}", path.display()));
    }
    Ok(path)
}

async fn launch_plan(plan: LaunchPlan) -> Result<u32, String> {
    // EAAC/Javelin verifies the EA client service; stopping it for a direct
    // launch is an invalid configuration and the game refuses to start. Those
    // titles keep the normal EA app handoff.
    if plan.eaac {
        return Err("EA anti-cheat titles need the EA app".into());
    }
    let access = super::ea_login::ensure_access().await?;

    // Frostbite titles read a signed license before the game window exists.
    // A missing license is exactly the "sign in with your EA account" dialog.
    if plan.ooa {
        let activation_dir = if ooa_state(&plan.work_dir) {
            plan.work_dir.clone()
        } else {
            plan.exe
                .parent()
                .map(|parent| parent.to_path_buf())
                .ok_or_else(|| "EA activation folder is missing".to_string())?
        };
        let version = super::ea_machine::activation_version(&activation_dir)?;
        let hash = super::ea_machine::hardware_hash(version)?;
        let signature_decoded = !activation_dir.join("Core/activation.exe").is_file();
        super::ea_license::ensure_license(
            &access,
            &plan.content_id,
            &hash,
            signature_decoded,
        )
        .await?;
    }

    let launch_token = super::ea_login::launch_token(&access)
        .await
        .unwrap_or_else(|_| access.clone());
    let player = super::ea_vault::load()
        .map(|tokens| tokens.name)
        .unwrap_or_default();
    let env = environment(&access, &launch_token, &player, "en_US", &plan);
    super::ea_lsx::ensure_started(3216, &access)?;

    // The game asks the EA background service first; with it stopped it uses
    // the LSX port we just opened. The service is put back when the game exits.
    let service_was_running = service_running();
    if service_was_running {
        stop_service();
    }

    let mut child = match spawn(&plan, &env) {
        Ok(child) => child,
        Err(err) => {
            if service_was_running {
                start_service();
            }
            return Err(err);
        }
    };
    let pid = child.id();
    if service_was_running {
        std::thread::spawn(move || {
            let _ = child.wait();
            start_service();
        });
    }
    clear_error();
    Ok(pid)
}

/// `EABackgroundService` is the EA client service the game looks for first.
#[cfg(windows)]
fn service_running() -> bool {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("sc.exe");
    cmd.args(["query", "EABackgroundService"]);
    cmd.creation_flags(0x0800_0000);
    cmd.output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains("RUNNING"))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn service_running() -> bool {
    false
}

#[cfg(windows)]
fn sc(verb: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("sc.exe");
    cmd.args([verb, "EABackgroundService"]);
    cmd.creation_flags(0x0800_0000);
    cmd.status().map(|status| status.success()).unwrap_or(false)
}

#[cfg(not(windows))]
fn sc(_verb: &str) -> bool {
    false
}

fn stop_service() {
    let _ = sc("stop");
    // `sc stop` returns while the service is still stopping; the port must be
    // free before the game starts, so wait for the STOPPED state.
    for _ in 0..20 {
        if !service_running() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

fn start_service() {
    let _ = sc("start");
}

/// The diagnostic row behind Settings > Integrations.
pub(crate) fn probe(game: &FoundGame) -> EaDirectProbe {
    match plan(&game.install_path, &game.store_id) {
        Ok(plan) => EaDirectProbe {
            ok: true,
            reason: String::new(),
            exe: plan.exe.to_string_lossy().to_string(),
            work_dir: plan.work_dir.to_string_lossy().to_string(),
            content_id: plan.content_id.clone(),
            eaac: plan.eaac,
            ooa: plan.ooa,
            args: plan.args.clone(),
            env: environment("", "", "", "en_US", &plan)
                .into_iter()
                .map(|(key, _)| key)
                .collect(),
        },
        Err(err) => EaDirectProbe {
            ok: false,
            reason: err.to_string(),
            exe: String::new(),
            work_dir: String::new(),
            content_id: String::new(),
            eaac: false,
            ooa: false,
            args: Vec::new(),
            env: Vec::new(),
        },
    }
}

#[cfg(windows)]
fn spawn(plan: &LaunchPlan, env: &[(String, String)]) -> Result<std::process::Child, String> {
    let target = if plan.eaac {
        eaac_launcher(&plan.work_dir)
            .ok_or_else(|| "EA anti-cheat launcher is missing".to_string())?
    } else {
        plan.exe.clone()
    };

    let mut cmd = std::process::Command::new(&target);
    cmd.current_dir(&plan.work_dir);
    if !plan.args.is_empty() {
        cmd.args(&plan.args);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    // A console flash would look like a crash on every launch.
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);

    let child = cmd
        .spawn()
        .map_err(|err| format!("{}: {err}", target.display()))?;
    Ok(child)
}

#[cfg(not(windows))]
fn spawn(_plan: &LaunchPlan, _env: &[(String, String)]) -> Result<std::process::Child, String> {
    Err("EA direct launch is Windows-only".into())
}

/// `EAAntiCheat.GameServiceLauncher.exe` in the root or in its own folder.
fn eaac_launcher(root: &Path) -> Option<PathBuf> {
    [
        "EAAntiCheat.GameServiceLauncher.exe",
        "EAAntiCheat/EAAntiCheat.GameServiceLauncher.exe",
    ]
    .iter()
    .map(|relative| root.join(relative))
    .find(|path| path.is_file())
}

/// DiP manifests carry a `<DiPManifest>` root; pre-DiP titles use `<game>`.
fn is_dip_manifest(xml: &str) -> bool {
    xml.contains("<DiPManifest")
}

/// The activation runtime that expects a license, present in modern Frostbite
/// titles (BF2042 ships `Core/Activation.dll`) and older OOA games.
fn ooa_state(root: &Path) -> bool {
    [
        "Core/activation.exe",
        "Core/Activation.dll",
        "Core/Activation64.dll",
        "Core/awc.dll",
    ]
    .iter()
    .any(|relative| root.join(relative).is_file())
}

/// The non-trial `<runtime><launcher>` entry and its own parameters.
fn launcher_entry(xml: &str) -> Option<(String, Vec<String>)> {
    let runtime = element(xml, "runtime")?;
    for launcher in elements(runtime, "launcher") {
        let trial = element(launcher, "trial")
            .map(|value| {
                let value = value.trim();
                value == "1" || value.eq_ignore_ascii_case("true")
            })
            .unwrap_or(false);
        if trial {
            continue;
        }
        let Some(path) = element(launcher, "filePath") else {
            continue;
        };
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        let args = element(launcher, "parameters")
            .map(split_args)
            .unwrap_or_default();
        return Some((path.to_string(), args));
    }
    None
}

/// The non-trial launcher path, without its parameters.
#[cfg(test)]
fn launcher_path(xml: &str) -> Option<String> {
    launcher_entry(xml).map(|(path, _)| path)
}

/// Reads one manifest that may be UTF-8 (with or without a BOM) or UTF-16.
pub(crate) fn decode(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16(&bytes[2..], false);
    }
    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return Some(text.trim_start_matches('\u{feff}').to_string());
    }
    utf16(bytes, true).or_else(|| utf16(bytes, false))
}

fn utf16(bytes: &[u8], little: bool) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16(&units).ok()
}

/// All `<name>...</name>` blocks, in document order.
fn elements<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let lower = xml.to_ascii_lowercase();
    let open_tag = format!("<{}", name.to_ascii_lowercase());
    let close_tag = format!("</{}>", name.to_ascii_lowercase());
    let mut out = Vec::new();
    let mut from = 0;

    while from < lower.len() {
        let Some(relative) = lower[from..].find(&open_tag) else {
            break;
        };
        let open = from + relative;
        let after = open + open_tag.len();
        let Some(boundary) = lower[after..].chars().next() else {
            break;
        };
        if !(boundary == '>' || boundary == '/' || boundary.is_ascii_whitespace()) {
            from = after;
            continue;
        }
        let Some(gt) = lower[after..].find('>') else {
            break;
        };
        let start = after + gt + 1;
        let Some(close) = lower[start..].find(&close_tag) else {
            break;
        };
        let end = start + close;
        out.push(&xml[start..end]);
        from = end + close_tag.len();
    }

    out
}

fn element<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    elements(xml, name).into_iter().next()
}

fn relative_path(raw: &str) -> PathBuf {
    let raw = raw.trim();
    // DiP manifests often prefix the launcher with a registry key:
    // `[HKEY_LOCAL_MACHINE\...\Install Dir]EAAntiCheat.GameServiceLauncher.exe`.
    // The install folder is already known, so only the part after `]` matters.
    let raw = raw.rsplit_once(']').map(|(_, rest)| rest).unwrap_or(raw);
    let clean = raw.trim().trim_start_matches(['/', '\\']);
    #[cfg(windows)]
    let clean = clean.replace('/', "\\");
    #[cfg(not(windows))]
    let clean = clean.replace('\\', "/");
    PathBuf::from(clean)
}

fn split_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in input.chars() {
        match ch {
            '"' => quoted = !quoted,
            ' ' | '\t' | '\r' | '\n' if !quoted => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

/// A v4 UUID in the shape the EA client uses for `OriginSessionKey`.
fn session_key() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The daily launch code EA expects; it changes every UTC day.
fn rtp_handshake() -> u32 {
    let (year, month, day) = crate::clock::date(std::time::SystemTime::now());
    let time = 104_729u32
        .wrapping_mul(year as u32)
        ^ month.wrapping_mul(224_737)
        ^ day.wrapping_mul(350_377);
    time ^ (time << 16) ^ (time >> 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<DiPManifest version="2.0">
  <game><contentIDs><contentID>194814</contentID></contentIDs></game>
  <runtime>
    <launcher uid="1">
      <filePath>/Nuts/Binaries/Win64/ItTakesTwo.exe</filePath>
      <trial>false</trial>
    </launcher>
  </runtime>
  <buildMetaData><gameVersion version="1.0.0"/></buildMetaData>
</DiPManifest>"#;

    #[test]
    fn the_first_non_trial_launcher_wins() {
        let xml = r#"<runtime>
            <launcher><filePath>/trial.exe</filePath><trial>true</trial></launcher>
            <launcher><filePath>/game.exe</filePath><trial>false</trial></launcher>
        </runtime>"#;
        assert_eq!(launcher_path(xml).as_deref(), Some("/game.exe"));
    }

    #[test]
    fn the_runtime_launcher_is_read_from_a_real_manifest() {
        assert_eq!(
            launcher_path(MANIFEST).as_deref(),
            Some("/Nuts/Binaries/Win64/ItTakesTwo.exe")
        );
    }

    #[test]
    fn a_missing_runtime_is_not_a_launcher() {
        assert_eq!(launcher_path("<DiPManifest></DiPManifest>"), None);
    }

    #[test]
    fn element_names_must_end_at_a_boundary() {
        let xml = "<launchers>wrong</launchers><launcher>right</launcher>";
        assert_eq!(element(xml, "launcher"), Some("right"));
    }

    #[test]
    fn quoted_parameters_stay_one_argument() {
        assert_eq!(
            split_args(r#"-windowed -name "Efe Test" --flag"#),
            vec!["-windowed", "-name", "Efe Test", "--flag"]
        );
    }

    #[test]
    fn utf16_manifests_are_decoded() {
        let text = "<DiPManifest><runtime></runtime></DiPManifest>";
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode(&bytes).as_deref(), Some(text));
    }

    #[test]
    fn a_registry_prefixed_launcher_keeps_only_the_relative_path() {
        let xml = r#"<DiPManifest><runtime>
            <launcher><filePath>[HKEY_LOCAL_MACHINE\SOFTWARE\EA Games\Battlefield 2042\Install Dir]EAAntiCheat.GameServiceLauncher.exe</filePath><trial>0</trial></launcher>
        </runtime></DiPManifest>"#;
        let path = launcher_path(xml).expect("launcher");
        assert_eq!(
            relative_path(&path),
            PathBuf::from("EAAntiCheat.GameServiceLauncher.exe")
        );
    }

    #[test]
    fn a_numeric_trial_flag_is_skipped() {
        let xml = r#"<runtime>
            <launcher><filePath>/trial.exe</filePath><trial>1</trial></launcher>
            <launcher><filePath>/game.exe</filePath><trial>0</trial></launcher>
        </runtime>"#;
        assert_eq!(launcher_path(xml).as_deref(), Some("/game.exe"));
    }

    #[test]
    fn launcher_parameters_belong_to_the_selected_entry() {
        let xml = r#"<runtime>
            <launcher><filePath>/trial.exe</filePath><parameters>-trial</parameters><trial>1</trial></launcher>
            <launcher><filePath>/game.exe</filePath><parameters>-windowed</parameters><trial>0</trial></launcher>
        </runtime>"#;
        assert_eq!(
            launcher_entry(xml),
            Some(("/game.exe".to_string(), vec!["-windowed".to_string()]))
        );
    }

    #[test]
    fn the_anti_cheat_guard_refuses_before_any_launch() {
        let root = std::env::temp_dir().join(format!("efxlve-eaac-guard-{}", std::process::id()));
        let installer = root.join("__Installer");
        std::fs::create_dir_all(&installer).expect("installer dir");
        std::fs::write(
            installer.join("installerdata.xml"),
            r#"<DiPManifest>
                <contentIDs><contentID>1</contentID></contentIDs>
                <runtime><launcher><filePath>Game.exe</filePath></launcher></runtime>
            </DiPManifest>"#,
        )
        .expect("manifest");
        std::fs::write(root.join("Game.exe"), b"fake").expect("game exe");
        std::fs::write(root.join("EAAntiCheat.GameServiceLauncher.exe"), b"fake")
            .expect("eaac launcher");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(launch_path(&root.to_string_lossy(), "1"));
        println!("eaac guard: {result:?}");
        assert!(matches!(result, Err(ref error) if error.contains("anti-cheat")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plain_legacy_execute_path_is_joined_to_the_install() {
        let root = std::env::temp_dir().join(format!("efxlve-ea-legacy-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("root");
        std::fs::write(root.join("game.exe"), b"fake").expect("exe");
        let plan = legacy_plan(&root.to_string_lossy(), "1", "game.exe", "-windowed")
            .expect("legacy plan");
        assert!(plan.exe.ends_with("game.exe"));
        assert_eq!(plan.args, vec!["-windowed"]);
        assert_eq!(plan.content_id, "1");
        assert!(!plan.eaac);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_legacy_executable_is_rejected() {
        let root = std::env::temp_dir().join(format!("efxlve-ea-missing-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("root");
        assert!(legacy_plan(&root.to_string_lossy(), "1", "missing.exe", "").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pre_dip_manifests_are_not_dip() {
        assert!(!is_dip_manifest(
            r#"<game manifestVersion="2.1"><executable/></game>"#
        ));
        assert!(is_dip_manifest(
            r#"<DiPManifest version="4.0"></DiPManifest>"#
        ));
    }

    #[test]
    fn the_ooa_runtime_is_detected_from_the_core_folder() {
        let root = std::env::temp_dir().join(format!("efxlve-ea-ooa-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Core")).expect("core");
        std::fs::write(root.join("Core").join("Activation.dll"), b"x").expect("activation");
        assert!(ooa_state(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "reads a real EA install from EFXLVE_EA_PROBE"]
    fn manual_probe() {
        let Ok(path) = std::env::var("EFXLVE_EA_PROBE") else {
            return;
        };
        let id = std::env::var("EFXLVE_EA_CONTENT_ID").unwrap_or_default();
        println!("{:?}", plan(&path, &id));
    }

    #[test]
    #[ignore = "uses the signed-in EA session"]
    fn manual_opaque_token() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = rt.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            super::super::ea_login::launch_token(&access).await
        });
        match result {
            Ok(token) => println!("opaque token length {}", token.len()),
            Err(err) => println!("failed: {err}"),
        }
    }

    #[test]
    #[ignore = "runs the LSX listener while launching an EA game from EFXLVE_EA_PROBE"]
    fn manual_lsx_catalyst() {
        let path = std::env::var("EFXLVE_EA_PROBE").unwrap_or_else(|_| {
            r"C:\Program Files (x86)\Steam\steamapps\common\Mirrors Edge Catalyst".to_string()
        });
        let content_id = std::env::var("EFXLVE_EA_CONTENT_ID").unwrap_or_else(|_| "1026480".into());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = rt.block_on(launch_path(&path, &content_id));
        println!("launch: {result:?}");
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    #[test]
    #[ignore = "reads the Dead Space 2 launch facts without starting the game"]
    fn manual_probe_deadspace() {
        let root = Path::new(r"C:\Program Files\EA Games\Dead Space 2");
        let plan = plan(&root.to_string_lossy(), "1002974");
        println!("dead space 2 plan: {plan:?}");
    }

    #[tokio::test]
    #[ignore = "launches Dead Space 2 through the legacy catalog path"]
    async fn manual_legacy_launch_deadspace() {
        let games = super::super::discover("ea");
        let game = games
            .iter()
            .find(|game| game.name.to_lowercase().contains("dead spac"))
            .expect("Dead Space 2 in the EA library");
        let result = launch(game).await;
        println!("legacy launch: {result:?}");
        assert!(result.is_ok(), "legacy launch failed: {result:?}");
    }

    #[tokio::test]
    #[ignore = "launches A Way Out through the direct path"]
    async fn manual_launch_a_way_out() {
        let games = super::super::discover("ea");
        let game = games
            .iter()
            .find(|game| game.name.to_lowercase().contains("a way out"))
            .expect("A Way Out in the EA library");
        println!(
            "game: id={} path={} store_id={}",
            game.id, game.install_path, game.store_id
        );
        let result = launch(game).await;
        println!("a way out launch: {result:?}");
        assert!(result.is_ok(), "A Way Out launch failed: {result:?}");
        std::thread::sleep(std::time::Duration::from_secs(180));
    }

    #[tokio::test]
    #[ignore = "refreshes the EA catalog and reads the Dead Space 2 legacy path"]
    async fn manual_probe_deadspace_legacy_path() {
        let _ = super::super::ea_login::sync_owned().await;
        let games = super::super::discover("ea");
        let game = games
            .iter()
            .find(|game| game.name.to_lowercase().contains("dead spac"))
            .unwrap_or_else(|| {
                for game in &games {
                    println!("ea game: {} | {}", game.id, game.name);
                }
                panic!("Dead Space 2 in the EA library")
            });
        println!(
            "game: id={} path={} store_id={}",
            game.id, game.install_path, game.store_id
        );
        let (execute, parameters) = super::super::ea_login::legacy_launch_for(&game)
            .expect("legacy execute path");
        println!("execute={execute} parameters={parameters}");
        let plan = legacy_plan(&game.install_path, &game.store_id, &execute, &parameters)
            .expect("legacy launch plan");
        println!("legacy plan: {plan:?}");
    }

    #[test]
    #[ignore = "launches a real EA game from EFXLVE_EA_PROBE"]
    fn manual_launch() {
        let Ok(path) = std::env::var("EFXLVE_EA_PROBE") else {
            return;
        };
        let id = std::env::var("EFXLVE_EA_CONTENT_ID").unwrap_or_default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        match rt.block_on(launch_path(&path, &id)) {
            Ok(pid) => println!("started pid {pid}"),
            Err(err) => println!("failed: {err}"),
        }
    }

    #[test]
    fn the_environment_carries_the_token_and_content_id() {
        let plan = LaunchPlan {
            exe: PathBuf::from(r"C:\Games\ItTakesTwo\ItTakesTwo.exe"),
            work_dir: PathBuf::from(r"C:\Games\ItTakesTwo"),
            args: Vec::new(),
            content_id: "194814".into(),
            eaac: false,
            ooa: false,
        };
        let env = environment("token-value", "short-value", "Efe", "tr_TR", &plan);
        let map: std::collections::HashMap<&str, &str> = env
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        assert_eq!(map["EALaunchUserAuthToken"], "short-value");
        assert_eq!(map["EAGenericAuthToken"], "token-value");
        assert_eq!(map["EALaunchEAID"], "Efe");
        assert_eq!(map["EAGameLocale"], "tr_TR");
        assert_eq!(map["ContentId"], "194814");
        assert_eq!(map["EAConnectionId"], "194814");
        assert_eq!(map["EALaunchOfflineMode"], "false");
        assert!(!map.contains_key("EALicenseFile"));
    }

    #[test]
    fn the_session_key_is_a_v4_uuid() {
        let key = session_key();
        assert_eq!(key.len(), 36);
        assert_eq!(key.matches('-').count(), 4);
        assert_eq!(&key[14..15], "4");
    }

    #[test]
    fn the_rtp_code_is_stable_within_a_day() {
        let first = rtp_handshake();
        let second = rtp_handshake();
        assert_eq!(first, second);
    }

    #[test]
    fn a_missing_game_folder_is_rejected() {
        let plan = plan(r"C:\definitely-not-a-game-folder", "");
        assert_eq!(plan.unwrap_err(), PlanError::NotInstalled);
    }
}
