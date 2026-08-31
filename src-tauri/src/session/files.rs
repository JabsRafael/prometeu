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
/// `recent` são os arquivos que o agente acabou de ler ou escrever nesta
/// conversa, do último para o primeiro — o front os tira da timeline. Quem
/// escreve "@" no meio de um trabalho quase sempre quer um deles.
#[tauri::command(async)]
pub fn find_paths(
    state: State<AppState>,
    id: String,
    query: String,
    recent: Vec<String>,
) -> Vec<Entry> {
    let Some(root) = cwd_of(&state, &id) else {
        return Vec::new();
    };
    let repos = repos_of(&state, &id);
    let all = cached(&id, || scan(&root, &repos));
    let fresh = recency(&root, &recent);

    let mut hits: Vec<(i32, usize, usize, &String)> = all
        .iter()
        .filter_map(|path| {
            let clean = path.trim_end_matches('/');
            let points = score(&query, clean)? + fresh.get(clean).copied().unwrap_or(0);
            Some((-points, clean.matches('/').count(), clean.len(), path))
        })
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

/// O quanto cada arquivo tocado há pouco sobe na lista. O último vale mais que
/// o anterior, e o décimo terceiro já não vale nada: o que interessa é o
/// punhado de arquivos deste trabalho, não o histórico da conversa inteira.
///
/// O agente escreve o caminho como quiser — absoluto, ou relativo à pasta onde
/// ele roda. Os dois viram o caminho relativo à raiz do workspace, que é a
/// forma que a lista usa; o que não estiver dentro dela fica de fora.
fn recency(root: &Path, recent: &[String]) -> HashMap<String, i32> {
    let mut out = HashMap::new();
    for (at, raw) in recent.iter().take(RECENT_MOST).enumerate() {
        let rel = match Path::new(raw).strip_prefix(root) {
            Ok(rest) => rest.to_string_lossy().replace('\\', "/"),
            // Relativo já: só o que não sobe de nível serve.
            Err(_) if !raw.starts_with('/') && !raw.starts_with("..") => raw.clone(),
            Err(_) => continue,
        };
        let points = RECENT - (at as i32) * RECENT_STEP;
        out.entry(rel).or_insert(points);
    }
    out
}

/// Quantos arquivos tocados há pouco ainda sobem na lista, e quanto vale cada
/// um. `RECENT` é da ordem de uma query de quatro letras casada no nome: pesa,
/// mas não passa por cima de quem a pessoa escreveu por extenso.
const RECENT_MOST: usize = 12;
const RECENT: i32 = 120;
const RECENT_STEP: i32 = 8;

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

/// O quanto um caminho combina com o que foi digitado. Mais é melhor; `None`
/// é não servir, e nada digitado serve tudo por igual.
///
/// Duas contas: uma no nome do arquivo e outra no caminho inteiro. O nome pesa
/// o dobro, porque é ele que a pessoa tem na cabeça — "user" quer
/// `models/user.rb` antes de `user/legacy/parser.rb`. Barra no que foi
/// digitado é sinal de que a conta é só do caminho: "app/mod" não é nome de
/// arquivo nenhum.
fn score(query: &str, path: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let q: Vec<char> = query.to_lowercase().chars().collect();
    if q.contains(&'/') {
        return fuzzy(&q, path);
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    let on_path = fuzzy(&q, path)?;
    // O nome é o fim do caminho: o que casa nele casa no caminho, e o contrário
    // não. Sem match no nome sobra a conta do caminho.
    let Some(on_name) = fuzzy(&q, name) else {
        return Some(on_path);
    };
    Some(on_name * 2 + on_path / 4 + whole(&q, name))
}

/// O quanto o que foi digitado dá conta do nome sozinho. Sem isto, "user" põe
/// a pasta `db/seeds/users` na frente de `app/models/user.rb`: as duas casam
/// quatro letras seguidas no começo do nome, e o desempate por caminho mais
/// curto escolhe a errada. A extensão não conta — quem escreve "user" escreveu
/// o nome do arquivo inteiro, e sabe disso.
fn whole(q: &[char], name: &str) -> i32 {
    let stem = match name.rsplit_once('.') {
        Some((before, _)) if !before.is_empty() => before,
        _ => name,
    };
    let low: Vec<char> = stem.to_lowercase().chars().collect();
    if low == q {
        return WHOLE;
    }
    match low.starts_with(q) {
        true => STARTS,
        false => 0,
    }
}

/// O nome inteiro escrito, e o nome começando pelo que foi escrito.
const WHOLE: i32 = 64;
const STARTS: i32 = 24;

/// Cada letra vale isto por si.
const MATCH: i32 = 16;
/// Letra que começa uma parte do caminho — a primeira de tudo, ou a que vem
/// depois de `/`, `_`, `-`, `.` ou espaço. É o que faz "amtr" achar
/// `app/models/transcriber.rb` e "ur" preferir `user_repo.rb` a `nature.rb`.
const BOUNDARY: i32 = 8;
/// Letra maiúscula depois de minúscula: a fronteira de `userRepo`, que ninguém
/// escreve com separador mas todo mundo lê como duas palavras.
const CAMEL: i32 = 6;
/// Letra colada na anterior. Premia o trecho inteiro escrito de uma vez.
const CONSEC: i32 = 8;
/// Cada letra pulada entre uma que casou e a seguinte.
const GAP: i32 = 1;
/// Caminho mais longo que isto não é pontuado até o fim: a conta é o produto
/// do tamanho da busca pelo do texto, e um caminho absurdo não pode custar o
/// tempo de todos os outros.
const LONGEST: usize = 260;

const NEVER: i32 = i32::MIN / 4;

/// As letras da busca no texto, na ordem, com a melhor pontuação possível.
///
/// É a conta que o quick open de um editor faz: uma matriz de programação
/// dinâmica onde cada letra da busca pode casar em qualquer ponto do texto, e
/// o que decide entre dois encaixes é onde eles caem — começo de palavra e
/// letras coladas valem mais que letras espalhadas. Guloso não serve: em
/// `models/user.rb`, "usr" casaria o "u" de nada e perderia o encaixe bom mais
/// à frente.
///
/// Só duas linhas da matriz existem por vez — a anterior e a de agora.
fn fuzzy(q: &[char], text: &str) -> Option<i32> {
    let chars: Vec<char> = text.chars().take(LONGEST).collect();
    let lower: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    // `to_lowercase` de uma letra pode dar mais de uma; nesse caso as posições
    // deixam de bater e a conta fina não vale a pena.
    if lower.len() != chars.len() || q.len() > chars.len() {
        return match lower.len() == chars.len() {
            true => None,
            false => subsequence(q, &lower).then_some(0),
        };
    }
    let n = chars.len();

    // Quanto vale casar na posição `j`, pelo lugar dela no texto.
    let place = |j: usize| -> i32 {
        if j == 0 {
            return BOUNDARY;
        }
        if matches!(chars[j - 1], '/' | '_' | '-' | '.' | ' ') {
            return BOUNDARY;
        }
        match chars[j - 1].is_lowercase() && chars[j].is_uppercase() {
            true => CAMEL,
            false => 0,
        }
    };

    // `exact[j]`: a melhor pontuação das letras da busca vistas até aqui,
    // terminando exatamente na posição `j` do texto.
    let mut exact = vec![NEVER; n];
    for (i, want) in q.iter().enumerate() {
        let mut next = vec![NEVER; n];
        // `carry` é o melhor encaixe da letra anterior em qualquer posição já
        // passada, já descontado o que se pulou para chegar aqui.
        let mut carry = NEVER;
        for j in 0..n {
            if j > 0 {
                let jump = exact[j - 1];
                carry = carry.saturating_sub(GAP).max(jump);
            }
            if lower[j] != *want {
                continue;
            }
            next[j] = match i {
                // A primeira letra pode casar em qualquer lugar: o que vem
                // antes dela não é buraco, é só o começo do caminho.
                0 => MATCH + place(j),
                _ if carry <= NEVER => continue,
                _ => {
                    let apart = carry + MATCH + place(j);
                    let glued = match j > 0 && exact[j - 1] > NEVER {
                        true => exact[j - 1] + MATCH + place(j) + CONSEC,
                        false => NEVER,
                    };
                    apart.max(glued)
                }
            };
        }
        exact = next;
    }
    exact.into_iter().max().filter(|best| *best > NEVER)
}

/// As letras de `q` aparecem em `text` nesta ordem, não necessariamente
/// juntas. É a resposta grosseira, para o caminho que a conta fina recusa.
fn subsequence(q: &[char], text: &[char]) -> bool {
    let mut left = q.iter();
    let mut want = left.next();
    for c in text {
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

    /// A lista como `find_paths` a monta: mais pontos primeiro, e o empate
    /// para o mais raso e mais curto.
    fn best(query: &str, paths: &[&str]) -> Vec<String> {
        ranked(query, paths, &HashMap::new())
    }

    fn ranked(query: &str, paths: &[&str], fresh: &HashMap<String, i32>) -> Vec<String> {
        let mut hits: Vec<(i32, usize, usize, &str)> = paths
            .iter()
            .filter_map(|p| {
                let points = score(query, p)? + fresh.get(*p).copied().unwrap_or(0);
                Some((-points, p.matches('/').count(), p.len(), *p))
            })
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
    fn o_nome_pesa_mais_que_o_resto_do_caminho() {
        let all = ["app/user/legacy/parser.rb", "app/models/user.rb"];
        assert_eq!(
            best("user", &all),
            ["app/models/user.rb", "app/user/legacy/parser.rb"]
        );
    }

    #[test]
    fn comeco_de_palavra_vale_mais_que_letra_no_meio() {
        // "ur" está nos dois: em `user_repo` começa as duas partes, em `nature`
        // cai no meio das duas sílabas.
        let q: Vec<char> = "ur".chars().collect();
        assert!(fuzzy(&q, "user_repo.rb") > fuzzy(&q, "nature.rb"));
    }

    /// "amtr" não é nome de arquivo nenhum: as letras começam as partes do
    /// caminho, e é assim que se chega no que está fundo sem escrever pasta
    /// por pasta.
    #[test]
    fn as_iniciais_do_caminho_acham_o_arquivo() {
        assert!(score("amtr", "app/models/transcriber.rb").is_some());
    }

    /// Casar no nome ganha de casar espalhado pelo caminho, mesmo o segundo
    /// caindo todo em começo de palavra: o nome é o que a pessoa tem na
    /// cabeça.
    #[test]
    fn nome_ganha_de_caminho() {
        let all = ["app/models/transcriber.rb", "lib/parametros.rb"];
        assert_eq!(best("amtr", &all)[0], "lib/parametros.rb");
    }

    #[test]
    fn escrito_de_uma_vez_ganha_de_letra_espalhada() {
        let all = ["app/user.rb", "app/utilities/serializer.rb"];
        assert_eq!(best("user", &all)[0], "app/user.rb");
    }

    #[test]
    fn camel_case_e_fronteira_como_qualquer_outra() {
        let all = ["src/userRepo.ts", "src/nature.ts"];
        assert_eq!(best("ur", &all)[0], "src/userRepo.ts");
    }

    #[test]
    fn nao_e_guloso_com_a_primeira_letra() {
        // O "u" de "under" é o primeiro que aparece, e o encaixe bom está
        // depois dele.
        assert!(score("usr", "under/models/user.rb").is_some());
        let all = ["under/models/user.rb", "under/models/superset.rb"];
        assert_eq!(best("usr", &all)[0], "under/models/user.rb");
    }

    #[test]
    fn barra_procura_no_caminho_inteiro() {
        let all = ["app/models/user.rb", "user_app/x.rb", "app/views/user.erb"];
        assert_eq!(best("app/mod", &all), ["app/models/user.rb"]);
    }

    #[test]
    fn o_que_nao_tem_as_letras_fica_de_fora() {
        assert!(score("zzz", "app/models/transcriber.rb").is_none());
    }

    /// O nome escrito por extenso ganha de um nome maior que só começa igual —
    /// e a extensão não conta, porque ninguém a escreve.
    #[test]
    fn o_nome_inteiro_ganha_de_quem_so_comeca_igual() {
        let all = ["db/seeds/users/", "app/models/user.rb"];
        assert_eq!(best("user", &all)[0], "app/models/user.rb");
        assert!(
            whole(&"user".chars().collect::<Vec<_>>(), "user.rb")
                > whole(&"user".chars().collect::<Vec<_>>(), "users")
        );
    }

    #[test]
    fn nada_digitado_serve_tudo() {
        assert_eq!(best("", &["b.rb", "a.rb"]), ["a.rb", "b.rb"]);
    }

    #[test]
    fn maiuscula_nao_atrapalha() {
        assert!(score("readme", "README.md").is_some());
        assert!(score("CLAUDE", "CLAUDE.md").is_some());
    }

    /// O arquivo que o agente acabou de mexer sobe — mas só entre os que já
    /// serviam: quem não tem as letras continua de fora.
    #[test]
    fn o_que_o_agente_acabou_de_tocar_sobe() {
        let all = ["app/models/user.rb", "spec/models/user_spec.rb"];
        assert_eq!(best("user", &all)[0], "app/models/user.rb");

        let fresh = HashMap::from([("spec/models/user_spec.rb".to_string(), RECENT)]);
        assert_eq!(ranked("user", &all, &fresh)[0], "spec/models/user_spec.rb");
        assert_eq!(ranked("zzz", &all, &fresh), Vec::<String>::new());
    }

    /// O agente escreve o caminho como quiser: o absoluto vira relativo à raiz,
    /// o relativo fica como está, e o que está fora do workspace não entra.
    #[test]
    fn os_recentes_viram_caminho_da_raiz() {
        let root = Path::new("/tmp/ws");
        let fresh = recency(
            root,
            &[
                "/tmp/ws/app/models/user.rb".to_string(),
                "spec/user_spec.rb".to_string(),
                "/etc/hosts".to_string(),
            ],
        );
        assert_eq!(fresh.get("app/models/user.rb"), Some(&RECENT));
        assert_eq!(
            fresh.get("spec/user_spec.rb"),
            Some(&(RECENT - RECENT_STEP))
        );
        assert!(fresh.keys().all(|k| !k.contains("hosts")));
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
}
