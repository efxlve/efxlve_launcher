//! EA install facts around the content package.
//!
//! The package is a ZIP; after every entry is written, `__Installer/touchup.exe`
//! registers the game with the usual installer data. This module reads
//! `installerdata.xml` from the package, builds the touchup command for a fresh
//! install, an update or a repair, and runs it. The download loop itself lives
//! in `ea_content`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::ea_content::{self, InstallPlan};

pub(crate) const MANIFEST: &str = ea_content::INSTALLER_MANIFEST;

/// Which touchup parameters to use. A fresh folder gets `install`, a newer
/// package over an existing one gets `update`, and a matching version being
/// checked gets `repair`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum TouchupMode {
    #[default]
    Install,
    Update,
    Repair,
}

impl TouchupMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TouchupMode::Install => "install",
            TouchupMode::Update => "update",
            TouchupMode::Repair => "repair",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Touchup {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub mode: TouchupMode,
}

/// The version recorded by an existing install, if the folder holds one.
pub(crate) fn installed_version(root: &Path) -> Option<String> {
    let path = root.join(MANIFEST.replace('/', std::path::MAIN_SEPARATOR_STR));
    let bytes = std::fs::read(path).ok()?;
    let xml = super::ea_direct::decode(&bytes)?;
    tag_attribute(&xml, "gameVersion", "version").map(|version| version.trim().to_string())
}

/// True when the folder holds an EA installer manifest, even if that manifest
/// carries no version (some legacy packages leave it empty).
pub(crate) fn has_install(root: &Path) -> bool {
    root.join(MANIFEST.replace('/', std::path::MAIN_SEPARATOR_STR))
        .is_file()
}

/// Builds the touchup command from the package's installer manifest.
pub(crate) async fn plan_touchup(
    plan: &InstallPlan,
    locale: &str,
    mode: TouchupMode,
) -> Result<Option<Touchup>, String> {
    let Some(text) = plan.installer_xml.as_deref() else {
        return Ok(None);
    };
    Ok(touchup_from_manifest(text, &plan.root, locale, mode))
}

/// Parses the `<touchup>` block of a DiP installer manifest. Older manifests
/// only carry `<parameters>`; update and repair fall back to it.
pub(crate) fn touchup_from_manifest(
    xml: &str,
    root: &Path,
    locale: &str,
    mode: TouchupMode,
) -> Option<Touchup> {
    let block = element(xml, "touchup")?;
    let raw = element(block, "filePath")?.trim();
    let relative = raw
        .trim_start_matches(['/', '\\'])
        .replace('/', std::path::MAIN_SEPARATOR_STR);
    let program = root.join(relative);
    if !program.starts_with(root) {
        return None;
    }
    let parameters = match mode {
        TouchupMode::Install => element(block, "parameters"),
        TouchupMode::Update => {
            element(block, "updateParameters").or_else(|| element(block, "parameters"))
        }
        TouchupMode::Repair => {
            element(block, "repairParameters").or_else(|| element(block, "parameters"))
        }
    }?;
    let parameters = parameters
        .replace("{locale}", locale)
        .replace("{installLocation}", &root.to_string_lossy());
    Some(Touchup {
        program,
        args: split_args(&parameters),
        mode,
    })
}

