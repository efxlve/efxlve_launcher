//! Optional xtool precompression.
//!
//! Games keep their assets in containers (Telltale `.ttarch2`, Unreal `.ucas`,
//! Unity bundles) that hold zlib streams. zstd cannot recompress those bytes,
//! so a plain backup barely shrinks them. xtool finds the streams, opens them
//! losslessly and recompresses them with LZMA; zstd then sees ordinary data.
//!
//! The binary stays external. The user points the launcher at their own copy
//! and the whole `_libraries` folder stays next to it. A backup made this way
//! needs the same tool to restore, because the reverse step has to rebuild the
//! original streams byte for byte.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use super::format::sha256_bytes;

/// The pinned release. The zip hash is checked before anything is unpacked, so
/// a replaced or tampered asset never reaches the user's disk.
pub const VERSION: &str = "0.7.9";
pub const DOWNLOAD_URL: &str =
    "https://github.com/Razor12911/xtool/releases/download/079/xtool_0.7.9_hotfix.zip";
const ARCHIVE_SHA256: &str = "098ac99fa6375eec2318d60e6d6edc27dd6443f3a2d66ffee9ce255caefdbbae";
const LICENSE: &str = include_str!("xtool_license.txt");

/// Where the launcher keeps its managed copy.
pub fn install_path(root: &Path) -> PathBuf {
    root.join("xtool").join(VERSION)
}

pub fn installed_exe(root: &Path) -> PathBuf {
    install_path(root).join("xtool.exe")
}

async fn download() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("Efxlve-Launcher")
        .build()
        .map_err(|error| format!("@t:archive.xtoolDownloadFailed\u{1f}{error}"))?;
    let response = client
        .get(DOWNLOAD_URL)
        .send()
        .await
        .map_err(|error| format!("@t:archive.xtoolDownloadFailed\u{1f}{error}"))?
        .error_for_status()
        .map_err(|error| format!("@t:archive.xtoolDownloadFailed\u{1f}{error}"))?;
    let payload = response
        .bytes()
        .await
        .map_err(|error| format!("@t:archive.xtoolDownloadFailed\u{1f}{error}"))?;
    Ok(payload.to_vec())
}

/// Unpacks the pinned archive, skipping the 32-bit copy and the FreeArc
/// examples the launcher never runs. `enclosed_name` keeps a crafted entry from
/// escaping the target.
fn extract(payload: &[u8], staging: &Path) -> Result<(), String> {
    std::fs::create_dir_all(staging)
        .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(payload))
        .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let name = relative.to_string_lossy().replace('\\', "/");
        if name == "_x86"
            || name.starts_with("_x86/")
            || name == "Freearc"
            || name.starts_with("Freearc/")
        {
            continue;
        }
        let out = staging.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)
                .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
        }
        let mut file = std::fs::File::create(&out)
            .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
    }
    if !staging.join("xtool.exe").is_file() || !staging.join("_libraries").is_dir() {
        return Err("@t:archive.xtoolExtractFailed\u{1f}missing files".to_string());
    }
    std::fs::write(staging.join("LICENSE-xtool.txt"), LICENSE)
        .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
    std::fs::write(
        staging.join("SOURCE.txt"),
        format!("xtool {VERSION}\n{DOWNLOAD_URL}\n"),
    )
    .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
    Ok(())
}

/// Downloads and unpacks the pinned xtool release into the launcher data
/// folder. An existing copy is returned without touching the network, so the
/// button is safe to press twice.
pub async fn install(root: &Path) -> Result<PathBuf, String> {
    let target = install_path(root);
    let exe = installed_exe(root);
    if exe.is_file() && target.join("_libraries").is_dir() {
        return Ok(exe);
    }
    let payload = download().await?;
    let digest = sha256_bytes(&payload)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != ARCHIVE_SHA256 {
        return Err("@t:archive.xtoolHash".to_string());
    }
    std::fs::create_dir_all(root).map_err(|error| {
        format!("@t:archive.xtoolExtractFailed\u{1f}{error}")
    })?;
    let staging = root.join("xtool-install");
    let _ = std::fs::remove_dir_all(&staging);
    extract(&payload, &staging)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
    }
    if target.exists() {
        let old = root.join("xtool-old");
        let _ = std::fs::remove_dir_all(&old);
        std::fs::rename(&target, &old)
            .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
        match std::fs::rename(&staging, &target) {
            Ok(()) => {
                let _ = std::fs::remove_dir_all(&old);
            }
            Err(error) => {
                let _ = std::fs::rename(&old, &target);
                return Err(format!("@t:archive.xtoolExtractFailed\u{1f}{error}"));
            }
        }
    } else {
        std::fs::rename(&staging, &target)
            .map_err(|error| format!("@t:archive.xtoolExtractFailed\u{1f}{error}"))?;
    }
    Ok(exe)
}

/// Verified against xtool 0.7.9:
/// `test.bat` uses this exact precompressor invocation, and `decode` is its
/// matching inverse. `-l6:d256mb` makes the opened streams LZMA-compressed
/// instead of stored, which is what brings a 32 MB sample from 125 MB down to
/// 23 MB at a fraction of the `-l9` cost. The backslash in `-bd.\_libraries`
/// matters: with a plain `._libraries` xtool cannot load its plugins and
/// silently stores the stream as is.
const PRECOMP_ARGS: &[&str] = &[
    "precomp",
    "-mzlib",
    "-c32mb",
    "-t100p-1",
    "-dd3",
    "-l6:d256mb",
    "-bd.\\_libraries",
    "-",
    "-",
];
const DECODE_ARGS: &[&str] = &["decode", "-t100p-1", "-bd.\\_libraries", "-", "-"];

#[derive(Debug, Clone)]
pub struct Xtool {
    exe: PathBuf,
    root: PathBuf,
}

