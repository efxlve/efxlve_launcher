//! UTC timestamps for logs and reports.
//!
//! `perf.log` lines, the feedback report and EA's login signature all need the
//! same calendar fields, so the date math lives here once instead of in every
//! writer. UTC is deliberate: a log from another timezone must still line up
//! with the rest of the report.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Year, month, day, hour, minute, second and millisecond in UTC.
fn fields(now: SystemTime) -> (i64, u32, u32, u32, u32, u32, u32) {
    let elapsed = now.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    let secs = elapsed.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let day_secs = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    (
        year,
        month,
        day,
        (day_secs / 3600) as u32,
        ((day_secs % 3600) / 60) as u32,
        (day_secs % 60) as u32,
        elapsed.subsec_millis(),
    )
}

/// `YYYY-MM-DD HH:MM:SS`, the timestamp a log header carries.
pub fn stamp(now: SystemTime) -> String {
    let (year, month, day, hour, minute, second, _) = fields(now);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
}

/// `YYYY-MM-DD HH:MM:SS:mmm`, the timestamp format EA expects.
pub fn stamp_millis(now: SystemTime) -> String {
    let (year, month, day, hour, minute, second, millis) = fields(now);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}:{millis:03}")
}

/// Howard Hinnant's civil-from-days, so the date math needs no extra crate.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::{stamp, stamp_millis};

    #[test]
    fn the_epoch_is_a_valid_stamp() {
        assert_eq!(stamp(std::time::UNIX_EPOCH), "1970-01-01 00:00:00");
    }

    #[test]
    fn leap_years_keep_their_extra_day() {
        let unix = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_709_164_800);
        assert_eq!(stamp(unix), "2024-02-29 00:00:00");
    }

    #[test]
    fn millis_are_padded_to_three_digits() {
        let unix = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_767_225_600_123);
        assert_eq!(stamp_millis(unix), "2026-01-01 00:00:00:123");
        let unix = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_767_225_600_007);
        assert_eq!(stamp_millis(unix), "2026-01-01 00:00:00:007");
    }
}
