//! Navegação segura dos arquivos do workspace para árvore e viewer.

use super::{cwd_of, git, repos_of};
use crate::state::Repo;
use crate::{i18n, AppState};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
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

#[tauri::command]
pub fn read_file(state: State<AppState>, id: String, rel: String) -> Result<String, String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let file = inside(&root, &rel)?;
    let meta = std::fs::metadata(&file).map_err(i18n::io)?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err(i18n::ta(
            "err.session.tooBig",
            &[("kb", (meta.len() / 1024).to_string())],
        ));
    }
    let bytes = std::fs::read(&file).map_err(i18n::io)?;
    String::from_utf8(bytes).map_err(|_| i18n::t("err.session.binary"))
}

/// O que o "@" da caixa de escrever oferece: os caminhos do workspace que
/// combinam com o que já foi digitado.
///
/// Quem sabe o que existe é o git, e não uma varredura própria: `ls-files`
/// traz o que está rastreado e o que é novo, sem nada que o `.gitignore`
/// mandou esquecer — o mesmo recorte que o agente enxerga, e sem entrar em
/// `node_modules` ou `target`. Num workspace de mais de um repositório cada
/// caminho vem com a pasta do repositório na frente, como o agente precisa
/// escrever para achar o arquivo.
#[tauri::command(async)]
pub fn find_paths(state: State<AppState>, id: String, query: String) -> Vec<Entry> {
    let Some(root) = cwd_of(&state, &id) else {
        return Vec::new();
    };
    let repos = repos_of(&state, &id);
    let all = cached(&id, || scan(&root, &repos));

    let mut hits: Vec<(u8, usize, usize, &String)> = all
        .iter()
        .filter_map(|path| rank(&query, path).map(|(kind, depth, len)| (kind, depth, len, path)))
        .collect();
    hits.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
            .then(a.3.cmp(b.3))
    });

    hits.into_iter()
        .take(MOST)
        .map(|(_, _, _, path)| {
            let clean = path.trim_end_matches('/');
            Entry {
                name: clean.rsplit('/').next().unwrap_or(clean).to_string(),
                path: clean.to_string(),
                dir: path.ends_with('/'),
            }
        })
        .collect()
}

/// Quantos cabem na lista sem ela virar a tela inteira.
const MOST: usize = 40;

/// Por quanto tempo a lista de caminhos vale sem perguntar ao git de novo. A
/// lista é pedida a cada letra digitada, e um repositório grande leva dezenas
/// de milissegundos por pergunta; nesse intervalo, um arquivo criado agora
/// demora isso para aparecer, o que ninguém percebe escrevendo.
const FRESH: Duration = Duration::from_secs(5);

type Cache = Mutex<HashMap<String, (Instant, Arc<Vec<String>>)>>;

fn cached(id: &str, make: impl FnOnce() -> Vec<String>) -> Arc<Vec<String>> {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Ok(map) = cache.lock() {
        if let Some((at, paths)) = map.get(id) {
            if at.elapsed() < FRESH {
                return Arc::clone(paths);
            }
        }
    }
    let fresh = Arc::new(make());
    if let Ok(mut map) = cache.lock() {
        map.insert(id.to_string(), (Instant::now(), Arc::clone(&fresh)));
    }
    fresh
}

/// Todo caminho do workspace: os arquivos que o git conhece, e as pastas que
/// eles implicam — o git não lista pasta, e quem escreve "@app/" quer ver a
/// pasta antes de escolher o que tem dentro. Pasta termina em barra, que é o
/// que distingue as duas coisas daqui para frente.
fn scan(root: &Path, repos: &[Repo]) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    let mut dirs: HashSet<String> = HashSet::new();

    let mut collect = |dir: &Path, prefix: &str| {
        // `-z` porque o git põe aspas em nome com acento ou espaço quando o
        // separador é a quebra de linha.
        for rel in git(dir, &["ls-files", "-coz", "--exclude-standard"]).split('\0') {
            if rel.is_empty() {
                continue;
            }
            let path = match prefix.is_empty() {
                true => rel.to_string(),
                false => format!("{prefix}/{rel}"),
            };
            let mut at = 0;
            while let Some(slash) = path[at..].find('/') {
                at += slash + 1;
                dirs.insert(path[..at].to_string());
            }
            files.push(path);
        }
    };

    match repos.is_empty() {
        // Workspace sem repositório registrado: a pasta é o que houver.
        true => collect(root, ""),
        false => {
            for repo in repos {
                let dir = PathBuf::from(&repo.worktree);
                // Um repositório só: o worktree é a raiz, e nada vai na frente.
                let prefix = match dir.strip_prefix(root) {
                    Ok(rest) => rest.to_string_lossy().replace('\\', "/"),
                    Err(_) => String::new(),
                };
                collect(&dir, &prefix);
            }
        }
    }

    files.extend(dirs);
    files
}

