//! Optical disc writing through Windows IMAPI2. The heavy lifting lives in
//! the OS (`imapi2fs.dll` + `imapi2.dll`), driven by a short PowerShell
//! script; this module owns validation, recorder listing and error mapping.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::format::{read_manifest, MANIFEST_FILE};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscRecorder {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub product: String,
    pub revision: String,
    pub device_type: i32,
    pub media_types: i32,
}

#[derive(Debug, Deserialize)]
struct RecorderList {
    #[serde(default)]
    items: Vec<DiscRecorder>,
}

pub fn list_recorders() -> Result<Vec<DiscRecorder>, String> {
    #[cfg(not(windows))]
    {
        return Ok(Vec::new());
    }
    #[cfg(windows)]
    {
        let script = r#"
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dm = New-Object -ComObject IMAPI2.MsftDiscMaster2
$items = @()
for ($i = 0; $i -lt $dm.Count; $i++) {
  try {
    $id = [string]$dm.Item($i)
    $rec = New-Object -ComObject IMAPI2.MsftDiscRecorder2
    $rec.InitializeDiscRecorder($id)
    $items += [pscustomobject]@{
      id = $id
      name = [string]$rec.VolumeName
      vendor = [string]$rec.VendorId
      product = [string]$rec.ProductId
      revision = [string]$rec.ProductRevision
      deviceType = [int]$rec.DeviceType
      mediaTypes = [int]$rec.MediaTypesSupported
    }
  } catch { }
}
@{ items = @($items) } | ConvertTo-Json -Compress -Depth 4
"#;
        let text = run_powershell(script).map_err(|error| {
            format!("@t:disc.failed\u{1f}{}", clean_error_detail(&error))
        })?;
        let text = text.trim_start_matches('\u{feff}').trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let parsed: RecorderList = serde_json::from_str(text).map_err(|error| {
            format!("@t:disc.failed\u{1f}{error}")
        })?;
        Ok(parsed.items)
    }
}

pub fn burn_folder(folder: &Path, recorder_id: &str) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (folder, recorder_id);
        return Err("@t:disc.unsupported".to_string());
    }
    #[cfg(windows)]
    {
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
                        entry
                            .file_name()
                            .to_string_lossy()
                            .contains(".efxpak.")
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
        let folder = plain_path(
            &folder
                .canonicalize()
                .map_err(|error| format!("@t:disc.folderMissing\u{1f}{error}"))?,
        );
        let script = format!(
            r#"
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$folder = {}
$recorderId = {}
$label = {}
try {{
  if (-not (Test-Path -LiteralPath $folder)) {{ throw "FOLDER_MISSING" }}
  $dm = New-Object -ComObject IMAPI2.MsftDiscMaster2
  $matched = $null
  for ($i = 0; $i -lt $dm.Count; $i++) {{
    $candidate = [string]$dm.Item($i)
    if ($candidate -eq $recorderId) {{ $matched = $candidate; break }}
  }}
  if ($null -eq $matched) {{ throw "RECORDER_MISSING" }}
  $rec = New-Object -ComObject IMAPI2.MsftDiscRecorder2
  $rec.InitializeDiscRecorder($matched)
  $writer = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
  $writer.Recorder = $rec
  $writer.ClientName = "Efxlve Launcher"
  if (-not $writer.IsMediaLoaded) {{ throw "NO_DISC" }}
  if (-not $writer.MediaPhysicallyBlank) {{ throw "NOT_BLANK" }}
  $free = [int64]$writer.FreeSectorsOnMedia
  if ($free -le 0) {{ throw "NO_SPACE" }}
  $part = Get-ChildItem -LiteralPath $folder -Filter "*.efxpak.*" | Select-Object -First 1
  if ($null -eq $part) {{ throw "NO_PART" }}
  if ($part.Length -gt ($free * 2048)) {{ throw "NO_SPACE" }}
  $fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  $fsi.FileSystemsToCreate = 4
  $fsi.VolumeName = $label
  $fsi.FreeMediaBlocks = $free
  $fsi.Root.AddTree($folder, $false)
  $image = $fsi.CreateResultImage()
  $stream = $image.ImageStream
  $writer.Write($stream)
  try {{ $rec.EjectMedia() }} catch {{ }}
  [Console]::Out.WriteLine("OK")
}} catch {{
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}}
"#,
            ps_quote(&folder.to_string_lossy()),
            ps_quote(recorder_id),
            ps_quote(&label)
        );
        let error = match run_powershell(&script) {
            Ok(_) => return Ok(()),
            Err(error) => error,
        };
        let code = [
            "NO_DISC",
            "NOT_BLANK",
            "NO_SPACE",
            "NO_PART",
            "RECORDER_MISSING",
            "FOLDER_MISSING",
        ]
        .iter()
        .find(|code| error.contains(**code))
        .copied();
        match code {
            Some("NO_DISC") => Err("@t:disc.noDisc".to_string()),
            Some("NOT_BLANK") => Err("@t:disc.notBlank".to_string()),
            Some("NO_SPACE") => Err("@t:disc.noSpace".to_string()),
            Some("NO_PART") => Err("@t:disc.noPart".to_string()),
            Some("RECORDER_MISSING") => Err("@t:disc.recorderMissing".to_string()),
            Some("FOLDER_MISSING") => Err("@t:disc.folderMissing".to_string()),
            _ => Err(format!(
                "@t:disc.failed\u{1f}{}",
                clean_error_detail(&error)
            )),
        }
    }
}

