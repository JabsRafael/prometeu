//! Os scripts que um repositório declara para o Prometheus: o que rodar quando
//! um worktree nasce (`setup`), o que sobe o projeto (`run`), e o que limpar
//! quando ele é arquivado (`archive`).
//!
//! Isto é o que faz worktree separado servir para *testar*, e não só para
//! editar: worktree novo vem sem nada que o `.gitignore` esconde — dependências,
//! `.env`, banco, build. Sem um `setup`, todo worktree nasce quebrado.
//!
//! Nada aqui é descoberto sozinho, e está tudo bem: o repositório declara. O que
//! o Prometheus faz é não deixar isso virar trabalho manual — o botão
//! "Perguntar ao agente" manda o próprio Claude Code ler o repo e escrever o
//! arquivo.
//!
//! Lê `.prometheus/settings.toml` e cai para `.conductor/settings.toml`: quem já
//! usa Conductor não configura nada de novo. Vale um só — o primeiro que existir
//! manda, para não juntar metade de cada.
//!
//! Worktree que não tem arquivo nenhum usa o do clone de onde saiu. É comum o
//! `.prometheus/` estar no `.gitignore` — configuração pessoal, num repositório
//! de empresa —, e aí todo worktree nascia sem setup e sem Run, e quem queria
//! subir o projeto digitava `npm run dev` à mão: porta fixa, e o segundo
//! worktree derrubava o primeiro.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Na ordem em que são procurados. O do Prometheus vem primeiro para quem quiser
/// um comando diferente aqui sem mexer no que o Conductor lê.
pub const FILES: [&str; 2] = [".prometheus/settings.toml", ".conductor/settings.toml"];

/// O que escrever quando não há arquivo nenhum. Comentado, porque este arquivo é
/// o contrato inteiro entre o repositório e o Prometheus.
pub const TEMPLATE: &str = r#"# Scripts que o Prometheus roda neste repositório.
#
# `setup`   roda sozinho quando um worktree nasce; a primeira fala do agente espera por ele
# `run`     é o botão Run
# `archive` roda antes de arquivar o workspace
#
# Rodam com `/bin/sh -lc`, com o worktree como diretório atual, e recebem:
#
#   $PROMETHEUS_WORKSPACE_PATH  o worktree onde o script está rodando
#   $PROMETHEUS_ROOT_PATH       o repositório de onde ele saiu
#   $PROMETHEUS_WORKSPACE_NAME  o nome deste workspace
#   $PROMETHEUS_PORT            porta reservada só para ele, mais nove até +9
#   $PORT                       a mesma porta, para o que já respeita a convenção
#
# Porta fixa faz dois worktrees brigarem — use $PROMETHEUS_PORT.

[scripts]
setup = "npm install"
run = "npm run dev -- --port $PROMETHEUS_PORT"
"#;

#[derive(Deserialize, Default)]
struct Table {
    setup: Option<String>,
    /// Cru de propósito: `run` aceita as duas formas que o Conductor documenta —
    /// uma string só, ou uma tabela de scripts nomeados. Um enum `untagged`
    /// resolveria no papel, mas o custo de errar é o arquivo inteiro virar
    /// "nenhum script"; ramificar no `Value` é explícito e não tem esse risco.
    run: Option<toml::Value>,
    archive: Option<String>,
}

#[derive(Deserialize, Default)]
struct File {
    #[serde(default)]
    scripts: Table,
}

#[derive(Serialize, Clone)]
pub struct Run {
    /// O nome da tabela `[scripts.run.<nome>]`, ou `"run"` quando é a string
    /// única. É o que aparece na lista do botão.
    pub name: String,
    pub command: String,
}

#[derive(Serialize, Clone, Default)]
pub struct Scripts {
    /// Qual dos `FILES` respondeu. `None` quando não há nenhum — e é isso que o
    /// front usa para desenhar o estado vazio em vez de um terminal mudo.
    pub file: Option<String>,
    /// O arquivo veio do clone de origem, e não do worktree: ver `read_for`.
    /// "Abrir o settings.toml" vira copiar, porque não há o que abrir aqui.
    pub inherited: bool,
    pub setup: Option<String>,
    pub runs: Vec<Run>,
    pub archive: Option<String>,
}

impl Scripts {
    /// O run que o botão dispara: o marcado como `default`, senão o primeiro.
    pub fn run(&self, name: Option<&str>) -> Option<&Run> {
        match name {
            Some(n) => self.runs.iter().find(|r| r.name == n),
            None => self.runs.first(),
        }
    }
}

/// O que vale para um workspace: o arquivo do worktree, e sem ele o do clone
/// de origem. O worktree ganha inteiro — um `setup` daqui e um `run` de lá seria
/// pior que qualquer um dos dois. Workspace solto no clone lê uma vez só.
pub fn read_for(worktree: &Path, repo: &Path) -> Scripts {
    let own = read(worktree);
    if own.file.is_some() || worktree == repo {
        return own;
    }
    let mut inherited = read(repo);
    inherited.inherited = inherited.file.is_some();
    inherited
}

