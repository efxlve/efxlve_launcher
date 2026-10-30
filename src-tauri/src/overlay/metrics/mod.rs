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

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSample {
    /// A game process was found for the running title.
    pub running: bool,
    pub pid: Option<u32>,
    pub fps: Option<f64>,
    pub frame_ms: Option<f64>,
    /// Average FPS of the slowest 1% of frames in the current window.
    pub low1_fps: Option<f64>,
    /// Average FPS of the slowest 0.1% of frames in the current window.
    pub low01_fps: Option<f64>,
    /// The ETW FPS session is running (Windows permission granted).
    pub fps_available: bool,
    /// System-wide CPU load, percent.
    pub cpu: f32,
    /// CPU frequency in GHz.
    pub cpu_ghz: Option<f32>,
    /// The game's own CPU load when its process was found.
    pub game_cpu: Option<f32>,
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
    /// The GPU utilization, percent.
    pub gpu: Option<f64>,
    /// The local VRAM usage, MB.
    pub vram_used_mb: Option<u64>,
    /// The total dedicated VRAM, MB.
    pub vram_total_mb: Option<u64>,
}

/// Starts the worker if it is not running. It stops itself a few seconds after
/// both the panel and the HUD are gone.
pub fn ensure_running(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || run(app));
}

/// True while the sampling worker is alive (the task manager shows this).
pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// Asks the worker to stop: it exits on its next tick. The next panel open (or
/// HUD enable) starts it again through `ensure_running`.
pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
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
        if !RUNNING.load(Ordering::SeqCst) {
            break;
        }
        // A ghost HUD keeps its pinned Performance card alive, so it counts as
        // active even though it takes no input.
        let active = STATE
            .lock()
            .map(|s| s.visible || s.ghost || s.hud)
            .unwrap_or(false);
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

        sys.refresh_cpu_all();
        sys.refresh_memory();
        // `global_cpu_usage` is documented as 0-100 but can overshoot on hybrid
        // CPUs; the per-process value counts every logical core (max =
        // cores * 100), so it is divided down to a machine-wide percentage.
        let logical_cpus = sys.cpus().len();
        let cpu = sys.global_cpu_usage().clamp(0.0, 100.0);
        let cpu_ghz = if !sys.cpus().is_empty() {
            let avg_mhz = sys.cpus().iter().map(|c| c.frequency()).sum::<u64>()
                / sys.cpus().len().max(1) as u64;
            if avg_mhz > 0 {
                Some(avg_mhz as f32 / 1000.0)
            } else {
                None
            }
        } else {
            None
        };
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

        let gpu_value = gpu.as_mut().and_then(|query| query.utilization(pid));
        let vram = gpu.as_mut().and_then(|query| query.vram_bytes(pid));
        let vram_total_mb = gpu.as_ref().and_then(|query| query.total_vram_mb());
        // The lows read the frame ring the ETW callback fills; they do not need
        // another trace pass.
        let lows = fps
            .as_ref()
            .map(|counter| counter.lows(&pids))
            .unwrap_or_default();

        let sample = MetricsSample {
            running: pid.is_some(),
            pid,
            fps: fps_value,
            frame_ms,
            low1_fps: lows.low1,
            low01_fps: lows.low01,
            fps_available: etw::available(),
            cpu,
            cpu_ghz,
            game_cpu,
            ram_used_mb: sys.used_memory() / 1_048_576,
            ram_total_mb: sys.total_memory() / 1_048_576,
            gpu: gpu_value,
            vram_used_mb: vram.map(|bytes| bytes / 1_048_576),
            vram_total_mb,
        };
        let _ = app.emit("overlay-metrics", sample.clone());

        let hud_on = STATE.lock().map(|s| s.hud).unwrap_or(false);
        if hud_on && sample.running {
            hud::update(&hud_text(&sample));
        } else if !hud_on {
            hud::hide();
        }

        std::thread::sleep(Duration::from_millis(1000));
    }

    RUNNING.store(false, Ordering::SeqCst);
    hud::hide();
}

/// One compact HUD line: `124 FPS · 8.1 ms · 1% 112 · 0.1% 98 | CPU 23% | ...`.
fn hud_text(s: &MetricsSample) -> String {
    let mut parts = Vec::new();
    if let Some(line) = fps_line(s) {
        parts.push(line);
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

/// The FPS cluster: current rate, frame time, then the frame-time lows once the
/// ring has enough samples for each.
fn fps_line(s: &MetricsSample) -> Option<String> {
    let fps = s.fps?;
    let mut line = format!("{fps:.0} FPS");
    if let Some(ms) = s.frame_ms {
        line.push_str(&format!(" · {ms:.1} ms"));
    }
    if let Some(low1) = s.low1_fps {
        line.push_str(&format!(" · 1% {low1:.0}"));
    }
    if let Some(low01) = s.low01_fps {
        line.push_str(&format!(" · 0.1% {low01:.0}"));
    }
    Some(line)
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
    use super::{fps_line, hud_text, normalize_process_cpu, MetricsSample};

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

    #[test]
    fn the_fps_cluster_grows_with_the_lows() {
        let mut sample = MetricsSample::default();
        sample.fps = Some(144.0);
        sample.frame_ms = Some(6.94);
        sample.low1_fps = Some(112.0);
        sample.low01_fps = Some(98.0);
        assert_eq!(
            fps_line(&sample).as_deref(),
            Some("144 FPS · 6.9 ms · 1% 112 · 0.1% 98")
        );
    }

    #[test]
    fn missing_lows_leave_the_fps_cluster_short() {
        let mut sample = MetricsSample::default();
        sample.fps = Some(60.0);
        sample.frame_ms = Some(16.7);
        assert_eq!(fps_line(&sample).as_deref(), Some("60 FPS · 16.7 ms"));
        assert!(hud_text(&sample).starts_with("60 FPS · 16.7 ms  |  CPU 0%"));
    }
}
