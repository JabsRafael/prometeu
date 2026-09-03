//! Navegação segura dos arquivos do workspace para árvore e viewer.

use super::cwd_of;
use crate::{i18n, AppState};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(serde::Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
}

fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(i18n::io)?;
    let real = root.join(rel).canonicalize().map_err(i18n::io)?;
    match real.starts_with(&root) {
        true => Ok(real),
        false => Err(i18n::t("err.session.outside")),
    }
}

#[tauri::command]
pub fn list_dir(state: State<AppState>, id: String, rel: String) -> Vec<Entry> {
    let Some(root) = cwd_of(&state, &id) else {
        return Vec::new();
    };
    let Ok(dir) = inside(&root, &rel) else {
        return Vec::new();
    };

    let mut out: Vec<Entry> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                return None;
            }
            let dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            let path = match rel.is_empty() {
                true => name.clone(),
                false => format!("{rel}/{name}"),
            };
            Some(Entry { name, path, dir })
        })
        .collect();

    out.sort_by_key(|entry| (!entry.dir, entry.name.to_lowercase()));
    out
}

/// Resolve o arquivo dentro do worktree e recusa o que passa do limite: o
/// conteúdo inteiro atravessa o IPC, e um arquivo enorme travaria a janela.
fn open(state: &State<AppState>, id: &str, rel: &str, limit: u64) -> Result<PathBuf, String> {
    let root = cwd_of(state, id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let file = inside(&root, rel)?;
    let meta = std::fs::metadata(&file).map_err(i18n::io)?;
    if meta.len() > limit {
        return Err(i18n::ta(
            "err.session.tooBig",
            &[("kb", (meta.len() / 1024).to_string())],
        ));
    }
    Ok(file)
}

#[tauri::command]
pub fn read_file(state: State<AppState>, id: String, rel: String) -> Result<String, String> {
    let file = open(&state, &id, &rel, 2 * 1024 * 1024)?;
    let bytes = std::fs::read(&file).map_err(i18n::io)?;
    String::from_utf8(bytes).map_err(|_| i18n::t("err.session.binary"))
}

/// Os bytes crus, para o que o viewer desenha sem ser texto: PDF e CSV. O
/// limite é mais folgado que o do código porque ninguém edita esses — só lê.
#[tauri::command]
pub fn read_bytes(
    state: State<AppState>,
    id: String,
    rel: String,
) -> Result<tauri::ipc::Response, String> {
    let file = open(&state, &id, &rel, 100 * 1024 * 1024)?;
    let bytes = std::fs::read(&file).map_err(i18n::io)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Carimbo barato (mtime + tamanho) para o viewer saber se vale reler um
/// arquivo grande a cada evento do quadro.
#[tauri::command]
pub fn file_stamp(state: State<AppState>, id: String, rel: String) -> Result<String, String> {
    let file = open(&state, &id, &rel, u64::MAX)?;
    let meta = std::fs::metadata(&file).map_err(i18n::io)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    Ok(format!(
        "{}.{}-{}",
        mtime.as_secs(),
        mtime.subsec_nanos(),
        meta.len()
    ))
}

/// Grava o que a pessoa escreveu no viewer. `was` é o texto que ela abriu: se
/// o disco não estiver mais assim, o agente mexeu no arquivo no meio da edição
/// e salvar apagaria o trabalho dele por cima. Melhor recusar — ela reabre o
/// arquivo já com o que chegou e refaz a correção.
pub fn save(file: &Path, text: &str, was: &str) -> Result<(), String> {
    let bytes = std::fs::read(file).map_err(i18n::io)?;
    let now = String::from_utf8(bytes).map_err(|_| i18n::t("err.session.binary"))?;
    if now != was {
        return Err(i18n::t("err.session.changed"));
    }
    std::fs::write(file, text).map_err(i18n::io)
}

#[tauri::command]
pub fn write_file(
    state: State<AppState>,
    id: String,
    rel: String,
    text: String,
    was: String,
) -> Result<(), String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let file = inside(&root, &rel)?;
    save(&file, &text, &was)
}

#[cfg(test)]
mod tests {
    use super::{inside, save};

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("prometheus-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// O caso comum: o disco está como estava quando abriu, então grava.
    #[test]
    fn salvar_grava_quando_o_disco_nao_mudou() {
        let dir = tmp("save");
        let file = dir.join("nota.md");
        std::fs::write(&file, "linha um\nlinha dois\n").unwrap();

        save(&file, "linha um\n", "linha um\nlinha dois\n").unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "linha um\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// O agente escreveu enquanto a pessoa editava: salvar apagaria o que ele
    /// fez, então não salva e o arquivo continua com o que ele deixou.
    #[test]
    fn salvar_recusa_quando_o_agente_escreveu_por_baixo() {
        let dir = tmp("race");
        let file = dir.join("nota.md");
        std::fs::write(&file, "o que o agente escreveu\n").unwrap();

        let err = save(&file, "o que eu escrevi\n", "o que eu abri\n").unwrap_err();

        assert_eq!(err, "i18n:{\"code\":\"err.session.changed\"}");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "o que o agente escreveu\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Link para fora do worktree não vira caminho para escrever.
    #[test]
    fn inside_barra_link_que_sai_do_worktree() {
        let dir = tmp("outside");
        let (root, fora) = (dir.join("worktree"), dir.join("fora"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&fora).unwrap();
        std::fs::write(fora.join("segredo.txt"), "x").unwrap();
        std::os::unix::fs::symlink(fora.join("segredo.txt"), root.join("atalho.txt")).unwrap();

        assert!(inside(&root, "atalho.txt").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
