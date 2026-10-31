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
    resolve(product_id, uplay_id, title, install.as_deref()).map(|folder| folder.path)
}

/// The save folder of one direct install; used by the cloud backup, which only
/// receives the library app key.
pub(crate) fn path_for_product(product_id: u32) -> Option<PathBuf> {
    path_for(product_id, None, None)
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
    install_dir: Option<&Path>,
) -> Option<SaveFolder> {
    let connect_roots = connect_roots();
    let documents_roots = documents_roots();
    let candidates = candidates(
        product_id,
        uplay_id,
        title,
        install_dir,
        &connect_roots,
        &documents_roots,
    );
    pick(candidates)
}

fn candidates(
    product_id: u32,
    uplay_id: u32,
    title: Option<&str>,
    install_dir: Option<&Path>,
    connect_roots: &[PathBuf],
    documents_roots: &[PathBuf],
) -> Vec<SaveFolder> {
    let mut out = Vec::new();

    if let Some(install_dir) = install_dir.filter(|dir| !dir.as_os_str().is_empty()) {
        let shim = install_dir.join("Saves");
        if shim.is_dir() {
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
            Some(&install),
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
            Some(&install),
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

        let found = pick(candidates(9000, 1651, None, None, &[connect], &[]))
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
            None,
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
        assert!(pick(candidates(80, 0, None, None, &[root], &[])).is_none());
    }
}
