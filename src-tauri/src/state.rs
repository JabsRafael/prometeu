//! Três camadas, como no Conductor:
//!
//!   Projeto    um repositório registrado uma vez
//!     └ Workspace   um worktree numa branch — é o card do quadro
//!         └ Aba     uma sessão de agente (Claude Code ou Codex); várias dividem
//!                   os mesmos arquivos
//!
//! A separação existe porque perder uma conversa não pode custar o worktree, e
//! começar conversa nova sobre os arquivos que você já mexeu tem que ser ⌘T.

use crate::lock::lock;
use crate::{paths, AppState};
use serde::{Deserialize, Serialize};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

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

/// O que a linha de atividade da aba passa a dizer.
///
/// É um `Option<String>` com nome, e o nome é o ponto: antes o `None` que
/// chegava em `set` queria dizer "não mexe", então a aba que terminava
/// continuava mostrando a última ferramenta que rodou — o card dizia "pronta"
/// embaixo de uma linha que parecia trabalho acontecendo agora. Agora todo
/// evento diz explicitamente qual das duas coisas quer.
pub enum Note {
    /// Não há mais o que dizer: o trabalho parou.
    Clear,
    Set(String),
    /// O que estava escrito continua valendo: o agente falou no meio de uma
    /// ferramenta e outra, e a ferramenta é o que a linha conta.
    Keep,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Tab {
    /// É o `--session-id` do Claude Code. O transcript pendura nele.
    pub id: String,
    /// A sessão do lado do agente, quando ela não é este id. O Codex não aceita
    /// `--session-id`: escolhe o dele, conta qual foi no hook `SessionStart`, e é
    /// este número que volta como `codex resume <id>`. Vazio é aba do Claude
    /// Code (onde os dois ids são o mesmo) ou aba do Codex que ainda não subiu.
    #[serde(default)]
    pub agent_session: Option<String>,
    pub title: String,
    pub status: Status,
    pub note: Option<String>,
    pub pending_prompt: Option<String>,
    /// Tokens de contexto na última resposta — quão cheia a janela está.
    /// Atualizado quando o agente para (`Stop`), que é quando muda. Vazio é
    /// conversa que ainda não respondeu, ou quadro gravado antes disto existir.
    #[serde(default)]
    pub tokens: Option<u64>,
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
    /// O `--model` das conversas deste workspace — um alias (`opus`,
    /// `sonnet[1m]`) ou o nome inteiro. Vazio é "o que o Claude Code escolheria
    /// sozinho". É do workspace e não da aba porque ⌘T e retomar nascem com o
    /// mesmo modelo que as irmãs: trocar de modelo no meio é trocar de worktree.
    /// Quadro gravado antes disto existir vem sem o campo, e vazio é o que ele
    /// fazia então.
    #[serde(default)]
    pub model: String,
    /// O `--effort` (`low`…`max`, `ultracode`), pela mesma regra. Vazio é o
    /// padrão — só de quadro antigo: o lançador sempre escolhe um.
    #[serde(default)]
    pub effort: String,
    /// Qual CLI roda nas abas daqui: vazio (ou `claude`) é o Claude Code,
    /// `codex` é o Codex da OpenAI. Sai do modelo escolhido no lançador — quem
    /// escolhe um GPT escolheu o Codex —, e é do workspace pelo mesmo motivo do
    /// modelo: ⌘T e retomar nascem com o agente das irmãs.
    #[serde(default)]
    pub agent: String,
    /// Base das dez portas reservadas a este worktree — `$PROMETHEUS_PORT` até
    /// `+9`. Guardada e não calculada: o script tem que achar a mesma porta na
    /// segunda vez que roda, e dois worktrees do mesmo projeto não podem
    /// disputar a mesma. Nasce vazia em quadro gravado antes disto existir, e é
    /// preenchida na primeira vez que o workspace é aberto — o painel pede os
    /// scripts, e a porta vai junto, porque é ela que ele mostra.
    #[serde(default)]
    pub port: Option<u16>,
    /// A issue do Linear de onde este trabalho saiu, se saiu de uma. O card
    /// mostra o identificador, e a aba de issues sabe que esta já tem dono.
    #[serde(default)]
    pub issue: Option<crate::linear::IssueRef>,
    /// O PR desta branch, como o `gh` respondeu da última vez. É o quadro que
    /// guarda porque é o quadro que desenha: o selo de mergeado no card e os
    /// botões da barra saem daqui, e uma resposta de minutos atrás vale mais
    /// que uma consulta à rede a cada redesenho. Vazio é "não perguntei ainda"
    /// e "esta branch não tem PR" — para a tela dá no mesmo.
    #[serde(default)]
    pub pr: Option<crate::session::Pr>,
    /// O worktree foi devolvido ao disco: a pasta não existe mais e a branch
    /// local foi apagada. O card fica como histórico — transcript, o número do
    /// PR, o caminho que era —, mas nada aqui abre terminal de novo.
    #[serde(default)]
    pub cleaned: bool,
    /// Compartilhado com o time: o front anuncia este workspace ao relay e
    /// repassa a saída das conversas a quem estiver olhando. Persistido para o
    /// dono que fecha o app voltar compartilhando, sem ninguém pedir de novo.
    #[serde(default)]
    pub shared: bool,
    /// O worktree ainda está sendo montado. O card entra no quadro assim que o
    /// lançador fecha e o `git worktree add` — segundos, num repositório
    /// grande — acontece atrás. Enquanto isto for verdade não há aba nenhuma:
    /// o agente só nasce depois de existir pasta onde rodar.
    #[serde(default)]
    pub preparing: bool,
    /// Por que a montagem não deu, no formato do `i18n` — quem monta a frase é
    /// o `fromBack`. O card fica, com o erro escrito, em vez de sumir: a branch
    /// pedida pode estar viva em outro worktree, e é olhando o card que se
    /// decide o que fazer com ela.
    #[serde(default)]
    pub failed: Option<String>,
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
        board.revive();
        board
    }

