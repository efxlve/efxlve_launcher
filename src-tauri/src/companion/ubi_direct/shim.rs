//! Compatibility shim for games that expect the Uplay loader.
//!
//! Ubisoft titles import `uplay_r1_loader*.dll` / `upc_r1_loader*.dll` (R1) or
//! the `upc_r2_loader*.dll` family (R2). The official loader talks to the
//! Connect client; these shims answer the same exported API locally, so a game
//! the account owns can start without the client running.
//!
//! The binaries are the MIT-licensed ServerEmus builds, downloaded once and
//! verified against a pinned SHA-256. They are only deployed for a game whose
//! ownership the launcher already confirmed through Demux.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::companion::accounts;

const R1_X86_URL: &str =
    "https://github.com/ServerEmus/Uplay.upc_r1/releases/download/release-v0/upc_r1.dll";
const R1_X86_SHA: &str = "411E2210090A5B58FD74FDC6B578970D732B292E62D6C6EDF2C0A91C68846E5A";
const R1_X64_URL: &str =
    "https://github.com/ServerEmus/Uplay.upc_r1/releases/download/release-v0/upc_r164.dll";
const R1_X64_SHA: &str = "856D02D15D310646EBAB2EC19ED4404B175181741259EB54B6433C18C638763C";
const R2_X86_URL: &str =
    "https://github.com/ServerEmus/Uplay.upc_r2/releases/download/release-v1/upc_r2.dll";
const R2_X86_SHA: &str = "9CD588F4B9E6583F0B8C248388AFFE802943C56EF9FF5638586946CFFB5C2DA8";
const R2_X64_URL: &str =
    "https://github.com/ServerEmus/Uplay.upc_r2/releases/download/release-v1/upc_r264.dll";
