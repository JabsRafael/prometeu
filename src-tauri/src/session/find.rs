//! A lista que o "@" da caixa de escrever abre: os caminhos do workspace que
//! combinam com o que já foi digitado.
//!
//! O tamanho do repositório é o que desenha este módulo. Num de cinco mil
//! arquivos qualquer coisa serve; num monorepo de trezentos mil, pontuar tudo
//! a cada letra custa um quarto de segundo, e a lista passa a andar atrás de
//! quem escreve. Por isso a busca tem duas passadas — uma barata que escolhe
//! alguns milhares de candidatos, e a cara, que só eles pagam — e por isso a
//! lista de caminhos fica pronta de véspera, em bytes, em vez de ser preparada
//! de novo a cada tecla.

use super::{cwd_of, git, repos_of};
use crate::state::Repo;
use crate::AppState;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::State;

use super::files::Entry;

/// O que o "@" da caixa de escrever oferece.
///
/// Quem sabe o que existe é o git, e não uma varredura própria: `ls-files`
/// traz o que está rastreado e o que é novo, sem nada que o `.gitignore`
/// mandou esquecer — o mesmo recorte que o agente enxerga, e sem entrar em
/// `node_modules` ou `target`. Num workspace de mais de um repositório cada
/// caminho vem com a pasta do repositório na frente, como o agente precisa
/// escrever para achar o arquivo.
///
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
    let all = cached(&id, move || scan(&root.clone(), &repos));
    let fresh = recency(&state, &id, &recent);

    let q: Vec<u8> = query.to_ascii_lowercase().into_bytes();
    let short = shortlist(&all, &q, &fresh);

    let mut hits: Vec<(i32, u32, u32, &Span)> = short
        .into_iter()
        .filter_map(|at| {
            let span = &all.at[at];
            let points = points(&q, &all, span)? + fresh.get(all.text(span)).copied().unwrap_or(0);
            Some((-points, span.depth, span.to - span.from, span))
        })
        .collect();
    hits.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
            .then(all.text(a.3).cmp(all.text(b.3)))
    });

    hits.into_iter()
        .take(MOST)
        .map(|(_, _, _, span)| Entry {
            name: all.name(span).to_string(),
            path: all.text(span).to_string(),
            dir: span.dir,
        })
        .collect()
}

/// Quantos cabem na lista sem ela virar a tela inteira.
const MOST: usize = 40;

/* ---------- os caminhos, prontos para a busca ---------- */

/// Todos os caminhos do workspace num pedaço só de memória.
///
/// Um `String` por caminho custaria três palavras de cabeçalho e uma alocação
/// cada; num monorepo são novecentas mil alocações, e mais memória vai embora
/// em cabeçalho e arredondamento do que nos caminhos. Aqui eles ficam colados
/// num texto só, e um índice diz onde cada um começa.
///
/// A versão minúscula também não fica guardada — seriam os mesmos bytes uma
/// segunda vez. Cada byte vira minúsculo na hora de comparar, o que é uma
/// instrução e nenhuma alocação.
struct Corpus {
    raw: String,
    at: Vec<Span>,
}

/// Onde um caminho está dentro do texto, e o que dele já se sabe. A barra que
/// marca pasta fica fora de `to`: ela não é do caminho, é do que ele é.
struct Span {
    from: u32,
    name_at: u32,
    to: u32,
    depth: u32,
    dir: bool,
}

impl Corpus {
    /// O caminho como a pessoa escreve.
    fn text(&self, at: &Span) -> &str {
        &self.raw[at.from as usize..at.to as usize]
    }
    fn bytes(&self, at: &Span) -> &[u8] {
        self.text(at).as_bytes()
    }
    fn name(&self, at: &Span) -> &str {
        &self.raw[at.name_at as usize..at.to as usize]
    }
    fn name_bytes(&self, at: &Span) -> &[u8] {
        self.name(at).as_bytes()
    }
}

fn corpus(paths: Vec<String>) -> Corpus {
    let mut raw = String::with_capacity(paths.iter().map(|p| p.len()).sum());
    let mut at = Vec::with_capacity(paths.len());
    for path in paths {
        let dir = path.ends_with('/');
        let text = path.trim_end_matches('/');
        let from = raw.len() as u32;
        at.push(Span {
            from,
            name_at: from + text.rfind('/').map(|slash| slash + 1).unwrap_or(0) as u32,
            to: from + text.len() as u32,
            depth: text.matches('/').count() as u32,
            dir,
        });
        raw.push_str(text);
    }
    Corpus { raw, at }
}

