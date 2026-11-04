//! Ubisoft Connect's local configuration cache and the imported owned catalog.
//!
//! The cache is a protobuf list of YAML documents. Each playable game has
//! `start_game` and a display name. Steam and Epic copies are left to those
//! stores. The file is a game list: account passwords are not in it, and this
//! parser never reads `settings.yaml`.
//!
//! Games the account owns but the client has not cached come from the sign-in
//! import and live in `companion_ubi_owned.json`.

use serde::{Deserialize, Serialize};

use super::proto::for_each_field;
use super::scan::slug;
use super::FoundGame;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct LaunchSpec {
    /// Executable path relative to the install root (`\` separated).
    pub exe: String,
    /// Working directory relative to the install root (`\` separated); empty when root.
    pub working_dir: String,
    /// Command-line arguments from the configuration, excluding Steam-only flags.
    pub arguments: String,
    /// Registry value path from `working_directory: register:`.
    pub install_reg: String,
}

pub(crate) struct UbiRow {
    pub(crate) install_id: u64,
    pub(crate) launch_id: u64,
    pub(crate) name: String,
    /// Catalog space id (`space_id:` in the YAML); empty when absent.
    pub(crate) space_id: String,
    /// Achievement archive spec (`achievements:` in the YAML); empty when absent.
    pub(crate) achievements: String,
    /// Executable, working directory, arguments, and registry key from `start_game`.
    pub(crate) spec: LaunchSpec,
}

