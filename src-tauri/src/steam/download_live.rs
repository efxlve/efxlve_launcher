//! Live Steam download numbers.
//!
//! The app manifest is rewritten when a transfer starts or pauses, not while
//! bytes are moving. Between those flushes the only moving signal is
//! `Current download rate` in `logs/content_log.txt`. This module projects the
//! byte counter forward from the last exact sample at that rate, then snaps
//! back to the manifest when Steam writes a newer total.

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::library::installed_games;
use super::runtime::steam_install_path;

/// How far the log tail is read. A transfer's "update started" line has to
/// still be inside this window or the row stays on the last manifest flush.
const LOG_TAIL_BYTES: u64 = 8 * 1024 * 1024;
/// A rate sample older than this no longer moves the counter. The download
/// stopped without a matching stop line.
const RATE_HOLDS_SECS: i64 = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
enum LiveEvent {
    Start { app: String, at: i64, got: u64, total: u64 },
    Rate { at: i64, bps: u64 },
    Stop { app: String, at: i64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamLiveDownload {
    pub app_id: String,
    pub bytes_downloaded: u64,
    pub bytes_to_download: u64,
    /// Bytes per second from Steam's latest rate line. Zero when paused.
    pub bytes_per_sec: u64,
}

/// Projects `got` forward across rate samples. Each sample is the rate over
/// the interval that just ended, and the last sample keeps running until `now`.
fn project_download(
    got: u64,
    total: u64,
    start: i64,
    rates: &[(i64, u64)],
    now: i64,
) -> (u64, u64) {
    if now <= start {
        return (got.min(nonzero(total, got)), 0);
    }
    let mut bytes = got;
    let mut t = start;
    let mut rate = 0u64;
    for &(at, bps) in rates {
        if at < start {
            continue;
        }
        if at > now {
            break;
        }
        let dt = (at - t).max(0) as u64;
        bytes = bytes.saturating_add(bps.saturating_mul(dt));
        rate = bps;
        t = at;
    }
    let since = (now - t).max(0);
    let live_rate = if since > RATE_HOLDS_SECS { 0 } else { rate };
    let dt = (since.min(RATE_HOLDS_SECS)).max(0) as u64;
    bytes = bytes.saturating_add(live_rate.saturating_mul(dt));
    let cap = nonzero(total, bytes);
    (bytes.min(cap), live_rate)
}

fn nonzero(total: u64, fallback: u64) -> u64 {
    if total == 0 { fallback } else { total }
}

/// One content-log line, without the leading timestamp. `at` is unix seconds.
fn parse_live_line(body: &str, at: i64) -> Option<LiveEvent> {
    let body = body.trim();
    if let Some(rest) = body.strip_prefix("Current download rate:") {
        return mbps_rate(rest.trim().trim_end_matches("Mbps"), at);
    }
    // "Current download rate" is a slow average. The connection line carries
    // the same Mbps figure Steam shows as MB/s, and it updates within seconds:
    // `(rate was 11.592, now 14.395)` → 1.8 MB/s.
    if let Some(now) = body.split("now ").nth(1) {
        if body.contains("rate was ") {
            let num = now.trim().trim_end_matches(')').trim();
            return mbps_rate(num, at);
        }
    }
    let rest = body.strip_prefix("AppID ")?;
    let (app, after) = rest.split_once(' ')?;
    if app.is_empty() || !app.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if after.starts_with("update canceled") || after.starts_with("state changed : None") {
        return Some(LiveEvent::Stop { app: app.to_string(), at });
    }
    let marker = "update started : download ";
    let pos = after.find(marker)?;
    let nums = &after[pos + marker.len()..];
    let (got, total) = split_pair(nums)?;
    Some(LiveEvent::Start { app: app.to_string(), at, got, total })
}

fn mbps_rate(text: &str, at: i64) -> Option<LiveEvent> {
    let mbps: f64 = text.trim().parse().ok()?;
    if mbps < 0.0 {
        return None;
    }
    // Steam logs megabits. 14.395 Mbps is 1.8 MB/s on the download page.
    let bps = (mbps * 1_000_000.0 / 8.0).round() as u64;
    Some(LiveEvent::Rate { at, bps })
}

fn split_pair(text: &str) -> Option<(u64, u64)> {
    let (left, right) = text.split_once('/')?;
    let got = left.trim().parse().ok()?;
    let total_txt = right.split([',', ' ']).next()?.trim();
    let total = total_txt.parse().ok()?;
    Some((got, total))
}

/// Bytes to show for one app. A stop after the last start trusts the manifest.
/// While the transfer is still open, the log's start sample moves at the rate.
fn live_bytes(
    events: &[LiveEvent],
    app: &str,
    acf_got: u64,
    acf_total: u64,
    now: i64,
) -> (u64, u64, u64) {
    let start = events.iter().rev().find_map(|ev| match ev {
        LiveEvent::Start { app: id, at, got, total } if id == app => Some((*at, *got, *total)),
        _ => None,
    });
    let Some((start_at, start_got, start_total)) = start else {
        return (acf_got, acf_total, 0);
    };
    let stopped = events.iter().rev().any(|ev| match ev {
        LiveEvent::Stop { app: id, at } if id == app && *at >= start_at => true,
        _ => false,
    });
    let total = if acf_total > 0 { acf_total } else { start_total };
    if stopped {
        let got = acf_got.max(start_got).min(nonzero(total, acf_got.max(start_got)));
        return (got, total, 0);
    }
    let rates: Vec<(i64, u64)> = events
        .iter()
        .filter_map(|ev| match ev {
            LiveEvent::Rate { at, bps } if *at >= start_at => Some((*at, *bps)),
            _ => None,
        })
        .collect();
    let (projected, rate) = project_download(start_got, total, start_at, &rates, now);
    let got = projected.max(acf_got).min(nonzero(total, projected.max(acf_got)));
    (got, total, rate)
}

fn parse_stamp(line: &str) -> Option<(i64, &str)> {
    let rest = line.strip_prefix('[')?;
    let (date, after) = rest.split_once(' ')?;
    let (time, body) = after.split_once("] ")?;
    let mut d = date.split('-');
    let y: u16 = d.next()?.parse().ok()?;
    let mo: u16 = d.next()?.parse().ok()?;
    let day: u16 = d.next()?.parse().ok()?;
    let mut t = time.split(':');
    let h: u16 = t.next()?.parse().ok()?;
    let mi: u16 = t.next()?.parse().ok()?;
    let s: u16 = t.next()?.parse().ok()?;
    let at = local_civil_to_unix(y, mo, day, h, mi, s)?;
    Some((at, body))
}

fn parse_log(text: &str) -> Vec<LiveEvent> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((at, body)) = parse_stamp(line) else {
            continue;
        };
        if let Some(ev) = parse_live_line(body, at) {
            out.push(ev);
        }
    }
    out
}

