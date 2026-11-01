//! Where a Ubisoft title keeps its saves.
//!
//! Three layouts matter: the compatibility shim writes under
//! `<install>\Saves`, the official client keeps saves below
//! `Ubisoft Game Launcher\savegames\<account>\<uplay_id>`, and older titles
//! write beside the user's documents. The Manage panel and the cloud backup
//! read this one resolver so they never point at different folders.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SaveFolder {
    pub path: PathBuf,
    /// `shim`, `connect` or `documents`. Kept for tests and for a caller that
    /// wants to explain the layout; nothing writes it to disk.
    pub kind: &'static str,
}

/// The save folder of one Ubisoft title: the direct-install `Saves` folder when
/// the launcher owns the files, otherwise the folder the official client or the
/// game itself uses. `install_dir` lets a client-managed library card resolve
/// its shim folder even without a direct-install record, and `title` covers the
/// `Documents\My Games\<title>` layout.
pub(crate) fn path_for(
    product_id: u32,
    install_dir: Option<&Path>,
    title: Option<&str>,
) -> Option<PathBuf> {
    let record = super::super::ubi_installs::find(product_id);
    let uplay_id = record.as_ref().map(|game| game.uplay_id).unwrap_or(0);
    let title = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .or_else(|| record.as_ref().map(|game| game.name.as_str()));
    let install = install_dir
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .or_else(|| record.as_ref().map(|game| PathBuf::from(&game.install_dir)));
    let shim_dirs = shim_dirs(install.as_deref(), record.as_ref());
    resolve(product_id, uplay_id, title, &shim_dirs).map(|folder| folder.path)
}

/// The shim writes `Saves` next to the executable and its `upc.json`, which is
/// not the install root for Unreal titles (`Binaries/Win64`). Prefer that
/// folder, then the root, because older games keep their data at the root.
fn shim_dirs(
    install: Option<&Path>,
    record: Option<&super::super::ubi_installs::InstalledGame>,
) -> Vec<PathBuf> {
    let Some(install) = install else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    if let Some(record) = record.filter(|game| !game.exe.trim().is_empty()) {
        let exe = install.join(record.exe.replace('\\', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = exe.parent().filter(|parent| *parent != install) {
            dirs.push(parent.to_path_buf());
        }
    }
    dirs.push(install.to_path_buf());
    dirs
}

/// The save folder of one direct install; used by the cloud backup, which only
/// receives the library app key.
pub(crate) fn path_for_product(product_id: u32) -> Option<PathBuf> {
    path_for(product_id, None, None)
}

/// Copy the Connect save slots into the folder the compatibility shim reads.
///
/// Classic Connect slots use the same 552-byte format as the shim; only the
/// folder differs (`savegames/<account>/<uplay id>` vs
/// `<install>/Saves/<app id>`). Existing direct saves always win, so a second
/// launch never rolls progress back.
pub(crate) fn migrate_connect_saves(
    product_id: u32,
    uplay_id: u32,
    install_dir: &Path,
    exe_dir: Option<&Path>,
) -> Result<usize, String> {
    let base = exe_dir.filter(|dir| !dir.as_os_str().is_empty()).unwrap_or(install_dir);
    if base.as_os_str().is_empty() {
        return Ok(0);
    }
    let mut ids = Vec::new();
    for id in [uplay_id, product_id] {
        if id != 0 && !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Ok(0);
    }
    let roots = connect_roots();
    // Prefer the signed-in account; a shared PC can hold several savegames
    // folders and the import must not copy another player's progress. When no
    // session names the account and more than one folder owns this product, do
    // nothing rather than guess.
    let account = super::super::ubisoft_login::stored_session()
        .map(|session| session.user_id)
        .unwrap_or_default();
    let mut found: Vec<PathBuf> = candidates(product_id, uplay_id, None, &[], &roots, &[])
        .into_iter()
        .filter(|folder| folder.kind == "connect" && holds_saves(&folder.path))
        .map(|folder| folder.path)
        .collect();
    let source = preferred_connect_source(&account, &ids, &roots).or_else(|| {
        if found.len() == 1 {
            found.pop()
        } else {
            None
        }
    });
    let Some(source) = source else {
        return Ok(0);
    };
    // R1 names the folder after the Uplay id it starts with, R2 after the
    // product id. One of the two is the active one; the other costs a few KB
    // and keeps a family switch from losing the imported progress.
    let mut copied = 0;
    for id in ids {
        let destination = base.join("Saves").join(id.to_string());
        copied += copy_slots(&source, &destination)?;
    }
    Ok(copied)
}

fn preferred_connect_source(account: &str, ids: &[u32], roots: &[PathBuf]) -> Option<PathBuf> {
    if account.is_empty() {
        return None;
    }
    for root in roots {
        for id in ids {
            let folder = root.join(account).join(id.to_string());
            if folder.is_dir() && holds_saves(&folder) {
                return Some(folder);
            }
        }
    }
    None
}

/// The shim's `UPLAY_SAVE_*` format stores a 552-byte header (the first field
/// is `548`). Newer Connect saves use a 36-byte header with a different payload;
/// copying those raw would make the shim seek past the real data, so they are
/// left to the official client instead of being half-imported.
fn classic_slot(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 4];
    if file.read_exact(&mut header).is_err() {
        return false;
    }
    u32::from_le_bytes(header) == 548
}

fn copy_slots(source: &Path, destination: &Path) -> Result<usize, String> {
    let entries = match std::fs::read_dir(source) {
        Ok(entries) => entries,
        Err(_) => return Ok(0),
    };
    let mut slots: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case("save"))
                .unwrap_or(false)
        })
        .filter(|path| classic_slot(path))
        .collect();
    if slots.is_empty() {
        return Ok(0);
    }
    slots.sort();
    std::fs::create_dir_all(destination)
        .map_err(|error| format!("creating {}: {error}", destination.display()))?;
    let mut copied = 0;
    for slot in slots {
        let Some(name) = slot.file_name() else {
            continue;
        };
        let target = destination.join(name);
        if target.exists() {
            continue;
        }
        std::fs::copy(&slot, &target)
            .map_err(|error| format!("copying {}: {error}", slot.display()))?;
        copied += 1;
    }
    Ok(copied)
}

