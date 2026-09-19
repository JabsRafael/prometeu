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
/// Run the official browser OAuth flow on an app-owned PTY. No terminal window or model session
/// is opened; the CLI alone owns the URL, callback server, token exchange and credential files.
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
    let mut process = super::login::LoginProcess::spawn(login_command(profile)?)?;
    let deadline = Instant::now() + Duration::from_secs(600);
    let identity = loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(i18n::t("err.account.cancelled"));
        }
        if Instant::now() >= deadline {
            return Err(i18n::t("err.account.timeout"));
        }
        let identity = account_status(profile)?;
        if identity.connected && identity.email.is_some() {
            break identity;
        }
        process.poll(&cancel)?;
    };
    drop(process);
    commit_oauth(credentials, identity, commit)
}
fn login_command(profile: &Profile) -> Result<portable_pty::CommandBuilder, String> {
    let mut environment = Command::new("gemini");
    account_env(&mut environment, profile)?;
    let mut command = portable_pty::CommandBuilder::new("gemini");
    command.arg("--experimental-acp");
    command.cwd(&profile.home);
    for (key, value) in environment.get_envs() {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    // The login has an explicit user action and a private TTY, even if the desktop inherited CI.
    command.env("CI", "");
    command.env("GITHUB_ACTIONS", "");
    command.env("TERM", "xterm-256color");
    Ok(command)
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
    #[ignore = "requires Gemini CLI and OAuth network access; intercepts browser without login or credentials"]
    fn real_cli_requests_browser_login_without_opening_terminal() {
        assert!(super::super::installed());
        let home =
            std::env::temp_dir().join(format!("prometeu-gemini-browser-{}", uuid::Uuid::new_v4()));
        paths::ensure_private_dir(&home.join(".gemini")).unwrap();
        paths::ensure_private_dir(&home.join("bin")).unwrap();
        paths::write_private(&home.join(".gemini/settings.json"),
            r#"{"security":{"auth":{"selectedType":"oauth-personal"}},"telemetry":{"enabled":false}}"#).unwrap();
        let opener = home.join("bin/open");
        paths::write_private(&opener, "#!/bin/sh\ncase \"$1\" in\nhttps://accounts.google.com/*) : > \"$GEMINI_CLI_HOME/browser-requested\" ;;\n*) : > \"$GEMINI_CLI_HOME/unexpected-open\" ;;\nesac\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&opener, std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            provider: crate::state::ProviderId::Gemini,
            home: home.clone(),
            managed: true,
            revision: 0,
            auth_method: Some("google".into()),
        };
        let mut command = login_command(&profile).unwrap();
        command.env(
            "PATH",
            format!(
                "{}:{}",
                home.join("bin").display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
        let mut process = super::super::login::LoginProcess::spawn(command).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let until = Instant::now() + Duration::from_secs(45);
        while !home.join("browser-requested").exists()
            && !home.join("unexpected-open").exists()
            && Instant::now() < until
        {
            process.poll(&cancel).unwrap();
        }
        let browser = home.join("browser-requested").exists();
        let unexpected = home.join("unexpected-open").exists();
        drop(process);
        assert!(!home.join(".gemini/oauth_creds.json").exists());
        std::fs::remove_dir_all(home).unwrap();
        assert!(browser, "CLI did not request the Google browser flow");
        assert!(
            !unexpected,
            "CLI tried to open something other than the Google auth URL"
        );
    }

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