const R2_X64_SHA: &str = "6F243D73DBEEC9B36336771A161AB0F22EC404DCAAD0681388909E3E3351A0AF";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Family {
    R1,
    R2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Loader {
    pub name: String,
    pub family: Family,
    x64: bool,
}

pub(crate) struct ShimAccount {
    pub product_id: u32,
    pub account_id: String,
    pub name: String,
    pub email: String,
    pub ticket: String,
    pub achievements: Vec<ShimAchievement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShimAchievement {
    pub id: u32,
    pub name: String,
    pub description: String,
    pub achieved: bool,
}

fn spec(family: Family, x64: bool) -> (&'static str, &'static str) {
    match (family, x64) {
        (Family::R1, false) => (R1_X86_URL, R1_X86_SHA),
        (Family::R1, true) => (R1_X64_URL, R1_X64_SHA),
        (Family::R2, false) => (R2_X86_URL, R2_X86_SHA),
        (Family::R2, true) => (R2_X64_URL, R2_X64_SHA),
    }
}

fn cache_dir() -> PathBuf {
    accounts::data_dir().join("ubi-shims")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

/// Download (once) and verify the shim for this architecture.
async fn ensure(family: Family, x64: bool) -> Result<PathBuf, String> {
    let (url, expected) = spec(family, x64);
    let file = cache_dir().join(
        url.rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("upc.dll"),
    );
    if let Ok(existing) = std::fs::read(&file) {
        if sha256_hex(&existing).eq_ignore_ascii_case(expected) {
            return Ok(file);
        }
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| format!("preparing the Uplay shim download: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("downloading the Uplay shim: {error}"))?;
    let response = response
        .error_for_status()
        .map_err(|error| format!("Uplay shim request failed: {error}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("reading the Uplay shim: {error}"))?;
    let got = sha256_hex(&bytes);
    if !got.eq_ignore_ascii_case(expected) {
        return Err(format!(
            "Uplay shim hash mismatch: got {got}, expected {expected}"
        ));
    }
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("creating {}: {error}", parent.display()))?;
    }
    let part = file.with_extension("part");
    tokio::fs::write(&part, &bytes)
        .await
        .map_err(|error| format!("writing {}: {error}", part.display()))?;
    tokio::fs::rename(&part, &file)
        .await
        .map_err(|error| format!("renaming {}: {error}", file.display()))?;
    Ok(file)
}

/// Find the loader a game imports. `None` means the game does not need a shim;
/// an `Err` means it needs the Orbit R2 loader, which is not handled here.
pub(crate) fn detect(exe: &Path) -> Result<Option<Loader>, String> {
    let bytes = std::fs::read(exe).map_err(|error| format!("reading {}: {error}", exe.display()))?;
    if contains(&bytes, b"ubiorbitapi_r2_loader") {
        return Err("this game uses the Orbit R2 loader, which is not supported yet".to_string());
    }
    let x64 = pe_is_64(&bytes).unwrap_or(true);
    // (needle in the exe, family, DLL to place next to it). Some titles import
    // a small `uplay32.dll`/`uplay64.dll` proxy that loads the real loader, so
    // the proxy has to map to the loader name the proxy expects.
    let names: &[(&str, Family, &str)] = if x64 {
        &[
            ("uplay_r1_loader64.dll", Family::R1, "uplay_r1_loader64.dll"),
            ("upc_r1_loader64.dll", Family::R1, "upc_r1_loader64.dll"),
            ("uplay_r2_loader64.dll", Family::R2, "uplay_r2_loader64.dll"),
            ("upc_r2_loader64.dll", Family::R2, "upc_r2_loader64.dll"),
            ("uplay64.dll", Family::R1, "uplay_r1_loader64.dll"),
            ("upc64.dll", Family::R2, "upc_r2_loader64.dll"),
        ]
    } else {
        &[
            ("uplay_r1_loader.dll", Family::R1, "uplay_r1_loader.dll"),
            ("upc_r1_loader.dll", Family::R1, "upc_r1_loader.dll"),
            ("uplay_r2_loader.dll", Family::R2, "uplay_r2_loader.dll"),
            ("upc_r2_loader.dll", Family::R2, "upc_r2_loader.dll"),
            ("uplay32.dll", Family::R1, "uplay_r1_loader.dll"),
            ("upc32.dll", Family::R2, "upc_r2_loader.dll"),
        ]
    };
    for (needle, family, target) in names {
        if contains(&bytes, needle.as_bytes()) {
            return Ok(Some(Loader {
                name: (*target).to_string(),
                family: *family,
                x64,
            }));
        }
    }
    Ok(None)
}

/// Deploy the matching loader next to the executable and write the account
/// config it reads. Returns the DLL name when a shim was installed.
pub(crate) async fn deploy(
    exe: &Path,
    account: &ShimAccount,
) -> Result<Option<String>, String> {
    let Some(loader) = detect(exe)? else {
        return Ok(None);
    };
    let source = ensure(loader.family, loader.x64).await?;
    let directory = exe
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", exe.display()))?;
    let target = directory.join(&loader.name);
    let source_bytes = tokio::fs::read(&source)
        .await
        .map_err(|error| format!("reading {}: {error}", source.display()))?;
    if let Ok(existing) = std::fs::read(&target) {
        if existing != source_bytes {
            let backup = directory.join(format!("{}.efxlve-orig", loader.name));
            if !backup.exists() {
                std::fs::rename(&target, &backup)
                    .map_err(|error| format!("backing up {}: {error}", target.display()))?;
            }
        }
    }
    tokio::fs::write(&target, &source_bytes)
        .await
        .map_err(|error| format!("writing {}: {error}", target.display()))?;
    write_config(directory, account, loader.family)?;
    Ok(Some(loader.name))
}

/// True when a loader backup is still in this folder, i.e. a restore either has
/// not run or failed (typically because the game is still running).
pub(crate) fn has_originals(directory: &Path) -> bool {
    std::fs::read_dir(directory)
        .map(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".efxlve-orig")
            })
        })
        .unwrap_or(false)
}

/// Put every loader the shim replaced back in place. Returns how many files
/// were restored; a folder with no backups is left untouched.
pub(crate) fn restore_originals(directory: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return 0;
    };
    let mut restored = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(original) = name.strip_suffix(".efxlve-orig") else {
            continue;
        };
        let target = directory.join(original);
        if target.exists() && std::fs::remove_file(&target).is_err() {
            continue;
        }
        if std::fs::rename(entry.path(), &target).is_ok() {
            restored += 1;
        }
    }
    restored
}

