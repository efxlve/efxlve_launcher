//! EA app: local install manifests and the Origin deep links.
//!
//! The EA app records its game library folder in the per-user settings INI and
//! every game folder carries `__Installer\installerdata.xml` with the content
//! ids the `origin2://game/launch` handler needs. Legacy Origin installs keep
//! the same offer ids in `%ProgramData%\Origin\LocalContent\**\*.mfst`. The
//! launcher only reads these files; the client does the work.

use std::path::{Path, PathBuf};

use super::FoundGame;

/// One installed game found in a client manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalGame {
    /// Display name (the install folder name).
    pub(crate) name: String,
    /// Install folder.
    pub(crate) folder: String,
    /// `contentID` values from `installerdata.xml`, or the `id` from a `.mfst`.
    pub(crate) ids: Vec<String>,
}

/// `user.downloadinplacedir` from the EA app settings INI.
pub(crate) fn download_dir(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let Some(value) = line.strip_prefix("user.downloadinplacedir=") else {
            continue;
        };
        let value = value
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .replace('/', "\\");
        if value.is_empty() {
            return None;
        }
        return Some(value);
    }
    None
}

/// All `contentID` texts in an `installerdata.xml` document, in file order.
/// A title can have several (base game, language packs, trials); the EA app
/// takes them as one comma-separated `offerIds` value.
pub(crate) fn content_ids(xml: &str) -> Vec<String> {
    let lower = xml.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut ids = Vec::new();
    let mut from = 0;
    while let Some(pos) = lower[from..].find("<contentid") {
        let start = from + pos;
        let name_end = start + "<contentid".len();
        // `<contentIDs>` is the container: the element name must end here.
        let next = bytes.get(name_end).copied().unwrap_or(b'<');
        if !(next == b'>' || next == b'/' || next.is_ascii_whitespace()) {
            from = name_end;
            continue;
        }
        let Some(open_end) = lower[name_end..].find('>').map(|i| i + name_end) else {
            break;
        };
        let mut search = open_end + 1;
        let close = loop {
            let Some(rel) = lower[search..].find("</contentid") else {
                break None;
            };
            let close_start = search + rel;
            let close_name_end = close_start + "</contentid".len();
            let close_next = bytes.get(close_name_end).copied().unwrap_or(b'>');
            if close_next == b'>' || close_next.is_ascii_whitespace() {
                break Some(close_start);
            }
            search = close_name_end;
        };
        let Some(close) = close else {
            break;
        };
        let value = xml[open_end + 1..close].trim();
        if !value.is_empty() && !ids.iter().any(|id| id == value) {
            ids.push(value.to_string());
        }
        from = close + 1;
    }
    ids
}

/// One `?id=...&dipinstallpath=...` Origin manifest.
pub(crate) fn mfst_values(text: &str) -> (Option<String>, Option<String>) {
    let mut id = None;
    let mut path = None;
    for pair in text.trim().trim_start_matches('?').split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let decoded = percent_decode(value);
        match key {
            "id" => id = Some(decoded),
            "dipinstallpath" => path = Some(decoded),
            _ => {}
        }
    }
    (id, path)
}

/// `%LOCALAPPDATA%\Electronic Arts\EA Desktop\user_*.ini`, when present.
fn settings_ini() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let dir = PathBuf::from(base).join("Electronic Arts").join("EA Desktop");
    let entries = std::fs::read_dir(dir).ok()?;
    entries.flatten().map(|entry| entry.path()).find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("user_") && name.ends_with(".ini"))
            .unwrap_or(false)
    })
}

fn library_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(ini) = settings_ini().and_then(|path| std::fs::read_to_string(path).ok()) {
        if let Some(dir) = download_dir(&ini) {
            roots.push(PathBuf::from(dir));
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = std::env::var_os(var) {
            roots.push(PathBuf::from(base).join("EA Games"));
        }
    }
    roots
}

/// Game folders under one library root: an `__Installer\installerdata.xml`
/// marks a game, the folder name is its display name.
pub(crate) fn games_in_root(root: &Path) -> Vec<LocalGame> {
    let mut games = Vec::new();
    collect_installer_games(root, 0, &mut games);
    games
}

