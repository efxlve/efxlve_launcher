//! The Microsoft Store library on this PC.
//!
//! The Store app keeps the signed-in account's entitlements in a small JSON
//! cache under `LocalCache`. A purchased game stays there after it is
//! uninstalled, while a title that was only borrowed through Game Pass is not
//! listed once the subscription ends. That makes the cache the difference
//! between "Install" and "Buy" for a title the Xbox title history still knows.
//!
//! The file is read-only and machine-local. A missing, unreadable or partially
//! written cache answers `known = false`, never "not owned": the library then
//! keeps its normal install action instead of claiming the player owns nothing.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(60);
const STORE_PACKAGE: &str = "Microsoft.WindowsStore_8wekyb3d8bbwe";

static CACHE: Mutex<Option<(Instant, Snapshot)>> = Mutex::new(None);

/// Active Store products plus whether a cache was actually read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Snapshot {
    /// Products the account owns or can use through family sharing.
    pub owned: HashSet<String>,
    /// False when no cache answered; the caller must not infer ownership.
    pub known: bool,
}

/// The Store library, cached briefly because one library refresh asks for the
/// same snapshot for every Xbox row.
pub(crate) fn snapshot() -> Snapshot {
    if let Ok(guard) = CACHE.lock() {
        if let Some((at, snapshot)) = guard.as_ref() {
            if at.elapsed() < TTL {
                return snapshot.clone();
            }
        }
    }
    let fresh = read_snapshot();
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

fn read_snapshot() -> Snapshot {
    let Some(dir) = cache_dir() else {
        return Snapshot::default();
    };
    let entitlements_path = newest(&dir, "_PersistentEntitlementsCache.json");
    let mut snapshot = Snapshot::default();
    if let Some(path) = entitlements_path.as_deref() {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(rows) = parse_entitlements(&text) {
                snapshot.owned.extend(rows);
                snapshot.known = true;
            }
        }
    }
    let library_path = match entitlements_path.as_deref() {
        // Read the library file of the same account only; mixing two Microsoft
        // accounts would report games the Store cannot install here.
        Some(path) => account_prefix(path)
            .map(|prefix| dir.join(format!("{prefix}_MinimalLibraryCache.json"))),
        None => newest(&dir, "_MinimalLibraryCache.json"),
    };
    if let Some(path) = library_path.as_deref() {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(rows) = parse_library(&text) {
                snapshot.owned.extend(rows);
                snapshot.known = true;
            }
        }
    }
    snapshot
}

/// `%LOCALAPPDATA%\Packages\Microsoft.WindowsStore_<id>\LocalCache`.
fn cache_dir() -> Option<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA")?;
    let dir = PathBuf::from(root)
        .join("Packages")
        .join(STORE_PACKAGE)
        .join("LocalCache");
    dir.is_dir().then_some(dir)
}

/// The `Msa<account>` prefix of an entitlements file, so its library file is
/// read from the same account when several are cached.
fn account_prefix(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    name.strip_suffix("_PersistentEntitlementsCache.json")
        .filter(|prefix| !prefix.is_empty())
        .map(str::to_string)
}

fn newest(dir: &Path, suffix: &str) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(suffix) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(UNIX_EPOCH);
        if best.as_ref().map_or(true, |(at, _)| modified > *at) {
            best = Some((modified, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

fn parse_entitlements(text: &str) -> Option<HashSet<String>> {
    #[derive(serde::Deserialize)]
    struct File {
        #[serde(rename = "Entitlements", default)]
        entitlements: Vec<Row>,
    }
    #[derive(serde::Deserialize)]
    struct Row {
        #[serde(rename = "ProductId", default)]
        product_id: String,
        #[serde(rename = "Status", default)]
        status: String,
        #[serde(rename = "EndDateUtc", default)]
        end_date: String,
    }
    let file: File = serde_json::from_str(text).ok()?;
    let mut owned = HashSet::new();
    for row in file.entitlements {
        let product_id = row.product_id.trim();
        if product_id.is_empty() {
            continue;
        }
        if !row.status.trim().eq_ignore_ascii_case("active") {
            continue;
        }
        if still_valid(&row.end_date) {
            owned.insert(product_id.to_string());
        }
    }
    Some(owned)
}

fn parse_library(text: &str) -> Option<HashSet<String>> {
    #[derive(serde::Deserialize)]
    struct File {
        #[serde(rename = "Items", default)]
        items: Vec<Row>,
    }
    #[derive(serde::Deserialize)]
    struct Row {
        #[serde(rename = "ProductId", default)]
        product_id: String,
    }
    let file: File = serde_json::from_str(text).ok()?;
    Some(
        file.items
            .into_iter()
            .map(|row| row.product_id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect(),
    )
}

/// `EndDateUtc` is an ISO timestamp. A purchase runs to 9999; a subscription
/// benefit carries its real end date and must not keep the title owned after it.
fn still_valid(end_date: &str) -> bool {
    let end_date = end_date.trim();
    if end_date.is_empty() || end_date.starts_with("9999-") {
        return true;
    }
    let Some(day) = end_date.get(0..10) else {
        return true;
    };
    day >= today_utc().as_str()
}

/// UTC date as `YYYY-MM-DD`, the comparable prefix of every ISO timestamp.
fn today_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Days since 1970-01-01 → civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_active_entitlement_is_owned_and_an_expired_one_is_not() {
        let rows = parse_entitlements(
            r#"{"Entitlements":[
                {"ProductId":"9P55TJKCL1BC","Status":"Active","EndDateUtc":"9999-12-31T23:59:59.9999999Z"},
                {"ProductId":"BQVQTL3PCH05","Status":"Active","EndDateUtc":"2020-01-01T00:00:00Z"},
                {"ProductId":"9NBLGGH5FV99","Status":"Expired","EndDateUtc":"9999-12-31T23:59:59.9999999Z"},
                {"ProductId":"","Status":"Active","EndDateUtc":"9999-12-31T23:59:59.9999999Z"}
            ]}"#,
        )
        .expect("the cache should parse");
        assert_eq!(rows.len(), 1);
        assert!(rows.contains("9P55TJKCL1BC"));
    }

    #[test]
    fn the_store_library_adds_its_product_ids() {
        let rows = parse_library(
            r#"{"Items":[
                {"ProductId":"9NBLGGH2JHXJ","Title":"Minecraft for Windows"},
                {"ProductId":"","Title":"broken"}
            ]}"#,
        )
        .expect("the library should parse");
        assert_eq!(rows.len(), 1);
        assert!(rows.contains("9NBLGGH2JHXJ"));
    }

    #[test]
    fn a_broken_cache_is_unknown_not_empty_ownership() {
        assert!(parse_entitlements("").is_none());
        assert!(parse_library("{").is_none());
    }

    #[test]
    fn dates_round_trip_from_the_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }
}
