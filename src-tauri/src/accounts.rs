//! Accounts on this Mac. Selection is global per provider; each process captures an immutable
//! profile and changes accounts only between turns.

use crate::lock::lock;
use crate::state::ProviderId;
use crate::{claude, codex, i18n, paths};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub connected: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_suffix: Option<String>,
    pub id: String,
    pub provider: ProviderId,
    #[serde(default)]
    pub revision: u64,
    #[serde(flatten)]
    pub identity: Identity,
}

#[derive(Clone, PartialEq)]
pub struct Registry {
    pub accounts: Vec<Account>,
    pub active: BTreeMap<String, String>,
    unknown_accounts: Vec<Value>,
    unknown_active: Map<String, Value>,
}

impl Default for Registry {
    fn default() -> Self {
        let accounts = [ProviderId::Claude, ProviderId::Codex]
            .into_iter()
            .map(|provider| Account {
                auth_method: None,
                key_suffix: None,
                id: key(provider).into(),
                provider,
                revision: 0,
                identity: Identity::default(),
            })
            .collect();
        Self {
            accounts,
            active: BTreeMap::from([
                ("claude".into(), "claude".into()),
                ("codex".into(), "codex".into()),
            ]),
            unknown_accounts: Vec::new(),
            unknown_active: Map::new(),
        }
    }
}

impl Serialize for Registry {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut accounts = self
            .accounts
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(serde::ser::Error::custom)?;
        accounts.extend(self.unknown_accounts.iter().cloned());
        let mut active = self.unknown_active.clone();
        active.extend(
            self.active
                .iter()
                .map(|(provider, id)| (provider.clone(), Value::String(id.clone()))),
        );
        let mut state = serializer.serialize_struct("Registry", 2)?;
        state.serialize_field("accounts", &accounts)?;
        state.serialize_field("active", &active)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for Registry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("registry must be an object"))?;
        let mut accounts = Vec::new();
        let mut unknown_accounts = Vec::new();
        for value in object
            .get("accounts")
            .and_then(Value::as_array)
            .ok_or_else(|| serde::de::Error::custom("accounts must be an array"))?
        {
            match value.get("provider").and_then(Value::as_str) {
                Some("claude" | "codex" | "gemini") => accounts
                    .push(serde_json::from_value(value.clone()).map_err(serde::de::Error::custom)?),
                Some(_) => unknown_accounts.push(value.clone()),
                None => {
                    return Err(serde::de::Error::custom(
                        "account provider must be a string",
                    ))
                }
            }
        }
        let mut active = BTreeMap::new();
        let mut unknown_active = Map::new();
        for (provider, value) in object
            .get("active")
            .and_then(Value::as_object)
            .ok_or_else(|| serde::de::Error::custom("active must be an object"))?
        {
            if matches!(provider.as_str(), "claude" | "codex" | "gemini") {
                active.insert(
                    provider.clone(),
                    value
                        .as_str()
                        .ok_or_else(|| serde::de::Error::custom("active account must be a string"))?
                        .to_owned(),
                );
            } else {
                unknown_active.insert(provider.clone(), value.clone());
            }
        }
        Ok(Self {
            accounts,
            active,
            unknown_accounts,
            unknown_active,
        })
    }
}

impl Registry {
    fn validate(&self) -> Result<(), String> {
        let mut ids = std::collections::HashSet::new();
        for account in &self.accounts {
            if !ids.insert(&account.id)
                || (account.id != key(account.provider)
                    && uuid::Uuid::parse_str(&account.id)
                        .map(|id| id.to_string())
                        .ok()
                        .as_deref()
                        != Some(&account.id))
            {
                return Err(i18n::t("err.account.store"));
            }
        }
        for (provider, id) in &self.active {
            if !self
                .accounts
                .iter()
                .any(|account| key(account.provider) == provider && &account.id == id)
            {
                return Err(i18n::t("err.account.store"));
            }
        }
        Ok(())
    }

    fn find(&self, id: &str) -> Result<&Account, String> {
        self.accounts
            .iter()
            .find(|account| account.id == id)
            .ok_or_else(|| i18n::t("err.account.missing"))
    }

    fn select(&mut self, id: &str) -> Result<(), String> {
        let account = self.find(id)?;
        if !account.identity.connected && account.id != key(account.provider) {
            return Err(i18n::t("err.account.disconnected"));
        }
        self.active.insert(key(account.provider).into(), id.into());
        Ok(())
    }

