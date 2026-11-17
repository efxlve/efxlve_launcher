//! Linux (`xorriso`) and macOS (`drutil`) optical paths. The Windows engine in
//! `disc.rs` uses IMAPI2; these two tools are invoked as child processes and
//! their output is parsed here. Real media is still an open field test, so the
//! unit tests use a mocked tool runner instead of a drive.
#![allow(dead_code)]

use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use super::super::format::{read_manifest, MediaManifest, MANIFEST_FILE};
use super::{clean_error_detail, disc_label, DiscRecorder};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

pub(crate) trait ToolRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<ToolOutput, String>;
}

pub(crate) struct SystemRunner;

impl ToolRunner for SystemRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<ToolOutput, String> {
        let output = Command::new(program)
            .args(args)
            .output()
            .map_err(|error| error.to_string())?;
        Ok(ToolOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

fn ensure_success(output: ToolOutput, stage: &str) -> Result<ToolOutput, String> {
    if output.success {
        return Ok(output);
    }
    let detail = clean_error_detail(&output.stderr);
    let detail = if detail.is_empty() {
        stage.to_string()
    } else {
        detail
    };
    Err(format!("@t:disc.failed\u{1f}{detail}"))
}

fn validate_folder(folder: &Path) -> Result<(MediaManifest, String), String> {
    if !folder.is_dir() {
        return Err("@t:disc.folderMissing".to_string());
    }
    let manifest_path = folder.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        return Err("@t:disc.notDiscFolder".to_string());
    }
    let parts = std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    name.contains(".efxpak.") && !name.contains(".efxpar.")
                })
                .count()
        })
        .unwrap_or(0);
    if parts == 0 {
        return Err("@t:disc.noPart".to_string());
    }
    if parts > 1 {
        return Err("@t:disc.multipleParts".to_string());
    }
    let manifest = read_manifest(&manifest_path)?;
    let disc_name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.to_ascii_lowercase().starts_with("disc-"));
    let label = match disc_name {
        Some(name) => disc_label(&format!("{name} {}", manifest.title)),
        None => disc_label(&manifest.title),
    };
    Ok((manifest, label))
}

struct XorrisoDevice {
    id: String,
    vendor: String,
    product: String,
    revision: String,
}

#[derive(Default)]
struct MediaState {
    loaded: bool,
    blank: bool,
    rewritable: bool,
    writable: bool,
    media_name: String,
    free_bytes: u64,
    capacity_bytes: u64,
}

fn quoted_tokens(text: &str) -> Vec<&str> {
    text.split('\'').skip(1).step_by(2).collect()
}

fn parse_xorriso_devices(text: &str) -> Vec<XorrisoDevice> {
    let mut devices = Vec::new();
    for line in text.lines() {
        let Some(start) = line.find("-dev '") else {
            continue;
        };
        let start = start + "-dev '".len();
        let Some(end) = line[start..].find('\'') else {
            continue;
        };
        let id = &line[start..start + end];
        let tokens = quoted_tokens(&line[start + end + 1..]);
        devices.push(XorrisoDevice {
            id: id.to_string(),
            vendor: tokens.first().copied().unwrap_or("").to_string(),
            product: tokens.get(1).copied().unwrap_or("").to_string(),
            revision: tokens.get(2).copied().unwrap_or("").to_string(),
        });
    }
    devices
}

fn parse_xorriso_toc(text: &str) -> MediaState {
    let mut state = MediaState::default();
    let mut status = String::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("Media current:") {
            state.media_name = value.trim().to_string();
            let lower = state.media_name.to_ascii_lowercase();
            state.loaded = !lower.is_empty() && !lower.contains("no media");
            state.rewritable = lower.contains("rw") || lower.contains("re") || lower.contains("ram");
        } else if let Some(value) = line.strip_prefix("Media status") {
            status = value.to_ascii_lowercase();
        } else if let Some(value) = line.strip_prefix("Media summary:") {
            if let Some(free) = value.rsplit(',').next() {
                if let Some(blocks) = free.trim().strip_suffix("free") {
                    if let Ok(blocks) = blocks.trim().parse::<u64>() {
                        state.free_bytes = blocks.saturating_mul(2048);
                        state.capacity_bytes = state.free_bytes;
                    }
                }
            }
        }
    }
    state.blank = status.contains("blank");
    state.writable = state.loaded && !status.contains("read-only") && !status.contains("closed");
    state
}