/// Resolves the best save folder for a Ubisoft product.
///
/// A folder that already holds save data wins over an empty one, because an
/// empty shim folder means the game has not been played through the shim yet
/// while Connect may still hold the progress from an earlier install.
fn resolve(
    product_id: u32,
    uplay_id: u32,
    title: Option<&str>,
    shim_dirs: &[PathBuf],
) -> Option<SaveFolder> {
    let connect_roots = connect_roots();
    let documents_roots = documents_roots();
    let candidates = candidates(
        product_id,
        uplay_id,
        title,
        shim_dirs,
        &connect_roots,
        &documents_roots,
    );
    pick(candidates)
}

fn candidates(
    product_id: u32,
    uplay_id: u32,
    title: Option<&str>,
    shim_dirs: &[PathBuf],
    connect_roots: &[PathBuf],
    documents_roots: &[PathBuf],
) -> Vec<SaveFolder> {
    let mut out = Vec::new();

    for install_dir in shim_dirs.iter().filter(|dir| !dir.as_os_str().is_empty()) {
        let shim = install_dir.join("Saves");
        if shim.is_dir() && !out.iter().any(|folder: &SaveFolder| folder.path == shim) {
            out.push(SaveFolder {
                path: shim,
                kind: "shim",
            });
        }
    }

    let mut ids: Vec<String> = Vec::new();
    for id in [uplay_id, product_id] {
        if id != 0 {
            let id = id.to_string();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    for root in connect_roots {
        for id in &ids {
            // The standard layout is `<account uuid>\<product>`; a product
            // folder directly below `savegames` also exists on a few installs.
            for found in child_dirs(root).filter_map(|account| {
                let direct = account.join(id);
                if direct.is_dir() {
                    return Some(direct);
                }
                if account.file_name()?.to_string_lossy() == id.as_str() {
                    return Some(account);
                }
                None
            }) {
                out.push(SaveFolder {
                    path: found,
                    kind: "connect",
                });
            }
        }
    }

    if let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) {
        for root in documents_roots {
            let dir = root.join(title);
            if dir.is_dir() {
                out.push(SaveFolder {
                    path: dir,
                    kind: "documents",
                });
            }
        }
    }

    out
}

fn pick(candidates: Vec<SaveFolder>) -> Option<SaveFolder> {
    let mut candidates = candidates;
    let filled = candidates
        .iter()
        .position(|folder| holds_saves(&folder.path));
    match filled {
        Some(index) => Some(candidates.remove(index)),
        None => {
            if candidates.is_empty() {
                None
            } else {
                Some(candidates.remove(0))
            }
        }
    }
}

fn holds_saves(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn child_dirs(root: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            entry.file_type().ok().filter(|kind| kind.is_dir()).map(|_| path)
        })
}

