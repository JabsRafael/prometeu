//! Private interactive transport for the official CLI's browser consent; never a visible terminal.
use crate::i18n;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

const CONSENT: &[u8] = b"Code Assist login required. Opening authentication page in your browser. Do you want to continue? [Y/n]: ";

#[derive(Default)]
struct Consent {
    tail: Vec<u8>,
    answered: bool,
}
impl Consent {
    fn feed(&mut self, bytes: &[u8]) -> bool {
        if self.answered {
            return false;
        }
        for byte in bytes {
            self.tail.push(*byte);
            if self.tail.ends_with(CONSENT) {
                self.tail.clear();
                self.answered = true;
                return true;
            }
            if self.tail.len() > CONSENT.len() {
                self.tail.remove(0);
            }
        }
        false
    }
}

pub(super) struct LoginProcess {
    child: Box<dyn Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    consent: Consent,
}
impl LoginProcess {
    pub(super) fn spawn(command: CommandBuilder) -> Result<Self, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 40,
                cols: 160,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| i18n::t("err.account.login"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| i18n::t("err.account.login"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|_| i18n::t("err.account.login"))?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| i18n::t("err.account.login"))?;
        drop(pair.slave);
        let (send, output) = mpsc::sync_channel(8);
        std::thread::spawn(move || {
            let mut bytes = [0; 4096];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if send.send(bytes[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Self {
            child,
            _master: pair.master,
            writer,
            output,
            consent: Consent::default(),
        })
    }
    pub(super) fn poll(&mut self, cancel: &Arc<AtomicBool>) -> Result<(), String> {
        if cancel.load(Ordering::Relaxed) {
            return Err(i18n::t("err.account.cancelled"));
        }
        match self.output.recv_timeout(Duration::from_millis(100)) {
            Ok(bytes) => {
                // Clicking Connect already authorizes browser login. Confirm only this known
                // startup question, never a tool, trust prompt or other interactive request.
                if self.consent.feed(&bytes) && !cancel.load(Ordering::Relaxed) {
                    self.writer
                        .write_all(b"y\r")
                        .and_then(|()| self.writer.flush())
                        .map_err(i18n::io)?;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(i18n::t("err.account.login")),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        Ok(())
    }
}
impl Drop for LoginProcess {
    fn drop(&mut self) {
        // Do not poll/reap the leader first: its reserved PID keeps the process group safe to
        // signal even when a CLI wrapper exits before a descendant. Rollback follows both signals.
        let pid = self.child.process_id().unwrap_or(0);
        crate::pty::signal_group(pid, &AtomicBool::new(true), libc::SIGTERM);
        std::thread::sleep(Duration::from_millis(500));
        crate::pty::signal_group(pid, &AtomicBool::new(true), libc::SIGKILL);
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_official_browser_consent_is_answered_once_across_chunks() {
        let mut consent = Consent::default();
        assert!(!consent.feed(b"Do you want to continue? [Y/n]: "));
        assert!(!consent.feed(b"\n"));
        for byte in &CONSENT[..CONSENT.len() - 1] {
            assert!(!consent.feed(&[*byte]));
        }
        assert!(consent.feed(&CONSENT[CONSENT.len() - 1..]));
        assert!(!consent.feed(CONSENT));
        assert!(!consent.feed(b"a-private-browser-url-or-token"));
        assert!(consent.tail.is_empty());
    }
    #[test]
    fn teardown_stops_descendants_even_when_the_launcher_exits_first() {
        let dir =
            std::env::temp_dir().join(format!("prometeu-login-child-{}", uuid::Uuid::new_v4()));
        crate::paths::ensure_private_dir(&dir).unwrap();
        let marker = dir.join("child");
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", r#"trap 'exit 0' TERM; sh -c 'trap "" TERM HUP; echo $$ > "$MARKER"; while :; do sleep 1; done' & wait"#]);
        command.env("MARKER", &marker);
        let mut process = LoginProcess::spawn(command).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(3);
        while !marker.exists() && std::time::Instant::now() < until {
            process.poll(&Arc::new(AtomicBool::new(false))).unwrap();
        }
        let child: i32 = std::fs::read_to_string(&marker)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        drop(process);
        let until = std::time::Instant::now() + Duration::from_secs(1);
        while unsafe { libc::kill(child, 0) } == 0 && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        let survived = unsafe { libc::kill(child, 0) } == 0;
        if survived {
            unsafe {
                libc::kill(child, libc::SIGKILL);
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
        assert!(!survived, "a login descendant outlived credential rollback");
    }

    #[test]
    fn private_process_has_tty_and_confirms_browser_consent_without_a_terminal_app() {
        let dir = std::env::temp_dir().join(format!("prometeu-login-{}", uuid::Uuid::new_v4()));
        crate::paths::ensure_private_dir(&dir).unwrap();
        let marker = dir.join("confirmed");
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "test -t 0 && test -t 1 || exit 23; printf '%s' \"$CONSENT\"; IFS= read -r answer; test \"$answer\" = y || exit 24; : > \"$MARKER\"; exec sleep 30"]);
        command.env("CONSENT", String::from_utf8(CONSENT.to_vec()).unwrap());
        command.env("MARKER", &marker);
        let mut process = LoginProcess::spawn(command).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !marker.exists() && std::time::Instant::now() < deadline {
            process.poll(&cancel).unwrap();
        }
        assert!(marker.exists());
        let pid = process.child.process_id().unwrap();
        cancel.store(true, Ordering::Relaxed);
        assert!(process.poll(&cancel).is_err());
        drop(process);
        // The child has been reaped before a failed reconnect may restore its credentials.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