/// Write `upc.json` in a game folder. The caller can point the working
/// directory and the executable folder at the same account when they differ.
pub(crate) fn write_account_config(
    directory: &Path,
    account: &ShimAccount,
    family: Family,
) -> Result<(), String> {
    write_config(directory, account, family)
}

fn write_config(directory: &Path, account: &ShimAccount, family: Family) -> Result<(), String> {
    let saves = directory.join("Saves");
    std::fs::create_dir_all(&saves)
        .map_err(|error| format!("creating {}: {error}", saves.display()))?;
    let config = match family {
        Family::R1 => {
            let achis: Vec<serde_json::Value> = account
                .achievements
                .iter()
                .map(|achievement| {
                    serde_json::json!({
                        "Id": achievement.id,
                        "Name": achievement.name,
                        "Description": achievement.description,
                        "Achieved": achievement.achieved,
                    })
                })
                .collect();
            serde_json::json!({
                "UseDebug": false,
                "Account": {
                    "AccountId": account.account_id,
                    "Email": account.email,
                    "Name": account.name,
                    "Password": "efxlve",
                    "Country": "en-US",
                    "Ticket": account.ticket,
                },
                "Save": {
                    "Path": saves.display().to_string(),
                    "UseAppIdInName": true,
                },
                "Others": {
                    "ApplicationId": account.account_id,
                    "OfflineMode": true,
                },
                "CDKeys": [],
                "ChunkInfo": {
                    "ChunkIds": [],
                    "InstalledChunkIds": [],
                    "UseInstalledChunkIds": false,
                },
                "Achis": achis,
                "Rewards": [],
                "AvatarsPath": "",
            })
        }
        Family::R2 => serde_json::json!({
            "BasicLog": {
                "LogLevel": "Information",
                "UseNamePipeClient": false,
                "WaitBetweenUpdate": 20000,
                "LogUpdate": false,
            },
            "Account": {
                "AccountId": account.account_id,
                "Email": account.email,
                "Name": account.name,
                "Password": "efxlve",
                "Country": "en-US",
                "Ticket": account.ticket,
                "IsOffline": true,
            },
            "Save": {
                "Path": saves.display().to_string(),
                "UseProductIdInName": true,
                "EnableFileDelete": false,
            },
            "Others": {
                "ApplicationId": account.account_id,
                "EnableCrossBoot": false,
            },
            "Products": [
                { "ProductId": account.product_id, "Type": 0 }
            ],
            "AutoProductIds": [account.product_id],
            "ChunkIds": [],
            "AvatarsPath": "",
        }),
    };
    let text = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("serializing upc.json: {error}"))?;
    let path = directory.join("upc.json");
    std::fs::write(&path, text).map_err(|error| format!("writing {}: {error}", path.display()))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(left, right)| left.eq_ignore_ascii_case(right))
    })
}