fn read_tail(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    if start > 0 {
        if let Some(i) = buf.find('\n') {
            buf.replace_range(..i + 1, "");
        }
    }
    Some(buf)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

struct LogCursor {
    len: u64,
    events: Vec<LiveEvent>,
}

static LOG_CURSOR: std::sync::Mutex<Option<LogCursor>> = std::sync::Mutex::new(None);

/// Reads only the bytes appended since the last pulse. The first read takes
/// the tail; after that a one-second tick is a few lines, not the whole log.
fn events_now(path: &Path) -> Vec<LiveEvent> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    let Ok(mut slot) = LOG_CURSOR.lock() else {
        return Vec::new();
    };
    if let Some(cur) = slot.as_mut() {
        if len < cur.len {
            *slot = None;
        } else if len == cur.len {
            return cur.events.clone();
        } else if file.seek(SeekFrom::Start(cur.len)).is_ok() {
            let mut buf = String::new();
            if file.read_to_string(&mut buf).is_ok() {
                cur.events.extend(parse_log(&buf));
                if cur.events.len() > 500 {
                    let drop_n = cur.events.len() - 500;
                    cur.events.drain(..drop_n);
                }
                cur.len = len;
                return cur.events.clone();
            }
        }
    }
    drop(slot);
    let Some(text) = read_tail(path, LOG_TAIL_BYTES) else {
        return Vec::new();
    };
    let events = parse_log(&text);
    if let Ok(mut slot) = LOG_CURSOR.lock() {
        *slot = Some(LogCursor { len, events: events.clone() });
    }
    events
}

