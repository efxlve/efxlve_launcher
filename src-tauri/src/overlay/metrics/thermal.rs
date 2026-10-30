//! Hardware temperatures and GPU board power for the performance HUD.
//!
//! CPU temperature comes from the vendor-agnostic PDH thermal-zone counter
//! (`\Thermal Zone Information(*)\Temperature`, Kelvin). GPU temperature and
//! board power come from NVML when the NVIDIA driver exposes `nvml.dll`; no
//! SDK is linked and no elevation is needed. A machine without either source
//! simply reports `None`, so the HUD keeps its existing layout.

/// One thermal sample. Every field is optional because the sources are.
#[derive(Default, Clone, Copy)]
pub struct ThermalSample {
    pub cpu_temp_c: Option<f64>,
    pub gpu_temp_c: Option<f64>,
    pub gpu_power_w: Option<f64>,
}

#[cfg(windows)]
pub use imp::ThermalQuery;

#[cfg(not(windows))]
pub struct ThermalQuery;

#[cfg(not(windows))]
impl ThermalQuery {
    pub fn open() -> Option<ThermalQuery> {
        None
    }
    pub fn sample(&mut self) -> ThermalSample {
        ThermalSample::default()
    }
}

/// PDH reports Kelvin; a few drivers report tenths of Kelvin or Celsius.
/// Values outside a plausible die temperature are ignored.
fn temperature_celsius(raw: f64) -> Option<f64> {
    let celsius = if (200.0..400.0).contains(&raw) {
        raw - 273.15
    } else if (2000.0..4000.0).contains(&raw) {
        raw / 10.0 - 273.15
    } else if (1.0..150.0).contains(&raw) {
        raw
    } else {
        return None;
    };
    (celsius > 0.0 && celsius < 125.0).then_some(celsius)
}

