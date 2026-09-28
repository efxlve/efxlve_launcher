//! GOG Galaxy playtime import (read-only).
//!
//! GOG exposes no public playtime API: hours played are tracked by the Galaxy
//! client in its local SQLite database
//! (`%ProgramData%\GOG.com\Galaxy\storage\galaxy-2.0.db`). The `GameTimes` table
//! stores `minutesInGame` per `userId` and `releaseKey`; GOG release keys have
//! the shape `gog_<productId>_<edition>`, so the product id can be recovered.
//!
//! This module only ever opens the database read-only. When Galaxy is missing or
//! the database is locked, every function returns an empty result.

use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

/// One playtime row read from Galaxy's database.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalaxyPlaytimeEntry {
    pub game_id: String,
    pub seconds: u64,
}

/// `<ProgramData>/GOG.com/Galaxy/storage/galaxy-2.0.db` when it exists.
fn galaxy_db_path() -> Option<PathBuf> {
    let program_data = std::env::var("ProgramData").ok()?;
    let path = PathBuf::from(program_data)
        .join("GOG.com")
        .join("Galaxy")
        .join("storage")
        .join("galaxy-2.0.db");
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

/// Turns a GOG release key (`gog_1207658924_GameOfTheYear`) into the product id.
fn product_id_from_release_key(key: &str) -> Option<String> {
    let rest = key.strip_prefix("gog_")?;
    let id: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Reads playtime (in seconds) per GOG product id.
///
/// `user_id` is the signed-in GOG user id; when it is known the query is limited
/// to that Galaxy user, otherwise every local user's rows are returned.
pub fn read_galaxy_playtime(user_id: Option<&str>) -> Vec<GalaxyPlaytimeEntry> {
    let Some(path) = galaxy_db_path() else {
        return Vec::new();
    };
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = Connection::open_with_flags(&path, flags) else {
        return Vec::new();
    };

    const SQL_ALL: &str = "SELECT rk.key, gt.minutesInGame \
         FROM GameTimes gt JOIN ReleaseKeys rk ON rk.key = gt.releaseKey \
         WHERE rk.key LIKE 'gog\\_%' ESCAPE '\\'";
    const SQL_USER: &str = "SELECT rk.key, gt.minutesInGame \
         FROM GameTimes gt JOIN ReleaseKeys rk ON rk.key = gt.releaseKey \
         WHERE rk.key LIKE 'gog\\_%' ESCAPE '\\' AND gt.userId = ?1";

    let mut out: Vec<GalaxyPlaytimeEntry> = Vec::new();
    let mut push = |key: String, minutes: i64| {
        if minutes <= 0 {
            return;
        }
        if let Some(game_id) = product_id_from_release_key(&key) {
            let entry = GalaxyPlaytimeEntry {
                game_id,
                seconds: (minutes as u64).saturating_mul(60),
            };
            // Galaxy may keep one row per user for the same key: keep the largest.
            match out.iter_mut().find(|e| e.game_id == entry.game_id) {
                Some(existing) => {
                    if entry.seconds > existing.seconds {
                        existing.seconds = entry.seconds;
                    }
                }
                None => out.push(entry),
            }
        }
    };

    let user_filter = user_id.and_then(|id| id.trim().parse::<i64>().ok());
    let collected = match user_filter {
        Some(uid) => conn
            .prepare(SQL_USER)
            .and_then(|mut stmt| {
                let rows = stmt.query_map([uid], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?;
                Ok(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
            })
            .unwrap_or_default(),
        None => conn
            .prepare(SQL_ALL)
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?;
                Ok(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
            })
            .unwrap_or_default(),
    };
    for (key, minutes) in collected {
        push(key, minutes);
    }

    out.sort_by(|a, b| b.seconds.cmp(&a.seconds));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_keys_map_to_product_ids() {
        assert_eq!(product_id_from_release_key("gog_1207658924_GOTY").as_deref(), Some("1207658924"));
        assert_eq!(product_id_from_release_key("gog_1423049311").as_deref(), Some("1423049311"));
        // Non-GOG platforms and malformed keys are ignored.
        assert_eq!(product_id_from_release_key("steam_12345_foo"), None);
        assert_eq!(product_id_from_release_key("gog_notanumber"), None);
        assert_eq!(product_id_from_release_key(""), None);
    }
}
