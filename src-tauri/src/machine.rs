//! O que o app está custando à máquina.
//!
//! Um agente é um processo, um terminal do dock é outro, e cada um deles sobe
//! os seus por baixo — o `npm run dev` da aba Run é um `npm` com um `node`
//! dentro. Quem quer saber por que o ventilador ligou não quer a lista de
//! todos eles: quer uma linha por conversa e por terminal, com a soma do que
//! cada um arrastou consigo.
//!
//! Daí a árvore. Um `ps` por tique traz o mundo inteiro; daqui sai o mapa de
//! pai para filhos, e cada raiz que o app conhece (ele mesmo, cada conversa,
//! cada terminal) leva a soma da própria subárvore. A raiz do app desconta as
//! outras, senão o Prometheus apareceria carregando os agentes que já estão
//! logo abaixo dele na lista.
//!
//! CPU é a diferença entre dois tiques, e não o `%CPU` do `ps` — aquele é a
//! média desde que o processo nasceu, e um agente que trabalhou muito faz uma
//! hora aparece parado agora.

use crate::lock::lock;
use crate::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// De quanto em quanto tempo se olha. Menos que isto é um `ps` por segundo
/// para mexer um pixel de gráfico.
const TICK: Duration = Duration::from_secs(3);
/// Quantos tiques a linha do gráfico guarda — uns dois minutos de história, que
/// é o quanto se quer ver para saber se aquilo ali está subindo ou já passou.
const HISTORY: usize = 40;

/// Uma linha do painel: o app, uma conversa ou um terminal, com o que a
/// subárvore dele soma.
#[derive(Serialize, Clone, PartialEq)]
pub struct Proc {
    /// `app`, `chat` ou `term` — é o que escolhe o ícone.
    pub kind: String,
    /// O que a pessoa deu de nome: o título do workspace. Não passa pelo
    /// catálogo porque não é tela — é o que ela escreveu.
    pub name: String,
    /// A segunda linha: o título da aba, numa conversa; a chave do dock
    /// (`setup`, `run`, `term2`), num terminal — essa o front traduz, porque
    /// aí sim é palavra de tela.
    pub detail: String,
    pub rss: u64,
    pub cpu: f32,
    /// O gráfico: as últimas leituras de CPU, a mais velha primeiro.
    pub hist: Vec<f32>,
}

/// Uma porta de workspace servindo agora.
#[derive(Serialize, Clone, PartialEq)]
pub struct Port {
    /// O workspace, para o clique abrir o navegador nele.
    pub id: String,
    pub title: String,
    pub port: u16,
}

#[derive(Serialize, Clone, PartialEq, Default)]
pub struct Machine {
    pub rss: u64,
    pub cpu: f32,
    pub procs: Vec<Proc>,
    /// Terminais de pé, que é o número na faixa.
    pub terms: usize,
    pub ports: Vec<Port>,
}

/// Uma raiz e o que o app sabe dizer dela.
struct Root {
    pid: u32,
    kind: &'static str,
    name: String,
    detail: String,
}

/// O tempo de CPU e a história de cada raiz entre um tique e outro. Some
/// quando o processo some — a lista das raízes é que manda.
#[derive(Default)]
struct Memo {
    /// Tempo de CPU acumulado da subárvore, em segundos, no último tique.
    time: HashMap<u32, f64>,
    hist: HashMap<u32, Vec<f32>>,
    last: Option<Instant>,
    sent: Machine,
}

/// A thread que olha. Uma só, do começo do app ao fim: parar e voltar a olhar
/// conforme o painel abre e fecha custaria mais linhas do que o `ps` que ela
/// roda.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut memo = Memo::default();
        loop {
            std::thread::sleep(TICK);
            if let Some(next) = read(&app, &mut memo) {
                let _ = app.emit("machine", &next);
            }
        }
    });
}

/// O que a tela pede ao abrir, antes do primeiro tique.
#[tauri::command]
pub fn machine(state: tauri::State<AppState>) -> Machine {
    Machine {
        terms: alive_terms(&state),
        ports: ports(&state),
        ..Machine::default()
    }
}

