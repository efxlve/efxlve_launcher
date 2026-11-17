#![cfg(feature = "restore-fixture")]

//! End-to-end check for the standalone restorer: the fixture packer builds a
//! real `.efxpak` archive, then the built `efxlve-restore` binary restores it
//! and every byte is compared with the source tree.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn temp_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "efxlve-restore-e2e-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn noisy(len: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

fn write_source(root: &Path) -> PathBuf {
    let game = root.join("Game");
    fs::create_dir_all(game.join("bin")).unwrap();
    fs::create_dir_all(game.join("empty")).unwrap();
    fs::write(game.join("bin").join("a.dat"), noisy(80 * 1024)).unwrap();
    fs::write(game.join("readme.txt"), b"hello fixture").unwrap();
    game
}

fn pack(source: &Path, target: &Path, disc_layout: bool) -> PathBuf {
    let mut command = Command::new(env!("CARGO_BIN_EXE_efxlve-pack-fixture"));
    command.arg("--source").arg(source).arg("--target").arg(target);
    if disc_layout {
        command.arg("--disc-layout");
    }
    let output = command.output().expect("run the fixture packer");
    assert!(
        output.status.success(),
        "packer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    PathBuf::from(
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string(),
    )
}

fn restore(manifest: &Path, target: &Path, extra: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_efxlve-restore"));
    command
        .arg("--manifest")
        .arg(manifest)
        .arg("--target")
        .arg(target);
    command.args(extra);
    command.output().expect("run efxlve-restore")
}

fn assert_same_tree(source: &Path, restored: &Path) {
    for relative in [Path::new("bin/a.dat"), Path::new("readme.txt")] {
        let expected = fs::read(source.join(relative)).unwrap();
        let actual = fs::read(restored.join(relative)).unwrap();
        assert_eq!(actual, expected, "{} differs", relative.display());
    }
    assert!(
        restored.join("empty").is_dir(),
        "empty directory was not restored"
    );
}

#[test]
fn the_built_binary_restores_a_flat_archive_byte_for_byte() {
    let root = temp_root("flat");
    let source = write_source(&root);
    let archive_root = root.join("archive");
    let manifest = pack(&source, &archive_root, false);
    let archive = manifest.parent().unwrap().to_path_buf();
    let manifest_json: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    assert!(
        manifest_json["volumes"].as_array().unwrap().len() > 1,
        "the fixture should span several volumes"
    );

    let restore_parent = root.join("restored");
    let output = restore(&archive, &restore_parent, &[]);
    assert!(
        output.status.success(),
        "restore failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_same_tree(&source, &restore_parent.join("Game"));

    let verify = restore(&manifest, &root.join("unused"), &["--verify"]);
    assert!(
        verify.status.success(),
        "verify failed: {}",
        String::from_utf8_lossy(&verify.stderr)
    );
    assert!(
        String::from_utf8_lossy(&verify.stdout).contains("Verified"),
        "verify output did not report success"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_built_binary_rejects_a_corrupted_volume_without_writing_files() {
    let root = temp_root("corrupt");
    let source = write_source(&root);
    let archive_root = root.join("archive");
    let manifest = pack(&source, &archive_root, false);
    let archive = manifest.parent().unwrap().to_path_buf();
    let volume = fs::read_dir(&archive)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".efxpak."))
        })
        .expect("a volume file");
    let mut bytes = fs::read(&volume).unwrap();
    assert!(bytes.len() > 72, "volume is too small to corrupt");
    bytes[64 + 8] ^= 0xFF;
    fs::write(&volume, &bytes).unwrap();

    let restore_parent = root.join("restored");
    let output = restore(&archive, &restore_parent, &[]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lower = stderr.to_lowercase();
    assert!(
        !output.status.success(),
        "corrupt restore unexpectedly succeeded"
    );
    assert!(
        (lower.contains("block") || lower.contains("volume"))
            && (lower.contains("corrupt") || lower.contains("sha-256")),
        "expected a block/volume corruption message, got: {stderr}"
    );
    assert!(
        !restore_parent.join("Game").exists(),
        "a target folder was created despite the corrupt volume"
    );
    let empty = fs::read_dir(&restore_parent)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true);
    assert!(empty, "staging or target files were left behind");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_built_binary_finds_disc_folders_and_restores_them() {
    let root = temp_root("discs");
    let source = write_source(&root);
    let archive_root = root.join("archive");
    let manifest = pack(&source, &archive_root, true);
    let archive = manifest.parent().unwrap().to_path_buf();
    assert!(
        archive.join("disc-2").is_dir(),
        "the fixture should have a second disc folder"
    );

    let restore_parent = root.join("restored");
    let output = restore(&archive, &restore_parent, &[]);
    assert!(
        output.status.success(),
        "disc restore failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_same_tree(&source, &restore_parent.join("Game"));

    let _ = fs::remove_dir_all(&root);
}