/// Minúsculo, no que é ASCII. O resto fica como está — um caminho com acento
/// casa com o acento escrito igual, que é o que qualquer busca de arquivo faz.
fn low(b: u8) -> u8 {
    b.to_ascii_lowercase()
}

/* ---------- a primeira passada, barata ---------- */

/// Os candidatos que valem a conta fina.
///
/// Aqui não há matriz nenhuma: só se pergunta onde as letras caem — se começam
/// o nome, se estão nele coladas, se estão nele espalhadas, se estão só no
/// caminho. É grosseiro de propósito, porque roda em tudo; a ordem final quem
/// dá é a passada seguinte, e para ela sobram alguns milhares.
///
/// Em pedaços, um por thread: a passada é a mesma para cada caminho e não
/// depende dos outros, e é o que faz um monorepo caber no tempo entre duas
/// teclas.
fn shortlist(all: &Corpus, q: &[u8], fresh: &HashMap<String, i32>) -> Vec<usize> {
    let hands = match all.at.len() {
        // Repositório pequeno não paga o preço de espalhar o trabalho.
        0..=20_000 => 1,
        _ => std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(8),
    };
    let each = all.at.len().div_ceil(hands.max(1));
    let keep: Vec<&str> = fresh.keys().map(|k| k.as_str()).collect();

    let mut found: Vec<Rough> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..hands)
            .map(|hand| {
                let first = (hand * each).min(all.at.len());
                let slice = &all.at[first..((hand + 1) * each).min(all.at.len())];
                let keep = &keep;
                scope.spawn(move || {
                    let mut best: BinaryHeap<Rough> = BinaryHeap::with_capacity(SHORT + 1);
                    for (at, span) in slice.iter().enumerate() {
                        let Some(rank) = rough(q, all, span, keep) else {
                            continue;
                        };
                        let cand = Rough {
                            rank,
                            depth: span.depth,
                            len: span.to - span.from,
                            at: first + at,
                        };
                        // O topo do monte é o pior que está guardado. Com o
                        // monte cheio, quem não for melhor que ele nem entra —
                        // uma comparação no lugar de acomodar e derrubar, o que
                        // num monorepo acontece centenas de milhares de vezes.
                        if best.len() >= SHORT {
                            if best.peek().is_some_and(|worst| *worst <= cand) {
                                continue;
                            }
                            best.pop();
                        }
                        best.push(cand);
                    }
                    best.into_vec()
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .flatten()
            .collect()
    });

    found.sort_unstable();
    found.into_iter().map(|r| r.at).collect()
}

/// Quantos candidatos cada thread leva para a conta fina. Com quarenta linhas
/// na tela, alguns milhares no total é folga de sobra — e é um teto, então o
/// custo da segunda passada não depende do tamanho do repositório.
const SHORT: usize = 256;

/// Onde as letras caem, sem conta nenhuma. Maior é melhor; `None` é não servir.
fn rough(q: &[u8], all: &Corpus, span: &Span, keep: &[&str]) -> Option<u8> {
    // O que o agente acabou de mexer passa por cima desta triagem: seria uma
    // pena o arquivo da vez cair aqui e nunca chegar na conta que o faria
    // subir.
    if !keep.is_empty() && keep.contains(&all.text(span)) {
        return Some(5);
    }
    if q.is_empty() {
        return Some(0);
    }
    // As letras na ordem primeiro, e só depois onde elas caem: quem não tem as
    // letras não tem como estar coladas, e é a maioria. Procurar o trecho
    // inteiro custa o tamanho da busca vezes o do texto; a ordem, só o texto.
    let name = all.name_bytes(span);
    if !q.contains(&b'/') && subsequence(q, name) {
        return Some(if starts(q, name) {
            4
        } else if window(q, name) {
            3
        } else {
            2
        });
    }
    if !subsequence(q, all.bytes(span)) {
        return None;
    }
    Some(window(q, all.bytes(span)).into())
}

/// Um candidato da primeira passada. A ordem é a do monte que os guarda: o
/// "maior" é o pior, para ser ele a sair quando o monte enche.
#[derive(PartialEq, Eq)]
struct Rough {
    rank: u8,
    depth: u32,
    len: u32,
    at: usize,
}

impl Ord for Rough {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .rank
            .cmp(&self.rank)
            .then(self.depth.cmp(&other.depth))
            .then(self.len.cmp(&other.len))
            .then(self.at.cmp(&other.at))
    }
}