/// Um tique. Devolve nada quando não há novidade — o `ps` falhou, ou tudo
/// continua igual, e redesenhar a faixa para dizer o mesmo é trabalho à toa.
fn read(app: &AppHandle, memo: &mut Memo) -> Option<Machine> {
    let state = app.state::<AppState>();
    let table = snapshot()?;
    let now = Instant::now();
    let elapsed = memo.last.replace(now).map(|last| now - last);

    let roots = roots(&state);
    let mut procs = Vec::new();
    let mut time = HashMap::new();
    let mut hist = HashMap::new();
    // O que as outras raízes carregam sai da conta do app: elas já aparecem
    // como linha própria, logo abaixo.
    let mine: Vec<(u64, f64)> = roots
        .iter()
        .filter(|r| r.kind != "app")
        .map(|r| table.sum(r.pid))
        .collect();

    for root in &roots {
        let (mut rss, mut secs) = table.sum(root.pid);
        if root.kind == "app" {
            for (child_rss, child_secs) in &mine {
                rss = rss.saturating_sub(*child_rss);
                secs = (secs - child_secs).max(0.0);
            }
        }
        if rss == 0 && secs == 0.0 {
            continue;
        }
        // Sem tique anterior não há de onde tirar velocidade: a primeira
        // leitura entra com zero e a segunda já é a de verdade.
        let cpu = match (memo.time.get(&root.pid), elapsed) {
            (Some(before), Some(gap)) if gap.as_secs_f64() > 0.0 => {
                (((secs - before) / gap.as_secs_f64()) * 100.0).max(0.0) as f32
            }
            _ => 0.0,
        };
        let mut line = memo.hist.get(&root.pid).cloned().unwrap_or_default();
        line.push(cpu);
        if line.len() > HISTORY {
            line.drain(..line.len() - HISTORY);
        }
        time.insert(root.pid, secs);
        hist.insert(root.pid, line.clone());
        procs.push(Proc {
            kind: root.kind.to_string(),
            name: root.name.clone(),
            detail: root.detail.clone(),
            rss,
            cpu,
            hist: line,
        });
    }
    memo.time = time;
    memo.hist = hist;

    let next = Machine {
        rss: procs.iter().map(|p| p.rss).sum(),
        cpu: procs.iter().map(|p| p.cpu).sum(),
        procs,
        terms: alive_terms(&state),
        ports: ports(&state),
    };
    (next != memo.sent).then(|| {
        memo.sent = next.clone();
        next
    })
}

/// O app, cada conversa de pé e cada terminal de pé. Conversa e terminal
/// mortos ficam no mapa (é a rolagem deles que a aba mostra amanhã) mas não
/// gastam nada: não entram.
fn roots(state: &tauri::State<AppState>) -> Vec<Root> {
    let board = lock(&state.board);
    let title_of = |id: &str| {
        board
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .map(|w| w.title.clone())
            .unwrap_or_else(|| id.to_string())
    };
    let mut roots = vec![Root {
        pid: std::process::id(),
        kind: "app",
        name: "Prometheus".to_string(),
        detail: String::new(),
    }];
    for (id, chat) in lock(&state.chats).iter() {
        if !chat.alive() {
            continue;
        }
        // Workspace e aba: "conversa 1a2b3c" não diz a ninguém de onde veio
        // aquela memória.
        let named = board.workspaces.iter().find_map(|w| {
            let tab = w.tabs.iter().find(|t| &t.id == id)?;
            Some((w.title.clone(), tab.title.clone()))
        });
        let (name, detail) = named.unwrap_or_else(|| (id.clone(), String::new()));
        roots.push(Root {
            pid: chat.pid(),
            kind: "chat",
            name,
            detail,
        });
    }
    for (key, pty) in lock(&state.ptys).iter() {
        if !pty.alive() {
            continue;
        }
        let (id, kind) = key.split_once(':').unwrap_or((key.as_str(), ""));
        roots.push(Root {
            pid: pty.pid(),
            kind: "term",
            name: title_of(id),
            detail: kind.to_string(),
        });
    }
    roots
}

fn alive_terms(state: &tauri::State<AppState>) -> usize {
    lock(&state.ptys).values().filter(|p| p.alive()).count()
}

