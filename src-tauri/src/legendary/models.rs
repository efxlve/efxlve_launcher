//! `legendary ... --json` çıktılarının serde modelleri.
//!
//! Alan adları legendary'nin Python `Game`/`InstalledGame` dataclass'larıyla
//! birebir aynıdır (snake_case). Sürüm farklarına dayanıklılık için çoğu
//! alan `#[serde(default)]` ile opsiyoneldir.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `asset_infos` içindeki platform (örn. "Windows") varlığı.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GameAsset {
    #[serde(default)]
    pub app_name: String,
    #[serde(default)]
    pub asset_id: String,
    /// Epic'teki derleme sürümü — güncelleme karşılaştırması buradan yapılır.
    #[serde(default)]
    pub build_version: String,
    #[serde(default)]
    pub catalog_item_id: String,
    #[serde(default)]
    pub label_name: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    #[serde(default)]
    pub sidecar_rev: i64,
}

/// `legendary list --json` dizisinin bir elemanı.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LegendaryGame {
    pub app_name: String,
    #[serde(default)]
    pub app_title: String,
    #[serde(default)]
    pub asset_infos: HashMap<String, GameAsset>,
    #[serde(default)]
    pub base_urls: Vec<String>,
    /// Epic katalog metadata'sı: açıklama, keyImages (kapaklar), DLC bilgisi...
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    pub sidecar: Option<Value>,
    pub achievements: Option<Value>,
    /// `list --json` her oyuna DLC listesini gömülü olarak ekler.
    #[serde(default)]
    pub dlcs: Vec<Value>,
}

/// `legendary list-installed --json` dizisinin bir elemanı.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InstalledGame {
    pub app_name: String,
    #[serde(default)]
    pub install_path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub base_urls: Vec<String>,
    #[serde(default)]
    pub can_run_offline: bool,
    #[serde(default)]
    pub egl_guid: String,
    #[serde(default)]
    pub executable: String,
    #[serde(default)]
    pub install_size: u64,
    #[serde(default)]
    pub install_tags: Vec<String>,
    #[serde(default)]
    pub is_dlc: bool,
    #[serde(default)]
    pub launch_parameters: String,
    #[serde(default)]
    pub manifest_path: String,
    #[serde(default)]
    pub needs_verification: bool,
    #[serde(default)]
    pub platform: String,
    pub prereq_info: Option<Value>,
    pub uninstaller: Option<Value>,
    #[serde(default)]
    pub requires_ot: bool,
    pub save_path: Option<String>,
    #[serde(default)]
    pub is_preloaded: bool,
}

/// `legendary status --offline --json` çıktısı.
/// Giriş yapılmamışsa `account == "<not logged in>"` olur.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LegendaryStatus {
    pub account: String,
    pub games_available: u32,
    pub games_installed: u32,
    pub egl_sync_enabled: bool,
    pub config_directory: String,
}