pub(crate) fn games_from_configurations(bytes: &[u8], installed: &[FoundGame]) -> Vec<FoundGame> {
    let mut games = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows(bytes) {
        let id = row.launch_id.to_string();
        if !seen.insert(id.clone()) {
            continue;
        }
        let mut game = FoundGame {
            store: "ubisoft".into(),
            id,
            name: row.name.clone(),
            install_path: String::new(),
            installed: false,
            store_id: if row.install_id > 0 {
                row.install_id.to_string()
            } else {
                String::new()
            },
            launch_exe: String::new(),
            launch_uri: format!("uplay://launch/{}/0", row.launch_id),
            install_uri: if row.install_id > 0 {
                format!("uplay://install/{}", row.install_id)
            } else {
                String::new()
            },
            uninstall_uri: format!("uplay://uninstall/{}", row.launch_id),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        };
        if let Some(hit) = installed
            .iter()
            .find(|g| g.store == "ubisoft" && g.installed && slug(&g.name) == slug(&row.name))
        {
            game.installed = true;
            game.install_path = hit.install_path.clone();
        }
        games.push(game);
    }
    for extra in installed.iter().filter(|g| g.store == "ubisoft") {
        if games.iter().any(|g| slug(&g.name) == slug(&extra.name)) {
            continue;
        }
        games.push(extra.clone());
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

fn rows(bytes: &[u8]) -> Vec<UbiRow> {
    let mut rows = Vec::new();
    for_each_field(
        bytes,
        |field, payload| {
            if field != 1 {
                return;
            }
            if let Some(row) = row_from_record(payload) {
                rows.push(row);
            }
        },
        |_, _| {},
    );
    rows
}

fn row_from_record(record: &[u8]) -> Option<UbiRow> {
    let mut install_id = 0u64;
    let mut launch_id = 0u64;
    let mut yaml = String::new();
    for_each_field(
        record,
        |field, payload| {
            if field == 3 {
                yaml = String::from_utf8_lossy(payload).to_string();
            }
        },
        |field, value| {
            if field == 1 {
                install_id = value;
            } else if field == 2 {
                launch_id = value;
            }
        },
    );
    let launch_id = if launch_id == 0 { install_id } else { launch_id };
    // Newer clients leave `start_game` out of a game's YAML; the space id is
    // then the marker that still separates a game from a helper entry.
    if launch_id == 0 || (!yaml.contains("start_game") && !yaml.contains("space_id:")) {
        return None;
    }
    if is_other_store(&yaml) {
        return None;
    }
    let name = game_name(&yaml)?;
    Some(UbiRow {
        install_id,
        launch_id,
        name,
        space_id: yaml_value(&yaml, "space_id"),
        achievements: yaml_value(&yaml, "achievements"),
        spec: launch_spec(&yaml),
    })
}

#[derive(Default)]
struct ExecCandidate {
    exe: String,
    working_dir: String,
    arguments: String,
    label: String,
}

/// Parse the primary executable, working directory, launch arguments, and
/// install registry key from a Ubisoft product YAML configuration.
pub(crate) fn launch_spec(yaml: &str) -> LaunchSpec {
    let install_reg = parse_install_register(yaml);
    let mut candidates: Vec<ExecCandidate> = Vec::new();
    let mut start_indent: Option<usize> = None;
    let mut mode_indent: Option<usize> = None;
    let mut skip_mode = false;
    let mut execs_indent: Option<usize> = None;
    let mut item_indent: Option<usize> = None;
    let mut sub_block: Option<(&str, usize)> = None;

    for line in yaml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = indent_of(line);
        if let Some(root_indent) = start_indent {
            if indent <= root_indent {
                start_indent = None;
                mode_indent = None;
                execs_indent = None;
                item_indent = None;
                sub_block = None;
            }
        }
        if start_indent.is_none() {
            if trimmed == "start_game:" {
                start_indent = Some(indent);
            }
            continue;
        }

        if let Some(m_indent) = mode_indent {
            if indent <= m_indent {
                mode_indent = None;
                execs_indent = None;
                item_indent = None;
                sub_block = None;
            }
        }
        if mode_indent.is_none() {
            if let Some(mode) = trimmed.strip_suffix(':') {
                let low = mode.trim().to_ascii_lowercase();
                mode_indent = Some(indent);
                skip_mode = low == "steam" || low == "epic";
            }
            continue;
        }
        if skip_mode {
            continue;
        }

        if let Some(e_indent) = execs_indent {
            if indent <= e_indent {
                execs_indent = None;
                item_indent = None;
                sub_block = None;
            }
        }
        if execs_indent.is_none() {
            if trimmed == "executables:" {
                execs_indent = Some(indent);
            }
            continue;
        }

        let mut active_indent = indent;
        let mut active_line = trimmed;
        if trimmed == "-" || trimmed.starts_with("- ") {
            if item_indent.map(|prev| indent <= prev).unwrap_or(true) {
                item_indent = Some(indent);
                sub_block = None;
                candidates.push(ExecCandidate::default());
                active_line = trimmed.trim_start_matches('-').trim();
                active_indent = indent + 2;
                if active_line.is_empty() {
                    continue;
                }
            }
        } else if let Some(i_indent) = item_indent {
            if indent <= i_indent {
                item_indent = None;
                sub_block = None;
                continue;
            }
        } else {
            continue;
        }

        let Some(current) = candidates.last_mut() else {
            continue;
        };

        if let Some((_, b_indent)) = sub_block {
            if active_indent <= b_indent {
                sub_block = None;
            }
        }

        if let Some((block_name, _)) = sub_block {
            if block_name == "path" {
                if let Some(rel) = active_line.strip_prefix("relative:") {
                    let norm = normalize_rel_path(rel);
                    if !norm.is_empty() {
                        current.exe = norm;
                    }
                }
            } else if block_name == "working_directory" {
                if let Some(rel) = active_line
                    .strip_prefix("relative:")
                    .or_else(|| active_line.strip_prefix("append:"))
                {
                    let norm = normalize_rel_path(rel);
                    if !norm.is_empty() && current.working_dir.is_empty() {
                        current.working_dir = norm;
                    }
                }
            }
            continue;
        }

        if active_line == "path:" {
            sub_block = Some(("path", active_indent));
        } else if let Some(inline_path) = active_line.strip_prefix("path:") {
            let norm = normalize_rel_path(inline_path);
            if !norm.is_empty() {
                current.exe = norm;
            }
        } else if active_line == "working_directory:" {
            sub_block = Some(("working_directory", active_indent));
        } else if let Some(args) = active_line.strip_prefix("arguments:") {
            let cleaned = clean_launch_arguments(args);
            if !cleaned.is_empty() {
                current.arguments = cleaned;
            }
        } else if let Some(desc) = active_line
            .strip_prefix("description:")
            .or_else(|| active_line.strip_prefix("shortcut_name:"))
            .or_else(|| active_line.strip_prefix("internal_description:"))
        {
            let cleaned = clean_value(desc);
            if !cleaned.is_empty() {
                if !current.label.is_empty() {
                    current.label.push(' ');
                }
                current.label.push_str(&cleaned);
            }
        }
    }

    let valid: Vec<&ExecCandidate> = candidates
        .iter()
        .filter(|c| !c.exe.is_empty() && c.exe.to_ascii_lowercase().ends_with(".exe"))
        .collect();
    let chosen = valid
        .iter()
        .copied()
        .find(|c| !is_secondary_exec(c))
        .or_else(|| valid.first().copied());

    match chosen {
        Some(c) => LaunchSpec {
            exe: c.exe.clone(),
            working_dir: c.working_dir.clone(),
            arguments: c.arguments.clone(),
            install_reg,
        },
        None => LaunchSpec {
            install_reg,
            ..Default::default()
        },
    }
}

fn is_secondary_exec(candidate: &ExecCandidate) -> bool {
    let exe_low = candidate.exe.to_ascii_lowercase();
    let label_low = candidate.label.to_ascii_lowercase();
    const SECONDARY: &[&str] = &[
        "benchmark",
        "editor",
        "config",
        "setting",
        "server",
        "dedicated",
        "crash",
        "unins",
        "setup",
        "dxsetup",
        "vcredist",
    ];
    SECONDARY
        .iter()
        .any(|needle| exe_low.contains(needle) || label_low.contains(needle))
}

fn normalize_rel_path(raw: &str) -> String {
    let cleaned = clean_value(raw).replace('/', "\\");
    let trimmed = cleaned
        .trim_start_matches(".\\")
        .trim_matches('\\')
        .trim();
    if trimmed.is_empty() || trimmed.contains(':') {
        return String::new();
    }
    let mut parts = Vec::new();
    for part in trimmed.split('\\').filter(|part| !part.is_empty() && *part != ".") {
        if part == ".." {
            return String::new();
        }
        parts.push(part);
    }
    parts.join("\\")
}

/// Split a command-line string into tokens while preserving quoted arguments
/// and stripping Steam-only flags (`-uplay_steam_mode`).
pub(crate) fn split_launch_arguments(raw: &str) -> Vec<String> {
    let cleaned = clean_value(raw);
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in cleaned.chars() {
        if ch == '"' {
            in_quotes = !in_quotes;
            continue;
        }
        if ch.is_whitespace() && !in_quotes {
            if !current.is_empty() {
                push_filtered_arg(&mut out, std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        push_filtered_arg(&mut out, current);
    }
    out
}

fn push_filtered_arg(out: &mut Vec<String>, token: String) {
    let low = token.trim().to_ascii_lowercase();
    if low == "-uplay_steam_mode" || low == "/uplay_steam_mode" {
        return;
    }
    out.push(token);
}

fn clean_launch_arguments(raw: &str) -> String {
    split_launch_arguments(raw)
        .into_iter()
        .map(|arg| {
            if arg.contains(char::is_whitespace) {
                format!("\"{arg}\"")
            } else {
                arg
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_install_register(config: &str) -> String {
    let mut in_working_directory = false;
    let mut base_indent = 0usize;
    let mut fallback = String::new();
    for line in config.lines() {
        let trimmed = line.trim();
        let indent = indent_of(line);
        if trimmed == "working_directory:" {
            in_working_directory = true;
            base_indent = indent;
            continue;
        }
        if !in_working_directory {
            continue;
        }
        if !trimmed.is_empty() && indent <= base_indent {
            in_working_directory = false;
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("register:") {
            let cleaned = clean_value(value);
            if cleaned.is_empty() {
                continue;
            }
            if !cleaned.to_ascii_lowercase().contains("\\launcher\\installs\\") {
                return cleaned;
            }
            if fallback.is_empty() {
                fallback = cleaned;
            }
        }
    }
    fallback
}

/// First `key: value` line anywhere in the YAML document.
pub(crate) fn yaml_value(yaml: &str, key: &str) -> String {
    let prefix = format!("{key}:");
    for line in yaml.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix(&prefix) {
            let value = clean_value(value);
            if !value.is_empty() {
                return value;
            }
        }
    }
    String::new()
}

fn is_other_store(yaml: &str) -> bool {
    let Some(name) = child_value(yaml, "third_party_platform", "name") else {
        return false;
    };
    let name = name.to_lowercase();
    name == "steam" || name == "epic"
}

pub(crate) fn game_name(yaml: &str) -> Option<String> {
    let direct = child_value(yaml, "root", "name").unwrap_or_default();
    if usable(&direct) {
        return Some(direct);
    }
    for line in yaml.lines() {
        let trimmed = line.trim();
        let Some(value) = trimmed.strip_prefix("GAMENAME:") else {
            continue;
        };
        let name = clean_value(value);
        if usable(&name) {
            return Some(name);
        }
    }
    None
}

fn usable(name: &str) -> bool {
    let low = name.to_lowercase();
    !name.is_empty()
        && low != "gamename"
        && low != "l1"
        && low != "name"
        && low != "game_identifier"
        && !super::scan::is_component_row(&low)
}

/// Direct child `key:` under the first `block:` line.
fn child_value(yaml: &str, block: &str, key: &str) -> Option<String> {
    let lines: Vec<&str> = yaml.lines().collect();
    let header = format!("{block}:");
    let mut start = None;
    for (i, line) in lines.iter().enumerate() {
        if line.trim() == header {
            start = Some(i);
            break;
        }
    }
    let start = start?;
    let root_indent = indent_of(lines[start]);
    let mut child_indent = None;
    let prefix = format!("{key}:");
    for line in lines.iter().skip(start + 1) {
        if line.trim().is_empty() {
            continue;
        }
        let indent = indent_of(line);
        if indent <= root_indent {
            break;
        }
        if child_indent.is_none() {
            child_indent = Some(indent);
        }
        if Some(indent) == child_indent && line.trim().starts_with(&prefix) {
            return Some(clean_value(line.trim().trim_start_matches(&prefix)));
        }
    }
    None
}

fn indent_of(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').count()
}

fn clean_value(value: &str) -> String {
    let value = value.trim();
    let value = value.split(" #").next().unwrap_or(value).trim();
    value.trim_matches(|c| c == '"' || c == '\'').trim().to_string()
}

pub(crate) fn configurations_path() -> Option<std::path::PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).map(|p| {
        p.join("Ubisoft Game Launcher")
            .join("cache")
            .join("configuration")
            .join("configurations")
    });
    if let Some(path) = local {
        if path.is_file() {
            return Some(path);
        }
    }
    let program = std::path::PathBuf::from(
        r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\cache\configuration\configurations",
    );
    if program.is_file() { Some(program) } else { None }
}

/// Every cached configuration record, including owned games the client has not
/// installed. The achievement lookup uses the space id and the archive spec.
pub(crate) fn config_rows() -> Vec<UbiRow> {
    configurations_path()
        .and_then(|path| std::fs::read(path).ok())
        .map(|bytes| rows(&bytes))
        .unwrap_or_default()
}

fn owned_cache_path() -> std::path::PathBuf {
    super::accounts::data_dir().join("companion_ubi_owned.json")
}

/// One imported owned game. `id` is the Ubisoft space id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OwnedGame {
    pub id: String,
    /// Numeric product id from the entitlement response; 0 when only the space
    /// id is known. The client's install protocol takes this id.
    #[serde(default)]
    pub product_id: u32,
    pub name: String,
    /// Catalog box art; empty when the catalog had none for this game.
    #[serde(default)]
    pub cover: String,
    /// Catalog wide art; empty when the catalog had none for this game.
    #[serde(default)]
    pub hero: String,
    /// Catalog description; empty when the catalog had none for this game.
    #[serde(default)]
    pub description: String,
}

/// Writes the owned catalog captured at sign-in; ids are Ubisoft space ids.
pub(crate) fn save_owned(games: &[OwnedGame]) {
    let path = owned_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(games) {
        let _ = std::fs::write(path, text);
    }
}

pub(crate) fn load_owned() -> Vec<OwnedGame> {
    let Ok(text) = std::fs::read_to_string(owned_cache_path()) else {
        return Vec::new();
    };
    let rows: Vec<OwnedGame> = serde_json::from_str(&text).unwrap_or_default();
    rows.into_iter()
        .filter(|game| !game.id.is_empty() && !game.name.is_empty())
        .collect()
}

/// Where the official client keeps installed games, newest location first.
pub(crate) fn connect_games_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(base) = std::env::var_os(var) {
            roots.push(
                std::path::PathBuf::from(base)
                    .join("Ubisoft")
                    .join("Ubisoft Game Launcher")
                    .join("games"),
            );
        }
    }
    roots
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientDownload {
    pub name: String,
    pub bytes: u64,
}

/// Every client download currently writing under a `uplay_download` folder.
pub(crate) fn active_client_downloads() -> Vec<ClientDownload> {
    let mut out = Vec::new();
    for root in connect_games_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let download = entry.path().join("uplay_download");
            if !download.is_dir() {
                continue;
            }
            let bytes = directory_size(&download);
            // A completed playgo install leaves an empty `uplay_download`
            // folder behind; only a non-zero folder is an active transfer.
            if bytes == 0 {
                continue;
            }
            out.push(ClientDownload {
                name: entry.file_name().to_string_lossy().to_string(),
                bytes,
            });
        }
    }
    out
}

/// Bytes already written under the client's `uplay_download` folder, or `None`
/// when no matching download folder exists. The folder is not in the registry
/// until the install completes, so match by title.
pub(crate) fn connect_download_state(title: &str) -> Option<u64> {
    let wanted = slug(title);
    if wanted.is_empty() {
        return None;
    }
    for root in connect_games_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            if slug(&entry.file_name().to_string_lossy()) != wanted {
                continue;
            }
            let download = entry.path().join("uplay_download");
            if download.is_dir() {
                let bytes = directory_size(&download);
                // An empty folder is the leftover of a finished playgo install.
                if bytes > 0 {
                    return Some(bytes);
                }
            }
        }
    }
    None
}

