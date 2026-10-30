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
//! Games that still use the old activation DRM (`Core/activation.exe`) need a
//! signed `.dlf`, which is not implemented here, so they stay on the EA app.

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
            PlanError::OldDrm => write!(f, "the game uses the old activation DRM"),
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
        .ok_or(PlanError::NoContentId)?
        .to_string();

    if old_drm(root) {
        return Err(PlanError::OldDrm);
    }

    let launcher = launcher_path(&text).ok_or(PlanError::NoLauncher)?;
    let relative = relative_path(&launcher);

    let root = root.canonicalize().map_err(|_| PlanError::NotInstalled)?;
    let exe = root.join(&relative);
    let exe = exe
        .canonicalize()
        .map_err(|_| PlanError::MissingExe(relative.to_string_lossy().to_string()))?;
    if !exe.starts_with(&root) {
        return Err(PlanError::OutsideInstall);
    }

    let args = element(&text, "parameters")
        .map(split_args)
        .unwrap_or_default();

    Ok(LaunchPlan {
        exe,
        work_dir: root.clone(),
        args,
        content_id,
        eaac: eaac_launcher(&root).is_some(),
    })
}

/// Builds the environment the EA app sets before it starts a game.
///
/// The values follow the EA client's own launch block. `EALicenseToken` is the
/// app's offline placeholder; the account token is what the game and EA's
/// backend use for entitlement and presence. No value is logged.
pub(crate) fn environment(
    access: &str,
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
        ("EALaunchUserAuthToken".into(), access.into()),
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
    let plan = plan(&game.install_path, &game.store_id).map_err(|err| err.to_string())?;
    let access = super::ea_login::ensure_access().await?;
    let player = super::ea_vault::load()
        .map(|tokens| tokens.name)
        .unwrap_or_default();
    let env = environment(&access, &player, "en_US", &plan);
    let pid = spawn(&plan, &env)?;
    clear_error();
    Ok(pid)
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
            args: plan.args.clone(),
            env: environment("", "", "en_US", &plan)
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
            args: Vec::new(),
            env: Vec::new(),
        },
    }
}

#[cfg(windows)]
fn spawn(plan: &LaunchPlan, env: &[(String, String)]) -> Result<u32, String> {
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
    Ok(child.id())
}

#[cfg(not(windows))]
fn spawn(_plan: &LaunchPlan, _env: &[(String, String)]) -> Result<u32, String> {
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

/// The pre-DiP activation DRM, identified by the files it drops in `Core`.
fn old_drm(root: &Path) -> bool {
    ["Core/activation.exe", "Core/activation.dll", "Core/awc.dll"]
        .iter()
        .any(|relative| root.join(relative).is_file())
}

/// The non-trial `<runtime><launcher><filePath>` entry.
fn launcher_path(xml: &str) -> Option<String> {
    let runtime = element(xml, "runtime")?;
    for launcher in elements(runtime, "launcher") {
        let trial = element(launcher, "trial")
            .map(|value| value.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if trial {
            continue;
        }
        if let Some(path) = element(launcher, "filePath") {
            let path = path.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Reads one manifest that may be UTF-8 (with or without a BOM) or UTF-16.
fn decode(bytes: &[u8]) -> Option<String> {
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
    fn the_environment_carries_the_token_and_content_id() {
        let plan = LaunchPlan {
            exe: PathBuf::from(r"C:\Games\ItTakesTwo\ItTakesTwo.exe"),
            work_dir: PathBuf::from(r"C:\Games\ItTakesTwo"),
            args: Vec::new(),
            content_id: "194814".into(),
            eaac: false,
        };
        let env = environment("token-value", "Efe", "tr_TR", &plan);
        let map: std::collections::HashMap<&str, &str> = env
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        assert_eq!(map["EALaunchUserAuthToken"], "token-value");
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