/// Runs the touchup and waits for it.
pub(crate) async fn run_touchup(touchup: &Touchup) -> Result<(), String> {
    let mut command = tokio::process::Command::new(&touchup.program);
    command.args(&touchup.args);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let status = command
        .status()
        .await
        .map_err(|err| format!("EA touchup: {err}"))?;
    if !status.success() {
        return Err(format!("EA touchup exited with {status}"));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct InstallReport {
    pub build_id: String,
    pub version: String,
    pub mode: TouchupMode,
    pub download: ea_content::DownloadReport,
    #[allow(dead_code)]
    pub touchup: Option<Touchup>,
    /// The files landed but the EA App registration failed (usually rights).
    pub touchup_error: Option<String>,
}

/// Which touchup block a folder should use.
fn touchup_mode(local: Option<&str>, live: &str, installed: bool) -> TouchupMode {
    match local {
        Some(version) if version == live => TouchupMode::Repair,
        Some(_) => TouchupMode::Update,
        None if installed => TouchupMode::Repair,
        None => TouchupMode::Install,
    }
}

/// What the install loop announces between steps.
pub(crate) struct InstallTick<'a> {
    pub phase: &'a str,
    pub progress: Option<ea_content::DownloadProgress>,
}

/// Downloads the full package and runs its touchup.
///
/// Existing files are checked by size and CRC, so a resumed install only fetches
/// what is missing or damaged. The caller owns the cancel flag.
pub(crate) async fn install_with_progress(
    access: &str,
    offer_id: &str,
    root: &Path,
    locale: &str,
    cancelled: &Arc<AtomicBool>,
    mut on_tick: impl FnMut(InstallTick<'_>) + Send,
) -> Result<InstallReport, String> {
    on_tick(InstallTick {
        phase: "planning",
        progress: None,
    });
    if cancelled.load(Ordering::Relaxed) {
        return Err("EA content: cancelled".into());
    }
    let mut plan = ea_content::plan_install(access, offer_id, root).await?;
    // Javelin verifies the client's own installation; keep those titles on the
    // EA App for installs, updates and repairs too.
    if plan.eaac {
        return Err("EA anti-cheat titles need the EA app".into());
    }

    // A signed package URL can expire during a multi-hour download. Re-plan
    // once on an authorization error; completed files are verified by size and
    // CRC on the retry, so the transfer resumes where it stopped.
    let mut refreshed = false;
    let download = loop {
        ea_content::ensure_disk_space(&plan)?;
        match ea_content::download_entries_controlled(
            &plan.download_url,
            &plan.root,
            &plan.manifest.entries,
            Some(cancelled.clone()),
            |progress| {
                on_tick(InstallTick {
                    phase: "downloading",
                    progress: Some(progress),
                })
            },
        )
        .await
        {
            Ok(report) => break report,
            Err(error) if !refreshed && ea_content::auth_error(&error) => {
                refreshed = true;
                on_tick(InstallTick {
                    phase: "planning",
                    progress: None,
                });
                plan = ea_content::plan_install(access, offer_id, root).await?;
                if plan.eaac {
                    return Err("EA anti-cheat titles need the EA app".into());
                }
            }
            Err(error) => return Err(error),
        }
    };

    let local = installed_version(root);
    let mode = touchup_mode(local.as_deref(), &plan.version, has_install(root));
    let touchup = plan_touchup(&plan, locale, mode).await?;

    let mut touchup_error = None;
    if let Some(touchup) = &touchup {
        if cancelled.load(Ordering::Relaxed) {
            return Err("EA content: cancelled".into());
        }
        on_tick(InstallTick {
            phase: "touchup",
            progress: None,
        });
        if let Err(error) = run_touchup(touchup).await {
            touchup_error = Some(error);
        }
    }
    on_tick(InstallTick {
        phase: "done",
        progress: None,
    });
    Ok(InstallReport {
        build_id: plan.build_id,
        version: plan.version,
        mode,
        download,
        touchup,
        touchup_error,
    })
}

/// The default folder for a fresh install. Program Files belongs to the EA App
/// and its elevated installer, so a launcher-owned install lives with the other
/// per-user data the same way Ubisoft direct installs do. The dialog still lets
/// the user pick any writable folder.
pub(crate) fn default_root(name: &str) -> PathBuf {
    let folder = safe_folder_name(name);
    super::accounts::data_dir()
        .join("ea-games")
        .join(folder)
}

/// True when this process can create and write files under `root`.
pub(crate) fn folder_writable(root: &Path) -> bool {
    if std::fs::create_dir_all(root).is_err() {
        return false;
    }
    let probe = root.join(".efxlve-write-test");
    match std::fs::write(&probe, b"efxlve") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn safe_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            _ => ch,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "EA Game".into()
    } else {
        trimmed.to_string()
    }
}

fn element<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let lower = xml.to_ascii_lowercase();
    let open = format!("<{}", name.to_ascii_lowercase());
    let close = format!("</{}>", name.to_ascii_lowercase());
    let start = lower.find(&open)?;
    let after = start + open.len();
    let boundary = lower[after..].chars().next()?;
    if !(boundary == '>' || boundary == '/' || boundary.is_ascii_whitespace()) {
        return None;
    }
    let content_start = lower[after..].find('>')? + after + 1;
    let end = lower[content_start..].find(&close)? + content_start;
    Some(&xml[content_start..end])
}

