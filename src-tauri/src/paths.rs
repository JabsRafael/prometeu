use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    dirs::home_dir().expect("sem HOME")
}

/// O que separa o app de dev do app instalado, em todo caminho que o Prometheus
/// escreve. Sem isto os dois disputam o mesmo socket — `socket::listen` apaga o
/// socket órfão antes do `bind`, então o último a subir rouba os hooks do outro —
/// e mexem no mesmo quadro e nos mesmos worktrees.
///
/// `cfg!` resolve em tempo de compilação: `tauri dev` compila em debug, `tauri
/// build` em release. Nada para configurar.
fn suffix() -> &'static str {
    if cfg!(debug_assertions) {
        "-dev"
    } else {
        ""
    }
}

/// Raiz de tudo que o Prometheus escreve fora do repositório do usuário.
///
/// O hook faz a mesma conta, e por isso o hook de debug fala com o app de dev.
pub fn root() -> PathBuf {
    if let Ok(p) = std::env::var("PROMETHEUS_ROOT") {
        return PathBuf::from(p);
    }
    home().join(format!(".prometheus{}", suffix()))
}

pub fn socket_path() -> PathBuf {
    root().join("run/prometheus.sock")
}

pub fn session_dir(id: &str) -> PathBuf {
    root().join("sessions").join(id)
}

/// Worktrees ficam fora de `.prometheus` porque o usuário abre esses diretórios no editor.
///
/// O sufixo também vale aqui: dois apps criando worktree para a mesma branch do
/// mesmo repo colidiriam no mesmo diretório — e o transcript, que o Claude Code
/// nomeia pelo caminho do cwd, seria o mesmo arquivo para as duas sessões.
pub fn worktree_dir(repo_name: &str, branch: &str) -> PathBuf {
    home()
        .join("prometheus")
        .join(format!("worktrees{}", suffix()))
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