fn collect_installer_games(dir: &Path, depth: u32, out: &mut Vec<LocalGame>) {
    if depth > 2 || out.len() > 300 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let folder = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();
        if folder.eq_ignore_ascii_case("__Installer") || folder.eq_ignore_ascii_case("Data") {
            continue;
        }
        let manifest = path.join("__Installer").join("installerdata.xml");
        if let Ok(xml) = std::fs::read_to_string(&manifest) {
            let ids = content_ids(&xml);
            if !ids.is_empty() {
                out.push(LocalGame {
                    name: folder,
                    folder: path.to_string_lossy().to_string(),
                    ids,
                });
                continue;
            }
        }
        subdirs.push(path);
    }
    // Some titles nest the game one level down (`<Studio>\<Game>\__Installer`).
    for path in subdirs {
        collect_installer_games(&path, depth + 1, out);
    }
}

/// `.mfst` manifests under a content folder (`%ProgramData%\Origin\LocalContent`
/// and the EA app's own install data). The id is the legacy Origin offer id.
pub(crate) fn mfst_games(root: &Path) -> Vec<LocalGame> {
    let mut files = Vec::new();
    collect_mfst(root, 0, &mut files);
    let mut games = Vec::new();
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let (Some(id), path) = mfst_values(&text) else {
            continue;
        };
        let folder = path.unwrap_or_else(|| {
            file.parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });
        if folder.is_empty() || !Path::new(&folder).is_dir() {
            continue;
        }
        let name = Path::new(&folder)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        if games.iter().any(|g: &LocalGame| g.folder.eq_ignore_ascii_case(&folder)) {
            continue;
        }
        games.push(LocalGame {
            name,
            folder,
            ids: vec![id],
        });
    }
    games
}

