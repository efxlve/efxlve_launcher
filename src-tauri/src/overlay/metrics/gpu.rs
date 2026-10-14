//! Per-game GPU utilization and VRAM from the Windows GPU performance counters.
//!
//! `\GPU Engine(*)\Utilization Percentage` and `\GPU Process Memory(*)\Local Usage`
//! are vendor-agnostic PDH counters; instances carry `pid_<id>_...`. Reading
//! them needs no driver SDK and no elevation.

#[cfg(windows)]
mod imp {
    use windows::core::w;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
        PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
        PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
    };

    pub struct GpuQuery {
        query: PDH_HQUERY,
        util: PDH_HCOUNTER,
        vram: PDH_HCOUNTER,
    }

    impl GpuQuery {
        pub fn open() -> Option<GpuQuery> {
            unsafe {
                let mut query = PDH_HQUERY::default();
                if PdhOpenQueryW(None, 0, &mut query) != 0 {
                    return None;
                }
                let mut util = PDH_HCOUNTER::default();
                if PdhAddEnglishCounterW(
                    query,
                    w!("\\GPU Engine(*)\\Utilization Percentage"),
                    0,
                    &mut util,
                ) != 0
                {
                    let _ = PdhCloseQuery(query);
                    return None;
                }
                let mut vram = PDH_HCOUNTER::default();
                if PdhAddEnglishCounterW(
                    query,
                    w!("\\GPU Process Memory(*)\\Local Usage"),
                    0,
                    &mut vram,
                ) != 0
                {
                    let _ = PdhCloseQuery(query);
                    return None;
                }
                Some(GpuQuery { query, util, vram })
            }
        }

        fn collect(&self) -> bool {
            unsafe { PdhCollectQueryData(self.query) == 0 }
        }

        /// Summed 3D-engine utilization in percent. If a PID is given, filters to
        /// that game's processes; otherwise sums 3D utilization across the system.
        pub fn utilization(&mut self, pid: Option<u32>) -> Option<f64> {
            if !self.collect() {
                return None;
            }
            let items = read_array(self.util)?;
            let prefix = pid.map(|id| format!("pid_{id}_"));
            let mut total = 0.0;
            let mut found = false;
            for (name, value) in &items {
                if let Some(ref p) = prefix {
                    if !name.starts_with(p) {
                        continue;
                    }
                }
                if name.to_ascii_lowercase().contains("engtype_3d") && value.is_finite() {
                    total += value;
                    found = true;
                }
            }
            if found {
                Some(total.min(100.0))
            } else if pid.is_none() {
                Some(0.0)
            } else {
                None
            }
        }

        /// Local VRAM usage in bytes. If a PID is given, returns that game's
        /// usage on its render adapter; otherwise sums local VRAM in use across
        /// all active processes.
        pub fn vram_bytes(&mut self, pid: Option<u32>) -> Option<u64> {
            if !self.collect() {
                return None;
            }
            let items = read_array(self.vram)?;
            if let Some(id) = pid {
                let prefix = format!("pid_{id}_");
                let mut best: Option<u64> = None;
                for (name, value) in &items {
                    if name.starts_with(&prefix) && value.is_finite() && *value > 0.0 {
                        let bytes = *value as u64;
                        best = Some(best.map_or(bytes, |current| current.max(bytes)));
                    }
                }
                best
            } else {
                let mut total_bytes = 0u64;
                for (_name, value) in &items {
                    if value.is_finite() && *value > 0.0 {
                        total_bytes += *value as u64;
                    }
                }
                Some(total_bytes)
            }
        }

        /// Total dedicated video memory in MB.
        pub fn total_vram_mb(&self) -> Option<u64> {
            detect_total_vram_mb()
        }
    }

    /// Detects the system's primary dedicated GPU VRAM size in MB via the display adapter registry.
    fn detect_total_vram_mb() -> Option<u64> {
        use std::sync::OnceLock;
        use windows::core::PCWSTR;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        };

        static CACHED: OnceLock<Option<u64>> = OnceLock::new();
        *CACHED.get_or_init(|| {
            let mut max_bytes = 0u64;
            for i in 0..8 {
                let subkey = format!(
                    "SYSTEM\\CurrentControlSet\\Control\\Class\\{{4d36e968-e325-11ce-bfc1-08002be10318}}\\{:04}\0",
                    i
                );
                let wide: Vec<u16> = subkey.encode_utf16().collect();
                let mut hkey = HKEY::default();
                unsafe {
                    if RegOpenKeyExW(
                        HKEY_LOCAL_MACHINE,
                        PCWSTR(wide.as_ptr()),
                        Some(0),
                        KEY_READ,
                        &mut hkey,
                    )
                    .is_ok()
                    {
                        let val_name: Vec<u16> =
                            "HardwareInformation.qwMemorySize\0".encode_utf16().collect();
                        let mut qword_val = 0u64;
                        let mut size = std::mem::size_of::<u64>() as u32;
                        if RegQueryValueExW(
                            hkey,
                            PCWSTR(val_name.as_ptr()),
                            None,
                            None,
                            Some(&mut qword_val as *mut _ as *mut u8),
                            Some(&mut size),
                        )
                        .is_ok()
                            && qword_val > max_bytes
                        {
                            max_bytes = qword_val;
                        }

                        if max_bytes == 0 {
                            let dword_name: Vec<u16> =
                                "HardwareInformation.MemorySize\0".encode_utf16().collect();
                            let mut dword_val = 0u32;
                            let mut dword_size = std::mem::size_of::<u32>() as u32;
                            if RegQueryValueExW(
                                hkey,
                                PCWSTR(dword_name.as_ptr()),
                                None,
                                None,
                                Some(&mut dword_val as *mut _ as *mut u8),
                                Some(&mut dword_size),
                            )
                            .is_ok()
                                && (dword_val as u64) > max_bytes
                            {
                                max_bytes = dword_val as u64;
                            }
                        }

                        let _ = RegCloseKey(hkey);
                    }
                }
            }

            if max_bytes > 0 {
                Some(max_bytes / 1_048_576)
            } else {
                None
            }
        })
    }

    /// Reads every instance of a counter as `(name, double value)`.
    ///
    /// The array API returns one buffer that holds both the item array and the
    /// instance name strings the items point into, so the buffer must be
    /// allocated with the size PDH reports — not with `count * item_size` —
    /// or PDH writes past the allocation.
    fn read_array(counter: PDH_HCOUNTER) -> Option<Vec<(String, f64)>> {
        unsafe {
            let mut size = 0u32;
            let mut count = 0u32;
            let mut status = PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                None,
            );
            // The first call only asks for the buffer size.
            if status != PDH_MORE_DATA {
                return None;
            }
            let mut buffer: Vec<u8> = vec![0u8; size as usize];
            status = PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W),
            );
            if status != 0 {
                return None;
            }
            let mut rows = Vec::with_capacity(count as usize);
            let items = buffer.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W;
            for index in 0..count as usize {
                let item = &*items.add(index);
                let name = item.szName.to_string().unwrap_or_default();
                let value = item.FmtValue.Anonymous.doubleValue;
                rows.push((name, value));
            }
            Some(rows)
        }
    }
}

#[cfg(windows)]
pub use imp::GpuQuery;

#[cfg(not(windows))]
pub struct GpuQuery;

#[cfg(not(windows))]
impl GpuQuery {
    pub fn open() -> Option<GpuQuery> {
        None
    }
    pub fn utilization(&mut self, _pid: Option<u32>) -> Option<f64> {
        None
    }
    pub fn vram_bytes(&mut self, _pid: Option<u32>) -> Option<u64> {
        None
    }
    pub fn total_vram_mb(&self) -> Option<u64> {
        None
    }
}
