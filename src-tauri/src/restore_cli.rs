//! Pure argument and path helpers for the standalone restorer. Kept apart
//! from `restore_main.rs` so they can be tested without compiling the archive
//! engine a second time.

use std::path::{Path, PathBuf};

#[derive(Default, Debug, PartialEq, Eq)]
pub struct Args {
    pub manifest: Option<PathBuf>,
    pub target: Option<PathBuf>,
    pub overwrite: bool,
    pub xtool: Option<String>,
    pub extra_dirs: Vec<PathBuf>,
    pub verify: bool,
    pub help: bool,
}

pub fn parse_args<I>(arguments: I) -> Result<Args, String>
where
    I: IntoIterator<Item = String>,
{
    let mut args = Args::default();
    let mut iter = arguments.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => args.help = true,
            "-m" | "--manifest" => {
                args.manifest = Some(PathBuf::from(next_value(&mut iter, "--manifest")?));
            }
            "-t" | "--target" => {
                args.target = Some(PathBuf::from(next_value(&mut iter, "--target")?));
            }
            "--overwrite" => args.overwrite = true,
            "--verify" => args.verify = true,
            "--xtool" => args.xtool = Some(next_value(&mut iter, "--xtool")?),
            "--extra" => args
                .extra_dirs
                .push(PathBuf::from(next_value(&mut iter, "--extra")?)),
            other if other.starts_with("--manifest=") => {
                args.manifest = Some(PathBuf::from(non_empty(
                    &other["--manifest=".len()..],
                    "--manifest",
                )?));
            }
            other if other.starts_with("--target=") => {
                args.target = Some(PathBuf::from(non_empty(
                    &other["--target=".len()..],
                    "--target",
                )?));
            }
            other if other.starts_with("--extra=") => {
                args.extra_dirs.push(PathBuf::from(non_empty(
                    &other["--extra=".len()..],
                    "--extra",
                )?));
            }
            other if other.starts_with("--xtool=") => {
                args.xtool = Some(non_empty(&other["--xtool=".len()..], "--xtool")?);
            }
            other => return Err(format!("unknown argument `{other}`; use --help")),
        }
    }
    Ok(args)
}

fn next_value(iter: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    iter.next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{flag} needs a value"))
}

fn non_empty(value: &str, flag: &str) -> Result<String, String> {
    if value.is_empty() {
        Err(format!("{flag} needs a value"))
    } else {
        Ok(value.to_string())
    }
}

/// Accepts the manifest file itself, the folder that holds it, or an archive
/// root with `disc-1`, `disc-2` subfolders. A disc-layout root resolves to the
/// first disc folder that carries a manifest.
pub fn resolve_manifest(path: PathBuf, manifest_file: &str) -> Result<PathBuf, String> {
    if path.is_file() {
        return Ok(path);
    }
    if !path.is_dir() {
        return Err(format!("manifest not found: {}", path.display()));
    }
    let direct = path.join(manifest_file);
    if direct.is_file() {
        return Ok(direct);
    }
    let mut discs = disc_children(&path)?;
    discs.sort();
    for dir in discs {
        let candidate = dir.join(manifest_file);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "no {manifest_file} in {} or its disc folders",
        path.display()
    ))
}

fn disc_children(path: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    Ok(entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|candidate| is_disc_folder(candidate))
        .collect())
}

/// Sibling `disc-N` folders next to the manifest, plus child `disc-N` folders
/// when the manifest sits at the archive root. The packer puts each disc's
/// volume and manifest in its own folder, so this keeps a disc backup usable
/// without adding every part by hand.
pub fn auto_disc_dirs(manifest_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(parent) = manifest_dir.parent() {
        if let Ok(entries) = parent.read_dir() {
            for entry in entries.flatten() {
                let path = entry.path();
                if path != manifest_dir && path.is_dir() && is_disc_folder(&path) {
                    dirs.push(path);
                }
            }
        }
    }
    if let Ok(entries) = manifest_dir.read_dir() {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && is_disc_folder(&path) {
                dirs.push(path);
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

fn is_disc_folder(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase().starts_with("disc-"))
        .unwrap_or(false)
}

pub fn store_hint(store: &str) -> &'static str {
    match store {
        "gog" | "custom" => {
            "This archive is DRM-free; run the game from the restored folder."
        }
        "steam" => {
            "Steam and an account that owns the game are required. Add the folder to a Steam library, then use Install/Verify."
        }
        "epic" => {
            "Epic Games Launcher or Legendary and an owning account are required; use its import/verify step."
        }
        "amazon" => {
            "Amazon Games and an owning account are required; use its import/verify step."
        }
        _ => "The store client may be required to launch this game.",
    }
}

pub fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    text
}