    fn remove(&mut self, id: &str) -> Result<(), String> {
        let account = self.find(id)?;
        let provider = key(account.provider);
        if self.active.get(provider).is_some_and(|active| active == id) {
            self.active.remove(provider);
        }
        self.accounts.retain(|account| account.id != id);
        Ok(())
    }
}

pub fn key(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Claude => "claude",
        ProviderId::Codex => "codex",
        ProviderId::Gemini => "gemini",
    }
}

fn provider(value: &str) -> Result<ProviderId, String> {
    match value {
        "claude" => Ok(ProviderId::Claude),
        "codex" => Ok(ProviderId::Codex),
        "gemini" => Ok(ProviderId::Gemini),
        _ => Err(i18n::t("err.account.provider")),
    }
}

fn registry() -> &'static Mutex<Result<Registry, String>> {
    static REGISTRY: OnceLock<Mutex<Result<Registry, String>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(read(&paths::root().join("accounts.json"))))
}

fn read(path: &Path) -> Result<Registry, String> {
    let body = match std::fs::read_to_string(path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Registry::default())
        }
        Err(error) => return Err(i18n::io(error)),
    };
    let registry: Registry =
        serde_json::from_str(&body).map_err(|_| i18n::t("err.account.store"))?;
    registry.validate()?;
    Ok(registry)
}

fn change(update: impl FnOnce(&mut Registry) -> Result<(), String>) -> Result<(), String> {
    let mut guard = lock(registry());
    let current = guard.as_mut().map_err(|error| error.clone())?;
    let mut next = current.clone();
    update(&mut next)?;
    next.validate()?;
    if &next == current {
        return Ok(());
    }
    paths::write_private(
        &paths::root().join("accounts.json"),
        &serde_json::to_string(&next).map_err(i18n::io)?,
    )
    .map_err(i18n::io)?;
    *current = next;
    Ok(())
}

#[derive(Clone)]
pub struct Profile {
    pub auth_method: Option<String>,
    pub id: String,
    pub provider: ProviderId,
    pub home: PathBuf,
    pub managed: bool,
    pub revision: u64,
}

impl Profile {
    fn of(account: &Account) -> Self {
        let managed = account.id != key(account.provider);
        Self {
            auth_method: account.auth_method.clone(),
            id: account.id.clone(),
            provider: account.provider,
            managed,
            revision: account.revision,
            home: if managed {
                paths::root().join("accounts").join(&account.id)
            } else {
                match account.provider {
                    ProviderId::Claude => claude::user_home(),
                    ProviderId::Codex => codex::user_home(),
                    ProviderId::Gemini => crate::gemini::user_home(),
                }
            },
        }
    }

    pub fn prepare(&self) -> Result<(), String> {
        if !self.managed {
            return Ok(());
        }
        paths::ensure_private_dir(&self.home).map_err(i18n::io)?;
        match self.provider {
            ProviderId::Claude => claude::prepare_profile(self),
            ProviderId::Codex => codex::prepare_profile(self),
            ProviderId::Gemini => crate::gemini::prepare_profile(self),
        }
    }

    pub fn apply(&self, command: &mut Command) -> Result<(), String> {
        match self.provider {
            ProviderId::Claude => claude::account_env(command, self),
            ProviderId::Codex => codex::account_env(command, self),
            ProviderId::Gemini => return crate::gemini::account_env(command, self),
        }
        Ok(())
    }
}

pub fn active(provider: ProviderId) -> Result<Profile, String> {
    let guard = lock(registry());
    let data = guard.as_ref().map_err(Clone::clone)?;
    Ok(Profile::of(
        data.find(
            data.active
                .get(key(provider))
                .ok_or_else(|| i18n::t("err.account.noActive"))?,
        )?,
    ))
}

pub fn profiles() -> Result<Vec<Profile>, String> {
    let guard = lock(registry());
    let data = guard.as_ref().map_err(Clone::clone)?;
    Ok(data.accounts.iter().map(Profile::of).collect())
}

