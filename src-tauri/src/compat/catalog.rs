//! The compatibility-tool catalogue: what each helper is, where it comes from,
//! and which release asset belongs to a platform.
//!
//! The list is static on purpose. A release check is a network call, and the
//! launcher must be able to paint the Compatibility settings page offline; the
//! GitHub answer only fills in the version, size and digest later.

use serde::{Deserialize, Serialize};

/// Where an installed copy comes from.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ToolSource {
    /// A dedicated module already downloads and runs this CLI.
    Module,
    /// The compatibility manager downloads the release archive.
    Github,
    /// Detected on the system; never installed by the launcher (licence or
    /// source-only projects).
    External,
}

pub struct ToolDef {
    pub id: &'static str,
    /// `owner/repo` for GitHub-backed tools, empty for external ones.
    pub repo: &'static str,
    pub homepage: &'static str,
    /// `store`, `runner`, `translation`, `runtime` or `helper`.
    pub kind: &'static str,
    /// Operating systems this tool is used on.
    pub platforms: &'static [&'static str],
    pub source: ToolSource,
}

/// The order here is the order the settings page shows.
pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        id: "legendary",
        repo: "derrod/legendary",
        homepage: "https://github.com/derrod/legendary",
        kind: "store",
        platforms: &["windows", "linux", "macos"],
        source: ToolSource::Module,
    },
    ToolDef {
        id: "gogdl",
        repo: "Heroic-Games-Launcher/heroic-gogdl",
        homepage: "https://github.com/Heroic-Games-Launcher/heroic-gogdl",
        kind: "store",
        platforms: &["windows", "linux", "macos"],
        source: ToolSource::Module,
    },
    ToolDef {
        id: "nile",
        repo: "imLinguin/nile",
        homepage: "https://github.com/imLinguin/nile",
        kind: "store",
        platforms: &["windows", "linux", "macos"],
        source: ToolSource::Module,
    },
    ToolDef {
        id: "comet",
        repo: "imLinguin/comet",
        homepage: "https://github.com/imLinguin/comet",
        kind: "store",
        platforms: &["windows", "linux", "macos"],
        source: ToolSource::Module,
    },
    ToolDef {
        id: "ge-proton",
        repo: "GloriousEggroll/proton-ge-custom",
        homepage: "https://github.com/GloriousEggroll/proton-ge-custom",
        kind: "runner",
        platforms: &["linux"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "proton-cachyos",
        repo: "CachyOS/proton-cachyos",
        homepage: "https://github.com/CachyOS/proton-cachyos",
        kind: "runner",
        platforms: &["linux"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "umu-launcher",
        repo: "Open-Wine-Components/umu-launcher",
        homepage: "https://github.com/Open-Wine-Components/umu-launcher",
        kind: "runtime",
        platforms: &["linux"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "dxvk",
        repo: "doitsujin/dxvk",
        homepage: "https://github.com/doitsujin/dxvk",
        kind: "translation",
        platforms: &["windows", "linux"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "vkd3d-proton",
        repo: "HansKristian-Work/vkd3d-proton",
        homepage: "https://github.com/HansKristian-Work/vkd3d-proton",
        kind: "translation",
        platforms: &["linux"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "game-porting-toolkit",
        repo: "Gcenx/game-porting-toolkit",
        homepage: "https://github.com/Gcenx/game-porting-toolkit",
        kind: "runtime",
        platforms: &["macos"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "wine-staging",
        repo: "Gcenx/macOS_Wine_builds",
        homepage: "https://github.com/Gcenx/macOS_Wine_builds",
        kind: "runner",
        platforms: &["macos"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "wine-crossover",
        repo: "",
        homepage: "https://www.codeweavers.com/crossover",
        kind: "runner",
        platforms: &["macos"],
        source: ToolSource::External,
    },
    ToolDef {
        id: "dxvk-macos",
        repo: "Gcenx/DXVK-macOS",
        homepage: "https://github.com/Gcenx/DXVK-macOS",
        kind: "translation",
        platforms: &["macos"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "dxmt",
        repo: "3Shain/dxmt",
        homepage: "https://github.com/3Shain/dxmt",
        kind: "translation",
        platforms: &["macos"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "heroic-epic-integration",
        repo: "Etaash-mathamsetty/heroic-epic-integration",
        homepage: "https://github.com/Etaash-mathamsetty/heroic-epic-integration",
        kind: "helper",
        platforms: &["windows", "linux", "macos"],
        source: ToolSource::Github,
    },
    ToolDef {
        id: "vulkan-helper-rs",
        repo: "imLinguin/vulkan-helper-rs",
        homepage: "https://github.com/imLinguin/vulkan-helper-rs",
        kind: "helper",
        platforms: &["linux", "macos"],
        source: ToolSource::External,
    },
];

pub fn find(id: &str) -> Option<&'static ToolDef> {
    TOOLS.iter().find(|tool| tool.id == id)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub os: String,
    pub arch: String,
}

impl Target {
    pub fn current() -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        }
    }

    /// `None`/`current` means this machine; anything else must be
    /// `<os>-<arch>` so a release can be fetched for another platform
    /// (preparing a Linux/macOS tree from a Windows build).
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let Some(raw) = raw
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "current")
        else {
            return Ok(Self::current());
        };
        let (os, arch) = raw
            .split_once('-')
            .ok_or_else(|| "@t:compat.badTarget".to_string())?;
        if !matches!(os, "windows" | "linux" | "macos") {
            return Err("@t:compat.badTarget".to_string());
        }
        if !matches!(arch, "x86_64" | "aarch64") {
            return Err("@t:compat.badTarget".to_string());
        }
        Ok(Self {
            os: os.to_string(),
            arch: arch.to_string(),
        })
    }

    pub fn key(&self) -> String {
        format!("{}-{}", self.os, self.arch)
    }

    pub fn is_current(&self) -> bool {
        self.os == std::env::consts::OS && self.arch == std::env::consts::ARCH
    }

    pub fn supports(&self, tool: &ToolDef) -> bool {
        tool.platforms.contains(&self.os.as_str())
    }
}

/// One asset from the GitHub releases API.
#[derive(Clone, Debug, Deserialize)]
pub struct GhAsset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub browser_download_url: String,
    /// GitHub's own `sha256:<hex>` digest, when the release has one.
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

/// Stored release answer, so the settings page does not hit the API on every
/// open and a rate-limited day still shows the version it already knows.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedRelease {
    pub tag: String,
    pub release_url: String,
    pub fetched_at: u64,
    pub assets: Vec<CachedAsset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAsset {
    pub name: String,
    pub size: u64,
    pub url: String,
    pub digest: Option<String>,
}

impl From<GhRelease> for CachedRelease {
    fn from(release: GhRelease) -> Self {
        Self {
            tag: release.tag_name,
            release_url: release.html_url,
            fetched_at: now_secs(),
            assets: release
                .assets
                .into_iter()
                .map(|asset| CachedAsset {
                    name: asset.name,
                    size: asset.size,
                    url: asset.browser_download_url,
                    digest: asset.digest,
                })
                .collect(),
        }
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn has_arch(name: &str, arch: &str) -> bool {
    match arch {
        "x86_64" => {
            name.contains("x86_64")
                || name.contains("x64")
                || name.contains("amd64")
                || name.contains("osx64")
        }
        "aarch64" => name.contains("aarch64") || name.contains("arm64") || name.contains("osx-arm"),
        _ => false,
    }
}

/// Picks the release asset for one tool. A score keeps the alternatives (a
/// `v3` build, a `builtin` variant, a checksum sidecar) from winning.
pub fn select_asset<'a>(
    id: &str,
    arch: &str,
    assets: &'a [CachedAsset],
) -> Option<&'a CachedAsset> {
    let best = assets
        .iter()
        .filter_map(|asset| asset_score(id, arch, &asset.name).map(|score| (score, asset)))
        .max_by_key(|(score, _)| *score);
    best.map(|(_, asset)| asset)
}

fn asset_score(id: &str, arch: &str, name: &str) -> Option<u32> {
    if name.ends_with(".sha256sum") || name.ends_with(".sha512sum") || name.ends_with(".sig") {
        return None;
    }
    match id {
        "ge-proton" => (name.ends_with(".tar.gz") && has_arch(name, arch)).then_some(100),
        "proton-cachyos" => {
            if !name.ends_with(".tar.xz") || !has_arch(name, arch) {
                None
            } else if name.contains("_v3") {
                // AVX2-only build: keep it as the fallback, not the default.
                Some(80)
            } else {
                Some(100)
            }
        }
        "umu-launcher" => (name.contains("zipapp") && name.ends_with(".tar")).then_some(100),
        "dxvk" => {
            (name.starts_with("dxvk-") && name.ends_with(".tar.gz") && !name.contains("native"))
                .then_some(100)
        }
        "vkd3d-proton" => name.ends_with(".tar.zst").then_some(100),
        "game-porting-toolkit" => name.ends_with(".tar.xz").then_some(100),
        "wine-staging" => {
            (name.contains("wine-staging") && name.ends_with(".tar.xz")).then_some(100)
        }
        "dxvk-macos" => {
            if !name.ends_with(".tar.gz") || !name.contains("dxvk-macOS") {
                None
            } else if name.contains("builtin") {
                Some(80)
            } else {
                Some(100)
            }
        }
        "dxmt" => {
            if !name.ends_with(".tar.gz") || !name.starts_with("dxmt") {
                None
            } else if name.contains("builtin") {
                Some(80)
            } else {
                Some(100)
            }
        }
        "heroic-epic-integration" => (name == "EpicGamesLauncher.exe").then_some(100),
        // Store CLIs are owned by their modules; external tools have no asset.
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveKind {
    TarGz,
    TarXz,
    TarZst,
    Tar,
    Plain,
}

pub fn archive_kind(name: &str) -> ArchiveKind {
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        ArchiveKind::TarGz
    } else if name.ends_with(".tar.xz") || name.ends_with(".txz") {
        ArchiveKind::TarXz
    } else if name.ends_with(".tar.zst") {
        ArchiveKind::TarZst
    } else if name.ends_with(".tar") {
        ArchiveKind::Tar
    } else {
        ArchiveKind::Plain
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> CachedAsset {
        CachedAsset {
            name: name.to_string(),
            size: 1,
            url: format!("https://example.invalid/{name}"),
            digest: None,
        }
    }

    #[test]
    fn picks_the_platform_asset_and_ignores_checksums() {
        let assets = vec![
            asset("GE-Proton11-10-x86_64.sha512sum"),
            asset("GE-Proton11-10-aarch64.tar.gz"),
            asset("GE-Proton11-10-x86_64.tar.gz"),
        ];
        let hit = select_asset("ge-proton", "x86_64", &assets).expect("x86_64 archive");
        assert_eq!(hit.name, "GE-Proton11-10-x86_64.tar.gz");
        let hit = select_asset("ge-proton", "aarch64", &assets).expect("arm archive");
        assert_eq!(hit.name, "GE-Proton11-10-aarch64.tar.gz");
    }

    #[test]
    fn prefers_the_non_v3_cachyos_build() {
        let assets = vec![
            asset("proton-cachyos-1-x86_64_v3.tar.xz"),
            asset("proton-cachyos-1-x86_64.tar.xz"),
        ];
        assert_eq!(
            select_asset("proton-cachyos", "x86_64", &assets)
                .expect("archive")
                .name,
            "proton-cachyos-1-x86_64.tar.xz"
        );
    }

    #[test]
    fn archive_kinds_match_the_extensions() {
        assert_eq!(archive_kind("a.tar.gz"), ArchiveKind::TarGz);
        assert_eq!(archive_kind("a.tar.xz"), ArchiveKind::TarXz);
        assert_eq!(archive_kind("a.tar.zst"), ArchiveKind::TarZst);
        assert_eq!(archive_kind("a.tar"), ArchiveKind::Tar);
        assert_eq!(archive_kind("EpicGamesLauncher.exe"), ArchiveKind::Plain);
    }

    #[test]
    fn target_parsing_rejects_unknown_platforms() {
        assert!(Target::parse(Some("linux-x86_64")).is_ok());
        assert!(Target::parse(Some("linux-arm64")).is_err());
        assert!(Target::parse(Some("plan9-x86_64")).is_err());
        assert_eq!(Target::parse(Some("current")).unwrap(), Target::current());
    }
}
