//! Legendary progress lines.
//!
//! Progress is on stderr and uses `\r` as well as `\n`. This file only parses
//! text. It does not spawn a process.

use tokio::io::{AsyncRead, AsyncReadExt};

/// Extracts seconds and the raw string from a "00:01:22" or "01:22" line.
pub fn parse_eta(line: &str) -> Option<(String, u64)> {
    let idx = line.find("ETA:")? + "ETA:".len();
    let rest = line[idx..].trim_start();
    let raw_eta: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ':')
        .collect();
    if raw_eta.is_empty() || !raw_eta.contains(':') {
        return None;
    }
    let parts: Vec<&str> = raw_eta.split(':').collect();
    let secs = match parts.len() {
        2 => {
            let m: u64 = parts[0].parse().ok()?;
            let s: u64 = parts[1].parse().ok()?;
            m * 60 + s
        }
        3 => {
            let h: u64 = parts[0].parse().ok()?;
            let m: u64 = parts[1].parse().ok()?;
            let s: u64 = parts[2].parse().ok()?;
            h * 3600 + m * 60 + s
        }
        _ => return None,
    };
    Some((raw_eta, secs))
}

/// Extracts a rate from lines such as `Download: 15.40 MiB/s` or `Download\t15.40 MiB/s`.
/// A cumulative size (`Written: 72.5 MiB`) is not a rate: the unit must contain `/s`.
pub fn parse_speed(line: &str, keys: &[&str]) -> Option<(String, u64)> {
    for key in keys {
        if let Some(idx) = line.find(key) {
            let rest = line[idx + key.len()..]
                .trim_start()
                .trim_start_matches([':', '\t'])
                .trim_start();
            let Some(num_end) = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ','))
            else {
                continue;
            };
            if num_end == 0 {
                continue;
            }
            let Ok(num) = rest[..num_end].replace(',', ".").parse::<f64>() else {
                continue;
            };
            let after = rest[num_end..].trim_start();
            let unit: String = after
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '/')
                .collect();
            let unit_lower = unit.to_lowercase();
            // Sizes (`MiB`, `MB`) share a prefix with rates. Only `/s` is a speed.
            if !unit_lower.contains("/s") {
                continue;
            }
            let bytes_per_sec = if unit_lower.starts_with("gib") || unit_lower.starts_with("gb") {
                (num * 1024.0 * 1024.0 * 1024.0) as u64
            } else if unit_lower.starts_with("mib") || unit_lower.starts_with("mb") {
                (num * 1024.0 * 1024.0) as u64
            } else if unit_lower.starts_with("kib") || unit_lower.starts_with("kb") {
                (num * 1024.0) as u64
            } else {
                num as u64
            };
            let speed_str = format!("{num:.1} {unit}");
            return Some((speed_str, bytes_per_sec));
        }
    }
    None
}

/// Bytes/sec from two cumulative MiB samples. `None` until the window is long enough.
pub(super) fn format_rate(bytes_per_sec: u64) -> String {
    let mb = bytes_per_sec as f64 / (1024.0 * 1024.0);
    if mb >= 0.1 {
        format!("{mb:.1} MiB/s")
    } else {
        let kb = bytes_per_sec as f64 / 1024.0;
        format!("{kb:.1} KiB/s")
    }
}

pub(super) fn bytes_per_sec_from_mib(
    prev: &mut Option<(f64, std::time::Instant)>,
    mib: f64,
) -> Option<u64> {
    let now = std::time::Instant::now();
    let out = if let Some((prev_mib, at)) = *prev {
        let dt = now.saturating_duration_since(at).as_secs_f64();
        if dt >= 0.4 {
            Some(((mib - prev_mib).max(0.0) * 1024.0 * 1024.0 / dt) as u64)
        } else {
            None
        }
    } else {
        None
    };
    if out.is_some() || prev.is_none() {
        *prev = Some((mib, now));
    }
    out
}

/// MiB value from `Downloaded: 123.45 MiB` / `Download size: 123.45 MiB` lines.
pub(super) fn parse_mib_after(line: &str, key: &str) -> Option<f64> {
    let rest = line.find(key).map(|i| &line[i + key.len()..])?.trim_start();
    let num_end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ','))?;
    if num_end == 0 {
        return None;
    }
    let num: f64 = rest[..num_end].replace(',', ".").parse().ok()?;
    let after = rest[num_end..].trim_start();
    Some(if after.starts_with("GiB") {
        num * 1024.0
    } else {
        num
    })
}

