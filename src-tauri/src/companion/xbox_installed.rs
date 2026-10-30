//! Installed Xbox (GDK) titles, from the package registration.
//!
//! `C:\XboxGames` is not a source of truth. An uninstall leaves the folder
//! behind, and a title installed to the default `WindowsApps` location has no
//! folder there at all. The package list is what the Xbox app itself reads, and
//! it carries the family name and the application id that launching by package
//! identity needs.

#[cfg(windows)]
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::scan;
use super::xbox_login::safe_aumid;
use super::FoundGame;

/// One registered package, free of WinRT types so the conversion stays testable.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PackageRow {
    /// `Package.id.FamilyName`, the identifier the account list keys on.
    pub family: String,
    /// `Package.id.Name`, for example `HelloGames.NoMansSky`.
    pub identity: String,
    /// `Package.DisplayName`; empty when the package does not answer.
    pub display: String,
    pub install_path: String,
    /// `AppxManifest.xml`, empty when unreadable.
    pub manifest: String,
    /// `MicrosoftGame.config`, present only on GDK titles.
    pub game_config: String,
}

/// Installed titles, cached for a short window: one library refresh asks each
/// store for its games several times in a row.
pub(crate) fn installed_games() -> Vec<FoundGame> {
    static CACHE: Mutex<Option<(Instant, Vec<FoundGame>)>> = Mutex::new(None);
    const TTL: Duration = Duration::from_secs(20);

    if let Ok(mut guard) = CACHE.lock() {
        if let Some((at, games)) = guard.as_ref() {
            if at.elapsed() < TTL {
                return games.clone();
            }
        }
        let started = Instant::now();
        let games = games_from_rows(&enumerate());
        crate::perf::write_line_global(&format!(
            "{:>6} ms  rust:companion/xbox_packages",
            started.elapsed().as_millis()
        ));
        *guard = Some((Instant::now(), games.clone()));
        return games;
    }
    games_from_rows(&enumerate())
}

