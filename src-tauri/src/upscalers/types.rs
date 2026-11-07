//! Shared upscaler types.

use serde::{Deserialize, Serialize};

/// One swappable upscaler DLL family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpscalerKind {
    Dlss,
    DlssFg,
    DlssRr,
    Fsr31Dx12,
    Fsr31Vk,
    Xess,
    XessDx11,
    XessFg,
    Xell,
}

impl UpscalerKind {
    /// The DLL file name a game ships for this family.
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Dlss => "nvngx_dlss.dll",
            Self::DlssFg => "nvngx_dlssg.dll",
            Self::DlssRr => "nvngx_dlssd.dll",
            Self::Fsr31Dx12 => "amd_fidelityfx_dx12.dll",
            Self::Fsr31Vk => "amd_fidelityfx_vk.dll",
            Self::Xess => "libxess.dll",
            Self::XessDx11 => "libxess_dx11.dll",
            Self::XessFg => "libxess_fg.dll",
            Self::Xell => "libxell.dll",
        }
    }

    /// Folder name used by the launcher's own DLL cache.
    pub fn dir_name(self) -> &'static str {
        match self {
            Self::Dlss => "dlss",
            Self::DlssFg => "dlss_g",
            Self::DlssRr => "dlss_d",
            Self::Fsr31Dx12 => "fsr_31_dx12",
            Self::Fsr31Vk => "fsr_31_vk",
            Self::Xess => "xess",
            Self::XessDx11 => "xess_dx11",
            Self::XessFg => "xess_fg",
            Self::Xell => "xell",
        }
    }

    /// Manifest array name for this family.
    pub fn manifest_key(self) -> &'static str {
        match self {
            Self::Dlss => "dlss",
            Self::DlssFg => "dlss_g",
            Self::DlssRr => "dlss_d",
            Self::Fsr31Dx12 => "fsr_31_dx12",
            Self::Fsr31Vk => "fsr_31_vk",
            Self::Xess => "xess",
            Self::XessDx11 => "xess_dx11",
            Self::XessFg => "xess_fg",
            Self::Xell => "xell",
        }
    }

    /// Display order on the game page.
    pub fn order(self) -> u8 {
        match self {
            Self::Dlss => 0,
            Self::DlssFg => 1,
            Self::DlssRr => 2,
            Self::Fsr31Dx12 => 3,
            Self::Fsr31Vk => 4,
            Self::Xess => 5,
            Self::XessDx11 => 6,
            Self::XessFg => 7,
            Self::Xell => 8,
        }
    }

    /// Maps a file name to its family. Windows file names are case-insensitive.
    pub fn from_file_name(name: &str) -> Option<Self> {
        const ALL: [UpscalerKind; 9] = [
            UpscalerKind::Dlss,
            UpscalerKind::DlssFg,
            UpscalerKind::DlssRr,
            UpscalerKind::Fsr31Dx12,
            UpscalerKind::Fsr31Vk,
            UpscalerKind::Xess,
            UpscalerKind::XessDx11,
            UpscalerKind::XessFg,
            UpscalerKind::Xell,
        ];
        ALL.into_iter()
            .find(|kind| name.eq_ignore_ascii_case(kind.file_name()))
    }
}

/// Original and swapped states are decided by the sidecar backup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DllState {
    Original,
    Swapped,
}

/// One DLL found in a game folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscalerDll {
    pub kind: UpscalerKind,
    pub file_name: String,
    pub path: String,
    pub version: String,
    pub md5: String,
    pub size: u64,
    pub state: DllState,
    pub backup_path: Option<String>,
    pub backup_version: Option<String>,
    pub backup_md5: Option<String>,
}

/// A DLL copied into the launcher's own cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDll {
    pub id: String,
    pub kind: UpscalerKind,
    pub file_name: String,
    pub version: String,
    pub md5: String,
    pub size: u64,
    pub imported_at: u64,
    /// Local path the user picked, or the catalog URL it came from.
    pub source_path: String,
}

/// Result of scanning one installed game.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameUpscalers {
    pub game_key: String,
    pub install_path: String,
    pub dlls: Vec<UpscalerDll>,
}

/// One version in the public DLSS Swapper catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub kind: UpscalerKind,
    pub id: String,
    pub version: String,
    pub version_number: u64,
    pub label: String,
    pub md5: String,
    pub zip_md5: String,
    pub download_url: String,
    pub file_size: u64,
    pub zip_file_size: u64,
    pub is_dev: bool,
    pub is_signed: bool,
}