pub fn fmt_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Turns the backend's `@t:archive.*` tags into one plain English line. The
/// detail fields carry the volume/block numbers; they are appended in
/// parentheses instead of being left unread.
pub fn localize(message: &str) -> String {
    let mut parts = message.split('\u{1f}');
    let key = parts.next().unwrap_or(message);
    let detail = parts
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let base = match key {
        "@t:archive.cancelled" => "Cancelled.",
        "@t:archive.missingVolume" => "A volume is missing.",
        "@t:archive.blockCorrupt" => "A block failed its SHA-256 check.",
        "@t:archive.volumeCorrupt" => "A volume is corrupt or does not match the manifest.",
        "@t:archive.manifestMissing" => "The manifest is missing.",
        "@t:archive.manifestInvalid" => "The manifest is invalid.",
        "@t:archive.manifestIncomplete" => "The manifest is incomplete.",
        "@t:archive.manifestVersion" => "This manifest version is not supported.",
        "@t:archive.invalidTarget" => "That target folder is not allowed.",
        "@t:archive.targetNotEmpty" => "The game folder already exists; pass --overwrite.",
        "@t:archive.notEnoughSpaceBackend" => "There is not enough free space.",
        "@t:archive.xtoolRequired" => "This archive needs xtool; pass --xtool.",
        "@t:archive.xtoolMissing" | "@t:archive.xtoolLibraries" => {
            "xtool or its _libraries folder is missing."
        }
        "@t:archive.xtoolFailed" => "xtool could not decode the archive.",
        "@t:archive.parityTooMany" => "Too many damaged shards to repair from parity.",
        "@t:archive.parityFailed" => "The parity data could not repair this backup.",
        "@t:archive.parityWrite" => "Writing parity files failed.",
        "@t:archive.readFailed" => "Reading the archive failed.",
        "@t:archive.writeFailed" => "Writing the restored files failed.",
        "@t:archive.unsafePath" => "The archive contains an unsafe path.",
        "@t:archive.fat32Limit" => "A volume is too large for FAT32.",
        "@t:archive.targetFailed" => "The target folder could not be prepared.",
        "@t:archive.targetInsideSource" => "The target is inside the source folder.",
        other if other.starts_with("@t:") => other,
        other => other,
    };
    if detail.is_empty() {
        base.to_string()
    } else {
        format!("{base} ({detail})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "efxlve-restore-cli-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn args(values: &[&str]) -> Result<Args, String> {
        parse_args(values.iter().map(|value| value.to_string()))
    }

    #[test]
    fn parses_restore_and_verify_arguments() {
        let parsed = args(&[
            "--manifest",
            "D:\\backup",
            "--target",
            "E:\\Games",
            "--overwrite",
            "--xtool",
            "C:\\xtool\\xtool.exe",
            "--extra",
            "F:\\disc-2",
            "--extra=G:\\disc-3",
            "--verify",
        ])
        .unwrap();

        assert_eq!(parsed.manifest, Some(PathBuf::from("D:\\backup")));
        assert_eq!(parsed.target, Some(PathBuf::from("E:\\Games")));
        assert!(parsed.overwrite);
        assert!(parsed.verify);
        assert_eq!(parsed.xtool.as_deref(), Some("C:\\xtool\\xtool.exe"));
        assert_eq!(
            parsed.extra_dirs,
            vec![
                PathBuf::from("F:\\disc-2"),
                PathBuf::from("G:\\disc-3")
            ]
        );
    }

    #[test]
    fn parses_equals_forms_and_help() {
        let parsed = args(&[
            "--manifest=D:\\backup",
            "--target=E:\\Games",
            "--xtool=C:\\xtool.exe",
            "--extra=F:\\disc-2",
            "--help",
        ])
        .unwrap();
        assert_eq!(parsed.manifest, Some(PathBuf::from("D:\\backup")));
        assert_eq!(parsed.target, Some(PathBuf::from("E:\\Games")));
        assert_eq!(parsed.xtool.as_deref(), Some("C:\\xtool.exe"));
        assert_eq!(parsed.extra_dirs, vec![PathBuf::from("F:\\disc-2")]);
        assert!(parsed.help);
    }

    #[test]
    fn rejects_missing_values_and_unknown_flags() {
        assert!(args(&["--manifest"]).unwrap_err().contains("needs a value"));
        assert!(args(&["--target="]).unwrap_err().contains("needs a value"));
        assert!(args(&["--extra"]).unwrap_err().contains("needs a value"));
        assert!(args(&["--xtool="]).unwrap_err().contains("needs a value"));
        assert!(args(&["--nope"]).unwrap_err().contains("unknown argument"));
    }

    #[test]
    fn resolves_a_manifest_file_folder_or_disc_root() {
        let root = temp_root("manifest");
        let manifest = root.join("manifest.efxmeta.json");
        std::fs::write(&manifest, "{}").unwrap();

        assert_eq!(
            resolve_manifest(manifest.clone(), "manifest.efxmeta.json").unwrap(),
            manifest
        );
        assert_eq!(
            resolve_manifest(root.clone(), "manifest.efxmeta.json").unwrap(),
            manifest
        );

        let disc_root = temp_root("manifest-disc");
        let disc = disc_root.join("disc-2");
        std::fs::create_dir_all(&disc).unwrap();
        let disc_manifest = disc.join("manifest.efxmeta.json");
        std::fs::write(&disc_manifest, "{}").unwrap();
        assert_eq!(
            resolve_manifest(disc_root.clone(), "manifest.efxmeta.json").unwrap(),
            disc_manifest
        );

        let missing = temp_root("manifest-missing");
        let error = resolve_manifest(missing.clone(), "manifest.efxmeta.json").unwrap_err();
        assert!(error.contains("no manifest.efxmeta.json"), "{error}");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&disc_root);
        let _ = std::fs::remove_dir_all(&missing);
    }

    #[test]
    fn finds_sibling_and_child_disc_folders() {
        let root = temp_root("discs");
        let disc1 = root.join("disc-1");
        let disc2 = root.join("disc-2");
        let disc3 = disc1.join("disc-3");
        std::fs::create_dir_all(&disc2).unwrap();
        std::fs::create_dir_all(&disc3).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();

        let mut expected = vec![disc2.clone(), disc3.clone()];
        expected.sort();
        assert_eq!(auto_disc_dirs(&disc1), expected);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn formats_sizes_and_store_hints() {
        assert_eq!(fmt_bytes(0), "0 B");
        assert_eq!(fmt_bytes(1536), "1.5 KiB");
        assert_eq!(fmt_bytes(2 * 1024 * 1024), "2.0 MiB");
        assert!(store_hint("gog").contains("DRM-free"));
        assert!(store_hint("custom").contains("DRM-free"));
        assert!(store_hint("steam").contains("Steam"));
        assert!(store_hint("epic").contains("Epic"));
        assert!(store_hint("amazon").contains("Amazon"));
    }

    #[test]
    fn localizes_archive_error_tags() {
        let text = localize("@t:archive.blockCorrupt\u{1f}1\u{1f}2");
        assert!(text.contains("block"), "{text}");
        assert!(text.contains("(1 2)"), "{text}");
        assert_eq!(
            localize("@t:archive.cancelled"),
            "Cancelled."
        );
        assert_eq!(localize("plain message"), "plain message");
    }

    #[cfg(windows)]
    #[test]
    fn strips_the_verbatim_prefix_from_display_paths() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\Games\Game")),
            r"C:\Games\Game"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\Game")),
            r"\\server\share\Game"
        );
    }
}