impl Xtool {
    /// The binary and its `_libraries` folder always ship together. Running
    /// xtool from the wrong folder silently loses its codec plugins, so both
    /// are checked before a job starts.
    pub fn new(path: &str) -> Result<Self, String> {
        let path = path.trim();
        if path.is_empty() {
            return Err("@t:archive.xtoolMissing".to_string());
        }
        let exe = PathBuf::from(path);
        if !exe.is_file() {
            return Err("@t:archive.xtoolMissing".to_string());
        }
        let root = exe
            .parent()
            .ok_or_else(|| "@t:archive.xtoolMissing".to_string())?
            .to_path_buf();
        if !root.join("_libraries").is_dir() {
            return Err("@t:archive.xtoolLibraries".to_string());
        }
        Ok(Self { exe, root })
    }

    pub fn precompress_file(&self, input: &Path, output: &Path) -> Result<(), String> {
        let input = std::fs::File::open(input)
            .map_err(|error| format!("@t:archive.xtoolFailed\u{1f}{error}"))?;
        let output = std::fs::File::create(output)
            .map_err(|error| format!("@t:archive.xtoolFailed\u{1f}{error}"))?;
        let status = Command::new(&self.exe)
            .args(PRECOMP_ARGS)
            .current_dir(&self.root)
            .stdin(Stdio::from(input))
            .stdout(Stdio::from(output))
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("@t:archive.xtoolFailed\u{1f}{error}"))?;
        if !status.success() {
            return Err(format!("@t:archive.xtoolFailed\u{1f}{status}"));
        }
        Ok(())
    }

    pub fn precompress(&self) -> Result<Child, String> {
        self.spawn(PRECOMP_ARGS)
    }

    pub fn decode(&self) -> Result<Child, String> {
        self.spawn(DECODE_ARGS)
    }

    fn spawn(&self, args: &[&str]) -> Result<Child, String> {
        Command::new(&self.exe)
            .args(args)
            .current_dir(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("@t:archive.xtoolFailed\u{1f}{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("efxlve-xtool-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn an_empty_path_is_refused() {
        assert!(Xtool::new("").is_err());
        assert!(Xtool::new("   ").is_err());
    }

    #[test]
    fn the_binary_and_its_libraries_must_sit_together() {
        let root = temp_root("layout");
        let exe = root.join("xtool.exe");
        std::fs::write(&exe, b"stub").unwrap();
        assert!(Xtool::new(&exe.display().to_string()).is_err());
        std::fs::create_dir_all(root.join("_libraries")).unwrap();
        assert!(Xtool::new(&exe.display().to_string()).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_precompressor_runs_from_the_binary_folder() {
        assert_eq!(PRECOMP_ARGS[0], "precomp");
        assert!(PRECOMP_ARGS.contains(&"-l6:d256mb"));
        assert!(PRECOMP_ARGS.contains(&"-bd.\\_libraries"));
        assert_eq!(DECODE_ARGS[0], "decode");
        assert!(DECODE_ARGS.contains(&"-bd.\\_libraries"));
    }

    #[test]
    fn the_pinned_archive_hash_is_a_sha256() {
        assert_eq!(ARCHIVE_SHA256.len(), 64);
        assert!(ARCHIVE_SHA256.chars().all(|value| value.is_ascii_hexdigit()));
    }

    #[test]
    fn extraction_keeps_the_binary_and_skips_the_32_bit_copy() {
        use std::io::Write;

        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("xtool.exe", options).unwrap();
            writer.write_all(b"exe").unwrap();
            writer
                .start_file("_libraries/zlibwapi.dll", options)
                .unwrap();
            writer.write_all(b"dll").unwrap();
            writer.start_file("_x86/xtool.exe", options).unwrap();
            writer.write_all(b"x86").unwrap();
            writer.start_file("Freearc/Arc.exe", options).unwrap();
            writer.write_all(b"arc").unwrap();
            writer.finish().unwrap();
        }
        let root = temp_root("extract");
        let staging = root.join("staging");
        extract(&buffer.into_inner(), &staging).unwrap();
        assert!(staging.join("xtool.exe").is_file());
        assert!(staging.join("_libraries").join("zlibwapi.dll").is_file());
        assert!(!staging.join("_x86").exists());
        assert!(!staging.join("Freearc").exists());
        assert!(staging.join("LICENSE-xtool.txt").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_package_without_its_libraries_is_refused() {
        use std::io::Write;

        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("xtool.exe", options).unwrap();
            writer.write_all(b"exe").unwrap();
            writer.finish().unwrap();
        }
        let root = temp_root("missing-libs");
        let error = extract(&buffer.into_inner(), &root).err().unwrap();
        assert!(error.contains("xtoolExtractFailed"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_existing_copy_is_returned_without_downloading() {
        let root = temp_root("installed");
        let target = install_path(&root);
        std::fs::create_dir_all(target.join("_libraries")).unwrap();
        std::fs::write(target.join("xtool.exe"), b"stub").unwrap();
        let resolved = install(&root).await.unwrap();
        assert_eq!(resolved, target.join("xtool.exe"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[ignore = "downloads the pinned xtool release from GitHub"]
    async fn the_pinned_release_downloads_and_unpacks() {
        let root =
            std::env::temp_dir().join(format!("efxlve-xtool-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = install(&root).await.expect("download and unpack xtool");
        assert!(exe.is_file());
        let folder = exe.parent().unwrap();
        assert!(folder.join("_libraries").is_dir());
        assert!(folder.join("LICENSE-xtool.txt").is_file());
        assert!(folder.join("xtool.exe").metadata().unwrap().len() > 1_000_000);
        let _ = std::fs::remove_dir_all(&root);
    }
}
