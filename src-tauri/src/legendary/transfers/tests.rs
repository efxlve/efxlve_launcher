use std::path::PathBuf;

use super::guard::*;
use super::launch::*;
use super::parse::*;

#[test]
fn install_path_does_not_match_a_drive_root_or_a_sibling() {
    assert!(!image_inside_install(
        r"C:\Users\Efe\AppData\Local\efxlve\efxlve-launcher.exe",
        r"C:\"
    ));
    assert!(!image_inside_install(
        r"C:\Games\Other\game.exe",
        r"C:\Games\WuWa"
    ));
    assert!(image_inside_install(
        r"C:\Games\WuWa\Client\Binaries\Win64\Client-Win64-Shipping.exe",
        r"C:\Games\WuWa"
    ));
}

#[test]
fn parses_progress_percent_line() {
    let line =
        "[DLManager] INFO: = Progress: 50.46% (1156/2291), Running for 00:00:31, ETA: 00:00:30";
    assert_eq!(parse_progress_percent(line), Some(50));
    let done =
        "[DLManager] INFO: = Progress: 100.00% (2291/2291), Running for 00:00:32, ETA: 00:00:00";
    assert_eq!(parse_progress_percent(done), Some(100));
    assert_eq!(parse_progress_percent("no progress here"), None);
}

#[test]
fn parses_mib_lines() {
    assert_eq!(
        parse_mib_after(
            "[cli] INFO: Download size: 84.29 MiB (Compression savings: 53.9%)",
            "Download size:"
        ),
        Some(84.29)
    );
    assert_eq!(
        parse_mib_after(
            "[DLManager] INFO:  - Downloaded: 1.33 MiB, Written: 2.00 MiB",
            "Downloaded:"
        ),
        Some(1.33)
    );
    assert_eq!(parse_mib_after("nothing here", "Downloaded:"), None);
}

#[test]
fn test_parse_eta() {
    let line =
        "[DLManager] INFO: = Progress: 50.46% (1156/2291), Running for 00:00:31, ETA: 00:01:22";
    let res = parse_eta(line);
    assert_eq!(res, Some(("00:01:22".to_string(), 82)));

    let short_eta = "Progress: 20%, ETA: 03:45";
    assert_eq!(parse_eta(short_eta), Some(("03:45".to_string(), 225)));
}

#[test]
fn test_parse_speed() {
    let line = "[DLManager] INFO:  - Download: 15.40 MiB/s, Disk: 24.50 MiB/s";
    let net = parse_speed(line, &["Download:", "Download speed:", "Speed:"]);
    assert_eq!(net, Some(("15.4 MiB/s".to_string(), 16148070)));

    let disk = parse_speed(line, &["Disk:", "Disk speed:"]);
    assert_eq!(disk, Some(("24.5 MiB/s".to_string(), 25690112)));

    // Cumulative sizes are not rates, even when the key is a prefix.
    let size_line = "[DLManager] INFO:  - Downloaded: 25.00 MiB, Written: 72.50 MiB";
    assert_eq!(
        parse_speed(size_line, &["Download:", "Download", "Speed:"]),
        None
    );
    assert_eq!(
        parse_speed(size_line, &["Disk:", "Write:", "Written:", "Write", "Disk"]),
        None
    );

    // Newer legendary builds separate the label with a tab instead of ": ".
    let tabbed = "[DLManager] INFO:  - Download\t15.40 MiB/s, Write\t24.50 MiB/s";
    assert_eq!(
        parse_speed(tabbed, &["Download:", "Download"]),
        Some(("15.4 MiB/s".to_string(), 16148070))
    );
    assert_eq!(
        parse_speed(tabbed, &["Write:", "Write"]),
        Some(("24.5 MiB/s".to_string(), 25690112))
    );
}

