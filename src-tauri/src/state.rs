//! Três camadas, como no Conductor:
//!
//!   Projeto    um repositório registrado uma vez
//!     └ Workspace   um worktree numa branch — é o card do quadro
//!         └ Aba     uma sessão do Claude Code; várias dividem os mesmos arquivos
//!
//! A separação existe porque perder uma conversa não pode custar o worktree, e
//! começar conversa nova sobre os arquivos que você já mexeu tem que ser ⌘T.

use crate::paths;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Agente trabalhando.
    Rodando,
    /// Processo vivo, esperando o que você mandar.
    Pronta,
    /// Agente travado numa pergunta: não anda sem você.
    Querendo,
    /// Processo não está rodando. Não é morte: o transcript continua no disco e
    /// `claude --resume` traz a conversa de volta. Toda aba vira isso quando o
    /// app abre, porque nenhum processo sobrevive ao app.
    /// `other` cobre valores gravados por versões anteriores — e obriga esta a
    /// ser a última variante, por isso a urgência vive no `rank` e não na ordem.
    #[serde(other)]
    Desligada,
}

impl Status {
    /// Urgência. Um workspace mostra o maior entre suas abas: uma aba travada
    /// numa pergunta manda no card inteiro, senão o quadro esconderia o único
    /// número que muda o que você faz de manhã.
    pub fn rank(self) -> u8 {
        match self {
            Status::Querendo => 3,
            Status::Rodando => 2,
            Status::Pronta => 1,
            Status::Desligada => 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Tab {
    /// É o `--session-id` do Claude Code. O transcript pendura nele.
    pub id: String,
    pub title: String,
    pub status: Status,
    pub note: Option<String>,
    pub pending_prompt: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub project: String,
    pub repo: String,
    pub repo_name: String,
    pub branch: String,
    pub worktree: String,
    /// Onde o trabalho está — o que o quadro desenhava como coluna. É seu, não
    /// do processo: `Status` é o que o agente está fazendo agora, `stage` é o
    /// que você decidiu sobre o trabalho. `column` é o nome antigo.
    #[serde(alias = "column")]
    pub stage: String,
    /// Fora da lista, mas nada foi perdido: worktree, branch e transcript
    /// continuam onde estavam.
    #[serde(default)]
    pub archived: bool,
    /// No topo da lista. Não é etapa nem atividade: é "é neste que eu volto".
    #[serde(default)]
    pub pinned: bool,
    /// Aconteceu algo aqui enquanto você olhava outra coisa.
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub tabs: Vec<Tab>,
    #[serde(default)]
    pub active: Option<String>,
}

impl Workspace {
    /// O card mostra o estado mais urgente entre as abas.
    pub fn status(&self) -> Status {
        self.tabs
            .iter()
            .map(|t| t.status)
            .max_by_key(|s| s.rank())
            .unwrap_or(Status::Desligada)
    }

    /// A linha de atividade vem da aba mais urgente, pelo mesmo motivo.
    pub fn note(&self) -> Option<String> {
        self.tabs
            .iter()
            .max_by_key(|t| t.status.rank())
            .and_then(|t| t.note.clone())
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Board {
    /// A sequência de etapas, na ordem. O ícone de cada uma sai da posição
    /// nela, então trocar a lista troca os ícones — sem tabela para manter.
    #[serde(alias = "columns")]
    pub stages: Vec<String>,
    #[serde(default)]
    pub projects: Vec<Project>,
    /// `cards` era o nome antigo, quando workspace e sessão eram a mesma coisa.
    #[serde(alias = "cards")]
    pub workspaces: Vec<Workspace>,
}

impl Default for Board {
    fn default() -> Self {
        Board {
            stages: ["Preparando", "Fazendo", "Code review", "Travado", "Feito"]
                .map(String::from)
                .to_vec(),
            projects: Vec::new(),
            workspaces: Vec::new(),
        }
    }
}

impl Board {
    pub fn load() -> Board {
        let mut board: Board = std::fs::read_to_string(path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        for ws in &mut board.workspaces {
            // Quadro gravado antes das abas existirem: o id do card era o id da
            // sessão, então ele vira a primeira aba e nada se perde.
            if ws.tabs.is_empty() {
                ws.tabs.push(Tab {
                    id: ws.id.clone(),
                    title: "conversa".into(),
                    status: Status::Desligada,
                    note: None,
                    pending_prompt: None,
                });
            }
            // Nenhum PTY sobrevive ao fechamento do app, então qualquer status
            // gravado como vivo é mentira.
            for tab in &mut ws.tabs {
                tab.status = Status::Desligada;
            }
            if ws.active.is_none() {
                ws.active = ws.tabs.first().map(|t| t.id.clone());
            }
            if ws.project.is_empty() {
                ws.project = ws.repo.clone();
            }
        }

        // Etapa gravada que não está mais na lista deixaria o workspace fora de
        // todo grupo — invisível. Volta para a primeira.
        let first = board.stages.first().cloned().unwrap_or_default();
        for ws in &mut board.workspaces {
            if !board.stages.contains(&ws.stage) {
                ws.stage = first.clone();
            }
        }

        // Repositório que já tem workspace é projeto, mesmo que nunca tenha sido
        // registrado à mão.
        for ws in board.workspaces.clone() {
            if !board.projects.iter().any(|p| p.path == ws.repo) {
                board.projects.push(Project {
                    id: ws.repo.clone(),
                    name: ws.repo_name.clone(),
                    path: ws.repo.clone(),
                });
            }
        }
        board
    }

    pub fn save(&self) {
        if let Some(dir) = path().parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(self) {
            let _ = std::fs::write(path(), json);
        }
    }

    pub fn workspace_mut(&mut self, id: &str) -> Option<&mut Workspace> {
        self.workspaces.iter_mut().find(|w| w.id == id)
    }

    /// Procura a aba pelo id da sessão — é assim que um hook, que só conhece o
    /// `session_id`, encontra onde escrever.
    pub fn tab_mut(&mut self, session: &str) -> Option<&mut Tab> {
        self.workspaces
            .iter_mut()
            .flat_map(|w| w.tabs.iter_mut())
            .find(|t| t.id == session)
    }

    /// O workspace dono da sessão, para escrever nele — é assim que um hook,
    /// que só conhece o `session_id`, marca novidade no card certo.
    pub fn workspace_of_mut(&mut self, session: &str) -> Option<&mut Workspace> {
        self.workspaces.iter_mut().find(|w| w.tabs.iter().any(|t| t.id == session))
    }

    pub fn workspace_of(&self, session: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.tabs.iter().any(|t| t.id == session))
    }
}

fn path() -> std::path::PathBuf {
    paths::root().join("board.json")
}