impl PartialOrd for Rough {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// `text` começa com `q`. `q` já vem minúsculo.
fn starts(q: &[u8], text: &[u8]) -> bool {
    text.len() >= q.len() && text.iter().zip(q).all(|(a, b)| low(*a) == *b)
}

/// `q` aparece inteiro e seguido em `text`. `q` já vem minúsculo.
fn window(q: &[u8], text: &[u8]) -> bool {
    q.len() <= text.len()
        && text
            .windows(q.len())
            .any(|w| w.iter().zip(q).all(|(a, b)| low(*a) == *b))
}

/// As letras de `q` aparecem em `text` nesta ordem, não necessariamente juntas.
fn subsequence(q: &[u8], text: &[u8]) -> bool {
    let mut left = q.iter();
    let mut want = left.next();
    for c in text {
        if Some(&low(*c)) == want.copied().as_ref() {
            want = left.next();
            if want.is_none() {
                return true;
            }
        }
    }
    want.is_none()
}

/* ---------- a segunda passada, a que ordena ---------- */

/// O quanto um caminho combina com o que foi digitado. Mais é melhor; `None`
/// é não servir, e nada digitado serve tudo por igual.
///
/// Duas contas: uma no nome do arquivo e outra no caminho inteiro. O nome pesa
/// o dobro, porque é ele que a pessoa tem na cabeça — "user" quer
/// `models/user.rb` antes de `user/legacy/parser.rb`. Barra no que foi
/// digitado é sinal de que a conta é só do caminho: "app/mod" não é nome de
/// arquivo nenhum.
fn points(q: &[u8], all: &Corpus, span: &Span) -> Option<i32> {
    if q.is_empty() {
        return Some(0);
    }
    if q.contains(&b'/') {
        return fuzzy(q, all.bytes(span));
    }
    let on_path = fuzzy(q, all.bytes(span))?;
    // O nome é o fim do caminho: o que casa nele casa no caminho, e o contrário
    // não. Sem match no nome sobra a conta do caminho.
    let name = all.name_bytes(span);
    let Some(on_name) = fuzzy(q, name) else {
        return Some(on_path);
    };
    Some(on_name * 2 + on_path / 4 + whole(q, name))
}

/// A mesma conta, a partir de um caminho solto. É por aqui que os testes
/// entram, e o custo de preparar os bytes não importa fora do caminho quente.
#[cfg(test)]
fn score(query: &str, path: &str) -> Option<i32> {
    let all = corpus(vec![path.to_string()]);
    points(&query.to_ascii_lowercase().into_bytes(), &all, &all.at[0])
}

/// O quanto o que foi digitado dá conta do nome sozinho. Sem isto, "user" põe
/// a pasta `db/seeds/users` na frente de `app/models/user.rb`: as duas casam
/// quatro letras seguidas no começo do nome, e o desempate por caminho mais
/// curto escolhe a errada. A extensão não conta — quem escreve "user" escreveu
/// o nome do arquivo inteiro, e sabe disso.
fn whole(q: &[u8], name: &[u8]) -> i32 {
    let stem = match name.iter().rposition(|b| *b == b'.') {
        Some(at) if at > 0 => &name[..at],
        _ => name,
    };
    if stem.len() == q.len() && starts(q, stem) {
        return WHOLE;
    }
    match starts(q, stem) {
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
/// Texto mais longo que isto não é pontuado até o fim: a conta é o produto do
/// tamanho da busca pelo do texto, e um caminho absurdo não pode custar o
/// tempo de todos os outros.
const LONGEST: usize = 260;

const NEVER: i32 = i32::MIN / 4;

/// As letras da busca no texto, na ordem, com a melhor pontuação possível.
///
/// É a conta que o quick open de um editor faz: uma matriz de programação
/// dinâmica onde cada letra da busca pode casar em qualquer ponto do texto, e
/// o que decide entre dois encaixes é onde eles caem — começo de palavra e
/// letras coladas valem mais que letras espalhadas. Guloso não serve: em
/// `under/models/user.rb`, "usr" casaria o "u" de "under" e perderia o encaixe
/// bom mais à frente.
///
/// `text` vem como está escrito: a caixa das letras é o que faz enxergar a
/// maiúscula de `userRepo`, e a comparação vira minúscula byte a byte. Só duas
/// linhas da matriz existem por vez.
fn fuzzy(q: &[u8], text: &[u8]) -> Option<i32> {
    let n = text.len().min(LONGEST);
    if q.len() > n {
        return None;
    }

    // Quanto vale casar na posição `j`, pelo lugar dela no texto.
    let place = |j: usize| -> i32 {
        if j == 0 {
            return BOUNDARY;
        }
        if matches!(text[j - 1], b'/' | b'_' | b'-' | b'.' | b' ') {
            return BOUNDARY;
        }
        match text[j - 1].is_ascii_lowercase() && text[j].is_ascii_uppercase() {
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
                carry = carry.saturating_sub(GAP).max(exact[j - 1]);
            }
            if low(text[j]) != *want {
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

/* ---------- o que o agente acabou de mexer ---------- */

/// O quanto cada arquivo tocado há pouco sobe na lista. O último vale mais que
/// o anterior, e o décimo terceiro já não vale nada: o que interessa é o
/// punhado de arquivos deste trabalho, não o histórico da conversa inteira.
///
/// O agente escreve o caminho como quiser — absoluto, ou relativo à pasta onde
/// ele roda. Os dois viram o caminho relativo à raiz do workspace, que é a
/// forma que a lista usa; o que não estiver dentro dela fica de fora.
fn recency(state: &State<AppState>, id: &str, recent: &[String]) -> HashMap<String, i32> {
    match cwd_of(state, id) {
        Some(root) => under(&root, recent),
        None => HashMap::new(),
    }
}

/// Os mesmos caminhos, medidos a partir da raiz.
fn under(root: &Path, recent: &[String]) -> HashMap<String, i32> {
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

/* ---------- a lista de caminhos, e quando ela se refaz ---------- */

/// Por quanto tempo a lista vale sem perguntar ao git de novo.
///
/// Passado isso ela não é refeita na hora: quem pediu leva a que existe, e a
/// nova se monta atrás. Num monorepo o `ls-files` sozinho passa do segundo, e
/// esperar por ele é a lista inteira travando no meio de uma palavra. O preço
/// é um arquivo criado agora demorar até a próxima tecla depois desta para
/// aparecer, o que ninguém percebe escrevendo.
const FRESH: Duration = Duration::from_secs(30);

struct Shelf {
    at: Instant,
    /// Quando alguém buscou nela pela última vez. É por aqui que a prateleira
    /// esquece: num monorepo a lista de um workspace passa de dezenas de
    /// megabytes, e guardar a de todos que já foram abertos é memória que
    /// nunca mais volta.
    used: Instant,
    list: Arc<Corpus>,
    /// Já há alguém montando a lista nova: não adianta um segundo git.
    filling: bool,
}

/// Quantos workspaces ficam na prateleira. Quem escreve "@" está numa conversa
/// e volta a outra logo em seguida; mais que um punhado é histórico.
const KEEP: usize = 4;

/// Tira da prateleira quem não é usado há mais tempo, até caber.
fn forget(cache: &mut HashMap<String, Shelf>) {
    while cache.len() > KEEP {
        let Some(oldest) = cache
            .iter()
            .filter(|(_, shelf)| !shelf.filling)
            .min_by_key(|(_, shelf)| shelf.used)
            .map(|(id, _)| id.clone())
        else {
            return;
        };
        cache.remove(&oldest);
    }
}

type Cache = Mutex<HashMap<String, Shelf>>;

fn shelf() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// A lista deste workspace, pronta para a busca.
///
/// Da primeira vez não há o que entregar, e quem pediu espera. Depois disso
/// nunca mais: o que está na prateleira sai na hora, velho ou novo.
fn cached(id: &str, make: impl FnOnce() -> Vec<String> + Send + 'static) -> Arc<Corpus> {
    {
        let mut cache = shelf().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(have) = cache.get_mut(id) {
            have.used = Instant::now();
            let list = Arc::clone(&have.list);
            if have.at.elapsed() >= FRESH && !have.filling {
                have.filling = true;
                let id = id.to_string();
                std::thread::spawn(move || {
                    let fresh = Arc::new(corpus(make()));
                    let mut cache = shelf().lock().unwrap_or_else(|e| e.into_inner());
                    let used = cache
                        .get(&id)
                        .map(|old| old.used)
                        .unwrap_or_else(Instant::now);
                    cache.insert(
                        id,
                        Shelf {
                            at: Instant::now(),
                            used,
                            list: fresh,
                            filling: false,
                        },
                    );
                    forget(&mut cache);
                });
            }
            return list;
        }
    }

    let fresh = Arc::new(corpus(make()));
    let mut cache = shelf().lock().unwrap_or_else(|e| e.into_inner());
    cache.insert(
        id.to_string(),
        Shelf {
            at: Instant::now(),
            used: Instant::now(),
            list: Arc::clone(&fresh),
            filling: false,
        },
    );
    forget(&mut cache);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A lista como `find_paths` a monta, com as duas passadas: a triagem
    /// escolhe os candidatos e a conta fina os ordena. É a busca inteira, e não
    /// só a pontuação — a triagem pode deixar alguém de fora, e é isso que os
    /// testes precisam ver.
    fn best(query: &str, paths: &[&str]) -> Vec<String> {
        ranked(query, paths, &HashMap::new())
    }

    fn ranked(query: &str, paths: &[&str], fresh: &HashMap<String, i32>) -> Vec<String> {
        let all = corpus(paths.iter().map(|p| p.to_string()).collect());
        let q: Vec<u8> = query.to_ascii_lowercase().into_bytes();
        let mut hits: Vec<(i32, u32, u32, &Span)> = shortlist(&all, &q, fresh)
            .into_iter()
            .filter_map(|at| {
                let span = &all.at[at];
                let points =
                    points(&q, &all, span)? + fresh.get(all.text(span)).copied().unwrap_or(0);
                Some((-points, span.depth, span.to - span.from, span))
            })
            .collect();
        hits.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.cmp(&b.1))
                .then(a.2.cmp(&b.2))
                .then(all.text(a.3).cmp(all.text(b.3)))
        });
        hits.into_iter()
            .map(|(_, _, _, s)| all.text(s).to_string())
            .collect()
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
        assert!(fuzzy(b"ur", b"user_repo.rb") > fuzzy(b"ur", b"nature.rb"));
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
        assert!(whole(b"user", b"user.rb") > whole(b"user", b"users"));
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
        let fresh = under(
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

    /// A triagem é quem decide o que chega na conta fina, e ela tem teto: num
    /// monorepo o que sobra são alguns milhares. O que casa bem tem de passar
    /// por ela mesmo cercado de milhares que casam mal.
    #[test]
    fn a_triagem_nao_perde_o_bom_no_meio_do_ruim() {
        let mut paths: Vec<String> = (0..50_000)
            .map(|n| format!("vendor/lib{n}/user_helper_stub.rb"))
            .collect();
        paths.push("app/models/user.rb".to_string());
        let all = corpus(paths);
        let short = shortlist(&all, b"user", &HashMap::new());
        assert!(short
            .iter()
            .any(|at| all.text(&all.at[*at]) == "app/models/user.rb"));
    }

    /// O caminho de um recente entra na conta fina mesmo que a triagem, sozinha,
    /// o deixasse de fora por causa dos milhares que casam melhor.
    #[test]
    fn a_triagem_guarda_lugar_para_o_recente() {
        let mut paths: Vec<String> = (0..50_000).map(|n| format!("app/user{n}.rb")).collect();
        paths.push("vendor/deep/nested/legacy/u_s_e_r.rb".to_string());
        let all = corpus(paths);
        let fresh = HashMap::from([("vendor/deep/nested/legacy/u_s_e_r.rb".to_string(), RECENT)]);
        let short = shortlist(&all, b"user", &fresh);
        assert!(short
            .iter()
            .any(|at| all.text(&all.at[*at]) == "vendor/deep/nested/legacy/u_s_e_r.rb"));
    }

    /// A prateleira esquece o workspace que ninguém usa há mais tempo: num
    /// monorepo cada lista é dezenas de megabytes.
    #[test]
    fn a_prateleira_so_guarda_alguns_workspaces() {
        let mut cache: HashMap<String, Shelf> = HashMap::new();
        for n in 0..KEEP + 3 {
            cache.insert(
                format!("ws{n}"),
                Shelf {
                    at: Instant::now(),
                    used: Instant::now() + Duration::from_secs(n as u64),
                    list: Arc::new(corpus(Vec::new())),
                    filling: false,
                },
            );
        }
        forget(&mut cache);
        assert_eq!(cache.len(), KEEP);
        // Os que sobram são os usados mais recentemente.
        assert!(cache.contains_key(&format!("ws{}", KEEP + 2)));
        assert!(!cache.contains_key("ws0"));
    }
}