/// Legendary overwrites download progress on a single line with `\r` (carriage return).
/// The standard `BufReader::lines()` only waits for `\n`, so speed/ETA data
/// does not reach the UI in time. This reader treats both `\n` and `\r`
/// boundaries as line ends, keeping the live speed stream uninterrupted.
pub(super) struct CrlfLines<R> {
    reader: R,
    buf: Vec<u8>,
    pending: Vec<u8>,
}

impl<R: AsyncRead + Unpin> CrlfLines<R> {
    pub(super) fn new(reader: R) -> Self {
        Self {
            reader,
            buf: vec![0u8; 4096],
            pending: Vec::new(),
        }
    }

    pub(super) async fn next_line(&mut self) -> Option<String> {
        loop {
            if let Some(pos) = self.pending.iter().position(|&b| b == b'\n' || b == b'\r') {
                let line: Vec<u8> = self.pending.drain(..=pos).collect();
                let s = String::from_utf8_lossy(&line[..line.len().saturating_sub(1)])
                    .trim()
                    .to_string();
                if s.is_empty() {
                    continue;
                }
                return Some(s);
            }
            match self.reader.read(&mut self.buf).await {
                Ok(0) => {
                    let s = String::from_utf8_lossy(&self.pending).trim().to_string();
                    self.pending.clear();
                    return if s.is_empty() { None } else { Some(s) };
                }
                Ok(n) => self.pending.extend_from_slice(&self.buf[..n]),
                Err(_) => return None,
            }
        }
    }
}

/// Percentage from the `= Progress: 50.46% (1156/2291)` line.
/// Legendary's own figure is the most accurate; the MiB-based one is a fallback.
pub(super) fn parse_progress_percent(line: &str) -> Option<i32> {
    let idx = line.find("Progress:")? + "Progress:".len();
    let rest = line[idx..].trim_start();
    let num_end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    if num_end == 0 {
        return None;
    }
    let v: f64 = rest[..num_end].parse().ok()?;
    Some((v.round() as i32).clamp(0, 100))
}

pub(super) fn short_error(err_text: &str) -> String {
    let low = err_text.to_lowercase();
    if low.contains("429") || low.contains("too many requests") {
        return "@t:dl.rateLimited".to_string();
    }
    if low.contains("no space left")
        || low.contains("disk full")
        || low.contains("not enough space")
        || low.contains("spaceerror")
    {
        return "@t:dl.diskFull".to_string();
    }
    if low.contains("no game information available")
        || (low.contains("fetching metadata") && low.contains("failed"))
    {
        return "@t:dl.itemNotFound".to_string();
    }
    if low.contains("connectionerror")
        || low.contains("getaddrinfo failed")
        || low.contains("connection refused")
        || low.contains("max retries exceeded")
    {
        return "@t:dl.networkError".to_string();
    }
    if low.contains("timeout") || low.contains("timed out") || low.contains("readtimeouterror") {
        return "@t:dl.timeoutError".to_string();
    }
    if low.contains("permissionerror") || low.contains("access is denied") {
        return "@t:dl.permissionDenied".to_string();
    }
    if low.contains("no saved credentials")
        || low.contains("token expired")
        || low.contains("401 client error")
    {
        return "@t:dl.sessionExpired".to_string();
    }

    let lines: Vec<&str> = err_text.lines().collect();
    let mut picked: Vec<&str> = lines
        .iter()
        .filter(|l| {
            let l_trim = l.trim();
            if l_trim.starts_with("[PYI-")
                || l_trim.starts_with("Traceback")
                || l_trim.starts_with("File \"")
                || l_trim.starts_with("[Core] WARNING:")
                || l_trim.starts_with("The above exception")
                || l_trim.starts_with("During handling of")
                || l_trim.starts_with("urllib3.")
                || l_trim.starts_with("requests.exceptions.")
            {
                return false;
            }
            let l_low = l_trim.to_lowercase();
            l_low.contains("error") || l_low.contains("exception") || l_low.contains("failed")
        })
        .take(2)
        .copied()
        .collect();

    if picked.is_empty() {
        picked = lines
            .iter()
            .filter(|l| {
                let l_trim = l.trim();
                !l_trim.starts_with("[PYI-")
                    && !l_trim.starts_with("Traceback")
                    && !l_trim.starts_with("File \"")
                    && !l_trim.starts_with("[Core] WARNING:")
                    && !l_trim.starts_with("The above exception")
                    && !l_trim.starts_with("During handling of")
                    && !l_trim.starts_with("urllib3.")
                    && !l_trim.starts_with("requests.exceptions.")
                    && !l_trim.is_empty()
            })
            .rev()
            .take(2)
            .copied()
            .collect();
        picked.reverse();
    }

    let out: String = picked.join(" — ").chars().take(200).collect();
    if out.trim().is_empty() {
        "@t:common.unknownError".to_string()
    } else {
        out
    }
}