/// Reads one attribute of a self-closing tag (`<gameVersion version="…" />`).
fn tag_attribute(xml: &str, name: &str, attribute: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let open = format!("<{}", name.to_ascii_lowercase());
    let start = lower.find(&open)?;
    let after = start + open.len();
    let boundary = lower[after..].chars().next()?;
    if !(boundary == '>' || boundary == '/' || boundary.is_ascii_whitespace()) {
        return None;
    }
    let tag_end = lower[after..].find('>')? + after;
    let tag = &xml[after..tag_end];
    let key = format!("{}=\"", attribute.to_ascii_lowercase());
    let position = tag.to_ascii_lowercase().find(&key)? + key.len();
    let rest = &tag[position..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
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

/// A command read from the game's own uninstall registry record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UninstallCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Reads `<uninstall><path>` from the local installer manifest, follows the
/// registry value and returns the `Cleanup.exe` command the EA installer wrote.
pub(crate) fn uninstall_command(root: &Path) -> Option<UninstallCommand> {
    let bytes = std::fs::read(root.join(MANIFEST.replace('/', std::path::MAIN_SEPARATOR_STR))).ok()?;
    let xml = super::ea_direct::decode(&bytes)?;
    let block = element(&xml, "uninstall")?;
    let pointer = element(block, "path")?.trim();
    let (key, value) = parse_registry_pointer(pointer)?;
    let output = registry_views(&key)
        .into_iter()
        .find_map(|key| crate::winreg::query(&key, Some(&value)))?;
    let command = crate::winreg::parse_reg_sz(&output);
    let mut parts = split_args(&command);
    if parts.is_empty() {
        return None;
    }
    let program = parts.remove(0);
    if program.trim().is_empty() {
        return None;
    }
    Some(UninstallCommand {
        program: PathBuf::from(program),
        args: parts,
    })
}

/// `[HKEY_LOCAL_MACHINE\...\UninstallString]` → key and value name.
fn parse_registry_pointer(raw: &str) -> Option<(String, String)> {
    let inner = raw.trim().strip_prefix('[')?.strip_suffix(']')?;
    let split = inner.rfind('\\')?;
    let key = &inner[..split];
    let value = &inner[split + 1..];
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key.to_string(), value.to_string()))
}

/// EA writes the same uninstall key under the 32-bit view on 64-bit Windows;
/// `installerdata.xml` does not repeat `WOW6432Node`, so try both views.
fn registry_views(key: &str) -> Vec<String> {
    let mut keys = vec![key.to_string()];
    if let Some((root, rest)) = key.split_once(r"\SOFTWARE\") {
        if !rest.to_ascii_uppercase().starts_with("WOW6432NODE\\") {
            keys.push(format!(r"{root}\SOFTWARE\WOW6432Node\{rest}"));
        }
    }
    keys
}

/// Runs the uninstaller and waits for it.
pub(crate) async fn run_uninstall(command: &UninstallCommand) -> Result<(), String> {
    let mut process = tokio::process::Command::new(&command.program);
    process.args(&command.args);
    #[cfg(windows)]
    {
        process.creation_flags(0x0800_0000);
    }
    let status = process
        .status()
        .await
        .map_err(|error| format!("EA uninstall: {error}"))?;
    if !status.success() {
        return Err(format!("EA uninstaller exited with {status}"));
    }
    Ok(())
}