/// Link only explicitly shared data. Login, tokens, identity, and authentication caches remain
/// private to the profile.
pub fn share(base: &Path, home: &Path, name: &str, directory: bool) -> Result<(), String> {
    let source = base.join(name);
    let target = home.join(name);
    if directory {
        paths::ensure_private_dir(&source).map_err(i18n::io)?;
    }
    if !source.exists() {
        return Ok(());
    }
    match std::fs::symlink_metadata(&target) {
        Ok(metadata)
            if metadata.file_type().is_symlink()
                && std::fs::read_link(&target).ok().as_ref() == Some(&source) =>
        {
            Ok(())
        }
        Ok(_) => Err(i18n::t("err.account.profile")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::os::unix::fs::symlink(&source, &target) {
                Ok(()) => Ok(()),
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists
                        && std::fs::read_link(&target).ok().as_ref() == Some(&source) =>
                {
                    Ok(())
                }
                Err(error) => Err(i18n::io(error)),
            }
        }
        Err(error) => Err(i18n::io(error)),
    }
}

#[derive(Clone, Serialize)]
pub struct LoginStatus {
    pub id: String,
    pub provider: ProviderId,
}
struct Login {
    status: LoginStatus,
    cancel: Arc<AtomicBool>,
}
fn pending() -> &'static Mutex<Option<Login>> {
    static LOGIN: Mutex<Option<Login>> = Mutex::new(None);
    &LOGIN
}

#[derive(Clone)]
pub struct Snapshot {
    registry: Registry,
    login: Option<LoginStatus>,
}

impl Serialize for Snapshot {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("Snapshot", 3)?;
        state.serialize_field("accounts", &self.registry.accounts)?;
        state.serialize_field("active", &self.registry.active)?;
        state.serialize_field("login", &self.login)?;
        state.end()
    }
}

#[tauri::command]
pub fn accounts() -> Result<Snapshot, String> {
    let data = lock(registry()).as_ref().map_err(Clone::clone)?.clone();
    let login = lock(pending()).as_ref().map(|login| login.status.clone());
    Ok(Snapshot {
        registry: data,
        login,
    })
}

pub fn publish(app: &AppHandle) {
    if let Ok(snapshot) = accounts() {
        let _ = app.emit("accounts", snapshot);
    }
}

#[tauri::command]
pub fn account_select(app: AppHandle, id: String) -> Result<Snapshot, String> {
    if lock(pending())
        .as_ref()
        .is_some_and(|login| login.status.id == id)
    {
        return Err(i18n::t("err.account.busy"));
    }
    change(|data| data.select(&id))?;
    publish(&app);
    accounts()
}

#[tauri::command]
pub fn account_remove(app: AppHandle, id: String) -> Result<Snapshot, String> {
    {
        let pending = lock(pending());
        if pending.is_some() {
            return Err(i18n::t("err.account.busy"));
        }
        // ponytail: removal forgets the registration; deleting profiles requires coordinating
        // processes that still use their credentials and history links.
        change(|data| data.remove(&id))?;
    }
    publish(&app);
    accounts()
}

#[tauri::command]
pub fn account_api_key(
    app: AppHandle,
    provider: String,
    id: Option<String>,
    key: String,
) -> Result<Snapshot, String> {
    if self::provider(&provider)? != ProviderId::Gemini {
        return Err(i18n::t("err.account.provider"));
    }
    let pending = lock(pending());
    if pending.is_some() {
        return Err(i18n::t("err.account.busy"));
    }
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if uuid::Uuid::parse_str(&id)
        .map(|v| v.to_string())
        .ok()
        .as_deref()
        != Some(id.as_str())
    {
        return Err(i18n::t("err.account.external"));
    }
    {
        let guard = lock(registry());
        let data = guard.as_ref().map_err(Clone::clone)?;
        if let Ok(account) = data.find(&id) {
            if account.provider != ProviderId::Gemini
                || account.auth_method.as_deref() != Some("apiKey")
            {
                return Err(i18n::t("err.account.provider"));
            }
        }
    }
    if lock(&app.state::<crate::AppState>().chats)
        .values()
        .any(|chat| chat.account() == id && chat.working())
    {
        return Err(i18n::t("err.account.working"));
    }
    let suffix: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    crate::gemini::update_key(&id, &key, || {
        change(|data| {
            if let Some(account) = data.accounts.iter_mut().find(|a| a.id == id) {
                account.revision += 1;
                account.identity.connected = true;
                account.key_suffix = Some(suffix.clone());
            } else {
                data.accounts.push(Account {
                    id: id.clone(),
                    provider: ProviderId::Gemini,
                    revision: 1,
                    identity: Identity {
                        connected: true,
                        email: None,
                        plan: None,
                    },
                    auth_method: Some("apiKey".into()),
                    key_suffix: Some(suffix.clone()),
                });
            }
            Ok(())
        })
    })?;
    drop(pending);
    crate::usage::forget(&app, &id);
    publish(&app);
    accounts()
}