fn xorriso_recorder(device: XorrisoDevice, state: MediaState) -> DiscRecorder {
    let name = format!("{} {}", device.vendor, device.product);
    DiscRecorder {
        id: device.id,
        name: name.trim().to_string(),
        vendor: device.vendor,
        product: device.product,
        revision: device.revision,
        device_type: 0,
        media_types: 0,
        media_loaded: state.loaded,
        media_blank: state.blank,
        media_type: 0,
        media_name: state.media_name,
        media_rewritable: state.rewritable,
        media_writable: state.writable,
        free_bytes: state.free_bytes,
        capacity_bytes: state.capacity_bytes,
    }
}

pub(crate) fn list_xorriso(runner: &dyn ToolRunner) -> Result<Vec<DiscRecorder>, String> {
    let devices = runner.run("xorriso", &["-devices".to_string()])?;
    let devices = ensure_success(devices, "devices")?;
    let mut recorders = Vec::new();
    for device in parse_xorriso_devices(&devices.stdout) {
        let state = runner
            .run(
                "xorriso",
                &[
                    "-indev".to_string(),
                    device.id.clone(),
                    "-toc".to_string(),
                ],
            )
            .and_then(|output| ensure_success(output, "toc"))
            .map(|output| parse_xorriso_toc(&output.stdout))
            .unwrap_or_default();
        recorders.push(xorriso_recorder(device, state));
    }
    Ok(recorders)
}

pub(crate) fn burn_xorriso(
    runner: &dyn ToolRunner,
    folder: &Path,
    recorder_id: &str,
) -> Result<(), String> {
    let (manifest, label) = validate_folder(folder)?;
    let udf = manifest.volume_bytes > 700 * 1024 * 1024;
    burn_xorriso_with(runner, folder, recorder_id, &label, udf)
}

fn burn_xorriso_with(
    runner: &dyn ToolRunner,
    folder: &Path,
    recorder_id: &str,
    label: &str,
    udf: bool,
) -> Result<(), String> {
    let iso = std::env::temp_dir().join(format!(
        "efxlve-disc-{}-{}.iso",
        std::process::id(),
        crate::media_archive::pack::now_seconds()
    ));
    let iso_text = iso.to_string_lossy().into_owned();
    let mut mkisofs = vec![
        "-as".to_string(),
        "mkisofs".to_string(),
        "-iso-level".to_string(),
        "3".to_string(),
        "-J".to_string(),
    ];
    if udf {
        mkisofs.push("-udf".to_string());
    }
    mkisofs.extend([
        "-V".to_string(),
        label.to_string(),
        "-o".to_string(),
        iso_text.clone(),
        folder.to_string_lossy().into_owned(),
    ]);
    let result = runner
        .run("xorriso", &mkisofs)
        .and_then(|output| ensure_success(output, "mkisofs"));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&iso);
        return Err(error);
    }
    let burn = vec![
        "-as".to_string(),
        "cdrecord".to_string(),
        "-v".to_string(),
        "-dao".to_string(),
        "-eject".to_string(),
        format!("dev={recorder_id}"),
        iso_text,
    ];
    let result = runner
        .run("xorriso", &burn)
        .and_then(|output| ensure_success(output, "cdrecord"))
        .map(|_| ());
    let _ = std::fs::remove_file(&iso);
    result
}

pub(crate) fn erase_xorriso(runner: &dyn ToolRunner, recorder_id: &str, full: bool) -> Result<(), String> {
    let mode = if full { "all" } else { "fast" };
    runner
        .run(
            "xorriso",
            &[
                "-outdev".to_string(),
                recorder_id.to_string(),
                "-blank".to_string(),
                mode.to_string(),
            ],
        )
        .and_then(|output| ensure_success(output, "blank"))
        .map(|_| ())
}

struct DrutilDrive {
    id: String,
    vendor: String,
    product: String,
    revision: String,
}

fn parse_drutil_list(text: &str) -> Vec<DrutilDrive> {
    let mut drives = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 || fields[0].parse::<u32>().is_err() {
            continue;
        }
        drives.push(DrutilDrive {
            id: fields[0].to_string(),
            vendor: fields[1].to_string(),
            product: fields[2].to_string(),
            revision: fields[3].to_string(),
        });
    }
    drives
}

