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

        /// The game's summed 3D-engine utilization in percent. Copy/compute
        /// engines stay out so the number stays close to Task Manager's.
        pub fn utilization(&mut self, pid: u32) -> Option<f64> {
            if !self.collect() {
                return None;
            }
            let items = read_array(self.util)?;
            let prefix = format!("pid_{pid}_");
            let mut total = 0.0;
            let mut found = false;
            for (name, value) in &items {
                if !name.starts_with(&prefix) {
                    continue;
                }
                if name.contains("engtype_3D") {
                    total += value;
                    found = true;
                }
            }
            if found {
                Some(total.min(100.0))
            } else {
                None
            }
        }

        /// The game's local VRAM usage in bytes.
        pub fn vram_bytes(&mut self, pid: u32) -> Option<u64> {
            if !self.collect() {
                return None;
            }
            let items = read_array(self.vram)?;
            let prefix = format!("pid_{pid}_");
            for (name, value) in &items {
                if name.starts_with(&prefix) {
                    return Some(*value as u64);
                }
            }
            None
        }
    }

    /// Reads every instance of a counter as `(name, double value)`.
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
            let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>() as u32;
            size = size.max(item_size);
            let mut buffer: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = (0..count.max(1))
                .map(|_| std::mem::zeroed())
                .collect();
            status = PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(buffer.as_mut_ptr()),
            );
            if status != 0 {
                return None;
            }
            let mut rows = Vec::with_capacity(count as usize);
            for item in buffer.iter().take(count as usize) {
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
    pub fn utilization(&mut self, _pid: u32) -> Option<f64> {
        None
    }
    pub fn vram_bytes(&mut self, _pid: u32) -> Option<u64> {
        None
    }
}