/// `canonicalize` returns a `\\?\` verbatim path on Windows, which IMAPI's
/// `AddTree` does not accept.
fn plain_path(path: &Path) -> std::path::PathBuf {
    #[cfg(windows)]
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return std::path::PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn clean_error_detail(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty() && !line.starts_with("#<") && !line.starts_with('<')
        })
        .unwrap_or("PowerShell")
        .to_string()
}

fn disc_label(title: &str) -> String {
    let mut label: String = title
        .chars()
        .filter(|value| value.is_alphanumeric() || matches!(value, ' ' | '-' | '_'))
        .take(32)
        .collect();
    label = label.trim().to_string();
    if label.is_empty() {
        "EFXLVE".to_string()
    } else {
        label
    }
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn run_powershell(script: &str) -> Result<String, String> {
    use base64::Engine;
    use std::os::windows::process::CommandExt;

    let utf16: Vec<u8> = script.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let mut command = std::process::Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded,
    ]);
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|error| format!("@t:disc.failed\u{1f}{error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_clean_and_bounded() {
        assert_eq!(disc_label("Cyberpunk 2077"), "Cyberpunk 2077");
        assert_eq!(disc_label("Çok Güzel Oyun"), "Çok Güzel Oyun");
        assert_eq!(disc_label(""), "EFXLVE");
        assert!(disc_label(&"x".repeat(100)).len() <= 32);
    }

    #[test]
    fn powershell_single_quotes_are_escaped() {
        assert_eq!(ps_quote("a'b"), "'a''b'");
    }

    #[cfg(windows)]
    #[test]
    fn recorder_list_returns_even_without_a_drive() {
        let result = list_recorders();
        assert!(result.is_ok(), "{:?}", result.err());
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_without_a_manifest_is_refused_before_powershell() {
        let dir = std::env::temp_dir().join(format!("efxlve-disc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let result = burn_folder(&dir, "recorder");
        assert_eq!(result.unwrap_err(), "@t:disc.notDiscFolder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_missing_recorder_is_reported_by_the_script() {
        let dir = std::env::temp_dir().join(format!("efxlve-disc-burn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(MANIFEST_FILE),
            r#"{
              "format": "efxlve-media-archive",
              "formatVersion": 1,
              "createdAt": 1,
              "launcherVersion": "test",
              "appName": "steam::1",
              "store": "steam",
              "title": "Test",
              "installDirName": "Test",
              "originalInstallPath": "C:\\Test",
              "originalBytes": 1,
              "fileCount": 1,
              "dirCount": 0,
              "skippedLinks": 0,
              "compression": { "algorithm": "zstd", "level": 3, "windowLog": 20, "frameBytes": 1048576 },
              "volumeBytes": 1048576,
              "volumes": [{ "index": 1, "fileName": "game.efxpak.001", "bytes": 1, "sha256": "x", "blocks": 1 }],
              "storeMeta": {},
              "complete": true,
              "discLayout": true
            }"#,
        )
        .unwrap();
        std::fs::write(dir.join("game.efxpak.001"), b"x").unwrap();
        let result = burn_folder(&dir, "no-such-recorder");
        assert_eq!(result.unwrap_err(), "@t:disc.recorderMissing");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