/// Downloading apps, with the byte counter moved forward since Steam's last exact sample.
#[tauri::command]
pub async fn steam_download_live() -> Vec<SteamLiveDownload> {
    // Manifest scan plus the client's content log: off the main thread, since
    // the downloads page polls this while bytes are moving.
    tokio::task::spawn_blocking(|| {
        let Some(steam) = steam_install_path() else {
            return Vec::new();
        };
        let games = installed_games(&steam);
        let events = events_now(&steam.join("logs").join("content_log.txt"));
        let now = now_unix();
        games
            .into_iter()
            .filter(|game| game.downloading)
            .map(|game| {
                let (got, total, rate) = live_bytes(
                    &events,
                    &game.app_id,
                    game.bytes_downloaded,
                    game.bytes_to_download,
                    now,
                );
                SteamLiveDownload {
                    app_id: game.app_id,
                    bytes_downloaded: got,
                    bytes_to_download: total,
                    bytes_per_sec: rate,
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(windows)]
fn local_civil_to_unix(y: u16, mo: u16, d: u16, h: u16, mi: u16, s: u16) -> Option<i64> {
    #[repr(C)]
    struct SysTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn TzSpecificLocalTimeToSystemTime(
            zone: *const core::ffi::c_void,
            local: *const SysTime,
            utc: *mut SysTime,
        ) -> i32;
        fn SystemTimeToFileTime(st: *const SysTime, ft: *mut FileTime) -> i32;
    }
    let local = SysTime {
        year: y,
        month: mo,
        day_of_week: 0,
        day: d,
        hour: h,
        minute: mi,
        second: s,
        milliseconds: 0,
    };
    unsafe {
        let mut utc = SysTime {
            year: 0,
            month: 0,
            day_of_week: 0,
            day: 0,
            hour: 0,
            minute: 0,
            second: 0,
            milliseconds: 0,
        };
        if TzSpecificLocalTimeToSystemTime(core::ptr::null(), &local, &mut utc) == 0 {
            return None;
        }
        let mut ft = FileTime { low: 0, high: 0 };
        if SystemTimeToFileTime(&utc, &mut ft) == 0 {
            return None;
        }
        let ticks = ((ft.high as u64) << 32) | ft.low as u64;
        Some((ticks / 10_000_000) as i64 - 11_644_473_600)
    }
}

#[cfg(not(windows))]
fn local_civil_to_unix(_y: u16, _mo: u16, _d: u16, _h: u16, _mi: u16, _s: u16) -> Option<i64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rate_sample_covers_the_interval_that_just_ended_and_keeps_running() {
        let (bytes, rate) = project_download(100, 10_000, 0, &[(10, 50)], 15);
        // 10s at 50 B/s, then 5s more at the same rate.
        assert_eq!(bytes, 100 + 50 * 15);
        assert_eq!(rate, 50);
    }

    #[test]
    fn a_later_rate_replaces_the_previous_interval() {
        let (bytes, rate) = project_download(0, 10_000, 0, &[(10, 100), (20, 10)], 25);
        // 0..10 at 100, 10..20 at 10, 20..25 at 10.
        assert_eq!(bytes, 100 * 10 + 10 * 10 + 10 * 5);
        assert_eq!(rate, 10);
    }

    #[test]
    fn the_projection_never_passes_the_total() {
        let (bytes, _) = project_download(900, 1_000, 0, &[(1, 500)], 10);
        assert_eq!(bytes, 1_000);
    }

    #[test]
    fn a_stop_after_the_start_trusts_the_manifest() {
        let events = vec![
            LiveEvent::Start { app: "730".into(), at: 10, got: 100, total: 1_000 },
            LiveEvent::Rate { at: 12, bps: 50 },
            LiveEvent::Stop { app: "730".into(), at: 20 },
        ];
        let (got, total, rate) = live_bytes(&events, "730", 400, 1_000, 30);
        assert_eq!(got, 400);
        assert_eq!(total, 1_000);
        assert_eq!(rate, 0);
    }

    #[test]
    fn an_open_transfer_moves_past_a_stale_manifest() {
        let events = vec![
            LiveEvent::Start { app: "730".into(), at: 0, got: 1_000, total: 8_000 },
            LiveEvent::Rate { at: 10, bps: 100 },
        ];
        let (got, total, rate) = live_bytes(&events, "730", 500, 8_000, 10);
        assert_eq!(got, 1_000 + 100 * 10);
        assert_eq!(total, 8_000);
        assert_eq!(rate, 100);
    }

    #[test]
    fn content_log_lines_parse() {
        let started = parse_live_line(
            "AppID 730 update started : download 324855312/761417584, store 0/0, reuse 1/2, delta 0/0, stage 9/10",
            50,
        );
        assert_eq!(
            started,
            Some(LiveEvent::Start { app: "730".into(), at: 50, got: 324_855_312, total: 761_417_584 })
        );
        let rate = parse_live_line("Current download rate: 8.000 Mbps", 60);
        assert_eq!(rate, Some(LiveEvent::Rate { at: 60, bps: 1_000_000 }));
        let fresh = parse_live_line(
            "Increasing target number of download connections to 11 (rate was 11.592, now 14.395)",
            70,
        );
        assert_eq!(fresh, Some(LiveEvent::Rate { at: 70, bps: 1_799_375 }));
        let stop = parse_live_line("AppID 730 update canceled : Disabled (Suspended)", 70);
        assert_eq!(stop, Some(LiveEvent::Stop { app: "730".into(), at: 70 }));
    }
}