/// O que o que foi digitado pode ser, e quão bem: primeiro o nome do arquivo
/// que começa assim, depois o que tem isso no meio, depois o caminho inteiro,
/// e por último as letras na ordem em pontos diferentes do caminho — é o que
/// faz "amtr" achar `app/models/transcriber.rb`. Empate se decide pelo mais
/// raso e mais curto: quem escreve pouco quer o arquivo perto da raiz.
///
/// `None` é não servir. Nada digitado serve tudo.
fn rank(query: &str, path: &str) -> Option<(u8, usize, usize)> {
    let clean = path.trim_end_matches('/');
    let depth = clean.matches('/').count();
    let len = clean.len();
    if query.is_empty() {
        return Some((0, depth, len));
    }
    let q = query.to_lowercase();
    let low = path.to_lowercase();
    let name = low.trim_end_matches('/').rsplit('/').next().unwrap_or(&low);

    // Com barra no que foi digitado, o alvo é o caminho: "app/mod" não é nome
    // de arquivo nenhum.
    let kind = if !q.contains('/') && name.starts_with(&q) {
        0
    } else if !q.contains('/') && name.contains(&q) {
        1
    } else if low.contains(&q) {
        2
    } else if subsequence(&q, &low) {
        3
    } else {
        return None;
    };
    Some((kind, depth, len))
}

/// As letras de `q` aparecem em `text` nesta ordem, não necessariamente
/// juntas.
fn subsequence(q: &str, text: &str) -> bool {
    let mut left = q.chars();
    let mut want = left.next();
    for c in text.chars() {
        if Some(c) == want {
            want = left.next();
            if want.is_none() {
                return true;
            }
        }
    }
    want.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn best(query: &str, paths: &[&str]) -> Vec<String> {
        let mut hits: Vec<(u8, usize, usize, &str)> = paths
            .iter()
            .filter_map(|p| rank(query, p).map(|(k, d, l)| (k, d, l, *p)))
            .collect();
        hits.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.cmp(&b.1))
                .then(a.2.cmp(&b.2))
                .then(a.3.cmp(b.3))
        });
        hits.into_iter().map(|(_, _, _, p)| p.to_string()).collect()
    }

    #[test]
    fn nome_que_comeca_assim_vem_antes() {
        let all = [
            "app/models/user.rb",
            "spec/models/user_spec.rb",
            "lib/use_case.rb",
        ];
        assert_eq!(
            best("user", &all),
            [
                "app/models/user.rb",
                "spec/models/user_spec.rb",
                "lib/use_case.rb"
            ]
        );
    }

    #[test]
    fn barra_procura_no_caminho_inteiro() {
        let all = ["app/models/user.rb", "user_app/x.rb", "app/views/user.erb"];
        assert_eq!(best("app/mod", &all), ["app/models/user.rb"]);
    }

    #[test]
    fn letras_na_ordem_acham_o_caminho() {
        assert_eq!(
            best("amtr", &["app/models/transcriber.rb"]),
            ["app/models/transcriber.rb"]
        );
        assert!(best("zzz", &["app/models/transcriber.rb"]).is_empty());
    }

    #[test]
    fn empate_vai_para_o_mais_raso() {
        let all = ["a/b/c/user.rb", "user.rb", "a/user.rb"];
        assert_eq!(
            best("user", &all),
            ["user.rb", "a/user.rb", "a/b/c/user.rb"]
        );
    }

    #[test]
    fn nada_digitado_serve_tudo() {
        assert_eq!(best("", &["b.rb", "a.rb"]), ["a.rb", "b.rb"]);
    }

    #[test]
    fn pasta_pesa_como_o_caminho_sem_a_barra() {
        assert_eq!(rank("app", "app/"), Some((0, 0, 3)));
    }

    /// Num repositório de verdade: o que o git conhece entra, o que o
    /// `.gitignore` mandou esquecer não, e as pastas aparecem com a barra no
    /// fim mesmo o git nunca listando pasta.
    #[test]
    fn a_varredura_e_o_que_o_git_conhece() {
        let root = std::env::temp_dir().join(format!("prometheus-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("app/models")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(root.join("app/models/user.rb"), "").unwrap();
        std::fs::write(root.join("node_modules/x/y.js"), "").unwrap();
        // Sem `git add`: `ls-files -co` também traz o que ainda é novo.
        let out = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(out.status.success());

        let found = scan(&root, &[]);
        assert!(found.contains(&"app/models/user.rb".to_string()));
        assert!(found.contains(&"app/".to_string()));
        assert!(found.contains(&"app/models/".to_string()));
        assert!(!found.iter().any(|p| p.contains("node_modules")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn maiuscula_nao_atrapalha() {
        assert!(rank("readme", "README.md").is_some());
        assert!(rank("CLAUDE", "CLAUDE.md").is_some());
    }
}