/// Library rows for the packages that are GDK titles.
pub(crate) fn games_from_rows(rows: &[PackageRow]) -> Vec<FoundGame> {
    let mut games: Vec<FoundGame> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        if row.family.is_empty() || row.game_config.trim().is_empty() {
            continue;
        }
        if !seen.insert(row.family.to_ascii_lowercase()) {
            continue;
        }
        let app = app_id(&row.manifest).unwrap_or_default();
        let aumid = aumid_for(&row.family, &app);
        let name = scan::xbox_display_name(&row.game_config)
            .or_else(|| non_empty(&row.display))
            .unwrap_or_else(|| row.identity.clone());
        if name.is_empty() {
            continue;
        }
        games.push(FoundGame {
            store: "xbox".into(),
            // The family name is what the account list, playtime and
            // achievements key on, so an installed row and an owned row are the
            // same game without comparing titles.
            id: row.family.clone(),
            name,
            install_path: row.install_path.clone(),
            installed: true,
            store_id: scan::xml_text(&row.game_config, "StoreId").unwrap_or_default(),
            // A GDK title starts through its package identity. Running the
            // executable named in the config skips the identity, and with it
            // saves, achievements and the license check.
            launch_exe: String::new(),
            launch_uri: if aumid.is_empty() {
                String::new()
            } else {
                format!("aumid:{aumid}")
            },
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

/// `Id` of the first `<Application>` in the package manifest.
fn app_id(manifest: &str) -> Option<String> {
    let rest = manifest.split("<Application ").nth(1)?;
    let tag = rest.split(['/', '>']).next()?;
    scan::xml_attr(tag, "Id")
}

fn aumid_for(family: &str, app: &str) -> String {
    if family.is_empty() || app.is_empty() {
        return String::new();
    }
    let aumid = format!("{family}!{app}");
    if safe_aumid(&aumid) {
        aumid
    } else {
        String::new()
    }
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(windows)]
fn enumerate() -> Vec<PackageRow> {
    use windows::Management::Deployment::PackageManager;

    // WinRT needs an apartment, and the blocking pool hands out plain threads.
    // A second call on a thread that already has one returns S_FALSE.
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }
    let Ok(manager) = PackageManager::new() else {
        return Vec::new();
    };
    // `FindPackages` reports every user and needs elevation; the empty SID asks
    // the same question for the signed-in user, which is the library's scope.
    let Ok(packages) = manager.FindPackagesByUserSecurityId(&windows::core::HSTRING::from("")) else {
        return Vec::new();
    };
    let Ok(iterator) = packages.First() else {
        return Vec::new();
    };

    let mut rows = Vec::new();
    while iterator.HasCurrent().unwrap_or(false) {
        let Ok(package) = iterator.Current() else {
            break;
        };
        let _ = iterator.MoveNext();
        if package.IsFramework().unwrap_or(false) || package.IsResourcePackage().unwrap_or(false) {
            continue;
        }
        let Ok(id) = package.Id() else {
            continue;
        };
        let family = id.FamilyName().map(|text| text.to_string_lossy()).unwrap_or_default();
        if family.is_empty() {
            continue;
        }
        let install_path = package
            .InstalledPath()
            .map(|text| text.to_string_lossy())
            .unwrap_or_default();
        // Reading the config first keeps the manifest read to the handful of
        // packages that are actually games.
        let game_config =
            std::fs::read_to_string(Path::new(&install_path).join("MicrosoftGame.config"))
                .unwrap_or_default();
        if game_config.trim().is_empty() {
            continue;
        }
        let manifest =
            std::fs::read_to_string(Path::new(&install_path).join("AppxManifest.xml"))
                .unwrap_or_default();
        rows.push(PackageRow {
            family,
            identity: id.Name().map(|text| text.to_string_lossy()).unwrap_or_default(),
            display: package
                .DisplayName()
                .map(|text| text.to_string_lossy())
                .unwrap_or_default(),
            install_path,
            manifest,
            game_config,
        });
    }
    rows
}

#[cfg(not(windows))]
fn enumerate() -> Vec<PackageRow> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(manifest: &str) -> PackageRow {
        PackageRow {
            family: "HelloGames.NoMansSky_bs190hzg1sesy".into(),
            identity: "HelloGames.NoMansSky".into(),
            display: "No Man's Sky".into(),
            install_path: r"C:\Program Files\WindowsApps\HelloGames.NoMansSky".into(),
            manifest: manifest.into(),
            game_config: r#"<Game>
              <ShellVisuals DefaultDisplayName="No Man's Sky" />
              <StoreId>BQVQTL3PCH05</StoreId>
            </Game>"#
                .into(),
        }
    }

    #[test]
    fn a_gdk_package_becomes_a_library_row() {
        let games = games_from_rows(&[row(
            r#"<Package><Applications><Application Id="NoMansSky" Executable="GameLaunchHelper.exe" /></Applications></Package>"#,
        )]);
        assert_eq!(games.len(), 1);
        let game = &games[0];
        assert_eq!(game.store, "xbox");
        // The family name is the id the account list also uses.
        assert_eq!(game.id, "HelloGames.NoMansSky_bs190hzg1sesy");
        assert_eq!(game.name, "No Man's Sky");
        assert_eq!(game.store_id, "BQVQTL3PCH05");
        assert!(game.installed);
        assert_eq!(
            game.launch_uri,
            "aumid:HelloGames.NoMansSky_bs190hzg1sesy!NoMansSky"
        );
        // The package identity starts the game, not the config executable.
        assert!(game.launch_exe.is_empty());
    }

    #[test]
    fn a_package_without_a_game_config_is_not_a_game() {
        let mut plain = row(r#"<Package><Applications><Application Id="App" /></Applications></Package>"#);
        plain.game_config.clear();
        assert!(games_from_rows(&[plain]).is_empty());
    }

    #[test]
    fn a_missing_application_id_leaves_launch_to_the_client() {
        let games = games_from_rows(&[row("<Package />")]);
        assert_eq!(games.len(), 1);
        assert!(games[0].launch_uri.is_empty());
        assert!(games[0].launch_exe.is_empty());
    }

    #[test]
    fn a_missing_display_name_falls_back_to_the_package_name() {
        let mut unnamed = row("<Package />");
        unnamed.game_config = "<Game />".into();
        unnamed.display.clear();
        let games = games_from_rows(&[unnamed]);
        assert_eq!(games[0].name, "HelloGames.NoMansSky");
    }

    /// The WinRT enumeration is the only part that needs the machine; run it
    /// manually (`cargo test -- --ignored --nocapture`) to see the real rows.
    #[cfg(windows)]
    #[test]
    #[ignore = "reads the real package list; run manually"]
    fn installed_packages_are_gdk_titles() {
        let games = installed_games();
        assert!(!games.is_empty(), "the machine should have GDK packages");
        for game in &games {
            assert!(game.installed);
            assert!(!game.install_path.is_empty(), "{} has no folder", game.name);
            assert!(
                game.launch_uri.starts_with("aumid:") || game.launch_uri.is_empty(),
                "{} has an unexpected launch target",
                game.name
            );
            println!(
                "{} | {} | {} | {}",
                game.name, game.id, game.store_id, game.launch_uri
            );
        }
    }
}
