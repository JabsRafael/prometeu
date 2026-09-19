//! Managed Gemini homes isolate authentication; native history alone is shared for resume.
use crate::{
    accounts::{self, Identity, Profile},
    i18n, paths,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
pub fn user_home() -> PathBuf {
    std::env::var_os("GEMINI_CLI_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(paths::home)
}
const BLOCKED: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_ACCESS_TOKEN",
    "GOOGLE_GENAI_USE_GCA",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
    "GOOGLE_GEMINI_BASE_URL",
    "GOOGLE_VERTEX_BASE_URL",
    "GEMINI_API_KEY_AUTH_MECHANISM",
    "GEMINI_CLI_CUSTOM_HEADERS",
    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
    "CLOUD_SHELL",
    "NO_BROWSER",
];
pub fn prepare_profile(profile: &Profile) -> Result<(), String> {
    let dir = profile.home.join(".gemini");
    paths::ensure_private_dir(&dir).map_err(i18n::io)?;
    accounts::share(&user_home().join(".gemini"), &dir, "tmp", true)?;
    let method = if profile.auth_method.as_deref() == Some("apiKey") {
        "gemini-api-key"
    } else {
        "oauth-personal"
    };
    paths::write_private(&dir.join("settings.json"),&json!({"security":{"auth":{"selectedType":method}},"experimental":{"plan":true},"telemetry":{"enabled":false}}).to_string()).map_err(i18n::io)
}
pub fn account_env(command: &mut Command, profile: &Profile) -> Result<(), String> {
    if !profile.managed {
        return Ok(());
    }
    // Empty values prevent dotenv from reintroducing inherited alternative credentials.
    for key in BLOCKED {
        command.env(key, "");
    }
    command.env("GEMINI_CLI_HOME", &profile.home);
    command.env(
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
        profile.home.join(".gemini/settings.json"),
    );
    if profile.auth_method.as_deref() == Some("apiKey") {
        let key = read_key(&profile.id)?;
        if key.is_empty() {
            return Err(i18n::t("err.gemini.key"));
        }
        command.env("GEMINI_API_KEY", key);
    }
    Ok(())
}
pub fn account_status(profile: &Profile) -> Result<Identity, String> {
    if profile.auth_method.as_deref() == Some("apiKey") {
        return Ok(Identity {
            connected: read_key(&profile.id).is_ok_and(|s| !s.is_empty()),
            email: None,
            plan: None,
        });
    }
    let dir = profile.home.join(".gemini");
    let value = std::fs::read_to_string(dir.join("google_accounts.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    Ok(Identity {
        connected: dir.join("oauth_creds.json").exists(),
        email: value["active"].as_str().map(str::to_owned),
        plan: None,
    })
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
/// The official OAuth consent path requires a TTY in 0.30. Open an isolated Terminal session,
/// leaving all consent and browser interaction to the CLI, then stop it once credentials exist.
pub fn login(
    profile: &Profile,
    cancel: Arc<AtomicBool>,
    commit: impl FnOnce(Identity) -> Result<(), String>,
) -> Result<(), String> {
    if !profile.managed || profile.auth_method.as_deref() != Some("google") {
        return Err(i18n::t("err.account.provider"));
    }
    if !super::installed() {
        return Err(i18n::t("err.gemini.version"));
    }
    let credentials = CredentialBackup::new(&profile.home.join(".gemini"))?;
    let attempt = profile.home.join(format!("login-{}", uuid::Uuid::new_v4()));
    paths::ensure_private_dir(&attempt).map_err(i18n::io)?;
    let script = attempt.join("login.command");
    let wrapper = attempt.join("login.cjs");
    let guard = TerminalLogin {
        directory: attempt.clone(),
    };
    // Only this wrapper owns the CLI process. The app requests cancellation with a private marker,
    // never a saved PID, and the child is reaped before credential rollback.
    paths::write_private(&wrapper, r#"const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cancel = path.join(__dirname, 'cancel');
const done = path.join(__dirname, 'done');
if (fs.existsSync(cancel)) { fs.writeFileSync(done, 'cancelled', {mode:0o600}); process.exit(0); }
const child = spawn('gemini', [], {stdio:'inherit'});
let stopping = false;
let force;
const stop = () => {
  if (stopping || child.exitCode !== null || child.signalCode !== null) return;
  stopping = true;
  child.kill('SIGTERM');
  force = setTimeout(() => child.kill('SIGKILL'), 2000);
};
const timer = setInterval(() => { if (fs.existsSync(cancel)) stop(); }, 100);
const finish = () => { clearInterval(timer); clearTimeout(force); fs.writeFileSync(done, 'done', {mode:0o600}); };
child.on('error', finish);
child.on('close', finish);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
"#).map_err(i18n::io)?;
    let mut text = String::from("#!/bin/sh\n");
    for key in BLOCKED {
        text.push_str(&format!("export {key}=''\n"));
    }
    text.push_str(&format!("export GEMINI_CLI_HOME={}\nexport GEMINI_CLI_SYSTEM_SETTINGS_PATH={}\nexport PATH={}\ncd {}\nexec node {}\n", quote(&profile.home.display().to_string()), quote(&profile.home.join(".gemini/settings.json").display().to_string()), quote(&std::env::var("PATH").unwrap_or_default()), quote(&profile.home.display().to_string()), quote(&wrapper.display().to_string())));
    paths::write_private(&script, &text).map_err(i18n::io)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).map_err(i18n::io)?;
    if !Command::new("open")
        .args(["-a", "Terminal"])
        .arg(&script)
        .status()
        .map_err(|_| i18n::t("err.account.login"))?
        .success()
    {
        return Err(i18n::t("err.account.login"));
    }
    let deadline = Instant::now() + Duration::from_secs(600);
    let result = loop {
        if cancel.load(Ordering::Relaxed) {
            break Err(i18n::t("err.account.cancelled"));
        }
        if Instant::now() >= deadline {
            break Err(i18n::t("err.account.timeout"));
        }
        let identity = account_status(profile)?;
        if identity.connected && identity.email.is_some() {
            break Ok(identity);
        }
        if attempt.join("done").exists() {
            break Err(i18n::t("err.account.login"));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    drop(guard);
    commit_oauth(credentials, result?, commit)
}
fn commit_oauth(
    mut credentials: CredentialBackup,
    identity: Identity,
    commit: impl FnOnce(Identity) -> Result<(), String>,
) -> Result<(), String> {
    commit(identity)?;
    credentials.commit = true;
    Ok(())
}
struct TerminalLogin {
    directory: PathBuf,
}
impl Drop for TerminalLogin {
    fn drop(&mut self) {
        let _ = paths::write_private(&self.directory.join("cancel"), "cancel");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.directory.join("done").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        // Keep cancellation visible if Terminal has not opened yet. A late wrapper exits before
        // spawning a process. Completed attempts contain no secrets and can be removed together.
        if self.directory.join("done").exists() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}

struct CredentialBackup {
    files: Vec<(PathBuf, Option<PathBuf>)>,
    commit: bool,
}
impl CredentialBackup {
    fn new(home: &std::path::Path) -> Result<Self, String> {
        let mut backup = Self {
            files: vec![],
            commit: false,
        };
        for name in ["oauth_creds.json", "google_accounts.json"] {
            let original = home.join(name);
            if original.exists() {
                let saved = home.join(format!("{name}.login-{}", uuid::Uuid::new_v4()));
                std::fs::rename(&original, &saved).map_err(|_| i18n::t("err.account.login"))?;
                backup.files.push((original, Some(saved)));
            } else {
                backup.files.push((original, None));
            }
        }
        Ok(backup)
    }
}
impl Drop for CredentialBackup {
    fn drop(&mut self) {
        for (original, saved) in &self.files {
            match (self.commit, saved) {
                (true, Some(saved)) => {
                    let _ = std::fs::remove_file(saved);
                }
                (false, Some(saved)) => {
                    let _ = std::fs::rename(saved, original);
                }
                (false, None) => {
                    let _ = std::fs::remove_file(original);
                }
                (true, None) => {}
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod vault {
    use std::{ffi::c_void, ptr};
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainFindGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            len: *mut u32,
            data: *mut *mut c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainAddGenericPassword(
            keychain: *const c_void,
            service_len: u32,
            service: *const u8,
            account_len: u32,
            account: *const u8,
            len: u32,
            data: *const c_void,
            item: *mut *mut c_void,
        ) -> i32;
        fn SecKeychainItemModifyAttributesAndData(
            item: *const c_void,
            attributes: *const c_void,
            len: u32,
            data: *const c_void,
        ) -> i32;
        fn SecKeychainItemDelete(item: *const c_void) -> i32;
        fn SecKeychainItemFreeContent(attributes: *const c_void, data: *mut c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }
    const SERVICE: &[u8] = b"com.prometeu.gemini.api-key";
    pub fn read(id: &str) -> Result<Option<String>, ()> {
        unsafe {
            let mut len = 0;
            let mut data = ptr::null_mut();
            let code = SecKeychainFindGenericPassword(
                ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                id.len() as u32,
                id.as_ptr(),
                &mut len,
                &mut data,
                ptr::null_mut(),
            );
            if code == -25300 {
                return Ok(None);
            }
            if code != 0 {
                return Err(());
            }
            let value = String::from_utf8(
                std::slice::from_raw_parts(data.cast::<u8>(), len as usize).to_vec(),
            )
            .map_err(|_| ());
            SecKeychainItemFreeContent(ptr::null(), data);
            value.map(Some)
        }
    }
    pub fn remove(id: &str) -> Result<(), ()> {
        unsafe {
            let mut item = ptr::null_mut();
            let found = SecKeychainFindGenericPassword(
                ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                id.len() as u32,
                id.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut item,
            );
            if found == -25300 {
                return Ok(());
            }
            if found != 0 {
                return Err(());
            }
            let result = SecKeychainItemDelete(item);
            CFRelease(item);
            if result == 0 {
                Ok(())
            } else {
                Err(())
            }
        }
    }
    pub fn save(id: &str, key: &str) -> Result<(), ()> {
        unsafe {
            let mut item = ptr::null_mut();
            let found = SecKeychainFindGenericPassword(
                ptr::null(),
                SERVICE.len() as u32,
                SERVICE.as_ptr(),
                id.len() as u32,
                id.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut item,
            );
            let code = if found == 0 {
                let result = SecKeychainItemModifyAttributesAndData(
                    item,
                    ptr::null(),
                    key.len() as u32,
                    key.as_ptr().cast(),
                );
                CFRelease(item);
                result
            } else if found == -25300 {
                SecKeychainAddGenericPassword(
                    ptr::null(),
                    SERVICE.len() as u32,
                    SERVICE.as_ptr(),
                    id.len() as u32,
                    id.as_ptr(),
                    key.len() as u32,
                    key.as_ptr().cast(),
                    ptr::null_mut(),
                )
            } else {
                found
            };
            if code == 0 {
                Ok(())
            } else {
                Err(())
            }
        }
    }
}
fn read_key(id: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        vault::read(id)
            .map_err(|_| i18n::t("err.gemini.key"))?
            .ok_or_else(|| i18n::t("err.gemini.key"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err(i18n::t("err.gemini.key"))
    }
}
pub fn update_key<T>(
    id: &str,
    key: &str,
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if uuid::Uuid::parse_str(id)
        .map(|v| v.to_string())
        .ok()
        .as_deref()
        != Some(id)
        || key.trim().chars().count() < 8
        || key.contains(['\n', '\r', '\0'])
        || key.trim() != key
    {
        return Err(i18n::t("err.gemini.key"));
    }
    #[cfg(target_os = "macos")]
    {
        let previous = vault::read(id).map_err(|_| i18n::t("err.gemini.key"))?;
        key_transaction(
            previous,
            key,
            |value| {
                match value {
                    Some(key) => vault::save(id, key),
                    None => vault::remove(id),
                }
                .map_err(|_| i18n::t("err.gemini.key"))
            },
            commit,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = commit;
        Err(i18n::t("err.gemini.key"))
    }
}
fn key_transaction<T>(
    previous: Option<String>,
    key: &str,
    mut write: impl FnMut(Option<&str>) -> Result<(), String>,
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    write(Some(key))?;
    match commit() {
        Ok(value) => Ok(value),
        Err(error) => {
            write(previous.as_deref())?;
            Err(error)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_google_env_neutralizes_dotenv_and_fixed_keychain() {
        let p = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            provider: crate::state::ProviderId::Gemini,
            home: "/tmp/isolated".into(),
            managed: true,
            revision: 0,
            auth_method: Some("google".into()),
        };
        let mut c = Command::new("gemini");
        account_env(&mut c, &p).unwrap();
        let env: std::collections::HashMap<_, _> = c.get_envs().collect();
        for key in BLOCKED {
            if *key == "GEMINI_CLI_SYSTEM_SETTINGS_PATH" {
                continue;
            }
            assert_eq!(
                env[std::ffi::OsStr::new(key)],
                Some(std::ffi::OsStr::new(""))
            );
        }
        assert_eq!(
            env[std::ffi::OsStr::new("GEMINI_CLI_HOME")],
            Some(std::ffi::OsStr::new("/tmp/isolated"))
        );
    }
    #[test]
    fn failed_reconnect_restores_only_the_managed_credentials() {
        let dir =
            std::env::temp_dir().join(format!("prometeu-gemini-backup-{}", uuid::Uuid::new_v4()));
        paths::ensure_private_dir(&dir).unwrap();
        let file = dir.join("oauth_creds.json");
        paths::write_private(&file, "old-private-value").unwrap();
        {
            let _backup = CredentialBackup::new(&dir).unwrap();
            assert!(!file.exists());
            paths::write_private(&file, "failed-replacement").unwrap();
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "old-private-value");
        {
            let mut backup = CredentialBackup::new(&dir).unwrap();
            paths::write_private(&file, "new-private-value").unwrap();
            backup.commit = true;
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new-private-value");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn key_change_rolls_back_when_registry_write_fails() {
        for previous in [None, Some("old-private-key".into())] {
            let vault = std::cell::RefCell::new(previous.clone());
            let result: Result<(), String> = key_transaction(
                previous.clone(),
                "new-private-key",
                |value| {
                    *vault.borrow_mut() = value.map(str::to_owned);
                    Ok(())
                },
                || Err("store failed".into()),
            );
            assert!(result.is_err());
            assert_eq!(*vault.borrow(), previous);
        }
    }
    #[test]
    fn oauth_rollback_covers_registry_failure_and_late_cancellation() {
        for cause in ["store failed", "cancelled"] {
            let dir = std::env::temp_dir()
                .join(format!("prometeu-oauth-commit-{}", uuid::Uuid::new_v4()));
            paths::ensure_private_dir(&dir).unwrap();
            let path = dir.join("oauth_creds.json");
            paths::write_private(&path, "old-private").unwrap();
            let guard = CredentialBackup::new(&dir).unwrap();
            paths::write_private(&path, "new-private").unwrap();
            assert!(commit_oauth(guard, Identity::default(), |_| Err(cause.into())).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "old-private");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}
