//! EA install facts around the content package.
//!
//! The package is a ZIP; after every entry is written, `__Installer/touchup.exe`
//! registers the game with the usual installer data. This module reads
//! `installerdata.xml` from the package, builds the touchup command and can run
//! it. The download loop itself lives in `ea_content`.

use std::path::{Path, PathBuf};

use super::ea_content::{self, InstallPlan};

pub(crate) const MANIFEST: &str = "__Installer/installerdata.xml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Touchup {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Reads the installer manifest from the package and builds its touchup command.
pub(crate) async fn plan_touchup(
    plan: &InstallPlan,
    locale: &str,
) -> Result<Option<Touchup>, String> {
    let Some(entry) = plan
        .manifest
        .entries
        .iter()
        .find(|entry| entry.name.eq_ignore_ascii_case(MANIFEST))
    else {
        return Ok(None);
    };
    let bytes = ea_content::read_entry(&plan.download_url, entry).await?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(touchup_from_manifest(&text, &plan.root, locale))
}

/// Parses the `<touchup>` block of a DiP installer manifest.
pub(crate) fn touchup_from_manifest(xml: &str, root: &Path, locale: &str) -> Option<Touchup> {
    let block = element(xml, "touchup")?;
    let raw = element(block, "filePath")?.trim();
    let relative = raw
        .trim_start_matches(['/', '\\'])
        .replace('/', std::path::MAIN_SEPARATOR_STR);
    let program = root.join(relative);
    if !program.starts_with(root) {
        return None;
    }
    let parameters = element(block, "parameters")?;
    let parameters = parameters
        .replace("{locale}", locale)
        .replace("{installLocation}", &root.to_string_lossy());
    Some(Touchup {
        program,
        args: split_args(&parameters),
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

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct InstallReport {
    pub version: String,
    pub download: ea_content::DownloadReport,
    pub touchup: Option<Touchup>,
}

/// Downloads the full package and runs its touchup.
///
/// The install button lands after the download progress UI; the batch probe and
/// the touchup parser are the tested pieces until then.
#[allow(dead_code)]
pub(crate) async fn install(
    access: &str,
    offer_id: &str,
    root: &Path,
    locale: &str,
) -> Result<InstallReport, String> {
    let plan = ea_content::plan_install(access, offer_id, root).await?;
    let touchup = plan_touchup(&plan, locale).await?;
    let download =
        ea_content::download_entries(&plan.download_url, &plan.root, &plan.manifest.entries)
            .await?;
    if let Some(touchup) = &touchup {
        run_touchup(touchup).await?;
    }
    Ok(InstallReport {
        version: plan.version,
        download,
        touchup,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<DiPManifest>
        <touchup>
            <filePath>/__Installer/touchup.exe</filePath>
            <parameters>install -locale {locale} -installPath "{installLocation}" -autologging</parameters>
        </touchup>
    </DiPManifest>"#;

    #[test]
    fn the_touchup_command_replaces_the_install_placeholders() {
        let root = Path::new("games/a way out");
        let root_text = root.to_string_lossy().to_string();
        let touchup = touchup_from_manifest(XML, root, "tr_TR").expect("touchup");
        assert_eq!(touchup.program, root.join("__Installer").join("touchup.exe"));
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
    fn a_manifest_without_a_touchup_is_ignored() {
        assert!(touchup_from_manifest("<DiPManifest></DiPManifest>", Path::new("x"), "en_US").is_none());
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
            let touchup = plan_touchup(&plan, "en_US").await?;
            println!("plan: {} entries, build {}", plan.manifest.entries.len(), plan.build_id);
            println!("touchup: {touchup:?}");
            Ok::<(), String>(())
        });
        println!("result: {result:?}");
    }
}
