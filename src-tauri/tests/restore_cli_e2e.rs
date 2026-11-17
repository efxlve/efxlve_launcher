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
    write_source_sized(root, 80 * 1024)
}

fn write_source_sized(root: &Path, data_len: usize) -> PathBuf {
    let game = root.join("Game");
    fs::create_dir_all(game.join("bin")).unwrap();
    fs::create_dir_all(game.join("empty")).unwrap();
    fs::write(game.join("bin").join("a.dat"), noisy(data_len)).unwrap();
    fs::write(game.join("readme.txt"), b"hello fixture").unwrap();
    game
}

fn pack(source: &Path, target: &Path, disc_layout: bool) -> PathBuf {
    pack_with(source, target, disc_layout, None, None, None)
}

fn pack_custom(
    source: &Path,
    target: &Path,
    volume_bytes: u64,
    parity_shards: usize,
) -> PathBuf {
    pack_with(
        source,
        target,
        false,
        None,
        Some(volume_bytes),
        Some(parity_shards),
    )
}

fn pack_with(
    source: &Path,
    target: &Path,
    disc_layout: bool,
    xtool: Option<&Path>,
    volume_bytes: Option<u64>,
    parity_shards: Option<usize>,
) -> PathBuf {
    let mut command = Command::new(env!("CARGO_BIN_EXE_efxlve-pack-fixture"));
    command.arg("--source").arg(source).arg("--target").arg(target);
    if disc_layout {
        command.arg("--disc-layout");
    }
    if let Some(xtool) = xtool {
        command.arg("--xtool").arg(xtool);
    }
    if let Some(volume_bytes) = volume_bytes {
        command.arg("--volume-bytes").arg(volume_bytes.to_string());
    }
    if let Some(parity_shards) = parity_shards {
        command.arg("--parity-shards").arg(parity_shards.to_string());
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

fn fake_xtool(root: &Path) -> PathBuf {
    let folder = root.join("fake-xtool");
    fs::create_dir_all(folder.join("_libraries")).unwrap();
    let name = if cfg!(windows) { "xtool.exe" } else { "xtool" };
    let path = folder.join(name);
    fs::copy(env!("CARGO_BIN_EXE_efxlve-fake-xtool"), &path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn volume_paths(archive: &Path) -> Vec<PathBuf> {
    let mut volumes: Vec<PathBuf> = fs::read_dir(archive)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".efxpak.") && !name.contains(".efxpar."))
        })
        .collect();
    volumes.sort();
    volumes
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
fn the_built_binary_repairs_a_damaged_shard_from_parity() {
    let root = temp_root("parity");
    let source = write_source(&root);
    let archive_root = root.join("archive");
    let manifest = pack(&source, &archive_root, false);
    let archive = manifest.parent().unwrap().to_path_buf();
    let manifest_json: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(manifest_json["formatVersion"], 3);
    assert!(
        manifest_json["parity"]["volumes"]
            .as_array()
            .is_some_and(|volumes| !volumes.is_empty()),
        "the fixture should carry parity metadata"
    );

    let volumes = volume_paths(&archive);
    let volume = volumes.first().expect("a volume file");
    let mut bytes = fs::read(volume).unwrap();
    assert!(bytes.len() > 72, "volume is too small to damage");
    bytes[64 + 8] ^= 0xFF;
    fs::write(volume, &bytes).unwrap();
    assert!(
        fs::read_dir(&archive).unwrap().any(|entry| entry
            .ok()
            .and_then(|entry| entry.file_name().to_str().map(str::to_string))
            .is_some_and(|name| name.contains(".efxpar."))),
        "the fixture should write a parity file"
    );

    let restore_parent = root.join("restored");
    let output = restore(&archive, &restore_parent, &[]);
    assert!(
        output.status.success(),
        "parity repair failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_same_tree(&source, &restore_parent.join("Game"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_built_binary_repairs_several_damaged_shards() {
    let root = temp_root("parity-multi");
    let source = write_source_sized(&root, 1024 * 1024);
    let archive_root = root.join("archive");
    let manifest = pack_custom(&source, &archive_root, 512 * 1024, 4);
    let archive = manifest.parent().unwrap().to_path_buf();
    let manifest_json: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(manifest_json["parity"]["parityShards"], 4);
    let data_shards = manifest_json["parity"]["dataShards"]
        .as_u64()
        .expect("dataShards");
    assert!(data_shards >= 5, "fixture has too few data shards");
    let shard_bytes = manifest_json["parity"]["shardBytes"]
        .as_u64()
        .expect("shardBytes") as usize;

    let volumes = volume_paths(&archive);
    let volume = volumes.first().expect("a volume file");
    let mut bytes = fs::read(volume).unwrap();
    assert!(bytes.len() > shard_bytes * 4, "volume is too small");
    for shard in 0..4 {
        bytes[shard * shard_bytes] ^= 0xFF;
    }
    fs::write(volume, &bytes).unwrap();

    let restore_parent = root.join("restored");
    let output = restore(&archive, &restore_parent, &[]);
    assert!(
        output.status.success(),
        "multi-shard parity repair failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_same_tree(&source, &restore_parent.join("Game"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_built_binary_rejects_a_volume_whose_parity_is_also_damaged() {
    let root = temp_root("corrupt");
    let source = write_source(&root);
    let archive_root = root.join("archive");
    let manifest = pack(&source, &archive_root, false);
    let archive = manifest.parent().unwrap().to_path_buf();
    let volumes = volume_paths(&archive);
    let volume = volumes.first().expect("a volume file");
    let mut bytes = fs::read(volume).unwrap();
    assert!(bytes.len() > 72, "volume is too small to corrupt");
    bytes[64 + 8] ^= 0xFF;
    fs::write(volume, &bytes).unwrap();

    let parity_files: Vec<PathBuf> = fs::read_dir(&archive)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(".efxpar."))
        })
        .collect();
    assert!(!parity_files.is_empty(), "the fixture should have parity files");
    for parity in &parity_files {
        let mut parity_bytes = fs::read(parity).unwrap();
        parity_bytes[0] ^= 0xFF;
        fs::write(parity, &parity_bytes).unwrap();
    }

    let restore_parent = root.join("restored");
    let output = restore(&archive, &restore_parent, &[]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lower = stderr.to_lowercase();
    assert!(
        !output.status.success(),
        "corrupt restore unexpectedly succeeded"
    );
    assert!(
        lower.contains("parity") || lower.contains("shard"),
        "expected a parity failure message, got: {stderr}"
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

#[test]
fn the_built_binary_rebuilds_a_deleted_disc_from_cross_disc_parity() {
    let root = temp_root("missing-disc");
    let source = write_source(&root);
    let archive_root = root.join("archive");
    let manifest = pack(&source, &archive_root, true);
    let archive = manifest.parent().unwrap().to_path_buf();
    assert!(
        archive.join("disc-2").is_dir(),
        "the fixture should have a second disc folder"
    );
    fs::remove_dir_all(archive.join("disc-2")).unwrap();

    let restore_parent = root.join("restored");
    let output = restore(&archive, &restore_parent, &[]);
    assert!(
        output.status.success(),
        "cross-disc repair failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_same_tree(&source, &restore_parent.join("Game"));

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_built_binary_restores_an_xtool_archive() {
    let root = temp_root("xtool");
    let source = write_source(&root);
    let archive_root = root.join("archive");
    let xtool = fake_xtool(&root);
    let manifest = pack_with(&source, &archive_root, false, Some(&xtool), None, None);
    let archive = manifest.parent().unwrap().to_path_buf();
    let manifest_json: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    assert_eq!(
        manifest_json["compression"]["precompressor"], "xtool",
        "the fixture should be marked as xtool-precompressed"
    );

    let restore_parent = root.join("restored");
    let xtool_arg = xtool.to_string_lossy().to_string();
    let output = restore(&archive, &restore_parent, &["--xtool", &xtool_arg]);
    assert!(
        output.status.success(),
        "xtool restore failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_same_tree(&source, &restore_parent.join("Game"));

    let verify = restore(&manifest, &root.join("unused"), &["--verify"]);
    assert!(
        verify.status.success(),
        "verify failed: {}",
        String::from_utf8_lossy(&verify.stderr)
    );
    assert!(String::from_utf8_lossy(&verify.stdout).contains("Verified"));

    let failure_parent = root.join("no-xtool");
    let failure = restore(&archive, &failure_parent, &[]);
    assert!(
        !failure.status.success(),
        "an xtool archive restored without --xtool"
    );
    assert!(
        String::from_utf8_lossy(&failure.stderr)
            .to_lowercase()
            .contains("xtool"),
        "expected an xtool error"
    );
    assert!(!failure_parent.join("Game").exists());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_built_binary_reports_a_missing_volume_without_writing_files() {
    let root = temp_root("missing");
    let source = write_source(&root);
    let archive_root = root.join("archive");
    let manifest = pack(&source, &archive_root, false);
    let archive = manifest.parent().unwrap().to_path_buf();
    let volumes = volume_paths(&archive);
    assert!(
        volumes.len() > 1,
        "the fixture should span several volumes"
    );
    let volume = &volumes[1];
    let volume_name = volume
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    fs::remove_file(volume).unwrap();
    for entry in fs::read_dir(&archive).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&volume_name) && name.contains(".efxpar.") {
            fs::remove_file(entry.path()).unwrap();
        }
    }

    let restore_parent = root.join("restored");
    let output = restore(&archive, &restore_parent, &[]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lower = stderr.to_lowercase();
    assert!(
        !output.status.success(),
        "missing-volume restore unexpectedly succeeded"
    );
    assert!(
        lower.contains("volume") && lower.contains("missing"),
        "expected a missing-volume message, got: {stderr}"
    );
    assert!(
        !restore_parent.join("Game").exists(),
        "a target folder was created despite the missing volume"
    );
    let empty = fs::read_dir(&restore_parent)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true);
    assert!(empty, "staging or target files were left behind");

    let _ = fs::remove_dir_all(&root);
}