fn parse_human_bytes(value: &str) -> u64 {
    let mut fields = value.split_whitespace();
    let Ok(number) = fields.next().unwrap_or("0").parse::<f64>() else {
        return 0;
    };
    let multiplier = match fields.next().unwrap_or("B").to_ascii_lowercase().as_str() {
        "kb" => 1024.0,
        "mb" => 1024.0 * 1024.0,
        "gb" => 1024.0 * 1024.0 * 1024.0,
        "tb" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (number * multiplier) as u64
}

fn parse_drutil_status(text: &str) -> MediaState {
    let mut state = MediaState::default();
    let mut status = String::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("Type:") {
            state.media_name = value
                .split("Name:")
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            let lower = state.media_name.to_ascii_lowercase();
            state.loaded = !lower.is_empty() && !lower.contains("no media");
            state.rewritable = lower.contains("rw") || lower.contains("re") || lower.contains("ram");
        } else if let Some(value) = line.strip_prefix("Status:") {
            status = value.to_ascii_lowercase();
        } else if let Some(value) = line.strip_prefix("Space Free:") {
            state.free_bytes = parse_human_bytes(value);
            state.capacity_bytes = state.free_bytes;
        }
    }
    state.blank = status.contains("blank") || status.contains("empty");
    state.writable = state.loaded && !status.contains("read-only") && !status.contains("closed");
    state
}

fn drutil_recorder(drive: DrutilDrive, state: MediaState) -> DiscRecorder {
    let name = format!("{} {}", drive.vendor, drive.product);
    DiscRecorder {
        id: drive.id,
        name: name.trim().to_string(),
        vendor: drive.vendor,
        product: drive.product,
        revision: drive.revision,
        device_type: 0,
        media_types: 0,
        media_loaded: state.loaded,
        media_blank: state.blank,
        media_type: 0,
        media_name: state.media_name,
        media_rewritable: state.rewritable,
        media_writable: state.writable,
        free_bytes: state.free_bytes,
        capacity_bytes: state.capacity_bytes,
    }
}

pub(crate) fn list_drutil(runner: &dyn ToolRunner) -> Result<Vec<DiscRecorder>, String> {
    let drives = runner.run("drutil", &["list".to_string()])?;
    let drives = ensure_success(drives, "list")?;
    let mut recorders = Vec::new();
    for drive in parse_drutil_list(&drives.stdout) {
        let state = runner
            .run(
                "drutil",
                &[
                    "status".to_string(),
                    "-drive".to_string(),
                    drive.id.clone(),
                ],
            )
            .and_then(|output| ensure_success(output, "status"))
            .map(|output| parse_drutil_status(&output.stdout))
            .unwrap_or_default();
        recorders.push(drutil_recorder(drive, state));
    }
    Ok(recorders)
}

pub(crate) fn burn_drutil(runner: &dyn ToolRunner, folder: &Path, recorder_id: &str) -> Result<(), String> {
    validate_folder(folder)?;
    burn_drutil_with(runner, folder, recorder_id)
}

fn burn_drutil_with(
    runner: &dyn ToolRunner,
    folder: &Path,
    recorder_id: &str,
) -> Result<(), String> {
    runner
        .run(
            "drutil",
            &[
                "burn".to_string(),
                "-drive".to_string(),
                recorder_id.to_string(),
                "-eject".to_string(),
                folder.to_string_lossy().into_owned(),
            ],
        )
        .and_then(|output| ensure_success(output, "burn"))
        .map(|_| ())
}