/// True when the client has begun downloading this title but has not finished.
pub(crate) fn connect_downloading(title: &str) -> bool {
    connect_download_state(title).is_some()
}

fn directory_size(directory: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            total = total.saturating_add(directory_size(&entry.path()));
        } else if kind.is_file() {
            total = total.saturating_add(entry.metadata().map(|meta| meta.len()).unwrap_or(0));
        }
    }
    total
}

/// Local games plus the imported catalog the client has not cached yet.
pub(crate) fn merged_games(installed: &[FoundGame]) -> Vec<FoundGame> {
    let games = match configurations_path().and_then(|path| std::fs::read(path).ok()) {
        Some(bytes) => games_from_configurations(&bytes, installed),
        None => installed.iter().filter(|g| g.store == "ubisoft").cloned().collect(),
    };
    let mut games = merge_owned(games, &load_owned());
    // A game the launcher installed itself is not in the client's uninstall
    // registry. Mark the matching local row installed, or add the row when the
    // client never cached it.
    for installed in crate::companion::ubi_installs::load() {
        if let Some(local) = games.iter_mut().find(|game| {
            game.name.eq_ignore_ascii_case(&installed.name)
                || slug(&game.name) == slug(&installed.name)
                || (!game.install_path.is_empty()
                    && game.install_path.eq_ignore_ascii_case(&installed.install_dir))
        }) {
            local.installed = true;
            local.install_path = installed.install_dir.clone();
            continue;
        }
        games.push(FoundGame {
            store: "ubisoft".into(),
            id: installed.product_id.to_string(),
            name: installed.name.clone(),
            install_path: installed.install_dir.clone(),
            installed: true,
            store_id: installed.product_id.to_string(),
            launch_exe: String::new(),
            launch_uri: String::new(),
            install_uri: String::new(),
            uninstall_uri: String::new(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// Adds imported games whose name is not in the local list yet and copies the
/// catalog art and description onto the local row that matches by name. An
/// imported row has no launch id, so `companion_launch` hands it to the client.
pub(crate) fn merge_owned(mut games: Vec<FoundGame>, owned: &[OwnedGame]) -> Vec<FoundGame> {
    for game in owned {
        if let Some(local) = games.iter_mut().find(|g| slug(&g.name) == slug(&game.name)) {
            if local.install_uri.is_empty() && game.product_id > 0 {
                local.install_uri = format!("uplay://install/{}", game.product_id);
            }
            if local.store_id.is_empty() && game.product_id > 0 {
                local.store_id = game.product_id.to_string();
            }
            if local.cover_url.is_empty() {
                local.cover_url = game.cover.clone();
            }
            if local.hero_url.is_empty() {
                local.hero_url = game.hero.clone();
            }
            if local.description.is_empty() {
                local.description = game.description.clone();
            }
            continue;
        }
        games.push(FoundGame {
            store: "ubisoft".into(),
            id: game.id.clone(),
            name: game.name.clone(),
            install_path: String::new(),
            installed: false,
            store_id: if game.product_id > 0 {
                game.product_id.to_string()
            } else {
                String::new()
            },
            launch_exe: String::new(),
            launch_uri: String::new(),
            install_uri: if game.product_id > 0 {
                format!("uplay://install/{}", game.product_id)
            } else {
                String::new()
            },
            uninstall_uri: if game.product_id > 0 {
                format!("uplay://uninstall/{}", game.product_id)
            } else {
                String::new()
            },
            cover_url: game.cover.clone(),
            hero_url: game.hero.clone(),
            description: game.description.clone(),
        });
    }
    games
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::proto::{push_bytes, push_varint_field};

    fn record(install: u64, launch: u64, yaml: &str) -> Vec<u8> {
        let mut body = Vec::new();
        push_varint_field(&mut body, 1, install);
        push_varint_field(&mut body, 2, launch);
        push_bytes(&mut body, 3, yaml.as_bytes());
        let mut msg = Vec::new();
        push_bytes(&mut msg, 1, &body);
        msg
    }

    #[test]
    fn yaml_name_prefers_the_real_title_over_the_placeholder() {
        let yaml = "root:\n  name: GAMENAME\n  start_game:\n    online: {}\nlocalizations:\n  default:\n    GAMENAME: Assassin's Creed\n";
        assert_eq!(game_name(yaml).as_deref(), Some("Assassin's Creed"));
        assert!(!is_other_store(yaml));
    }

    #[test]
    fn steam_copies_are_not_ubisoft_games() {
        let yaml = "root:\n  name: Ghost Recon\n  third_party_platform:\n    name: Steam\n  start_game:\n    steam: {}\n";
        assert!(is_other_store(yaml));
    }

    #[test]
    fn configuration_records_keep_launch_ids_and_skip_other_stores() {
        let owned = "root:\n  name: Watch Dogs\n  start_game:\n    online: {}\n";
        let steam = "root:\n  name: Far Cry\n  third_party_platform:\n    name: Steam\n  start_game:\n    steam: {}\n";
        let dlc = "root:\n  name: Season Pass\n";
        let component = "root:\n  name: Ubisoft AntiCheat\n  start_game:\n    online: {}\n";
        let mut bytes = record(12, 34, owned);
        bytes.extend(record(1, 2, steam));
        bytes.extend(record(3, 4, dlc));
        bytes.extend(record(5, 6, component));
        let games = games_from_configurations(&bytes, &[]);
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].name, "Watch Dogs");
        assert_eq!(games[0].id, "34");
        assert_eq!(games[0].launch_uri, "uplay://launch/34/0");
        assert_eq!(games[0].install_uri, "uplay://install/12");
        assert_eq!(games[0].uninstall_uri, "uplay://uninstall/34");
        assert_eq!(games[0].store_id, "12");
        assert!(!games[0].installed);
    }

    #[test]
    fn a_leftover_uninstall_row_does_not_mark_a_game_installed() {
        let bytes = record(
            12,
            34,
            "root:\n  name: Watch Dogs\n  start_game:\n    online: {}\n",
        );
        let stale = FoundGame {
            store: "ubisoft".into(),
            id: "watch-dogs".into(),
            name: "Watch Dogs".into(),
            install_path: r"C:\Games\Gone".into(),
            installed: false,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: String::new(),
            install_uri: String::new(),
            uninstall_uri: String::new(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        };
        let games = games_from_configurations(&bytes, &[stale]);
        assert_eq!(games.len(), 1);
        assert!(!games[0].installed);
        assert!(games[0].install_path.is_empty());
    }

    #[test]
    fn imported_games_join_the_local_list_without_duplicating_names() {
        let local = vec![FoundGame {
            store: "ubisoft".into(),
            id: "34".into(),
            name: "Watch Dogs".into(),
            install_path: String::new(),
            installed: false,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: "uplay://launch/34/0".into(),
            install_uri: "uplay://install/12".into(),
            uninstall_uri: "uplay://uninstall/34".into(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        }];
        let merged = merge_owned(
            local,
            &[
                OwnedGame { id: "space-1".into(), product_id: 274, name: "Watch Dogs".into(), cover: "ubi-cover".into(), hero: String::new(), description: "Chicago hacker story".into() },
                OwnedGame { id: "space-2".into(), product_id: 5520, name: "Far Cry 6".into(), cover: "fc6-cover".into(), hero: "fc6-hero".into(), description: String::new() },
            ],
        );
        assert_eq!(merged.len(), 2);
        // The catalog art and description land on the local row that matches by name.
        assert_eq!(merged.iter().find(|g| g.id == "34").unwrap().cover_url, "ubi-cover");
        assert_eq!(merged.iter().find(|g| g.id == "34").unwrap().description, "Chicago hacker story");
        let imported = merged.iter().find(|g| g.id == "space-2").unwrap();
        assert_eq!(imported.name, "Far Cry 6");
        assert_eq!(imported.cover_url, "fc6-cover");
        assert_eq!(imported.hero_url, "fc6-hero");
        assert!(imported.description.is_empty());
        assert!(!imported.installed);
        assert!(imported.launch_uri.is_empty());
        assert_eq!(imported.install_uri, "uplay://install/5520");
        assert_eq!(imported.uninstall_uri, "uplay://uninstall/5520");
        assert_eq!(imported.store_id, "5520");
        assert_eq!(merged.iter().filter(|g| g.id == "34").count(), 1);
    }

    #[test]
    fn launch_spec_reads_the_primary_executable_working_dir_and_arguments() {
        let yaml = "root:\n  name: GAMENAME\n  working_directory:\n    register: HKEY_LOCAL_MACHINE\\SOFTWARE\\Ubisoft\\Game\\Install path\n  start_game:\n    online:\n      executables:\n        - shortcut_name: Settings\n          path:\n            relative: bin/SettingsApplication.exe\n        - shortcut_name: Game\n          path:\n            relative: Binaries/Win64/Game.exe\n          working_directory:\n            register: HKEY_LOCAL_MACHINE\\SOFTWARE\\Ubisoft\\Launcher\\Installs\\123\\InstallDir\n            append: Binaries/Win64/\n          arguments: -seekfreeloadingpcconsole -uplay_steam_mode -lang \"en US\"\n";
        let spec = launch_spec(yaml);
        assert_eq!(spec.exe, r"Binaries\Win64\Game.exe");
        assert_eq!(spec.working_dir, r"Binaries\Win64");
        assert_eq!(spec.arguments, "-seekfreeloadingpcconsole -lang \"en US\"");
        assert_eq!(
            spec.install_reg,
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Ubisoft\Game\Install path"
        );
        assert_eq!(
            split_launch_arguments(&spec.arguments),
            vec![
                "-seekfreeloadingpcconsole".to_string(),
                "-lang".to_string(),
                "en US".to_string()
            ]
        );
    }
}