fn pe_is_64(bytes: &[u8]) -> Option<bool> {
    if bytes.len() < 0x40 {
        return None;
    }
    let pe = u32::from_le_bytes(bytes.get(0x3c..0x40)?.try_into().ok()?) as usize;
    if bytes.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    let machine = u16::from_le_bytes(bytes.get(pe + 4..pe + 6)?.try_into().ok()?);
    Some(machine == 0x8664)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_exe(loader: &str, machine: u16) -> Vec<u8> {
        let mut bytes = vec![0u8; 0x200];
        bytes[0..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
        bytes.extend_from_slice(loader.as_bytes());
        bytes
    }

    #[test]
    fn detects_r1_and_r2_loaders_by_arch() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-shim-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let x86 = root.join("x86.exe");
        let x64 = root.join("x64.exe");
        std::fs::write(&x86, fake_exe("uplay_r1_loader.dll", 0x014c)).unwrap();
        std::fs::write(&x64, fake_exe("upc_r2_loader64.dll", 0x8664)).unwrap();
        let r1 = detect(&x86).unwrap().unwrap();
        assert_eq!(r1.name, "uplay_r1_loader.dll");
        assert_eq!(r1.family, Family::R1);
        assert!(!r1.x64);
        let r2 = detect(&x64).unwrap().unwrap();
        assert_eq!(r2.family, Family::R2);
        assert!(r2.x64);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_orbit_title_is_rejected_with_a_clear_message() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-orbit-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("orbit.exe");
        std::fs::write(&exe, fake_exe("ubiorbitapi_r2_loader64.dll", 0x8664)).unwrap();
        let error = detect(&exe).expect_err("Orbit is not supported");
        assert!(error.contains("Orbit R2"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_game_without_a_loader_needs_no_shim() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-noshim-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("game.exe");
        std::fs::write(&exe, fake_exe("steam_api64.dll", 0x8664)).unwrap();
        assert!(detect(&exe).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn maps_the_32_bit_uplay_proxy_to_the_loader() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-proxy-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("proxy.exe");
        std::fs::write(&exe, fake_exe("uplay32.dll", 0x014c)).unwrap();
        let loader = detect(&exe).unwrap().unwrap();
        assert_eq!(loader.name, "uplay_r1_loader.dll");
        assert_eq!(loader.family, Family::R1);
        assert!(!loader.x64);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_pinned_hashes_are_well_formed() {
        for (_, hash) in [
            spec(Family::R1, false),
            spec(Family::R1, true),
            spec(Family::R2, false),
            spec(Family::R2, true),
        ] {
            assert_eq!(hash.len(), 64);
            assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn r2_config_uses_the_r2_schema() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-r2json-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let account = ShimAccount {
            product_id: 80,
            account_id: "account-1".into(),
            name: "Player".into(),
            email: "player@efxlve.local".into(),
            ticket: "ticket-1".into(),
            achievements: Vec::new(),
        };
        write_config(&root, &account, Family::R2).unwrap();
        let text = std::fs::read_to_string(root.join("upc.json")).unwrap();
        assert!(text.contains("\"BasicLog\""));
        assert!(text.contains("\"UseProductIdInName\""));
        assert!(text.contains("\"Products\""));
        assert!(!text.contains("\"UseDebug\""));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[ignore = "downloads the MIT-licensed shim; no account needed"]
    async fn live_shim_asset_matches_the_pinned_hash() {
        let path = ensure(Family::R1, true).await.expect("shim download");
        println!("{}", path.display());
        assert!(path.is_file());
    }

    #[tokio::test]
    #[ignore = "downloads the shim and writes a temp game folder"]
    async fn deploys_the_loader_and_writes_the_account_config() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-deploy-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("game.exe");
        std::fs::write(&exe, fake_exe("uplay_r1_loader64.dll", 0x8664)).unwrap();
        let account = ShimAccount {
            product_id: 80,
            account_id: "account-1".into(),
            name: "Player".into(),
            email: "player@efxlve.local".into(),
            ticket: "ticket-1".into(),
            achievements: Vec::new(),
        };
        let name = deploy(&exe, &account).await.expect("deploy").expect("shim");
        assert_eq!(name, "uplay_r1_loader64.dll");
        assert!(root.join("uplay_r1_loader64.dll").is_file());
        let config = std::fs::read_to_string(root.join("upc.json")).unwrap();
        assert!(config.contains("account-1"));
        assert!(config.contains("ticket-1"));
        assert!(root.join("Saves").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }
}
