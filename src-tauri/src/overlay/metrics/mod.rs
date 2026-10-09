//! Overlay metrics worker: one sample per second, zero cost when idle.
//!
//! Sources: `sysinfo` for CPU/RAM, the Windows GPU performance counters for
//! per-game GPU utilization and VRAM, and an ETW present-event counter for FPS
//! (the PresentMon method — no hooks). Every sample is emitted as
//! `overlay-metrics` and painted into the native HUD when it is enabled.

mod etw;
mod gpu;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use sysinfo::{Pid, ProcessesToUpdate, System};

use super::{hud, STATE};

static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSample {
    /// A game process was found for the running title.
    pub running: bool,
    pub pid: Option<u32>,
    pub fps: Option<f64>,
    pub frame_ms: Option<f64>,
    /// The ETW FPS session is running (Windows permission granted).
    pub fps_available: bool,
    /// System-wide CPU load, percent.
    pub cpu: f32,
    /// The game's own CPU load when its process was found.
    pub game_cpu: Option<f32>,
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
    /// The game's GPU utilization, percent.
    pub gpu: Option<f64>,
    /// The game's local VRAM usage, MB.
    pub vram_used_mb: Option<u64>,
}

/// Starts the worker if it is not running. It stops itself a few seconds after
/// both the panel and the HUD are gone.
pub fn ensure_running(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || run(app));
}

/// True while the ETW FPS session is running (Windows permission granted).
pub fn fps_available() -> bool {
    etw::available()
}

fn run(app: AppHandle) {
    let mut sys = System::new();
    let mut gpu = gpu::GpuQuery::open();
    let mut fps = etw::FpsCounter::start();
    let mut idle = 0u32;

    loop {
        let active = STATE.lock().map(|s| s.visible || s.hud).unwrap_or(false);
        if active {
            idle = 0;
        } else {
            idle += 1;
            if idle > 2 {
                break;
            }
        }

        let pids = crate::legendary::screenshots::active_game_pids();
        let pid = pids.first().copied();

        sys.refresh_cpu_usage();
        sys.refresh_memory();
        // `global_cpu_usage` is documented as 0-100 but can overshoot on hybrid
        // CPUs; the per-process value counts every logical core (max =
        // cores * 100), so it is divided down to a machine-wide percentage.
        let logical_cpus = sys.cpus().len();
        let cpu = sys.global_cpu_usage().clamp(0.0, 100.0);
        let game_cpu = pid.and_then(|id| {
            let wanted = Pid::from_u32(id);
            sys.refresh_processes(ProcessesToUpdate::Some(&[wanted]), true);
            sys.process(wanted)
                .map(|process| normalize_process_cpu(process.cpu_usage(), logical_cpus))
        });

        // Presents per second, summed over the game's processes. Some titles
        // present from a child process rather than the main one.
        let (fps_value, frame_ms) = match fps.as_mut() {
            Some(counter) => match counter.sample_many(&pids) {
                Some(value) if value > 0.01 => {
                    (Some(value), Some(1000.0 / value.max(0.1)))
                }
                Some(value) => (Some(value), None),
                None => (None, None),
            },
            None => (None, None),
        };

        let gpu_value = pid.and_then(|id| gpu.as_mut().and_then(|query| query.utilization(id)));
        let vram = pid.and_then(|id| gpu.as_mut().and_then(|query| query.vram_bytes(id)));

        let sample = MetricsSample {
            running: pid.is_some(),
            pid,
            fps: fps_value,
            frame_ms,
            fps_available: etw::available(),
            cpu,
            game_cpu,
            ram_used_mb: sys.used_memory() / 1_048_576,
            ram_total_mb: sys.total_memory() / 1_048_576,
            gpu: gpu_value,
            vram_used_mb: vram.map(|bytes| bytes / 1_048_576),
        };
        let _ = app.emit("overlay-metrics", sample.clone());

        let hud_on = STATE.lock().map(|s| s.hud).unwrap_or(false);
        if hud::hint_active() {
            // A game-start hint owns the plate for a few seconds.
        } else if hud_on && sample.running {
            hud::update(&hud_text(&sample));
        } else if !hud_on {
            hud::hide();
        }

        std::thread::sleep(Duration::from_millis(1000));
    }

    RUNNING.store(false, Ordering::SeqCst);
    hud::hide();
}

/// One compact HUD line: `124 FPS · 8.1 ms | CPU 23% | GPU 67% | VRAM 5.2 GB | RAM 12.4/31.8 GB`.
fn hud_text(s: &MetricsSample) -> String {
    let mut parts = Vec::new();
    if let Some(fps) = s.fps {
        let ms = s.frame_ms.unwrap_or(0.0);
        parts.push(format!("{fps:.0} FPS · {ms:.1} ms"));
    }
    let cpu = s.game_cpu.unwrap_or(s.cpu);
    parts.push(format!("CPU {cpu:.0}%"));
    if let Some(gpu) = s.gpu {
        parts.push(format!("GPU {gpu:.0}%"));
    }
    if let Some(vram) = s.vram_used_mb {
        parts.push(format!("VRAM {}", mb_label(vram)));
    }
    parts.push(format!(
        "RAM {}/{}",
        mb_label(s.ram_used_mb),
        mb_label(s.ram_total_mb)
    ));
    parts.join("  |  ")
}

/// `sysinfo` reports a process value that can reach `logical_cpus * 100`
/// (one full core is 100). The overlay shows machine-wide percentages like
/// Task Manager, so the raw value is divided by the core count and clamped.
fn normalize_process_cpu(raw: f32, logical_cpus: usize) -> f32 {
    let cores = logical_cpus.max(1) as f32;
    (raw / cores).clamp(0.0, 100.0)
}

fn mb_label(mb: u64) -> String {
    if mb >= 1024 {
        format!("{:.1} GB", mb as f64 / 1024.0)
    } else {
        format!("{mb} MB")
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_process_cpu;

    #[test]
    fn process_cpu_is_normalized_to_machine_wide() {
        // A fully busy 16-thread process is 100%, not 1600%.
        assert_eq!(normalize_process_cpu(1600.0, 16), 100.0);
        assert_eq!(normalize_process_cpu(800.0, 16), 50.0);
        // A single-core machine needs no division.
        assert_eq!(normalize_process_cpu(50.0, 1), 50.0);
        // Nonsense readings never leak through as negative or above 100.
        assert_eq!(normalize_process_cpu(-4.0, 8), 0.0);
        assert_eq!(normalize_process_cpu(1e6, 4), 100.0);
    }
}
