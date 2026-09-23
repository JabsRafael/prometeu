//! Use macOS caffeinate to prevent sleep: -i blocks idle sleep, -d keeps the display on, and -s
//! covers other sleep attempts on AC power. The -w app PID ties its lifetime to ours, including
//! abrupt app termination. On Linux, systemd-inhibit holds the locks while `tail --pid` waits on
//! our PID. The UI chooses when to enable it based on user preference and active agents.

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
    // Not an error: the UI repeats this call on every board change.
    if !supported() {
        return Ok(());
    }
    let mut child = lock(running());
    // Restart an unexpectedly exited inhibitor process instead of treating its stale handle as
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
            let spawned = inhibitor().spawn().map_err(|error| error.to_string())?;
            *child = Some(spawned);
        }
        (false, Some(mut alive)) => {
            stop(&alive);
            let _ = alive.kill();
            let _ = alive.wait();
        }
        (false, None) => {}
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn inhibitor() -> Command {
    let mut cmd = Command::new("/usr/bin/caffeinate");
    cmd.args(["-d", "-i", "-s", "-w", &std::process::id().to_string()]);
    cmd
}

#[cfg(target_os = "macos")]
fn supported() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
fn supported() -> bool {
    crate::platform::has("systemd-inhibit") && std::path::Path::new("/run/systemd/system").exists()
}

#[cfg(target_os = "macos")]
fn stop(_: &Child) {}

/// systemd-inhibit does not forward signals to tail, so kill its whole group.
#[cfg(not(target_os = "macos"))]
fn stop(child: &Child) {
    // SAFETY: only sends a signal to the group created in inhibitor().
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
}

#[cfg(not(target_os = "macos"))]
fn inhibitor() -> Command {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("systemd-inhibit");
    cmd.process_group(0);
    cmd.args([
        "--what=idle:sleep",
        "--who=Prometeu",
        "--why=Agents are running",
        "--mode=block",
        "tail",
        "--pid",
        &std::process::id().to_string(),
        "-f",
        "/dev/null",
    ]);
    cmd
}

#[cfg(all(test, target_os = "macos"))]
const EXPECTED: &str = "caffeinate -d -i -s -w";
#[cfg(all(test, not(target_os = "macos")))]
const EXPECTED: &str = "systemd-inhibit --what=idle:sleep";

#[cfg(test)]
mod tests {
    use super::*;

    /// Start and stop the real inhibitor. The test PID it waits on ensures failures cannot leave
    /// the machine permanently awake.
    #[test]
    fn enables_display_and_system_awake_once_then_disables_them() {
        if !supported() {
            eprintln!("skipped: no systemd session to inhibit");
            return;
        }
        set_awake(true).expect("inhibitor did not start");
        let first = lock(running()).as_ref().map(|c| c.id());
        assert!(first.is_some());

        // Verify the flags as well as the child: caffeinate with only -i allowed the display to
        // sleep.
        let command = Command::new("/bin/ps")
            .args(["-p", &first.unwrap().to_string(), "-o", "command="])
            .output()
            .expect("could not read inhibitor");
        let command = String::from_utf8_lossy(&command.stdout);
        assert!(command.contains(EXPECTED), "{command}");

        set_awake(true).expect("second request");
        assert_eq!(lock(running()).as_ref().map(|c| c.id()), first);

        set_awake(false).expect("desligar");
        assert!(lock(running()).is_none());
        // Disabling an already disabled assertion is a no-op.
        set_awake(false).expect("desligar de novo");
        assert!(lock(running()).is_none());
    }
}