pub fn read(root: &Path) -> Scripts {
    for file in FILES {
        let Ok(text) = std::fs::read_to_string(root.join(file)) else { continue };
        // TOML quebrado é erro do usuário, não motivo para o app sumir com a
        // aba: vira "nenhum script", e o arquivo continua lá para ele consertar.
        let parsed: File = toml::from_str(&text).unwrap_or_default();
        return Scripts {
            file: Some(file.to_string()),
            inherited: false,
            setup: trimmed(parsed.scripts.setup),
            runs: runs(parsed.scripts.run),
            archive: trimmed(parsed.scripts.archive),
        };
    }
    Scripts::default()
}

fn trimmed(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn runs(spec: Option<toml::Value>) -> Vec<Run> {
    match spec {
        // `run = "..."`: um script só, e o nome não vem de lugar nenhum.
        Some(toml::Value::String(command)) => trimmed(Some(command))
            .map(|command| vec![Run { name: "run".into(), command }])
            .unwrap_or_default(),
        // `[scripts.run.<nome>]`: vários, cada um com seu `command`.
        Some(toml::Value::Table(table)) => {
            let mut list: Vec<(bool, Run)> = table
                .into_iter()
                .filter_map(|(name, value)| {
                    let entry = value.as_table()?;
                    let command = trimmed(entry.get("command")?.as_str().map(str::to_string))?;
                    let default = entry.get("default").and_then(toml::Value::as_bool).unwrap_or(false);
                    Some((default, Run { name, command }))
                })
                .collect();
            // O marcado como padrão vai para a frente, porque é ele que o botão
            // dispara; o resto fica na ordem em que o TOML foi lido.
            list.sort_by_key(|(is_default, _)| !is_default);
            list.into_iter().map(|(_, run)| run).collect()
        }
        _ => Vec::new(),
    }
}

/// O contrato com o script. Os nomes do Conductor vão junto com os do Prometheus
/// para que um `.conductor/settings.toml` copiado de outro projeto funcione sem
/// edição — e para que quem escreve para o Prometheus não precise citar o outro.
///
/// `PORT` vai solto também: é a convenção que Rails, Next, Express e o Procfile
/// do Heroku já respeitam. Com ela, um `npm run dev` digitado no terminal do
/// dock sobe na porta do worktree sem que ninguém tenha escrito script nenhum.
pub fn env(worktree: &Path, repo: &Path, name: &str, port: Option<u16>) -> Vec<(String, String)> {
    let mut pairs = vec![
        ("WORKSPACE_PATH", worktree.display().to_string()),
        ("ROOT_PATH", repo.display().to_string()),
        ("WORKSPACE_NAME", name.to_string()),
    ];
    if let Some(port) = port {
        pairs.push(("PORT", port.to_string()));
    }
    let mut out: Vec<(String, String)> = pairs
        .into_iter()
        .flat_map(|(key, value)| {
            [(format!("PROMETHEUS_{key}"), value.clone()), (format!("CONDUCTOR_{key}"), value)]
        })
        .collect();
    if let Some(port) = port {
        out.push(("PORT".into(), port.to_string()));
    }
    out
}

/// Dez portas por workspace, como no Conductor: `$PROMETHEUS_PORT` até `+9`.
///
/// A base é sempre múltipla de dez, então a conta que o script faz
/// (`$((PROMETHEUS_PORT + 1))`) nunca cai na faixa do vizinho. `taken` são as
/// bases que outros workspaces já guardaram — o teste de `bind` sozinho não
/// bastaria, porque workspace parado não segura porta nenhuma e a base dele
/// seria entregue de novo.
///
/// A procura começa num ponto que sai do caminho do worktree, e não sempre da
/// primeira. Cada Prometheus de pé — o instalado e cada `tauri dev` — tem o seu
/// quadro, e quadros que não se conhecem começando todos de 3100 entregavam a
/// mesma porta para worktrees diferentes; o `bind` só pega o vizinho enquanto
/// ele está rodando. Com o ponto de partida vindo do caminho, worktrees
/// diferentes caem longe um do outro, e o mesmo worktree ganha a mesma porta em
/// qualquer quadro. Não é à prova de tudo — são 690 faixas, e dois caminhos
/// podem cair na mesma — mas é o bastante para os três ou quatro ambientes que
/// alguém sobe ao mesmo tempo.
pub fn alloc_port(worktree: &Path, taken: &[u16]) -> Option<u16> {
    const FIRST: u16 = 3100;
    const SLOTS: u16 = (9990 - FIRST) / 10 + 1;
    let start = (crate::paths::fnv1a(&worktree.to_string_lossy()) % u64::from(SLOTS)) as u16;
    (0..SLOTS)
        .map(|i| FIRST + ((start + i) % SLOTS) * 10)
        .find(|base| !taken.contains(base) && (0..10).all(|i| free(base + i)))
}

/// Livre nos dois loopbacks: o vite, por exemplo, escuta só em `::1`, e
/// `127.0.0.1` desocupado não diz nada sobre ele. Bind que falha por outro
/// motivo — máquina sem IPv6 — não é porta ocupada.
fn free(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener};
    [IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)]
        .into_iter()
        .all(|ip| match TcpListener::bind((ip, port)) {
            Ok(_) => true,
            Err(e) => e.kind() != std::io::ErrorKind::AddrInUse,
        })
}