#[tokio::test]
async fn crlf_lines_splits_on_carriage_return() {
    // Legendary overwrites progress with `\r`; the reader must split on both \r and \n.
    let data = b"first line\nDownload: 5.0 MiB/s\rDownload: 6.0 MiB/s\r\nlast";
    let mut r = CrlfLines::new(&data[..]);
    assert_eq!(r.next_line().await.as_deref(), Some("first line"));
    assert_eq!(r.next_line().await.as_deref(), Some("Download: 5.0 MiB/s"));
    assert_eq!(r.next_line().await.as_deref(), Some("Download: 6.0 MiB/s"));
    assert_eq!(r.next_line().await.as_deref(), Some("last"));
    assert_eq!(r.next_line().await, None);
}

#[test]
fn play_stub_launches_the_game_binary() {
    let temp = std::env::temp_dir().join("efxlve_test_play_stub");
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).unwrap();
    std::fs::write(temp.join("PlayRDR2.exe"), b"stub").unwrap();
    std::fs::write(temp.join("RDR2.exe"), vec![0u8; 64]).unwrap();
    assert_eq!(
        direct_game_exe(&temp, "PlayRDR2.exe").as_deref(),
        Some("RDR2.exe")
    );
    std::fs::write(temp.join("OnlyGame.exe"), b"game").unwrap();
    assert!(direct_game_exe(&temp, "OnlyGame.exe").is_none());
    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn test_discover_game_executables() {
    let temp = std::env::temp_dir().join("efxlve_test_discover_exes");
    let _ = std::fs::remove_dir_all(&temp);
    let sub = temp.join("Binaries").join("Win64");
    std::fs::create_dir_all(&sub).unwrap();

    std::fs::write(temp.join("GameWrapper.exe"), b"fake").unwrap();
    std::fs::write(sub.join("Game-Win64-Shipping.exe"), b"fake").unwrap();
    std::fs::write(temp.join("CrashReportClient.exe"), b"fake").unwrap();
    std::fs::write(temp.join("vc_redist.x64.exe"), b"fake").unwrap();

    let exes = discover_game_executables(&temp, Some("GameWrapper.exe"));
    assert!(exes.contains(&"gamewrapper.exe".to_string()));
    assert!(exes.contains(&"game-win64-shipping.exe".to_string()));
    assert!(!exes.contains(&"crashreportclient.exe".to_string()));
    assert!(!exes.contains(&"vc_redist.x64.exe".to_string()));

    let _ = std::fs::remove_dir_all(&temp);
}

#[test]
fn test_is_game_process_running() {
    assert!(!is_game_process_running(
        None,
        &["fake_nonexistent_game_xyz_999.exe".to_string()]
    ));
    #[cfg(target_os = "windows")]
    {
        let running = is_game_process_running(None, &["services.exe".to_string()]);
        assert!(running, "services.exe should be running on Windows");
    }
}

#[test]
fn test_is_safe_game_dir() {
    let def = PathBuf::from(r"C:\Games");
    assert!(is_safe_game_dir(
        &PathBuf::from(r"C:\Games\ReadyOrNot"),
        &def
    ));
    assert!(is_safe_game_dir(
        &PathBuf::from(r"D:\EpicGames\Cyberpunk2077"),
        &def
    ));
    assert!(!is_safe_game_dir(&PathBuf::from(r"C:\"), &def));
    assert!(!is_safe_game_dir(&PathBuf::from(r"D:\"), &def));
    assert!(!is_safe_game_dir(&PathBuf::from(r"C:\Games"), &def));
    assert!(!is_safe_game_dir(&PathBuf::from(r"C:\Windows"), &def));
    assert!(!is_safe_game_dir(&PathBuf::from(r"C:\Program Files"), &def));
}

#[test]
fn test_force_remove_dir_all_handles_readonly() {
    let temp_dir =
        std::env::temp_dir().join(format!("efxlve_test_uninstall_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp_dir);
    let sub = temp_dir.join("subfolder");
    std::fs::create_dir_all(&sub).unwrap();
    let file = sub.join("readonly_file.txt");
    std::fs::write(&file, "test").unwrap();
    let mut perms = std::fs::metadata(&file).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&file, perms).unwrap();

    assert!(force_remove_dir_all(&temp_dir).is_ok());
    assert!(!temp_dir.exists());
}
