//! Use macOS caffeinate to prevent sleep: -i blocks idle sleep, -d keeps the display on, and -s
//! covers other sleep attempts on AC power. The -w app PID ties its lifetime to ours, including
//! abrupt app termination. The UI chooses when to enable it based on user preference and active
//! agents.

use crate::lock::lock;
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};

fn running() -> &'static Mutex<Option<Child>> {
    static RUNNING: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(None))
}

/// Repeated requests for the same state are no-ops because the UI updates this setting with every
/// board change.
#[tauri::command]
pub fn set_awake(on: bool) -> Result<(), String> {
    let mut child = lock(running());
    // Restart an unexpectedly exited caffeinate process instead of treating its stale handle as
    // active.
    let mut alive = child.take();
    if let Some(caffeinate) = &mut alive {
        // Only Ok(None) proves the process is still running; a status or error does not.
        if !matches!(caffeinate.try_wait(), Ok(None)) {
            alive = None;
        }
    }
    match (on, alive) {
        (true, Some(alive)) => *child = Some(alive),
        (true, None) => {
            let spawned = Command::new("/usr/bin/caffeinate")
                .args(["-d", "-i", "-s", "-w", &std::process::id().to_string()])
                .spawn()
                .map_err(|error| error.to_string())?;
            *child = Some(spawned);
        }
        (false, Some(mut alive)) => {
            let _ = alive.kill();
            let _ = alive.wait();
        }
        (false, None) => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Start and stop real caffeinate. The test PID supplied to -w ensures failures cannot leave
    /// the machine permanently awake.
    #[test]
    fn enables_display_and_system_awake_once_then_disables_them() {
        set_awake(true).expect("caffeinate did not start");
        let first = lock(running()).as_ref().map(|c| c.id());
        assert!(first.is_some());

        // Verify the flags as well as the child: using only -i allowed the display to sleep.
        let command = Command::new("/bin/ps")
            .args(["-p", &first.unwrap().to_string(), "-o", "command="])
            .output()
            .expect("could not read caffeinate");
        let command = String::from_utf8_lossy(&command.stdout);
        assert!(command.contains("caffeinate -d -i -s -w"), "{command}");

        set_awake(true).expect("second request");
        assert_eq!(lock(running()).as_ref().map(|c| c.id()), first);

        set_awake(false).expect("desligar");
        assert!(lock(running()).is_none());
        // Disabling an already disabled assertion is a no-op.
        set_awake(false).expect("desligar de novo");
        assert!(lock(running()).is_none());
    }
}
