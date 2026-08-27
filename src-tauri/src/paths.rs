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

/// O time de que este app faz parte, com o segredo — só o dono lê. Quem fala
/// com o relay é o front; o back só guarda isto fora do `localStorage`.
pub fn team_path() -> PathBuf {
    root().join("team.json")
}

/// Grava um arquivo que só o dono lê: nasce `0600`, e é reescrito inteiro —
/// nunca truncado e preenchido, para não haver um instante com ele vazio. O
/// erro é a causa crua; quem chama embrulha no código da sua tela.
pub fn write_private(target: &Path, body: &str) -> Result<(), String> {
    use std::io::Write;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension("json.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, target).map_err(|e| e.to_string())
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
        .join(dir_name(branch))
}

/// O nome da pasta de uma branch. Trocar `/` por `-` é o que dá nome legível,
/// mas sozinho ele colide: `feat/x` e `feat-x` viravam a mesma pasta, e a
/// segunda sessão pegava silenciosamente o worktree da primeira — na branch
/// errada, com o quadro mentindo qual era.
///
/// Quando a troca acontece, o nome ganha um sufixo tirado da branch inteira.
/// Nome sem `/` continua exatamente como era, que é o caso comum.
fn dir_name(branch: &str) -> String {
    let flat = branch.replace('/', "-");
    match flat == branch {
        true => flat,
        false => format!("{flat}-{:06x}", fnv1a(branch) & 0xff_ffff),
    }
}

/// FNV-1a. Não precisa ser criptográfico — precisa ser estável entre execuções
/// (o caminho fica gravado no quadro) e não valer uma dependência nova. A
/// porta do worktree sai da mesma conta (ver `scripts::alloc_port`).
pub(crate) fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in s.bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
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

    /// Branch sem `/` mantém o nome; com `/`, o nome achatado nunca é o mesmo
    /// de uma branch que já se chamava assim.
    #[test]
    fn branch_com_barra_nao_colide_com_a_achatada() {
        assert_eq!(dir_name("feat-x"), "feat-x");
        assert_ne!(dir_name("feat/x"), dir_name("feat-x"));
        assert!(dir_name("feat/x").starts_with("feat-x-"), "{}", dir_name("feat/x"));
        // Estável: o caminho fica gravado no quadro e tem de continuar valendo.
        assert_eq!(dir_name("feat/x"), dir_name("feat/x"));
        assert_ne!(dir_name("a/b"), dir_name("a/c"));
    }
}
