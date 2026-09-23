//! Linux banners and sounds. notify-send has no per-app authorization, so its presence counts as
//! granted.
use super::{Notice, Tone};
use crate::{i18n, lock::lock, platform};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};

const NOTIFY: &str = "notify-send";

pub fn permission() -> String {
    if platform::has(NOTIFY) {
        "granted"
    } else {
        "unavailable"
    }
    .into()
}

/// notify-send --wait prints the clicked action when the banner closes; the watcher reports it.
pub fn banner(app: &tauri::AppHandle, notice: &Notice) -> Result<(), String> {
    if !platform::has(NOTIFY) {
        return Err(i18n::t("err.notifications.unavailable"));
    }
    let mut cmd = Command::new(NOTIFY);
    cmd.args(["--app-name=Prometeu", "--wait"]);
    // Test notices have no conversation to open.
    if notice.tab.is_some() {
        cmd.arg(format!("--action=default={}", notice.open_label));
    }
    let mut child = cmd
        .arg("--")
        .arg(&notice.title)
        .arg(&notice.body)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(i18n::io)?;
    // Without a notification daemon, notify-send fails at once.
    let deadline = Instant::now() + Duration::from_millis(300);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) if !status.success() => {
                return Err(i18n::t("err.notifications.unavailable"))
            }
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(i18n::io(error)),
        }
    }
    watch(app);
    lock(&LIVE).insert(notice.tab.clone().unwrap_or_default(), child);
    Ok(())
}

/// Waiting notify-send processes, one per tab ("" for tests); a newer notice ends the previous one.
static LIVE: Mutex<Live> = Mutex::new(Live(Vec::new()));

struct Live(Vec<(String, Child)>);

impl Live {
    fn insert(&mut self, key: String, child: Child) {
        if let Some(at) = self.0.iter().position(|(k, _)| *k == key) {
            let (_, mut old) = self.0.swap_remove(at);
            end(&mut old);
        }
        self.0.push((key, child));
    }

    /// Remove exited processes and return the tabs whose banner was clicked.
    fn reap(&mut self) -> Vec<String> {
        let mut clicked = Vec::new();
        self.0.retain_mut(|(key, child)| {
            if matches!(child.try_wait(), Ok(None)) {
                return true;
            }
            let mut out = String::new();
            if let Some(mut stdout) = child.stdout.take() {
                let _ = stdout.read_to_string(&mut out);
            }
            if !key.is_empty() && out.trim() == "default" {
                clicked.push(key.clone());
            }
            false
        });
        clicked
    }

    fn clear(&mut self) {
        for (_, mut child) in self.0.drain(..) {
            end(&mut child);
        }
    }
}

fn end(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// A single polling watcher reaps every banner process.
fn watch(app: &tauri::AppHandle) {
    static STARTED: Once = Once::new();
    let app = app.clone();
    STARTED.call_once(move || {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            for tab in lock(&LIVE).reap() {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = super::open_tab(&handle, Some(&tab));
                });
            }
        });
    });
}

pub fn shutdown() {
    lock(&LIVE).clear();
}

/// Freedesktop sound theme event IDs.
fn event(tone: Tone) -> &'static str {
    match tone {
        Tone::Soft => "message-new-instant",
        Tone::Digital => "complete",
        Tone::Bell => "bell",
    }
}

pub fn sound(tone: Tone) -> Result<(), String> {
    let id = event(tone);
    let file = format!("/usr/share/sounds/freedesktop/stereo/{id}.oga");
    let attempts: [(&str, Vec<&str>); 3] = [
        ("canberra-gtk-play", vec!["-i", id]),
        ("pw-play", vec![&file]),
        ("paplay", vec![&file]),
    ];
    for (program, args) in attempts {
        if !platform::has(program) {
            continue;
        }
        let played = Command::new(program)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if played {
            return Ok(());
        }
    }
    Err(i18n::t("err.notifications.sound"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waiting() -> Child {
        Command::new("sleep").arg("30").spawn().unwrap()
    }

    fn clicked() -> Child {
        Command::new("echo")
            .arg("default")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap()
    }

    #[test]
    fn a_newer_banner_for_the_same_tab_ends_the_previous_process() {
        let mut live = Live(Vec::new());
        live.insert("tab".into(), waiting());
        let first = live.0[0].1.id();
        live.insert("tab".into(), waiting());
        live.insert("other".into(), waiting());
        assert_eq!(live.0.len(), 2);
        assert!(live.0.iter().all(|(_, child)| child.id() != first));
        live.clear();
        assert!(live.0.is_empty());
    }

    #[test]
    fn reaping_reports_clicks_only_for_conversation_banners() {
        let mut live = Live(Vec::new());
        live.insert("tab".into(), clicked());
        live.insert(String::new(), clicked());
        live.insert("open".into(), waiting());
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(live.reap(), ["tab"]);
        assert_eq!(live.0.len(), 1);
        live.clear();
    }

    #[test]
    fn tones_map_to_distinct_theme_events() {
        let events = [Tone::Soft, Tone::Digital, Tone::Bell].map(event);
        assert_eq!(events, ["message-new-instant", "complete", "bell"]);
    }
}
