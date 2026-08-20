use std::path::PathBuf;

pub fn home() -> PathBuf {
    dirs::home_dir().expect("sem HOME")
}

/// Raiz de tudo que o Prometheus escreve fora do repositório do usuário.
pub fn root() -> PathBuf {
    home().join(".prometheus")
}

pub fn socket_path() -> PathBuf {
    root().join("run/prometheus.sock")
}

pub fn session_dir(id: &str) -> PathBuf {
    root().join("sessions").join(id)
}

/// Worktrees ficam fora de `.prometheus` porque o usuário abre esses diretórios no editor.
pub fn worktree_dir(repo_name: &str, branch: &str) -> PathBuf {
    home()
        .join("prometheus/worktrees")
        .join(repo_name)
        .join(branch.replace('/', "-"))
}

/// O binário do hook mora ao lado do executável do app.
pub fn hook_bin() -> PathBuf {
    if let Ok(p) = std::env::var("PROMETHEUS_HOOK_BIN") {
        return PathBuf::from(p);
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("prometheus-hook")))
        .unwrap_or_else(|| PathBuf::from("prometheus-hook"))
}
