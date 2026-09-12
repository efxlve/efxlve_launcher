//! `legendary ... --json` çıktılarının serde modelleri.
//!
//! Alan adları legendary'nin Python `Game`/`InstalledGame` dataclass'larıyla
//! birebir aynıdır (snake_case). Sürüm farklarına dayanıklılık için çoğu
//! alan `#[serde(default)]` ile opsiyoneldir.
//!
//! ÖNEMLİ: legendary bazı alanları açıkça `null` gönderir (örn.
//! `manifest_path: null`). `#[serde(default)]` yalnız EKSİK anahtarı
//! kurtarır; `null` için `deserialize_with = "null_string"` gerekir.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `null` → `""` (eksik anahtar zaten `default` ile `""` olur).
pub(crate) fn null_string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// `null` → `0`.
pub(crate) fn null_u64<'de, D>(d: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<u64>::deserialize(d)?.unwrap_or_default())
}

/// `asset_infos` içindeki platform (örn. "Windows") varlığı.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GameAsset {
    #[serde(default, deserialize_with = "null_string")]
    pub app_name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub asset_id: String,
    /// Epic'teki derleme sürümü — güncelleme karşılaştırması buradan yapılır.
    #[serde(default, deserialize_with = "null_string")]
    pub build_version: String,
    #[serde(default, deserialize_with = "null_string")]
    pub catalog_item_id: String,
    #[serde(default, deserialize_with = "null_string")]
    pub label_name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub namespace: String,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    #[serde(default)]
    pub sidecar_rev: i64,
}

/// `legendary list --json` dizisinin bir elemanı.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LegendaryGame {
    #[serde(default, deserialize_with = "null_string")]
    pub app_name: String,
    #[serde(default, deserialize_with = "null_string")]
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
    #[serde(default, deserialize_with = "null_string")]
    pub app_name: String,
    #[serde(default, deserialize_with = "null_string")]
    pub install_path: String,
    #[serde(default, deserialize_with = "null_string")]
    pub title: String,
    #[serde(default, deserialize_with = "null_string")]
    pub version: String,
    #[serde(default)]
    pub base_urls: Vec<String>,
    #[serde(default)]
    pub can_run_offline: bool,
    #[serde(default, deserialize_with = "null_string")]
    pub egl_guid: String,
    #[serde(default, deserialize_with = "null_string")]
    pub executable: String,
    #[serde(default, deserialize_with = "null_u64")]
    pub install_size: u64,
    #[serde(default)]
    pub install_tags: Vec<String>,
    #[serde(default)]
    pub is_dlc: bool,
    #[serde(default, deserialize_with = "null_string")]
    pub launch_parameters: String,
    #[serde(default, deserialize_with = "null_string")]
    pub manifest_path: String,
    #[serde(default)]
    pub needs_verification: bool,
    #[serde(default, deserialize_with = "null_string")]
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
    #[serde(default, deserialize_with = "null_string")]
    pub account: String,
    pub games_available: u32,
    pub games_installed: u32,
    pub egl_sync_enabled: bool,
    #[serde(default, deserialize_with = "null_string")]
    pub config_directory: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gerçek `list-installed --json` çıktısı: manifest_path null gelir.
    /// (Hata: "invalid type: null, expected a string at line 1 column 753")
    #[test]
    fn installed_with_nulls_parses() {
        let json = r#"[{
            "app_name": "19927295d6e3467887d4e830d8c85963",
            "install_path": "C:\\Games\\AbsoluteDrift",
            "title": "Absolute Drift",
            "version": "Win_202306231055",
            "manifest_path": null,
            "save_path": null,
            "install_size": 374178085
        }]"#;
        let v: Vec<InstalledGame> = serde_json::from_str(json).expect("parse edilmeli");
        assert_eq!(v[0].manifest_path, "");
        assert_eq!(v[0].install_size, 374178085);
        assert_eq!(v[0].platform, "");
    }
}
