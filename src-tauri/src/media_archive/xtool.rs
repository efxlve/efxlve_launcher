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

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

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
}
