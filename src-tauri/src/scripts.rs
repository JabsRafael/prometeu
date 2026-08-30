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
//!
//! O outro que o `.gitignore` esconde é o `.env`. Esse nenhum `setup` reconstrói
//! — não dá para derivar segredo de lugar nenhum —, então ele é copiado do clone
//! antes do setup rodar: `[worktree] copy`, e sem declaração o `.env` da raiz e
//! os irmãos dele. Ver `copies` e `hydrate`.

use crate::i18n;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

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

# O que cada worktree novo recebe do clone de origem, antes do setup: o que o
# `.gitignore` esconde e nenhum script reconstrói. Sem esta lista vai o `.env` da
# raiz e os irmãos dele; `copy = []` desliga. Nunca sobrescreve o que já está aqui.
#
# [worktree]
# copy = [".env", "config/master.key"]
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

/// `[worktree]` do settings.toml. Separado de `[scripts]` porque não é script:
/// é o que o Prometheus faz *antes* de qualquer um deles rodar.
#[derive(Deserialize, Default)]
struct WorktreeTable {
    /// `None` é "não declarou", e vale o automático de `auto`. `Some(vec![])` é
    /// a escolha explícita de não copiar nada — os dois precisam existir.
    copy: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
struct File {
    #[serde(default)]
    scripts: Table,
    #[serde(default)]
    worktree: WorktreeTable,
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
    /// O que este worktree recebe do clone, já resolvido: o `[worktree] copy`
    /// declarado, ou o automático. É o que a aba Setup mostra, e é o que faz ela
    /// existir mesmo num repositório sem `setup` nenhum.
    pub copy: Vec<String>,
    /// Cru, como o arquivo escreveu — `None` é "não declarou". Só o `read_for`
    /// usa, para resolver o `copy`; o front lê a lista pronta.
    #[serde(skip)]
    declared: Option<Vec<String>>,
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
    let mut found = read(worktree);
    if found.file.is_none() && worktree != repo {
        found = read(repo);
        found.inherited = found.file.is_some();
    }
    // Depois de escolher o arquivo, e não antes: a lista que vale é a de quem
    // mandou — inclusive quando quem mandou foi o clone de origem.
    found.copy = copies(worktree, repo, found.declared.as_deref());
    found
}

pub fn read(root: &Path) -> Scripts {
    for file in FILES {
        let Ok(text) = std::fs::read_to_string(root.join(file)) else {
            continue;
        };
        // TOML quebrado é erro do usuário, não motivo para o app sumir com a
        // aba: vira "nenhum script", e o arquivo continua lá para ele consertar.
        let parsed: File = toml::from_str(&text).unwrap_or_default();
        return Scripts {
            file: Some(file.to_string()),
            inherited: false,
            setup: trimmed(parsed.scripts.setup),
            runs: runs(parsed.scripts.run),
            archive: trimmed(parsed.scripts.archive),
            copy: Vec::new(),
            declared: parsed.worktree.copy,
        };
    }
    Scripts::default()
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn runs(spec: Option<toml::Value>) -> Vec<Run> {
    match spec {
        // `run = "..."`: um script só, e o nome não vem de lugar nenhum.
        Some(toml::Value::String(command)) => trimmed(Some(command))
            .map(|command| {
                vec![Run {
                    name: "run".into(),
                    command,
                }]
            })
            .unwrap_or_default(),
        // `[scripts.run.<nome>]`: vários, cada um com seu `command`.
        Some(toml::Value::Table(table)) => {
            let mut list: Vec<(bool, Run)> = table
                .into_iter()
                .filter_map(|(name, value)| {
                    let entry = value.as_table()?;
                    let command = trimmed(entry.get("command")?.as_str().map(str::to_string))?;
                    let default = entry
                        .get("default")
                        .and_then(toml::Value::as_bool)
                        .unwrap_or(false);
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

/* ---------- o que o worktree recebe do clone ---------- */

/// O que aconteceu com um arquivo da lista. Vira as linhas que a aba Setup
/// mostra antes da saída do script: cópia calada é mágica, e mágica que falha
/// não tem onde ser vista.
pub enum Copied {
    Made(String),
    /// O worktree já tinha. Aparece na tela mesmo assim — é o que explica por
    /// que o `.env` daqui não é o do clone depois de alguém editar um dos dois.
    Kept(String),
    Failed(String, String),
}

/// Os arquivos que este worktree recebe do clone de origem, resolvidos.
///
/// A lista é o que existe **no clone**, e não o que falta aqui: se encolhesse a
/// cada cópia, a aba Setup sumiria da barra no segundo em que passou a ter
/// motivo para existir.
///
/// Workspace que roda no próprio clone não recebe nada — não há de onde copiar.
pub fn copies(worktree: &Path, repo: &Path, declared: Option<&[String]>) -> Vec<String> {
    if worktree == repo {
        return Vec::new();
    }
    match declared {
        Some(list) => list
            .iter()
            .map(|rel| rel.trim().to_string())
            .filter(|rel| safe(rel).is_some_and(|path| repo.join(path).exists()))
            .collect(),
        None => auto(repo),
    }
}

/// Sem declaração, o `.env` da raiz do clone e os irmãos dele — `.env.local`,
/// `.env.development` —, que é como o mesmo segredo costuma estar partido.
///
/// Os exemplos ficam de fora porque vêm no commit: já estão em todo worktree, e
/// listá-los seria prometer uma cópia que nunca acontece. O resto do que o
/// `.gitignore` esconde não precisa de teste nenhum: a cópia não sobrescreve, e
/// arquivo versionado já está aqui.
fn auto(repo: &Path) -> Vec<String> {
    const SAMPLES: [&str; 4] = [".env.example", ".env.sample", ".env.template", ".env.dist"];
    let Ok(dir) = std::fs::read_dir(repo) else {
        return Vec::new();
    };
    let mut out: Vec<String> = dir
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            let keep = name.starts_with(".env")
                && !SAMPLES.contains(&name.as_str())
                && entry.path().is_file();
            keep.then_some(name)
        })
        .collect();
    out.sort();
    out
}

/// Relativo e para dentro do worktree. Absoluto ou com `..` sai do repositório,
/// e ler ou escrever fora dele não é o que este campo promete.
fn safe(rel: &str) -> Option<PathBuf> {
    let path = Path::new(rel.trim());
    let inside = path.components().all(|c| matches!(c, Component::Normal(_)));
    (inside && path.components().next().is_some()).then(|| path.to_path_buf())
}

/// Copia do clone o que falta aqui, antes de o setup rodar.
///
/// Nunca sobrescreve: arquivo que já está no worktree é o que veio no commit ou
/// o que alguém editou de propósito, e os dois valem mais que a cópia. Por isso
/// também é seguro rodar de novo — "Rodar o setup de novo" busca o que faltar
/// sem desfazer nada.
pub fn hydrate(worktree: &Path, repo: &Path, list: &[String]) -> Vec<Copied> {
    if worktree == repo {
        return Vec::new();
    }
    list.iter()
        .filter_map(|rel| {
            let path = safe(rel)?;
            let to = worktree.join(&path);
            if to.exists() {
                return Some(Copied::Kept(rel.clone()));
            }
            Some(match copy_into(&repo.join(&path), &to) {
                Ok(()) => Copied::Made(rel.clone()),
                Err(e) => Copied::Failed(rel.clone(), e),
            })
        })
        .collect()
}

/// Arquivo ou diretório inteiro. O `fs::copy` leva os bits de permissão junto, e
/// é disso que uma chave privada depende para continuar sendo aceita.
fn copy_into(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(i18n::io)?;
    }
    if !from.is_dir() {
        return std::fs::copy(from, to).map(|_| ()).map_err(i18n::io);
    }
    std::fs::create_dir_all(to).map_err(i18n::io)?;
    for entry in std::fs::read_dir(from).map_err(i18n::io)? {
        let entry = entry.map_err(i18n::io)?;
        copy_into(&entry.path(), &to.join(entry.file_name()))?;
    }
    Ok(())
}

/// O cabeçalho da aba Setup. `None` quando não há lista nenhuma: worktree que
/// não recebe nada não ganha linha em branco no começo do log.
pub fn report(notes: &[Copied]) -> Option<String> {
    if notes.is_empty() {
        return None;
    }
    let mut out = String::new();
    for note in notes {
        out.push_str(&match note {
            Copied::Made(path) => {
                format!(
                    "\x1b[32m→\x1b[0m {path} {}\r\n",
                    i18n::pick("veio do clone", "copied from the clone")
                )
            }
            Copied::Kept(path) => {
                format!(
                    "\x1b[2m· {path} {}\x1b[0m\r\n",
                    i18n::pick("já estava aqui", "already here")
                )
            }
            Copied::Failed(path, why) => format!("\x1b[31m✗\x1b[0m {path}: {why}\r\n"),
        });
    }
    out.push_str("\r\n");
    Some(out)
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
            [
                (format!("PROMETHEUS_{key}"), value.clone()),
                (format!("CONDUCTOR_{key}"), value),
            ]
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
        .find(|base| !taken.contains(base) && (0..10).all(|i| usable(base + i) && free(base + i)))
}

/// Portas que navegador nenhum abre: a lista de "bad ports" da spec Fetch, que
/// Chrome (`ERR_UNSAFE_PORT`) e WebKit (`URL::portAllowed`) seguem. Um servidor
/// na 5060 sobe e responde ao curl, mas a janela fica branca sem dizer por quê.
/// Só as que cabem na faixa do alocador; as abaixo de 3100 nunca saem dele.
const BAD: &[u16] = &[
    3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
];

/// Se um navegador aceita abrir `localhost:{port}`.
pub fn usable(port: u16) -> bool {
    !BAD.contains(&port)
}

/// Livre nos dois loopbacks: o vite, por exemplo, escuta só em `::1`, e
/// `127.0.0.1` desocupado não diz nada sobre ele. Bind que falha por outro
/// motivo — máquina sem IPv6 — não é porta ocupada.
fn free(port: u16) -> bool {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener};
    [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ]
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
sobe o projeto para eu ver a mudança funcionando. O que nenhum comando
reconstrói — segredo, chave — vai em `[worktree] copy`, e o Prometheus copia do
clone de origem antes do setup.

Leia o README, os manifestos de pacote e os scripts do repositório antes de
responder. Não chute.

Formato:

```toml
[scripts]
setup = "..."
run = "..."

[worktree]
copy = [".env"]
```

Regras:

- Rodam com `/bin/sh -lc`, com o worktree como diretório atual.
- `setup` precisa ser idempotente: roda inteiro em cada worktree novo.
- `copy` são caminhos relativos à raiz do repositório, e só o que o `.gitignore`
  esconde e nenhum comando refaz. Não escreva `cp` no `setup` para isso: a cópia
  acontece antes dele, nunca sobrescreve, e aparece na aba Setup. Omita a seção
  inteira se o `.env` da raiz é o único caso — esse já vai sozinho.
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

    struct Tmp(std::path::PathBuf);

    impl std::ops::Deref for Tmp {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn tmp(name: &str) -> Tmp {
        let dir = std::env::temp_dir().join(format!(
            "prometheus-scripts-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
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
        write(
            &dir,
            ".conductor/settings.toml",
            "[scripts]\nsetup = \"velho\"\nrun = \"velho\"\n",
        );
        write(
            &dir,
            ".prometheus/settings.toml",
            "[scripts]\nrun = \"novo\"\n",
        );
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
        write(
            &repo,
            ".prometheus/settings.toml",
            "[scripts]\nsetup = \"npm i\"\nrun = \"npm dev\"\n",
        );

        let s = read_for(&wt, &repo);
        assert!(s.inherited);
        assert_eq!(s.run(None).unwrap().command, "npm dev");
        assert_eq!(s.file.as_deref(), Some(".prometheus/settings.toml"));

        write(
            &wt,
            ".prometheus/settings.toml",
            "[scripts]\nrun = \"meu\"\n",
        );
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
        assert_eq!(s.setup.as_deref(), Some("npm install"));
        assert_eq!(s.run(None).unwrap().name, "app");
        assert!(s
            .run(Some("browser"))
            .unwrap()
            .command
            .contains("Google Chrome"));
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
        assert!(env(Path::new("/wt"), Path::new("/repo"), "x", None)
            .iter()
            .all(|(k, _)| k != "PORT"));
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

    /// Sem `[worktree] copy`, o `.env` da raiz e os irmãos dele. Exemplo fica
    /// de fora: vem no commit, então já está no worktree.
    #[test]
    fn copia_automatica_pega_os_env_e_deixa_o_exemplo() {
        let repo = tmp("auto-repo");
        for name in [".env", ".env.local", ".env.example", "package.json"] {
            write(&repo, name, "x");
        }
        std::fs::create_dir_all(repo.join(".env.d")).unwrap();
        let wt = tmp("auto-wt");
        assert_eq!(
            copies(&wt, &repo, None),
            vec![".env".to_string(), ".env.local".to_string()]
        );
    }

    /// Declarado manda: só o que existe no clone, e nada que aponte para fora.
    #[test]
    fn copia_declarada_filtra_o_que_nao_existe_e_o_que_escapa() {
        let repo = tmp("decl-repo");
        write(&repo, ".env", "x");
        write(&repo, "config/master.key", "x");
        let wt = tmp("decl-wt");
        let declared = [
            ".env".to_string(),
            "config/master.key".to_string(),
            "nao-existe".to_string(),
            "../fora".to_string(),
            "/etc/passwd".to_string(),
        ];
        assert_eq!(
            copies(&wt, &repo, Some(&declared)),
            vec![".env".to_string(), "config/master.key".to_string()]
        );
        // Workspace no próprio clone não recebe nada: não há de onde copiar.
        assert!(copies(&repo, &repo, Some(&declared)).is_empty());
    }

    /// A lista é o que existe no clone, e não o que falta aqui: se encolhesse
    /// depois da cópia, a aba Setup sumiria assim que passasse a ter conteúdo.
    #[test]
    fn copia_declarada_nao_encolhe_depois_de_copiar() {
        let repo = tmp("estavel-repo");
        write(&repo, ".env", "PORT=3000");
        let wt = tmp("estavel-wt");
        let list = copies(&wt, &repo, None);
        hydrate(&wt, &repo, &list);
        assert_eq!(copies(&wt, &repo, None), list);
    }

    #[test]
    fn hydrate_copia_o_que_falta_e_nao_sobrescreve() {
        let repo = tmp("hyd-repo");
        write(&repo, ".env", "do clone");
        write(&repo, "config/master.key", "chave");
        let wt = tmp("hyd-wt");
        write(&wt, ".env", "meu");

        let list = vec![".env".to_string(), "config/master.key".to_string()];
        let notes = hydrate(&wt, &repo, &list);
        assert!(matches!(notes[0], Copied::Kept(_)));
        assert!(matches!(notes[1], Copied::Made(_)));
        // O que já estava aqui continua sendo o daqui.
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "meu");
        assert_eq!(
            std::fs::read_to_string(wt.join("config/master.key")).unwrap(),
            "chave"
        );

        // Rodar de novo não desfaz nem duplica nada.
        let de_novo = hydrate(&wt, &repo, &list);
        assert!(de_novo.iter().all(|n| matches!(n, Copied::Kept(_))));
        assert!(report(&de_novo).is_some());
        assert!(report(&[]).is_none());
    }

    /// Diretório inteiro, porque é assim que uma credencial do Rails costuma
    /// estar guardada.
    #[test]
    fn hydrate_copia_diretorio() {
        let repo = tmp("dir-repo");
        write(&repo, "config/credentials/production.key", "chave");
        let wt = tmp("dir-wt");
        hydrate(&wt, &repo, &["config/credentials".to_string()]);
        assert_eq!(
            std::fs::read_to_string(wt.join("config/credentials/production.key")).unwrap(),
            "chave"
        );
    }

    /// A lista do clone vale no worktree que herda o arquivo dele — é o caso
    /// inteiro: `.prometheus/` no `.gitignore` e `.env` também.
    #[test]
    fn copia_vem_junto_com_o_arquivo_herdado() {
        let repo = tmp("copia-herda-repo");
        write(
            &repo,
            ".prometheus/settings.toml",
            "[scripts]\nrun = \"x\"\n\n[worktree]\ncopy = [\"segredo\"]\n",
        );
        write(&repo, "segredo", "s");
        write(&repo, ".env", "nao-declarado");
        let wt = tmp("copia-herda-wt");

        let s = read_for(&wt, &repo);
        assert!(s.inherited);
        // Declarou: vale a lista dela, e o `.env` não entra de contrabando.
        assert_eq!(s.copy, vec!["segredo".to_string()]);
    }

    /// `copy = []` é a escolha de não copiar nada, e não "não declarou".
    #[test]
    fn copia_vazia_desliga_o_automatico() {
        let repo = tmp("vazia-repo");
        write(
            &repo,
            ".prometheus/settings.toml",
            "[worktree]\ncopy = []\n",
        );
        write(&repo, ".env", "x");
        let wt = tmp("vazia-wt");
        assert!(read_for(&wt, &repo).copy.is_empty());
    }

    /// Um worktree cujo caminho cai na faixa da 5060 pula para a seguinte: o
    /// navegador não abre porta da lista proibida, e a faixa inteira vai junto
    /// porque `$PORT+1` do mesmo workspace não pode cair numa delas.
    #[test]
    fn porta_pula_as_que_o_navegador_recusa() {
        const SLOTS: u64 = (9990 - 3100) / 10 + 1;
        let slot = (5060 - 3100) / 10;
        let path = (0..)
            .map(|i| format!("/wt/{i}"))
            .find(|p| crate::paths::fnv1a(p) % SLOTS == slot)
            .unwrap();
        let base = alloc_port(Path::new(&path), &[]).unwrap();
        assert_ne!(base, 5060);
        assert!((base..base + 10).all(usable), "{base}");
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