    /// O que um quadro gravado precisa antes de virar o quadro de hoje: nada
    /// que estava vivo continua vivo, quadro velho ganha o que passou a
    /// existir, e o que ficou pela metade é dito em voz alta.
    ///
    /// Separado do `load` para poder ser testado: `load` lê de `paths::root()`,
    /// que sai de uma variável de ambiente — e ambiente é global, enquanto o
    /// cargo roda cada teste numa thread.
    fn revive(&mut self) {
        for ws in &mut self.workspaces {
            // O app fechou no meio da montagem. A thread que montava morreu com
            // o processo, então continuar dizendo "montando" seria esperar por
            // quem não vai voltar — e o worktree pode ter ficado pela metade.
            if ws.preparing {
                ws.preparing = false;
                ws.failed = Some(crate::i18n::t("err.session.interrupted"));
            }
            // Quadro gravado antes das abas existirem: o id do card era o id da
            // sessão, então ele vira a primeira aba e nada se perde. Workspace
            // que nunca chegou a montar não é disso: ele não tem aba porque
            // nenhuma nasceu, e inventar uma daria um "Retomar" que não retoma.
            if ws.tabs.is_empty() && ws.failed.is_none() {
                ws.tabs.push(Tab {
                    id: ws.id.clone(),
                    agent_session: None,
                    title: "conversa".into(),
                    status: Status::Desligada,
                    note: None,
                    pending_prompt: None,
                    tokens: None,
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
        let first = self.stages.first().cloned().unwrap_or_default();
        let stages = self.stages.clone();
        for ws in &mut self.workspaces {
            if !stages.contains(&ws.stage) {
                ws.stage = first.clone();
            }
        }

        // Repositório que já tem workspace é projeto, mesmo que nunca tenha sido
        // registrado à mão.
        for ws in self.workspaces.clone() {
            if !self.projects.iter().any(|p| p.path == ws.repo) {
                self.projects.push(Project {
                    id: ws.repo.clone(),
                    name: ws.repo_name.clone(),
                    path: ws.repo.clone(),
                });
            }
        }
    }

    /// Grava num arquivo ao lado e renomeia por cima. `rename` é atômico no
    /// mesmo sistema de arquivos, então nunca existe um `board.json` cortado no
    /// meio — e um quadro cortado no meio não volta a carregar.
    pub fn save(&self) {
        let path = path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let Ok(json) = serde_json::to_vec_pretty(self) else { return };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
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

/* ---------- publicar ---------- */

/// Manda o quadro para a tela e para o disco. Único caminho: quem mexe no
/// quadro mexe sob o lock e chama isto depois.
///
/// O lock sai antes de qualquer I/O. Antes ele ficava tomado durante o
/// `serde_json` e o `write`, e como isto roda **a cada ferramenta que o agente
/// usa**, cada tool call de cada sessão parava as outras para esperar o disco.
pub fn publish(app: &AppHandle) {
    let state = app.state::<AppState>();
    let board = Arc::new(lock(&state.board).clone());
    let _ = state.save.send(board.clone());
    let _ = app.emit("board", &*board);
}

/// Grava agora, nesta thread. É o que fecha a janela de perda que a gravação
/// adiada abre: o app morrendo dentro do `COALESCE` levaria junto a última
/// mudança. Chamado na saída, quando não há mais depois.
pub fn save_now(app: &AppHandle) {
    lock(&app.state::<AppState>().board).save();
}

/// Junta as gravações numa só. Uma sessão ativa dispara dezenas de eventos por
/// minuto, e o quadro inteiro cabe num write — então o que importa é gravar o
/// **último**, não todos.
const COALESCE: Duration = Duration::from_millis(250);

/// A thread que grava. Recebe o quadro por canal, espera a poeira assentar e
/// escreve uma vez só o estado mais recente que chegou.
pub fn spawn_saver() -> Sender<Arc<Board>> {
    let (tx, rx) = channel::<Arc<Board>>();
    std::thread::spawn(move || {
        while let Ok(mut board) = rx.recv() {
            std::thread::sleep(COALESCE);
            // Tudo que chegou durante a espera: só o último interessa.
            while let Ok(newer) = rx.try_recv() {
                board = newer;
            }
            board.save();
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;

    /// O mínimo que um workspace precisa no `board.json`: todo o resto tem
    /// `serde(default)`, e é justamente isso que um quadro velho aproveita.
    fn board_json(extra: &str) -> Board {
        let json = format!(
            r#"{{"stages":["Fazendo"],"projects":[],"workspaces":[
                 {{"id":"w","title":"t","repo":"/r","repo_name":"r",
                   "branch":"b","worktree":"/wt","stage":"Fazendo"{extra}}}]}}"#
        );
        serde_json::from_str(&json).expect("board não desserializou")
    }

    /// O app fechou no meio de montar um worktree. Voltar dizendo "montando"
    /// seria esperar por uma thread que morreu junto com o processo.
    #[test]
    fn montagem_interrompida_vira_erro_escrito_no_card() {
        let mut board = board_json(r#","preparing":true"#);
        board.revive();
        let ws = &board.workspaces[0];
        assert!(!ws.preparing, "não pode voltar montando");
        assert_eq!(ws.failed.as_deref(), Some(crate::i18n::t("err.session.interrupted")).as_deref());
    }

    /// E não inventa aba para ele: a migração que dá uma aba a quadro antigo é
    /// para quem teve sessão, não para quem nunca chegou a ter pasta. Uma aba
    /// aqui daria um "Retomar conversa" que não retoma nada.
    #[test]
    fn montagem_interrompida_nao_ganha_aba() {
        let mut board = board_json(r#","preparing":true"#);
        board.revive();
        assert!(board.workspaces[0].tabs.is_empty());
        assert!(board.workspaces[0].active.is_none());
    }

    /// O quadro que já existia continua ganhando a aba de migração — o campo
    /// novo não pode mudar o que acontece com quem foi gravado sem ele.
    #[test]
    fn quadro_antigo_sem_aba_continua_ganhando_a_sua() {
        let mut board = board_json("");
        board.revive();
        let ws = &board.workspaces[0];
        assert_eq!(ws.tabs.len(), 1);
        assert_eq!(ws.tabs[0].id, "w");
        assert_eq!(ws.active.as_deref(), Some("w"));
        assert!(ws.failed.is_none());
    }

    /// Nenhum PTY sobrevive ao app: aba gravada rodando volta desligada.
    #[test]
    fn aba_gravada_viva_volta_desligada() {
        let mut board = board_json(
            r#","tabs":[{"id":"t1","title":"conversa","status":"rodando","note":null,"pending_prompt":null}]"#,
        );
        board.revive();
        assert!(matches!(board.workspaces[0].tabs[0].status, Status::Desligada));
    }
}