#[tauri::command]
pub fn account_login_cancel(id: String) {
    if let Some(login) = lock(pending())
        .as_ref()
        .filter(|login| login.status.id == id)
    {
        login.cancel.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn account_login(
    app: AppHandle,
    provider: String,
    id: Option<String>,
    method: Option<String>,
) -> Result<Snapshot, String> {
    let provider = self::provider(&provider)?;
    let method = method.unwrap_or_else(|| {
        if provider == ProviderId::Gemini {
            "google"
        } else {
            "browser"
        }
        .into()
    });
    if (provider == ProviderId::Gemini && method != "google")
        || (provider != ProviderId::Gemini && method != "browser")
    {
        return Err(i18n::t("err.account.provider"));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let profile = {
        let mut pending = lock(pending());
        if pending.is_some() {
            return Err(i18n::t("err.account.busy"));
        }
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        change(|data| {
            if let Ok(account) = data.find(&id) {
                if account.provider != provider {
                    return Err(i18n::t("err.account.provider"));
                }
                if account
                    .auth_method
                    .as_deref()
                    .is_some_and(|old| old != method)
                {
                    return Err(i18n::t("err.account.provider"));
                }
                // The app never disconnects or replaces the terminal's account.
                if account.id == key(provider) {
                    return Err(i18n::t("err.account.external"));
                }
            } else {
                data.accounts.push(Account {
                    auth_method: Some(method.clone()),
                    key_suffix: None,
                    id: id.clone(),
                    provider,
                    revision: 0,
                    identity: Identity::default(),
                });
            }
            Ok(())
        })?;
        let profile = {
            let guard = lock(registry());
            Profile::of(guard.as_ref().map_err(Clone::clone)?.find(&id)?)
        };
        *pending = Some(Login {
            status: LoginStatus { id, provider },
            cancel: cancel.clone(),
        });
        profile
    };
    // Login blocks new messages before this check. Refresh must not replace credentials during an
    // active turn.
    if lock(&app.state::<crate::AppState>().chats)
        .values()
        .any(|chat| chat.account() == profile.id && chat.working())
    {
        *lock(pending()) = None;
        publish(&app);
        return Err(i18n::t("err.account.working"));
    }
    publish(&app);
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        profile.prepare()?;
        let commit = |identity| {
            if cancel.load(Ordering::Relaxed) {
                return Err(i18n::t("err.account.cancelled"));
            }
            change(|data| {
                let account = data
                    .accounts
                    .iter_mut()
                    .find(|account| account.id == profile.id)
                    .ok_or_else(|| i18n::t("err.account.missing"))?;
                account.identity = identity;
                account.revision += 1;
                Ok(())
            })
        };
        match provider {
            ProviderId::Gemini => crate::gemini::login(&profile, cancel.clone(), commit)?,
            ProviderId::Claude => commit(claude::login(&profile, cancel.clone())?)?,
            ProviderId::Codex => commit(codex::login(&profile, cancel.clone())?)?,
        }
        crate::usage::forget(&handle, &profile.id);
        Ok(())
    })
    .await
    .map_err(i18n::io)
    .and_then(|result| result);
    *lock(pending()) = None;
    publish(&app);
    result?;
    accounts()
}

pub fn set_identity(app: &AppHandle, id: &str, identity: Identity) -> Result<(), String> {
    if lock(registry())
        .as_ref()
        .map_err(Clone::clone)?
        .find(id)?
        .identity
        == identity
    {
        return Ok(());
    }
    change(|data| {
        let account = data
            .accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| i18n::t("err.account.missing"))?;
        account.identity = identity;
        Ok(())
    })?;
    publish(app);
    Ok(())
}

pub fn logging_in(id: &str) -> bool {
    lock(pending())
        .as_ref()
        .is_some_and(|login| login.status.id == id)
}

