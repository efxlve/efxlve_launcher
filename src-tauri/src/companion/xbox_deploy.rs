//! Installing and removing Xbox titles from the launcher.
//!
//! Microsoft Store deployment owns the download, the decryption and the licence
//! work. The launcher opens the store page for the package and watches the
//! registration, so the row reports a real state instead of guessing a
//! percentage. Nothing here touches the package contents.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use super::{launch, xbox_installed};

/// One running watch per package family name.
static WATCHES: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);

/// The Store registers the package within seconds of the click. Half an hour
/// means the row is stale, not that the download is slow.
const LIMIT: Duration = Duration::from_secs(30 * 60);
const POLL: Duration = Duration::from_secs(2);

fn emit(app: &AppHandle, family: &str, state: &str) {
    let _ = app.emit("xbox-install", serde_json::json!({ "id": family, "state": state }));
}

/// Opens the Store page for one package and watches for its registration.
pub(crate) fn start(app: AppHandle, family: String) -> Result<(), String> {
    if xbox_installed::is_installed(&family) {
        emit(&app, &family, "done");
        return Ok(());
    }
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = WATCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let watches = guard.get_or_insert_with(HashMap::new);
        if let Some(previous) = watches.insert(family.clone(), flag.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
    }
    // The store page comes first: a store that refuses to open must not leave a
    // row waiting for a click that can never happen.
    if let Err(error) = launch::open_game(&format!("ms-windows-store://pdp/?PFN={family}"), "") {
        stop(&family, &flag);
        return Err(error);
    }
    emit(&app, &family, "waiting");

    let watch = flag.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            if watch.load(Ordering::Relaxed) {
                stop(&family, &watch);
                emit(&app, &family, "cancelled");
                return;
            }
            if xbox_installed::is_installed(&family) {
                stop(&family, &watch);
                xbox_installed::invalidate();
                emit(&app, &family, "done");
                return;
            }
            if started.elapsed() > LIMIT {
                stop(&family, &watch);
                emit(&app, &family, "timeout");
                return;
            }
            std::thread::sleep(POLL);
        }
    });
    Ok(())
}

/// Stops watching without touching the install the Store is running.
pub(crate) fn cancel(family: &str) {
    if let Ok(mut guard) = WATCHES.lock() {
        if let Some(watches) = guard.as_mut() {
            if let Some(flag) = watches.remove(family) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

/// Drops one watch, but only when it is still the current one: a second click
/// replaces the flag and the old thread must not remove the new row.
fn stop(family: &str, flag: &Arc<AtomicBool>) {
    if let Ok(mut guard) = WATCHES.lock() {
        if let Some(watches) = guard.as_mut() {
            let current = watches
                .get(family)
                .is_some_and(|current| Arc::ptr_eq(current, flag));
            if current {
                watches.remove(family);
            }
        }
    }
}

/// Removes one package through the same deployment service Settings uses.
pub(crate) fn uninstall(family: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;

        let full = xbox_installed::full_name(family).ok_or("Game is not installed")?;
        let manager = xbox_installed::manager().ok_or("Package manager is unavailable")?;
        let operation = manager
            .RemovePackageAsync(&HSTRING::from(full))
            .map_err(|error| error.message())?;
        let result = operation.get().map_err(|error| error.message())?;
        let code = result.ExtendedErrorCode().map(|code| code.0).unwrap_or(0);
        if code != 0 {
            let text = result
                .ErrorText()
                .map(|text| text.to_string_lossy())
                .unwrap_or_default();
            return Err(if text.is_empty() {
                format!("0x{code:08X}")
            } else {
                text
            });
        }
        xbox_installed::invalidate();
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = family;
        Err("Xbox packages only exist on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_watch(family: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = WATCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .get_or_insert_with(HashMap::new)
            .insert(family.to_string(), flag.clone());
        flag
    }

    fn watched(family: &str) -> bool {
        let guard = WATCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .as_ref()
            .is_some_and(|watches| watches.contains_key(family))
    }

    #[test]
    fn a_replaced_watch_does_not_clear_the_new_one() {
        let old = Arc::new(AtomicBool::new(false));
        let current = install_watch("Example.Game_0000000000000");
        // The first watcher finishes after a second click replaced it.
        stop("Example.Game_0000000000000", &old);
        assert!(watched("Example.Game_0000000000000"));
        stop("Example.Game_0000000000000", &current);
        assert!(!watched("Example.Game_0000000000000"));
    }

    #[test]
    fn cancelling_raises_the_flag_and_drops_the_row() {
        let flag = install_watch("Example.Cancel_0000000000000");
        cancel("Example.Cancel_0000000000000");
        assert!(flag.load(Ordering::Relaxed));
        assert!(!watched("Example.Cancel_0000000000000"));
    }
}