#[cfg(windows)]
mod imp {
    use super::{temperature_celsius, ThermalSample};
    use windows::core::w;
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
        PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
        PDH_MORE_DATA,
    };

    pub struct ThermalQuery {
        zone: Option<(PDH_HQUERY, PDH_HCOUNTER)>,
        nvml: Option<Nvml>,
    }

    impl ThermalQuery {
        pub fn open() -> Option<ThermalQuery> {
            let zone = open_zone();
            let nvml = Nvml::load();
            if zone.is_none() && nvml.is_none() {
                None
            } else {
                Some(ThermalQuery { zone, nvml })
            }
        }

        pub fn sample(&mut self) -> ThermalSample {
            let cpu_temp_c = self.zone.as_ref().and_then(read_zone);
            let (gpu_temp_c, gpu_power_w) = self
                .nvml
                .as_ref()
                .map(Nvml::sample)
                .unwrap_or((None, None));
            ThermalSample {
                cpu_temp_c,
                gpu_temp_c,
                gpu_power_w,
            }
        }
    }

    fn open_zone() -> Option<(PDH_HQUERY, PDH_HCOUNTER)> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(None, 0, &mut query) != 0 {
                return None;
            }
            let mut counter = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(
                query,
                w!("\\Thermal Zone Information(*)\\Temperature"),
                0,
                &mut counter,
            ) != 0
            {
                let _ = PdhCloseQuery(query);
                return None;
            }
            Some((query, counter))
        }
    }

    fn read_zone(zone: &(PDH_HQUERY, PDH_HCOUNTER)) -> Option<f64> {
        unsafe {
            if PdhCollectQueryData(zone.0) != 0 {
                return None;
            }
        }
        let items = read_array(zone.1)?;
        items
            .iter()
            .filter_map(|(_, value)| temperature_celsius(*value))
            .fold(None, |best: Option<f64>, value| {
                Some(best.map_or(value, |current| current.max(value)))
            })
    }

    /// Reads every instance of a counter as `(name, double value)`. PDH packs
    /// the item array and the instance strings into one buffer, so the buffer
    /// must use the size PDH reports.
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
                rows.push((
                    item.szName.to_string().unwrap_or_default(),
                    item.FmtValue.Anonymous.doubleValue,
                ));
            }
            Some(rows)
        }
    }

    type NvmlInit = unsafe extern "C" fn() -> i32;
    type NvmlShutdown = unsafe extern "C" fn() -> i32;
    type NvmlDeviceGetCount = unsafe extern "C" fn(*mut u32) -> i32;
    type NvmlDeviceGetHandle = unsafe extern "C" fn(u32, *mut isize) -> i32;
    type NvmlDeviceGetTemperature = unsafe extern "C" fn(isize, u32, *mut u32) -> i32;
    type NvmlDeviceGetPowerUsage = unsafe extern "C" fn(isize, *mut u32) -> i32;

    struct Nvml {
        handle: isize,
        get_temperature: NvmlDeviceGetTemperature,
        get_power: NvmlDeviceGetPowerUsage,
        shutdown: NvmlShutdown,
    }

    impl Nvml {
        fn load() -> Option<Nvml> {
            unsafe {
                #[link(name = "kernel32")]
                extern "system" {
                    fn LoadLibraryA(name: *const u8) -> isize;
                    fn GetProcAddress(module: isize, proc_name: *const u8) -> usize;
                }

                let module = LoadLibraryA(b"nvml.dll\0".as_ptr());
                if module == 0 {
                    return None;
                }
                let symbol = |name: &[u8]| -> usize { GetProcAddress(module, name.as_ptr()) };
                let init_ptr = symbol(b"nvmlInit_v2\0");
                let shutdown_ptr = symbol(b"nvmlShutdown\0");
                let count_ptr = symbol(b"nvmlDeviceGetCount_v2\0");
                let handle_ptr = symbol(b"nvmlDeviceGetHandleByIndex_v2\0");
                let temperature_ptr = symbol(b"nvmlDeviceGetTemperature\0");
                let power_ptr = symbol(b"nvmlDeviceGetPowerUsage\0");
                if init_ptr == 0
                    || shutdown_ptr == 0
                    || count_ptr == 0
                    || handle_ptr == 0
                    || temperature_ptr == 0
                    || power_ptr == 0
                {
                    return None;
                }
                let init: NvmlInit = std::mem::transmute(init_ptr);
                let shutdown: NvmlShutdown = std::mem::transmute(shutdown_ptr);
                let count: NvmlDeviceGetCount = std::mem::transmute(count_ptr);
                let get_handle: NvmlDeviceGetHandle = std::mem::transmute(handle_ptr);
                let get_temperature: NvmlDeviceGetTemperature =
                    std::mem::transmute(temperature_ptr);
                let get_power: NvmlDeviceGetPowerUsage = std::mem::transmute(power_ptr);
                if init() != 0 {
                    return None;
                }
                let mut devices = 0u32;
                if count(&mut devices) != 0 || devices == 0 {
                    let _ = shutdown();
                    return None;
                }
                let mut handle = 0isize;
                if get_handle(0, &mut handle) != 0 || handle == 0 {
                    let _ = shutdown();
                    return None;
                }
                Some(Nvml {
                    handle,
                    get_temperature,
                    get_power,
                    shutdown,
                })
            }
        }

        fn sample(&self) -> (Option<f64>, Option<f64>) {
            unsafe {
                let mut temperature = 0u32;
                let temp = if (self.get_temperature)(self.handle, 0, &mut temperature) == 0 {
                    Some(temperature as f64)
                } else {
                    None
                };
                let mut milliwatts = 0u32;
                let power = if (self.get_power)(self.handle, &mut milliwatts) == 0 {
                    Some(milliwatts as f64 / 1000.0)
                } else {
                    None
                };
                (temp, power)
            }
        }
    }

    impl Drop for Nvml {
        fn drop(&mut self) {
            unsafe {
                let _ = (self.shutdown)();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::temperature_celsius;

    #[test]
    fn thermal_zones_convert_from_kelvin() {
        let close = |value: Option<f64>, expected: f64| {
            assert!((value.unwrap() - expected).abs() < 0.001);
        };
        close(temperature_celsius(333.15), 60.0);
        close(temperature_celsius(3331.5), 60.0);
        close(temperature_celsius(60.0), 60.0);
        assert_eq!(temperature_celsius(0.0), None);
        assert_eq!(temperature_celsius(500.0), None);
    }
}