/// True when the folder belongs to the launcher's own EA library, so it can be
/// removed when no installer record exists.
pub(crate) fn managed_root(root: &Path) -> bool {
    root.starts_with(super::accounts::data_dir().join("ea-games"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<DiPManifest>
        <gameVersion version="1.2.0.2" />
        <touchup>
            <filePath>/__Installer/touchup.exe</filePath>
            <parameters>install -locale {locale} -installPath "{installLocation}" -autologging</parameters>
            <updateParameters>install -update -locale {locale} -installPath "{installLocation}" -autologging</updateParameters>
            <repairParameters>install -repair -locale {locale} -installPath "{installLocation}" -autologging</repairParameters>
        </touchup>
    </DiPManifest>"#;

    #[test]
    fn the_touchup_command_replaces_the_install_placeholders() {
        let root = Path::new("games/a way out");
        let root_text = root.to_string_lossy().to_string();
        let touchup =
            touchup_from_manifest(XML, root, "tr_TR", TouchupMode::Install).expect("touchup");
        assert_eq!(touchup.program, root.join("__Installer").join("touchup.exe"));
        assert_eq!(touchup.mode, TouchupMode::Install);
        assert_eq!(
            touchup.args,
            vec![
                "install",
                "-locale",
                "tr_TR",
                "-installPath",
                root_text.as_str(),
                "-autologging"
            ]
        );
    }

    #[test]
    fn updates_and_repairs_use_their_own_parameters() {
        let root = Path::new("games/a way out");
        let update = touchup_from_manifest(XML, root, "en_US", TouchupMode::Update).expect("update");
        assert_eq!(update.args[1], "-update");
        let repair = touchup_from_manifest(XML, root, "en_US", TouchupMode::Repair).expect("repair");
        assert_eq!(repair.args[1], "-repair");
    }

    #[test]
    fn an_old_manifest_falls_back_to_the_install_parameters() {
        let old = r#"<DiPManifest><touchup>
            <filePath>/__Installer/touchup.exe</filePath>
            <parameters>install -locale {locale}</parameters>
        </touchup></DiPManifest>"#;
        let update = touchup_from_manifest(old, Path::new("x"), "en_US", TouchupMode::Update)
            .expect("update");
        assert_eq!(update.args, vec!["install", "-locale", "en_US"]);
    }

    #[test]
    fn the_installed_version_comes_from_the_local_manifest() {
        let root = std::env::temp_dir().join(format!(
            "efxlve-ea-version-{}",
            std::process::id()
        ));
        let manifest = root.join("__Installer").join("installerdata.xml");
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(&manifest, XML).unwrap();
        assert_eq!(installed_version(&root).as_deref(), Some("1.2.0.2"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_touchup_mode_follows_the_local_version() {
        assert_eq!(touchup_mode(None, "1", false), TouchupMode::Install);
        assert_eq!(touchup_mode(None, "1", true), TouchupMode::Repair);
        assert_eq!(touchup_mode(Some("1"), "1", true), TouchupMode::Repair);
        assert_eq!(touchup_mode(Some("1"), "2", true), TouchupMode::Update);
        assert_eq!(touchup_mode(Some("1"), "", true), TouchupMode::Update);
    }

    #[test]
    fn a_registry_pointer_splits_into_key_and_value() {
        let pointer = r"[HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{45e281f3}\UninstallString]";
        let (key, value) = parse_registry_pointer(pointer).expect("pointer");
        assert_eq!(
            key,
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{45e281f3}"
        );
        assert_eq!(value, "UninstallString");
        assert!(parse_registry_pointer("C:\\Games\\x.exe").is_none());
    }

    #[test]
    fn the_registry_lookup_tries_the_32_bit_view() {
        let keys = registry_views(
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{45e281f3}",
        );
        assert_eq!(keys.len(), 2);
        assert!(keys[1].contains(r"SOFTWARE\WOW6432Node\"));
        assert_eq!(
            registry_views(
                r"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{x}"
            )
            .len(),
            1
        );
    }

    #[test]
    fn the_uninstaller_runner_waits_for_the_process() {
        #[cfg(windows)]
        let command = UninstallCommand {
            program: PathBuf::from("cmd.exe"),
            args: vec!["/c".into(), "exit".into(), "0".into()],
        };
        #[cfg(not(windows))]
        let command = UninstallCommand {
            program: PathBuf::from("sh"),
            args: vec!["-c".into(), "true".into()],
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime
            .block_on(run_uninstall(&command))
            .expect("uninstaller should exit successfully");
    }

    #[test]
    #[ignore = "reads the real EA uninstall registry record"]
    fn manual_uninstall_command_reads_the_registry() {
        let root = Path::new(r"C:\Program Files\EA Games\Battlefield 2042");
        let command = uninstall_command(root);
        println!("uninstall command: {command:?}");
        assert!(command.is_some());
        assert!(command
            .unwrap()
            .program
            .to_string_lossy()
            .to_lowercase()
            .contains("cleanup.exe"));
    }

    #[test]
    fn a_missing_manifest_has_no_installed_version() {
        assert!(installed_version(Path::new("does-not-exist")).is_none());
    }

    #[test]
    fn a_manifest_without_a_touchup_is_ignored() {
        assert!(touchup_from_manifest(
            "<DiPManifest></DiPManifest>",
            Path::new("x"),
            "en_US",
            TouchupMode::Install
        )
        .is_none());
    }

    #[test]
    fn default_roots_drop_path_separators_from_the_title() {
        let root = default_root("A/B: C?");
        let leaf = root.file_name().unwrap().to_string_lossy();
        assert!(!leaf.contains('/') && !leaf.contains(':') && !leaf.contains('?'));
        assert_eq!(
            root.parent()
                .and_then(|path| path.file_name())
                .map(|name| name.to_string_lossy().to_string())
                .as_deref(),
            Some("ea-games")
        );
    }

    #[test]
    fn a_user_folder_is_writable() {
        let root = std::env::temp_dir().join(format!("efxlve-ea-writable-{}", std::process::id()));
        assert!(folder_writable(&root));
        assert!(!root.join(".efxlve-write-test").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_touchup_runner_waits_for_the_process() {
        #[cfg(windows)]
        let touchup = Touchup {
            program: PathBuf::from("cmd.exe"),
            args: vec!["/c".into(), "exit".into(), "0".into()],
            mode: TouchupMode::Install,
        };
        #[cfg(not(windows))]
        let touchup = Touchup {
            program: PathBuf::from("sh"),
            args: vec!["-c".into(), "true".into()],
            mode: TouchupMode::Install,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime
            .block_on(run_touchup(&touchup))
            .expect("touchup should exit successfully");
    }

    #[test]
    #[ignore = "talks to EA's content service and starts a package download"]
    fn manual_install_stops_on_cancel() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let root = std::env::temp_dir().join("efxlve-ea-cancel");
            let _ = std::fs::remove_dir_all(&root);
            let cancelled = Arc::new(AtomicBool::new(false));
            let from_tick = cancelled.clone();
            let result = install_with_progress(
                &access,
                "Origin.OFR.50.0002412",
                &root,
                "en_US",
                &cancelled,
                |tick| {
                    println!("tick: {} {:?}", tick.phase, tick.progress);
                    if tick.progress.is_some_and(|progress| progress.files > 0) {
                        from_tick.store(true, Ordering::Relaxed);
                    }
                },
            )
            .await;
            println!("install: {result:?}");
            let cancelled_cleanly = matches!(&result, Err(error) if error.contains("cancelled"));
            let _ = std::fs::remove_dir_all(&root);
            if !cancelled_cleanly {
                return Err(format!("expected a clean cancel, got {result:?}"));
            }
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
    }

    #[test]
    #[ignore = "talks to EA's content service and reads installerdata.xml"]
    fn manual_touchup_plan() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let result = runtime.block_on(async {
            let access = super::super::ea_login::ensure_access().await?;
            let root = std::env::temp_dir().join("efxlve-ea-plan");
            let plan = ea_content::plan_install(&access, "Origin.OFR.50.0002412", &root).await?;
            let touchup = plan_touchup(&plan, "en_US", TouchupMode::Install).await?;
            println!("plan: {} entries, build {}", plan.manifest.entries.len(), plan.build_id);
            println!("touchup: {touchup:?}");
            if let Some(entry) = plan
                .manifest
                .entries
                .iter()
                .find(|entry| entry.name.eq_ignore_ascii_case(MANIFEST))
            {
                let bytes = ea_content::read_entry(&plan.download_url, entry).await?;
                let text = String::from_utf8_lossy(&bytes);
                println!("version tag: {:?}", installed_version(&root));
                println!("manifest head: {}", &text[..text.len().min(1600)]);
            }
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
    }
}