pub(crate) fn erase_drutil(runner: &dyn ToolRunner, recorder_id: &str, full: bool) -> Result<(), String> {
    let mode = if full { "full" } else { "quick" };
    runner
        .run(
            "drutil",
            &[
                "erase".to_string(),
                "-drive".to_string(),
                recorder_id.to_string(),
                mode.to_string(),
            ],
        )
        .and_then(|output| ensure_success(output, "erase"))
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    type Handler = dyn Fn(&str, &[String]) -> Result<ToolOutput, String> + Send + Sync;

    struct MockRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
        handler: Box<Handler>,
    }

    impl MockRunner {
        fn new(handler: impl Fn(&str, &[String]) -> Result<ToolOutput, String> + Send + Sync + 'static) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                handler: Box::new(handler),
            }
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl ToolRunner for MockRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<ToolOutput, String> {
            self.calls
                .lock()
                .unwrap()
                .push((program.to_string(), args.to_vec()));
            (self.handler)(program, args)
        }
    }

    fn ok(stdout: &str) -> Result<ToolOutput, String> {
        Ok(ToolOutput {
            success: true,
            stdout: stdout.to_string(),
            stderr: String::new(),
        })
    }

    #[test]
    fn xorriso_devices_and_media_are_parsed() {
        let devices = "0  -dev '/dev/sr0' rwrw-- :  'HL-DT-ST' 'DVDRAM GP65NB60' '1.00'\n";
        let toc = "Media current: DVD-RW\nMedia status : is blank\nMedia summary: 0 sessions, 0 data blocks, 2295104 free\n";
        let runner = MockRunner::new(move |_, args| {
            if args.len() == 1 && args[0] == "-devices" {
                ok(devices)
            } else {
                ok(toc)
            }
        });

        let recorders = list_xorriso(&runner).unwrap();
        assert_eq!(recorders.len(), 1);
        let recorder = &recorders[0];
        assert_eq!(recorder.id, "/dev/sr0");
        assert_eq!(recorder.vendor, "HL-DT-ST");
        assert_eq!(recorder.product, "DVDRAM GP65NB60");
        assert!(recorder.media_loaded);
        assert!(recorder.media_blank);
        assert!(recorder.media_rewritable);
        assert_eq!(recorder.free_bytes, 2295104 * 2048);
        assert_eq!(runner.calls().len(), 2);
    }

    #[test]
    fn xorriso_burn_builds_mkisofs_then_cdrecord() {
        let runner = MockRunner::new(|_, _| ok(""));
        burn_xorriso_with(
            &runner,
            Path::new("/tmp/disc-1"),
            "/dev/sr0",
            "EFXLVE",
            true,
        )
        .unwrap();
        let calls = runner.calls();
        assert_eq!(calls.len(), 2);
        let first = &calls[0].1;
        assert!(first.contains(&"-as".to_string()));
        assert!(first.contains(&"mkisofs".to_string()));
        assert!(first.contains(&"-udf".to_string()));
        let iso = first
                .iter()
                .position(|value| value == "-o")
                .and_then(|index| first.get(index + 1))
                .cloned()
                .expect("iso path");
        let second = &calls[1].1;
        assert!(second.contains(&"cdrecord".to_string()));
        assert!(second.contains(&"dev=/dev/sr0".to_string()));
        assert_eq!(second.last(), Some(&iso));
        assert!(!Path::new(&iso).exists());
    }

    #[test]
    fn xorriso_erase_selects_quick_or_full() {
        let runner = MockRunner::new(|_, _| ok(""));
        erase_xorriso(&runner, "/dev/sr0", false).unwrap();
        erase_xorriso(&runner, "/dev/sr0", true).unwrap();
        let calls = runner.calls();
        assert!(calls[0].1.contains(&"fast".to_string()));
        assert!(calls[1].1.contains(&"all".to_string()));
    }

    #[test]
    fn drutil_drives_and_media_are_parsed() {
        let list = "0  HL-DT-ST DVDRAM GP65NB60 1.00  USB  2\n";
        let status = "Type: DVD-RW   Name: /dev/disk4\nStatus: blank\nSpace Free: 4.38 GB\n";
        let runner = MockRunner::new(move |_, args| {
            if args.len() == 1 && args[0] == "list" {
                ok(list)
            } else {
                ok(status)
            }
        });
        let recorders = list_drutil(&runner).unwrap();
        assert_eq!(recorders.len(), 1);
        assert_eq!(recorders[0].id, "0");
        assert!(recorders[0].media_loaded);
        assert!(recorders[0].media_blank);
        assert!(recorders[0].media_rewritable);
        assert!(recorders[0].free_bytes > 4_000_000_000);
    }

    #[test]
    fn drutil_burn_and_erase_use_the_drive() {
        let runner = MockRunner::new(|_, _| ok(""));
        burn_drutil_with(&runner, Path::new("/tmp/disc-1"), "0").unwrap();
        erase_drutil(&runner, "0", false).unwrap();
        erase_drutil(&runner, "0", true).unwrap();
        let calls = runner.calls();
        assert!(calls[0].1.contains(&"burn".to_string()));
        assert!(calls[0].1.contains(&"0".to_string()));
        assert!(calls[1].1.contains(&"quick".to_string()));
        assert!(calls[2].1.contains(&"full".to_string()));
    }

    #[test]
    fn a_failed_tool_maps_to_the_disc_error() {
        let runner = MockRunner::new(|_, _| {
            Ok(ToolOutput {
                success: false,
                stdout: String::new(),
                stderr: "no blank media".to_string(),
            })
        });
        let error = erase_xorriso(&runner, "/dev/sr0", false).unwrap_err();
        assert!(error.contains("disc.failed"), "{error}");
        assert!(error.contains("no blank media"), "{error}");
    }
}

