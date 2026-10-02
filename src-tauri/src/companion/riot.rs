//! Riot Games: the Riot Client's product settings and launch hand-off.
//!
//! All four PC titles are free to play, so the owned list is the catalog
//! itself; only the install state comes from the client's own product settings.
//! Launch, install and uninstall go through `RiotClientServices.exe`, the same
//! hand-off the Galaxy Riot integration uses.

use std::path::PathBuf;

use super::FoundGame;

/// Riot product codes and display names. Every one is free to play.
pub(crate) const GAMES: &[(&str, &str)] = &[
    ("league_of_legends", "League of Legends"),
    ("bacon", "Legends of Runeterra"),
    ("valorant", "VALORANT"),
    ("lion", "2XKO"),
];

fn program_data() -> Option<PathBuf> {
    std::env::var_os("PROGRAMDATA").map(PathBuf::from)
}

/// `RiotClientInstalls.json` names the client executable (`rc_default`).
pub(crate) fn client_exe() -> Option<PathBuf> {
    let path = program_data()?
        .join("Riot Games")
        .join("RiotClientInstalls.json");
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let exe = value.get("rc_default").and_then(|v| v.as_str())?.trim();
    if exe.is_empty() {
        return None;
    }
    let exe = PathBuf::from(exe);
    exe.is_file().then_some(exe)
}

/// `product_install_full_path` from one product settings document.
fn settings_path(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(value) = trimmed.strip_prefix("product_install_full_path:") else {
            continue;
        };
        let value = value.split(" #").next().unwrap_or(value).trim();
        let value = value
            .trim_matches(|c| c == '"' || c == '\'')
            .trim()
            .replace("\\\\", "\\")
            .replace('/', "\\");
        if value.is_empty() {
            return None;
        }
        return Some(value);
    }
    None
}

/// Install folder the client recorded for one product, when it exists on disk.
fn install_path(id: &str) -> Option<PathBuf> {
    let path = program_data()?
        .join("Riot Games")
        .join("Metadata")
        .join(format!("{id}.live"))
        .join(format!("{id}.live.product_settings.yaml"));
    let text = std::fs::read_to_string(path).ok()?;
    let folder = PathBuf::from(settings_path(&text)?);
    folder.is_dir().then_some(folder)
}

/// The catalog with the client's install state. The launcher owns no files.
pub(crate) fn games() -> Vec<FoundGame> {
    GAMES
        .iter()
        .map(|(id, name)| {
            let path = install_path(id);
            FoundGame {
                store: "riot".into(),
                id: (*id).to_string(),
                name: (*name).to_string(),
                install_path: path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
                installed: path.is_some(),
                store_id: String::new(),
                launch_exe: String::new(),
                launch_uri: String::new(),
                install_uri: String::new(),
                uninstall_uri: String::new(),
                cover_url: String::new(),
                hero_url: String::new(),
                description: String::new(),
            }
        })
        .collect()
}

/// The Riot Client Services command for one catalog product. Launch and install
/// both hand the product to the client; an uninstalled product opens its
/// install flow there.
pub(crate) fn action_command(id: &str, action: &str) -> Option<(PathBuf, Vec<String>)> {
    if !GAMES.iter().any(|(code, _)| *code == id) {
        return None;
    }
    let exe = client_exe()?;
    let args = if action == "uninstall" {
        vec![
            format!("--uninstall-product={id}"),
            "--uninstall-patchline=live".into(),
        ]
    } else {
        vec![
            format!("--launch-product={id}"),
            "--launch-patchline=live".into(),
        ]
    };
    Some((exe, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_settings_read_the_install_path() {
        let yaml = "install:
  product_install_full_path: \"C:\\\\Riot Games\\\\League of Legends\" # live
  other: 1
";
        assert_eq!(
            settings_path(yaml).as_deref(),
            Some(r"C:\Riot Games\League of Legends")
        );
        assert_eq!(settings_path("other: 1\n"), None);
        assert_eq!(settings_path("product_install_full_path:\n"), None);
    }

    #[test]
    fn the_catalog_is_the_four_free_titles() {
        let games = games();
        assert_eq!(games.len(), 4);
        assert!(games.iter().all(|g| g.store == "riot"));
        assert!(games.iter().any(|g| g.id == "valorant" && g.name == "VALORANT"));
        // The machine running the tests may or may not have the client.
        assert!(games.iter().all(|g| !g.installed || !g.install_path.is_empty()));
    }

    #[test]
    fn unknown_products_have_no_client_action() {
        assert!(action_command("not-a-riot-product", "launch").is_none());
    }
}
