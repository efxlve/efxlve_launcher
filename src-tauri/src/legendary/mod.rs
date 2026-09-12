//! Epic Games (Legendary CLI) entegrasyonu.
//!
//! Faz 0 kapsamı: binary çözümleme + oto-indirme, auth (kod/aktarım),
//! oturum durumu ve kütüphane listeleme. İndirme/oynatma Faz 1-2'de.

pub mod client;
pub mod cache;
pub mod commands;
pub mod downloader;
pub mod models;
pub mod paths;
pub mod skip;
pub mod transfers;

use thiserror::Error;

/// Frontend'in "giriş gerekli" durumunu tanıdığı sabit hata kodu.
/// Komutlar `LegendaryError::NotAuthenticated` yerine bunu döndürür.
pub const NOT_AUTHENTICATED: &str = "NOT_AUTHENTICATED";

#[derive(Debug, Error)]
pub enum LegendaryError {
    #[error("Epic hesabına giriş yapılmamış")]
    NotAuthenticated,
    #[error("legendary komutu başarısız oldu (çıkış kodu {exit}): {stderr_tail}")]
    CommandFailed {
        exit: i32,
        stderr_tail: String,
        /// Tanı için tam çıktı (arayüze gönderilmez, dosyaya yazılır).
        stderr_full: String,
    },
    #[error("legendary çıktısı okunamadı: {0}")]
    ParseError(String),
    #[error("legendary bulunamadı, önce indirin")]
    BinaryMissing,
    #[error("legendary indirilemedi: {0}")]
    DownloadFailed(String),
    #[error("komut zaman aşımına uğradı")]
    Timeout,
    #[error("G/Ç hatası: {0}")]
    Io(String),
}

impl From<std::io::Error> for LegendaryError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            LegendaryError::BinaryMissing
        } else {
            LegendaryError::Io(e.to_string())
        }
    }
}

/// Geçici hata izleri: tekrar denemeye değer durumlar.
/// Her deneme yeni bir `legendary` süreci + taze login ile çalışır,
/// ayrıca kısmi metadata diske yazıldığı için kalan iş her turda azalır.
pub(crate) fn transient_reason(text: &str) -> Option<&'static str> {
    if text.contains("429") || text.contains("Too Many Requests") {
        Some("Epic hız limiti (429)")
    } else if text.contains("401 Client Error") || text.contains("Unauthorized") {
        // Uzun senkronlarda token ortada eskiyebilir; yeni süreç taze giriş yapar.
        Some("Epic oturum hatası (401)")
    } else if [
        "Max retries",
        "Failed to establish",
        "NameResolution",
        "Connection aborted",
        "ConnectTimeout",
        "NewConnectionError",
        "Temporary failure",
        "timed out",
    ]
    .iter()
    .any(|m| text.contains(m))
    {
        Some("Geçici ağ hatası")
    } else {
        None
    }
}

impl LegendaryError {
    /// Kullanıcıya gösterilecek Türkçe mesaj (teknik detay korunur).
    pub fn friendly(self) -> String {
        match &self {
            LegendaryError::CommandFailed { stderr_tail, .. } => {
                match transient_reason(stderr_tail) {
                    Some("Epic hız limiti (429)") => {
                        "Epic API hız limitine takıldı (429) — tekrar denemeler tükendi. \
                         Birkaç dakika bekleyip Tekrar dene'ye bas. \
                         (Not: ilk senkron kaldığı yerden devam eder, baştan başlamaz.)"
                            .to_string()
                    }
                    Some("Epic oturum hatası (401)") => {
                        "Epic oturumu tazelenemedi (401) — tekrar denemeler tükendi. \
                         Önce Tekrar dene'ye bas (her deneme taze giriş yapar); \
                         düzelmezse Epic'ten çıkış yapıp tekrar giriş yap."
                            .to_string()
                    }
                    Some(_) => {
                        format!("Geçici ağ hatası — denemeler tükendi. İnterneti kontrol edip Tekrar dene'ye bas.\nDetay: {stderr_tail}")
                    }
                    None if stderr_tail.contains("Login failed") => {
                        "Epic girişi başarısız. İnterneti kontrol edip tekrar dene; \
                         olmazsa çıkış yapıp tekrar giriş yap."
                            .to_string()
                    }
                    None => self.to_string(),
                }
            }
            _ => self.to_string(),
        }
    }
}

/// Tauri komutları için hata eşleme.
pub fn cmd_error(e: LegendaryError) -> String {
    match e {
        LegendaryError::NotAuthenticated => NOT_AUTHENTICATED.to_string(),
        other => other.friendly(),
    }
}