pub fn shutdown() {
    if let Some(login) = lock(pending()).as_ref() {
        login.cancel.store(true, Ordering::Relaxed);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while lock(pending()).is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Authentication subprocess with private output, timeout, and cancellation. Drop stops descendants
/// and reaps the child on every error path.
pub struct AuthProcess {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    deadline: Instant,
    cancel: Arc<AtomicBool>,
}

impl AuthProcess {
    pub fn spawn(
        mut command: Command,
        timeout: Duration,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = command.spawn().map_err(i18n::io)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| i18n::t("err.account.login"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| i18n::t("err.account.login"))?;
        let (send, lines) = mpsc::sync_channel(64);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.len() > 1_048_576 || send.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            lines,
            deadline: Instant::now() + timeout,
            cancel,
        })
    }

    pub fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(i18n::t("err.account.cancelled"));
        }
        if Instant::now() >= self.deadline {
            return Err(i18n::t("err.account.timeout"));
        }
        Ok(())
    }

    pub fn send(&mut self, value: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{value}")
            .and_then(|()| self.stdin.flush())
            .map_err(i18n::io)
    }

    pub fn line(&mut self) -> Result<Option<String>, String> {
        loop {
            self.check()?;
            match self.lines.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => return Ok(Some(line)),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    pub fn finish(&mut self) -> Result<(), String> {
        loop {
            self.check()?;
            if let Some(status) = self.child.try_wait().map_err(i18n::io)? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(i18n::t("err.account.login"))
                };
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for AuthProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            crate::pty::signal_group(self.child.id(), &AtomicBool::new(true), libc::SIGKILL);
        }
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cadastro_novo_preserva_o_cli_e_persiste_selecao_independente() {
        let dir = std::env::temp_dir().join(format!("prometeu-accounts-{}", uuid::Uuid::new_v4()));
        let path = dir.join("accounts.json");
        let mut registry = read(&path).unwrap();
        assert_eq!(registry.active["claude"], "claude");
        assert_eq!(registry.active["codex"], "codex");
        let id = uuid::Uuid::new_v4().to_string();
        registry.accounts.push(Account {
            auth_method: None,
            key_suffix: None,
            id: id.clone(),
            provider: ProviderId::Codex,
            revision: 1,
            identity: Identity {
                connected: true,
                email: Some("trabalho@example.com".into()),
                plan: Some("pro".into()),
            },
        });
        registry.select(&id).unwrap();
        assert_eq!(registry.active["claude"], "claude");
        assert_eq!(registry.active["codex"], id);
        paths::write_private(&path, &serde_json::to_string(&registry).unwrap()).unwrap();
        let loaded = read(&path).unwrap();
        assert!(loaded == registry);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        registry.accounts.last_mut().unwrap().identity.connected = false;
        assert!(registry.select(&id).is_err());
        registry.accounts.last_mut().unwrap().id = "../fora".into();
        assert!(registry.validate().is_err());
        std::fs::write(&path, "cadastro truncado").unwrap();
        assert!(read(&path).is_err());
        assert!(provider("desconhecido").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remocao_aceita_todas_as_contas_e_cadastro_antigo_com_apelido() {
        let mut legacy = serde_json::to_value(Registry::default()).unwrap();
        let codex = uuid::Uuid::new_v4().to_string();
        let claude = uuid::Uuid::new_v4().to_string();
        for (id, provider) in [(&codex, "codex"), (&claude, "claude")] {
            legacy["accounts"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "id": id, "provider": provider, "label": "apelido antigo",
                    "connected": true, "email": "pessoal@example.com", "plan": "pro"
                }));
        }
        let mut registry: Registry = serde_json::from_value(legacy).unwrap();
        registry.validate().unwrap();
        assert!(serde_json::to_value(&registry).unwrap()["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|account| account.get("label").is_none()));
        registry.select(&claude).unwrap();
        let before = registry.clone();
        assert!(registry.remove("../fora").is_err());
        assert!(registry == before);

        registry.remove(&codex).unwrap();
        assert_eq!(registry.active["codex"], "codex");
        assert_eq!(registry.active["claude"], claude);
        assert!(registry.find(&codex).is_err());
        registry.remove(&claude).unwrap();
        assert!(!registry.active.contains_key("claude"));
        assert_eq!(registry.accounts.len(), 2);
        registry.validate().unwrap();
        registry.remove("claude").unwrap();
        registry.remove("codex").unwrap();
        assert!(registry.accounts.is_empty());
        assert!(registry.active.is_empty());
        registry.validate().unwrap();

        let dir = std::env::temp_dir().join(format!("prometeu-accounts-{}", uuid::Uuid::new_v4()));
        let path = dir.join("accounts.json");
        paths::write_private(&path, &serde_json::to_string(&registry).unwrap()).unwrap();
        let restored = read(&path).unwrap();
        assert!(restored == registry);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cadastro_futuro_sobrevive_ao_round_trip_sem_aparecer_na_interface() {
        let dir = std::env::temp_dir().join(format!("prometeu-accounts-{}", uuid::Uuid::new_v4()));
        let path = dir.join("accounts.json");
        let future = serde_json::json!({
            "id": "future-provider",
            "provider": "future-provider",
            "connected": true,
            "email": "future@example.com",
            "plan": { "tier": "ultra" },
            "futureField": [1, 2, 3]
        });
        paths::write_private(
            &path,
            &serde_json::json!({
                "accounts": [
                    {
                        "id": "claude", "provider": "claude", "revision": 0,
                        "connected": false, "email": null, "plan": null
                    },
                    future.clone()
                ],
                "active": { "claude": "claude", "future-provider": "future-provider" }
            })
            .to_string(),
        )
        .unwrap();

        let mut registry = read(&path).unwrap();
        assert_eq!(registry.accounts.len(), 1);
        assert_eq!(registry.active.len(), 1);
        assert_eq!(
            serde_json::to_value(Snapshot {
                registry: registry.clone(),
                login: None,
            })
            .unwrap(),
            serde_json::json!({
                "accounts": [{
                    "id": "claude", "provider": "claude", "revision": 0,
                    "connected": false, "email": null, "plan": null
                }],
                "active": { "claude": "claude" },
                "login": null
            })
        );
        registry.remove("claude").unwrap();

        let stored = serde_json::to_value(&registry).unwrap();
        assert_eq!(stored["accounts"], serde_json::json!([future]));
        assert_eq!(
            stored["active"],
            serde_json::json!({ "future-provider": "future-provider" })
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cadastro_futuro_nao_relaxa_validacao_de_conta_conhecida() {
        let dir = std::env::temp_dir().join(format!("prometeu-accounts-{}", uuid::Uuid::new_v4()));
        let path = dir.join("accounts.json");
        paths::write_private(
            &path,
            &serde_json::json!({
                "accounts": [
                    { "provider": "claude", "connected": false },
                    { "provider": "future-provider", "payload": { "version": 2 } }
                ],
                "active": {}
            })
            .to_string(),
        )
        .unwrap();

        assert!(read(&path).is_err());

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn login_cancelado_encerra_processo_sem_devolver_saida_privada() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut command = Command::new("sh");
        command.args(["-c", "printf 'pronto\\n'; exec sleep 30"]);
        let mut process =
            AuthProcess::spawn(command, Duration::from_secs(5), cancel.clone()).unwrap();
        assert_eq!(process.line().unwrap().as_deref(), Some("pronto"));
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(
            process.line().unwrap_err(),
            i18n::t("err.account.cancelled")
        );
        let pid = process.child.id();
        drop(process);
        // Drop reaps the child so no orphaned login server remains.
        assert_eq!(
            unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) },
            -1
        );
    }
    #[test]
    fn gemini_metadata_round_trips_without_autoactivation_or_a_secret() {
        let mut registry = Registry::default();
        assert!(!registry.active.contains_key("gemini"));
        let id = uuid::Uuid::new_v4().to_string();
        registry.accounts.push(Account {
            id: id.clone(),
            provider: ProviderId::Gemini,
            revision: 1,
            auth_method: Some("apiKey".into()),
            key_suffix: Some("1234".into()),
            identity: Identity {
                connected: true,
                email: None,
                plan: None,
            },
        });
        registry.validate().unwrap();
        assert!(!registry.active.contains_key("gemini"));
        registry.select(&id).unwrap();
        let value = serde_json::to_value(&registry).unwrap();
        let account = value["accounts"].as_array().unwrap().last().unwrap();
        assert_eq!(account["authMethod"], "apiKey");
        assert_eq!(account["keySuffix"], "1234");
        assert!(account.get("key").is_none());
        let restored: Registry = serde_json::from_value(value).unwrap();
        assert!(restored == registry);
        registry.remove(&id).unwrap();
        assert!(!registry.active.contains_key("gemini"));
    }
}