fn connect_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // Older clients kept savegames under the user profile; current ones use
    // the launcher folder under Program Files.
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        roots.push(local.join("Ubisoft Game Launcher").join("savegames"));
    }
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        let Some(base) = std::env::var_os(var).map(PathBuf::from) else {
            continue;
        };
        roots.push(
            base.join("Ubisoft")
                .join("Ubisoft Game Launcher")
                .join("savegames"),
        );
    }
    roots
}

fn documents_roots() -> Vec<PathBuf> {
    let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) else {
        return Vec::new();
    };
    let documents = profile.join("Documents");
    vec![
        documents.join("My Games"),
        documents.join("Ubisoft"),
        documents,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "efxlve-saves-{}-{}-{name}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The shim's slot header: `header_size - 4 = 548`, then payload.
    fn classic_slot(payload: &[u8]) -> Vec<u8> {
        let mut file = vec![0u8; 552];
        file[0..4].copy_from_slice(&548u32.to_le_bytes());
        file.extend_from_slice(payload);
        file
    }

    #[test]
    fn a_folder_with_saves_beats_an_empty_shim_folder() {
        let root = temp_dir("filled-connect");
        let install = root.join("game");
        let shim = install.join("Saves");
        std::fs::create_dir_all(&shim).unwrap();
        let connect = root.join("savegames");
        let account = connect.join("account");
        let product = account.join("80");
        std::fs::create_dir_all(&product).unwrap();
        std::fs::write(product.join("save.sav"), b"progress").unwrap();

        let found = pick(candidates(
            80,
            0,
            None,
            &[install.clone()],
            &[connect],
            &[],
        ))
        .expect("a folder");
        assert_eq!(found.kind, "connect");
        assert_eq!(found.path, product);
    }

    #[test]
    fn the_shim_folder_is_used_when_nothing_else_exists() {
        let root = temp_dir("empty-shim");
        let install = root.join("game");
        let shim = install.join("Saves");
        std::fs::create_dir_all(&shim).unwrap();

        let found = pick(candidates(
            80,
            0,
            None,
            &[install.clone()],
            &[root.join("savegames")],
            &[],
        ))
        .expect("the shim folder");
        assert_eq!(found.kind, "shim");
        assert_eq!(found.path, shim);
    }

    #[test]
    fn connect_folders_match_the_uplay_id_before_the_product_id() {
        let root = temp_dir("uplay-id");
        let connect = root.join("savegames");
        let account = connect.join("account");
        let uplay = account.join("1651");
        let product = account.join("9000");
        std::fs::create_dir_all(&uplay).unwrap();
        std::fs::create_dir_all(&product).unwrap();
        std::fs::write(uplay.join("save.sav"), b"one").unwrap();
        std::fs::write(product.join("save.sav"), b"two").unwrap();

        let found = pick(candidates(9000, 1651, None, &[], &[connect], &[]))
            .expect("a Connect folder");
        assert_eq!(found.path, uplay);
    }

    #[test]
    fn documents_folders_are_matched_by_title() {
        let root = temp_dir("documents");
        let my_games = root.join("My Games");
        let saves = my_games.join("Rayman Origins");
        std::fs::create_dir_all(&saves).unwrap();
        std::fs::write(saves.join("slot1.sav"), b"x").unwrap();

        let found = pick(candidates(
            80,
            0,
            Some("Rayman Origins"),
            &[],
            &[],
            &[my_games],
        ))
        .expect("a documents folder");
        assert_eq!(found.kind, "documents");
        assert_eq!(found.path, saves);
    }

    #[test]
    fn a_product_without_any_folder_has_no_answer() {
        let root = temp_dir("nothing");
        assert!(pick(candidates(80, 0, None, &[], &[root], &[])).is_none());
    }

    #[test]
    fn connect_slots_are_copied_into_the_shim_folder() {
        let root = temp_dir("migrate-slots");
        let source = root.join("connect").join("account").join("1651");
        let destination = root.join("game").join("Saves").join("1651");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("1.save"), classic_slot(b"first")).unwrap();
        std::fs::write(source.join("4.save"), classic_slot(b"fourth")).unwrap();
        std::fs::write(source.join("notes.txt"), b"not a slot").unwrap();
        // A newer Connect slot uses a 36-byte header; leave it to the client.
        let mut modern = 36u32.to_le_bytes().to_vec();
        modern.extend_from_slice(b"payload");
        std::fs::write(source.join("7.save"), modern).unwrap();

        let copied = copy_slots(&source, &destination).unwrap();
        assert_eq!(copied, 2);
        assert_eq!(
            std::fs::read(destination.join("1.save")).unwrap(),
            classic_slot(b"first")
        );
        assert_eq!(
            std::fs::read(destination.join("4.save")).unwrap(),
            classic_slot(b"fourth")
        );
        assert!(!destination.join("notes.txt").exists());
        assert!(!destination.join("7.save").exists());
    }

    #[test]
    fn an_unreal_executable_prefers_its_own_saves_folder() {
        let root = temp_dir("unreal-shim");
        let install = root.join("game");
        let exe_dir = install.join("Binaries").join("Win64");
        let shim = exe_dir.join("Saves");
        std::fs::create_dir_all(&shim).unwrap();
        std::fs::write(shim.join("1.save"), classic_slot(b"progress")).unwrap();
        let record = crate::companion::ubi_installs::InstalledGame {
            product_id: 80,
            name: "Game".into(),
            install_dir: install.display().to_string(),
            exe: "Binaries\\Win64\\Game.exe".into(),
            installed_at: 0,
            install_reg: String::new(),
            uplay_id: 80,
            ticket: String::new(),
            client_launch: false,
            manifest: String::new(),
        };
        let dirs = shim_dirs(Some(&install), Some(&record));
        assert_eq!(dirs.first().unwrap(), &exe_dir);
        let found = pick(candidates(80, 80, None, &dirs, &[], &[])).expect("shim folder");
        assert_eq!(found.path, shim);
    }

    #[test]
    #[ignore = "reads the installed Ubisoft Connect savegames"]
    fn live_classic_connect_slot_is_imported() {
        let root = temp_dir("live-migrate");
        let install = root.join("game");
        let copied = migrate_connect_saves(274, 274, &install, None).expect("migration");
        assert!(copied > 0, "no classic Connect save slot found");
        let slot = install.join("Saves").join("274").join("1.save");
        assert!(slot.is_file());
        let bytes = std::fs::read(&slot).unwrap();
        assert!(bytes.len() > 552);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 548);
        println!("imported {copied} slot(s), first={} bytes", bytes.len());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_direct_slot_is_never_overwritten_by_the_connect_copy() {
        let root = temp_dir("migrate-keep");
        let source = root.join("connect");
        let destination = root.join("game").join("Saves");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("1.save"), classic_slot(b"old cloud")).unwrap();
        std::fs::write(destination.join("1.save"), classic_slot(b"new local")).unwrap();

        let copied = copy_slots(&source, &destination).unwrap();
        assert_eq!(copied, 0);
        assert_eq!(
            std::fs::read(destination.join("1.save")).unwrap(),
            classic_slot(b"new local")
        );
    }
}