/// As portas que estão servindo agora: a do Run de cada workspace com o script
/// de pé. Não é uma varredura da máquina — é o que o app subiu, que é o que se
/// quer abrir no navegador.
fn ports(state: &tauri::State<AppState>) -> Vec<Port> {
    let ptys = lock(&state.ptys);
    let board = lock(&state.board);
    let mut ports: Vec<Port> = board
        .workspaces
        .iter()
        .filter_map(|w| {
            let port = w.port?;
            let up = ptys
                .get(&format!("{}:run", w.id))
                .is_some_and(|pty| pty.alive());
            up.then(|| Port {
                id: w.id.clone(),
                title: w.title.clone(),
                port,
            })
        })
        .collect();
    ports.sort_by_key(|process| process.port);
    ports
}

/* ---------- o `ps` ---------- */

/// A árvore de processos da máquina, com o que cada um pesa.
struct Table {
    rss: HashMap<u32, u64>,
    /// Tempo de CPU acumulado do processo, em segundos.
    time: HashMap<u32, f64>,
    kids: HashMap<u32, Vec<u32>>,
}

impl Table {
    /// O que esta subárvore soma: o processo e tudo que ele subiu.
    fn sum(&self, pid: u32) -> (u64, f64) {
        let mut rss = *self.rss.get(&pid).unwrap_or(&0);
        let mut time = *self.time.get(&pid).unwrap_or(&0.0);
        for kid in self.kids.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
            let (r, t) = self.sum(*kid);
            rss += r;
            time += t;
        }
        (rss, time)
    }
}

/// Um `ps` de tudo, uma vez por tique. Perguntar processo por processo custaria
/// um fork por conversa aberta.
fn snapshot() -> Option<Table> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-Ao", "pid=,ppid=,rss=,time="])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut table = Table {
        rss: HashMap::new(),
        time: HashMap::new(),
        kids: HashMap::new(),
    };
    for line in text.lines() {
        let mut cols = line.split_whitespace();
        let (Some(pid), Some(ppid), Some(rss), Some(time)) =
            (cols.next(), cols.next(), cols.next(), cols.next())
        else {
            continue;
        };
        let (Ok(pid), Ok(ppid), Ok(rss)) = (pid.parse(), ppid.parse::<u32>(), rss.parse::<u64>())
        else {
            continue;
        };
        // O `ps` do macOS dá RSS em KiB.
        table.rss.insert(pid, rss * 1024);
        table.time.insert(pid, cpu_time(time));
        table.kids.entry(ppid).or_default().push(pid);
    }
    (!table.rss.is_empty()).then_some(table)
}

/// O `TIME` do `ps`: `MM:SS.cc`, ou `HH:MM:SS.cc` quando passa da hora. Vira
/// segundos; o que não se entende vale zero, e o tique seguinte corrige.
fn cpu_time(text: &str) -> f64 {
    let parts: Vec<&str> = text.split(':').collect();
    let mut seconds = 0.0;
    for part in &parts {
        let Ok(n) = part.parse::<f64>() else {
            return 0.0;
        };
        seconds = seconds * 60.0 + n;
    }
    seconds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tempo_de_cpu_em_segundos() {
        assert!((cpu_time("0:12.34") - 12.34).abs() < 0.001);
        assert!((cpu_time("2:30.00") - 150.0).abs() < 0.001);
        assert!((cpu_time("1:00:00.00") - 3600.0).abs() < 0.001);
        assert_eq!(cpu_time("-"), 0.0);
    }

    #[test]
    fn a_subarvore_soma_os_filhos() {
        let table = Table {
            rss: HashMap::from([(1, 100), (2, 20), (3, 3)]),
            time: HashMap::from([(1, 10.0), (2, 2.0), (3, 0.5)]),
            kids: HashMap::from([(1, vec![2]), (2, vec![3])]),
        };
        assert_eq!(table.sum(1), (123, 12.5));
        assert_eq!(table.sum(2), (23, 2.5));
        assert_eq!(table.sum(9), (0, 0.0));
    }

    /// Um `ps` de verdade tem que dar pelo menos o processo do próprio teste.
    #[test]
    fn o_ps_desta_maquina_traz_a_arvore() {
        let table = snapshot().expect("ps não respondeu");
        let me = std::process::id();
        assert!(table.rss.contains_key(&me), "o próprio pid não veio");
        assert!(table.sum(me).0 > 0);
    }
}
