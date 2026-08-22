use std::path::{Path, PathBuf};

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

/// Onde o Claude Code guarda o transcript de uma sessão: ele troca no caminho do
/// cwd tudo que não é letra ou número por `-` e usa isso como nome da pasta.
///
/// O arquivo só nasce na primeira mensagem. Conversa criada e nunca usada não
/// tem transcript nenhum — e é exatamente isso que o `--resume` responde com
/// "No conversation found with session ID".
pub fn transcript(id: &str, cwd: &Path) -> PathBuf {
    let slug: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    home().join(".claude/projects").join(slug).join(format!("{id}.jsonl"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_troca_tudo_que_nao_e_alfanumerico() {
        let path = transcript("abc", Path::new("/Users/ana/.prometheus/wt/x_1"));
        assert!(path.ends_with("-Users-ana--prometheus-wt-x-1/abc.jsonl"), "{}", path.display());
    }
}
