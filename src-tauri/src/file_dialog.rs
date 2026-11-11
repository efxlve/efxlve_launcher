//! Native "open file" dialog shared by the custom-game executable picker and
//! the backup imports. The Windows filter follows the requested kind so a
//! `.efxprofile` export stays visible instead of hiding behind "All files".
//! `title` is supplied by the frontend so the dialog follows the UI language.

/// What the dialog lists. Add a variant when a picker needs its own filter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilePickerKind {
    Executable,
    Archive,
    Audio,
}

impl FilePickerKind {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("archive") => Self::Archive,
            Some("audio") => Self::Audio,
            _ => Self::Executable,
        }
    }

    fn default_title(self) -> &'static str {
        match self {
            Self::Executable => "Select Executable",
            Self::Archive => "Select Backup Archive",
            Self::Audio => "Select Audio File",
        }
    }
}

#[tauri::command]
pub async fn pick_file_dialog(
    default_path: Option<String>,
    title: Option<String>,
    kind: Option<String>,
) -> Result<Option<String>, String> {
    let kind = FilePickerKind::parse(kind.as_deref());
    #[cfg(windows)]
    {
        let filter = match kind {
            FilePickerKind::Executable => {
                r"Executables (*.exe;*.bat;*.cmd;*.lnk)|*.exe;*.bat;*.cmd;*.lnk|All files (*.*)|*.*"
            }
            FilePickerKind::Archive => {
                r"Launcher backups (*.efxprofile;*.tar.gz;*.zip)|*.efxprofile;*.tar.gz;*.zip|All files (*.*)|*.*"
            }
            FilePickerKind::Audio => {
                r"Audio (*.mp3;*.ogg;*.wav;*.m4a;*.aac;*.flac;*.opus;*.webm)|*.mp3;*.ogg;*.wav;*.m4a;*.aac;*.flac;*.opus;*.webm|All files (*.*)|*.*"
            }
        };
        let picker_title = title
            .unwrap_or_else(|| kind.default_title().to_string())
            .replace('\'', "''");
        tokio::task::spawn_blocking(move || {
            let clean_default_path = default_path.unwrap_or_default().replace('\'', "''");
            let script = format!(
                r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Windows.Forms;
$f = New-Object System.Windows.Forms.OpenFileDialog;
$f.Title = '{picker_title}';
$f.Filter = '{filter}';
if ('{clean_default_path}' -ne '') {{ $f.InitialDirectory = '{clean_default_path}' }};
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
    Write-Output $f.FileName
}}
"#
            );

            let mut cmd = std::process::Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let output = cmd.output().map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok::<Option<String>, String>(if stdout.is_empty() {
                None
            } else {
                Some(stdout)
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        let picked_title = title.unwrap_or_else(|| kind.default_title().to_string());
        let filter = match kind {
            FilePickerKind::Archive => "*.efxprofile *.tar.gz *.zip",
            FilePickerKind::Executable => "*.exe *.bat *.cmd *.lnk",
            FilePickerKind::Audio => "*.mp3 *.ogg *.wav *.m4a *.aac *.flac *.opus *.webm",
        };
        if cfg!(target_os = "macos") {
            let escaped = picked_title.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!("POSIX path of (choose file with prompt \"{escaped}\")");
            let output = Command::new("osascript")
                .args(["-e", &script])
                .output()
                .map_err(|error| error.to_string())?;
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok(if output.status.success() && !path.is_empty() {
                Some(path)
            } else {
                None
            });
        }

        let mut zenity = Command::new("zenity");
        zenity.args(["--file-selection", "--title", &picked_title]);
        zenity.arg(format!("--file-filter={filter}"));
        if let Some(default) = default_path.as_deref().filter(|path| !path.is_empty()) {
            zenity.arg(format!("--filename={default}/"));
        }
        if let Ok(output) = zenity.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(Some(path));
                }
            }
        }

        let mut kdialog = Command::new("kdialog");
        kdialog.args(["--getopenfilename", "", filter]);
        if let Some(default) = default_path.as_deref().filter(|path| !path.is_empty()) {
            kdialog.arg(default);
        }
        if let Ok(output) = kdialog.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(Some(path));
                }
            }
        }
        Ok(None)
    }
}