fn collect_mfst(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 4 || out.len() > 300 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_mfst(&path, depth + 1, out);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("mfst"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

/// Everything the machine knows about installed EA games, manifests first.
pub(crate) fn local_games() -> Vec<LocalGame> {
    let mut games = Vec::new();
    for root in library_roots() {
        for game in games_in_root(&root) {
            if !games.iter().any(|g: &LocalGame| g.folder.eq_ignore_ascii_case(&game.folder)) {
                games.push(game);
            }
        }
    }
    let program_data = std::env::var_os("PROGRAMDATA").map(PathBuf::from);
    if let Some(base) = program_data {
        for dir in ["Origin\\LocalContent", "EA Desktop\\InstallData"] {
            for game in mfst_games(&base.join(dir)) {
                if !games.iter().any(|g: &LocalGame| g.folder.eq_ignore_ascii_case(&game.folder)) {
                    games.push(game);
                }
            }
        }
    }
    games
}

fn same_folder(a: &str, b: &str) -> bool {
    !a.is_empty()
        && !b.is_empty()
        && a.trim_end_matches(['\\', '/']).eq_ignore_ascii_case(b.trim_end_matches(['\\', '/']))
}

fn normalize_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

fn launch_uri(ids: &[String]) -> String {
    format!("origin2://game/launch?offerIds={}", ids.join(","))
}

fn install_uri(ids: &[String]) -> String {
    format!("origin2://game/launch?offerIds={}&autoDownload=1", ids.join(","))
}

fn attach(game: &mut FoundGame, local: &LocalGame) {
    if !local.ids.is_empty() {
        game.store_id = local.ids.join(",");
        game.launch_uri = launch_uri(&local.ids);
        game.install_uri = install_uri(&local.ids);
    }
    if game.install_path.is_empty() {
        game.install_path = local.folder.clone();
    }
    game.installed = true;
}

fn local_to_found(local: &LocalGame) -> FoundGame {
    let mut game = FoundGame {
        store: "ea".into(),
        id: super::scan::slug(&local.name),
        name: local.name.clone(),
        install_path: local.folder.clone(),
        installed: true,
        store_id: String::new(),
        launch_exe: String::new(),
        launch_uri: String::new(),
        install_uri: String::new(),
        uninstall_uri: String::new(),
        cover_url: String::new(),
        hero_url: String::new(),
        description: String::new(),
    };
    attach(&mut game, local);
    game
}

/// Installed EA games: the uninstall-registry rows plus every manifest the
/// client left behind. A manifest row fills in the missing id and deep links
/// of the registry row with the same folder or title.
pub(crate) fn merged_games(installed: &[FoundGame]) -> Vec<FoundGame> {
    let mut games: Vec<FoundGame> = installed
        .iter()
        .filter(|game| game.store == "ea")
        .cloned()
        .collect();
    for local in local_games() {
        let existing = games.iter_mut().find(|game| {
            same_folder(&game.install_path, &local.folder)
                || normalize_title(&game.name) == normalize_title(&local.name)
        });
        if let Some(game) = existing {
            attach(game, &local);
        } else {
            games.push(local_to_found(&local));
        }
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// `encodeURIComponent`-style escapes (`%3a`), used by the Origin manifests.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_row(name: &str, location: &str) -> FoundGame {
        FoundGame {
            store: "ea".into(),
            id: super::super::scan::slug(name),
            name: name.into(),
            install_path: location.into(),
            installed: true,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: String::new(),
            install_uri: String::new(),
            uninstall_uri: String::new(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        }
    }

    #[test]
    fn settings_read_the_library_folder() {
        let ini = "user.userid=1..\r\nuser.downloadinplacedir=C:\\Program Files\\EA Games\r\nlocation.language=tr\r\n";
        assert_eq!(download_dir(ini).as_deref(), Some(r"C:\Program Files\EA Games"));
        assert_eq!(download_dir("user.userid=1\n"), None);
    }

    #[test]
    fn installer_xml_yields_every_content_id() {
        let xml = r#"<?xml version="1.0"?>
            <game><contentIDs><contentID>71592</contentID><contentID>1009368_ltdtrial</contentID></contentIDs>
            <name>NFS</name></game>"#;
        assert_eq!(content_ids(xml), vec!["71592", "1009368_ltdtrial"]);
        assert!(content_ids("<game></game>").is_empty());
    }

    #[test]
    fn mfst_values_decode_the_offer_id_and_path() {
        let text = "?currentstate=kReadyToStart&id=OFB-EAST%3a48217&previousstate=kCompleted&dipinstallpath=C:\\Games\\FIFA%2012";
        let (id, path) = mfst_values(text);
        assert_eq!(id.as_deref(), Some("OFB-EAST:48217"));
        assert_eq!(path.as_deref(), Some(r"C:\Games\FIFA 12"));
    }

    #[test]
    fn manifest_rows_fill_in_the_registry_row() {
        let registry = vec![registry_row("FIFA 12", r"C:\Games\FIFA 12")];
        let local = LocalGame {
            name: "FIFA 12".into(),
            folder: r"C:\Games\FIFA 12".into(),
            ids: vec!["71592".into()],
        };
        let mut games = registry.clone();
        let game = games.iter_mut().find(|g| g.name == "FIFA 12").unwrap();
        attach(game, &local);
        assert_eq!(game.store_id, "71592");
        assert_eq!(game.launch_uri, "origin2://game/launch?offerIds=71592");
        assert_eq!(game.install_uri, "origin2://game/launch?offerIds=71592&autoDownload=1");
    }

    #[test]
    fn duplicate_titles_merge_into_one_row() {
        // A registry row without InstallLocation still matches by title.
        let registry = vec![registry_row("EA SPORTS FC 25", "")];
        let local = LocalGame {
            name: "EA SPORTS FC 25".into(),
            folder: r"D:\EA Games\EA SPORTS FC 25".into(),
            ids: vec!["1002975".into(), "1003943".into()],
        };
        let mut games = registry;
        attach(
            games
                .iter_mut()
                .find(|game| normalize_title(&game.name) == normalize_title(&local.name))
                .unwrap(),
            &local,
        );
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].install_path, r"D:\EA Games\EA SPORTS FC 25");
        assert_eq!(games[0].store_id, "1002975,1003943");
    }
}