/// O que o botão "Perguntar ao agente" manda na conversa nova. É prompt e não
/// código porque a resposta certa mora no README e nos manifestos do repo, que
/// nenhuma heurística lê tão bem quanto o agente que já está ali dentro.
pub fn ask_prompt(file: &str) -> String {
    format!(
        r#"Descubra como preparar e como rodar este projeto, e escreva isso em `{file}`.

O Prometheus roda cada trabalho num worktree git separado. Worktree novo vem sem
nada que o `.gitignore` esconde: dependências, `.env`, banco, build. O `setup` é
o que transforma o worktree num lugar onde dá para trabalhar; o `run` é o que
sobe o projeto para eu ver a mudança funcionando.

Leia o README, os manifestos de pacote e os scripts do repositório antes de
responder. Não chute.

Formato:

```toml
[scripts]
setup = "..."
run = "..."
```

Regras:

- Rodam com `/bin/sh -lc`, com o worktree como diretório atual.
- `setup` precisa ser idempotente: roda inteiro em cada worktree novo.
- `run` precisa ficar em primeiro plano — sem `&`, sem `--daemon`. O Prometheus
  mostra a saída num terminal e mata o processo quando eu peço.
- Se o projeto abre porta, use `$PROMETHEUS_PORT`. Ela é reservada só para este
  worktree; porta fixa faz dois worktrees brigarem. Há mais nove, de
  `$PROMETHEUS_PORT`+1 a +9. `$PORT` vale o mesmo, para o que já lê a convenção.
- Outras variáveis: `$PROMETHEUS_WORKSPACE_PATH`, `$PROMETHEUS_ROOT_PATH`,
  `$PROMETHEUS_WORKSPACE_NAME`.
- Nada destrutivo fora do worktree, e nada de rede além do que instalar
  dependência exige.

Escreva o arquivo e rode o `setup` uma vez para confirmar que ele passa."#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("prometheus-scripts-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn le_as_tres_chaves() {
        let dir = tmp("tres");
        write(
            &dir,
            ".prometheus/settings.toml",
            "[scripts]\nsetup = \"npm i\"\nrun = \"npm dev\"\narchive = \"rm -rf tmp\"\n",
        );
        let s = read(&dir);
        assert_eq!(s.setup.as_deref(), Some("npm i"));
        assert_eq!(s.run(None).unwrap().command, "npm dev");
        assert_eq!(s.archive.as_deref(), Some("rm -rf tmp"));
        assert_eq!(s.file.as_deref(), Some(".prometheus/settings.toml"));
    }

    /// A forma que o Conductor documenta em `[scripts.run.<nome>]` não pode
    /// quebrar a leitura — e o marcado como padrão tem que vir na frente.
    #[test]
    fn run_nomeado_com_padrao_na_frente() {
        let dir = tmp("nomeado");
        write(
            &dir,
            ".conductor/settings.toml",
            r#"[scripts]
setup = "pnpm i"

[scripts.run.api]
command = "bin/api"

[scripts.run.web]
command = "pnpm dev"
default = true
"#,
        );
        let s = read(&dir);
        assert_eq!(s.runs.len(), 2);
        assert_eq!(s.run(None).unwrap().name, "web");
        assert_eq!(s.run(Some("api")).unwrap().command, "bin/api");
    }

    /// O do Prometheus ganha, e não se mistura com o do Conductor: metade de
    /// cada arquivo seria pior que qualquer um dos dois inteiro.
    #[test]
    fn prometheus_tem_prioridade_e_nao_mistura() {
        let dir = tmp("prioridade");
        write(&dir, ".conductor/settings.toml", "[scripts]\nsetup = \"velho\"\nrun = \"velho\"\n");
        write(&dir, ".prometheus/settings.toml", "[scripts]\nrun = \"novo\"\n");
        let s = read(&dir);
        assert_eq!(s.run(None).unwrap().command, "novo");
        assert!(s.setup.is_none());
    }

    /// TOML quebrado não pode sumir com a aba: vira "nenhum script", e o arquivo
    /// continua no disco para o usuário consertar.
    #[test]
    fn toml_quebrado_nao_explode() {
        let dir = tmp("quebrado");
        write(&dir, ".prometheus/settings.toml", "[scripts\nsetup = ");
        let s = read(&dir);
        assert!(s.setup.is_none() && s.runs.is_empty());
        assert_eq!(s.file.as_deref(), Some(".prometheus/settings.toml"));
    }

    #[test]
    fn sem_arquivo_nao_tem_script() {
        let s = read(&tmp("vazio"));
        assert!(s.file.is_none() && s.runs.is_empty());
    }

    /// Worktree sem arquivo usa o do clone de origem, marcado como herdado; com
    /// arquivo próprio, o do clone não entra — nem para completar o que falta.
    #[test]
    fn worktree_sem_arquivo_herda_o_do_clone() {
        let repo = tmp("herda-repo");
        let wt = tmp("herda-wt");
        write(&repo, ".prometheus/settings.toml", "[scripts]\nsetup = \"npm i\"\nrun = \"npm dev\"\n");

        let s = read_for(&wt, &repo);
        assert!(s.inherited);
        assert_eq!(s.run(None).unwrap().command, "npm dev");
        assert_eq!(s.file.as_deref(), Some(".prometheus/settings.toml"));

        write(&wt, ".prometheus/settings.toml", "[scripts]\nrun = \"meu\"\n");
        let s = read_for(&wt, &repo);
        assert!(!s.inherited);
        assert_eq!(s.run(None).unwrap().command, "meu");
        assert!(s.setup.is_none());

        // Solto no clone: é o mesmo diretório, e nada é "herdado".
        assert!(!read_for(&repo, &repo).inherited);
        // Clone sem arquivo também não inventa um.
        let vazio = tmp("herda-vazio");
        assert!(read_for(&wt, &vazio).file.is_some()); // o do worktree, escrito acima
        assert!(read_for(&vazio, &vazio).file.is_none());
    }

    /// O settings.toml deste repositório é o caso mais torto que existe: `setup`
    /// solto no `[scripts]`, dois runs em tabela, e um `command` de várias
    /// linhas. Se ele deixar de ser lido, o Prometheus para de conseguir rodar o
    /// Prometheus — e isso não pode falhar em silêncio.
    #[test]
    fn o_proprio_repositorio_e_lido() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let s = read(root);
        assert_eq!(s.file.as_deref(), Some(".prometheus/settings.toml"));
        assert!(s.setup.as_deref().is_some_and(|c| c.contains("sidecar.sh")));
        assert_eq!(s.run(None).unwrap().name, "app");
        assert!(s.run(Some("browser")).unwrap().command.contains("Google Chrome"));
    }

    #[test]
    fn env_traz_os_dois_prefixos_e_o_port_solto() {
        let pairs = env(Path::new("/wt"), Path::new("/repo"), "x", Some(3100));
        let get = |k: &str| pairs.iter().find(|(a, _)| a == k).map(|(_, b)| b.clone());
        assert_eq!(get("PROMETHEUS_PORT").as_deref(), Some("3100"));
        assert_eq!(get("CONDUCTOR_PORT").as_deref(), Some("3100"));
        assert_eq!(get("PORT").as_deref(), Some("3100"));
        assert_eq!(get("CONDUCTOR_WORKSPACE_PATH").as_deref(), Some("/wt"));
        // Sem porta, `PORT` não vai vazio: vazio quebraria o `${PORT:-3000}` de todo mundo.
        assert!(env(Path::new("/wt"), Path::new("/repo"), "x", None).iter().all(|(k, _)| k != "PORT"));
    }

    /// A base precisa ser múltipla de dez, senão `$PORT+1` de um cai no `$PORT`
    /// do outro — e a já guardada nunca é entregue de novo.
    #[test]
    fn porta_pula_a_ja_guardada_e_e_multipla_de_dez() {
        let wt = Path::new("/wt/a");
        let first = alloc_port(wt, &[]).unwrap();
        assert_eq!(first % 10, 0);
        let second = alloc_port(wt, &[first]).unwrap();
        assert_ne!(second, first);
        assert_eq!(second % 10, 0);
        assert!((3100..=9990).contains(&second));
    }

    /// O mesmo worktree cai na mesma porta em qualquer quadro; worktrees
    /// diferentes começam a procura em pontos diferentes.
    #[test]
    fn porta_sai_do_caminho_do_worktree() {
        let a = Path::new("/Users/ana/prometheus/worktrees/app/feat-a");
        let b = Path::new("/Users/ana/prometheus/worktrees/app/feat-b");
        assert_eq!(alloc_port(a, &[]), alloc_port(a, &[]));
        assert_ne!(alloc_port(a, &[]), alloc_port(b, &[]));
    }
}
