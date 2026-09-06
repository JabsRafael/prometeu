//! Integração com GitHub CLI. O resto da sessão trabalha com git e worktrees;
//! descoberta, cache e abertura de PRs ficam nesta borda de rede/processo.
//!
//! O PR é do repositório, não do workspace: um workspace com mais de um repo
//! tem um PR por repo, cada um na mesma branch, cada um com o seu histórico.

use crate::domain::Pr;
use crate::lock::lock;
use crate::state::{publish, Repo, Workspace};
use crate::{i18n, AppState};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use tauri::{AppHandle, State};

/// Pergunta o PR desta branch em cada repositório do workspace e grava no
/// quadro. É o caminho rápido de quem abriu o workspace; a varredura periódica
/// continua sendo a rede de proteção.
#[tauri::command(async)]
pub fn pr_open(app: AppHandle, state: State<AppState>, id: String) {
    let found: Vec<(String, Option<Pr>)> = repos_of(&state, &id)
        .iter()
        .map(|repo| {
            let worktree = Path::new(&repo.worktree);
            let pr = head_branch(worktree).and_then(|branch| pr_for_branch(worktree, &branch));
            (repo.name.clone(), pr)
        })
        .collect();
    remember(&app, &state, &id, found);
}

/// Uma consulta ao `gh` por clone, não uma por workspace: dois workspaces do
/// mesmo repositório, e os dois repos de um workspace, cabem na mesma
/// resposta. Nem falha de rede nem resposta incompleta apagam o último estado
/// conhecido do quadro.
#[tauri::command(async)]
pub fn refresh_prs(app: AppHandle, state: State<AppState>) {
    let alive: Vec<Workspace> = lock(&state.board)
        .workspaces
        .iter()
        .filter(|workspace| !workspace.cleaned && !workspace.branch.is_empty())
        .cloned()
        .collect();

    // Clone → (workspace, nome do repo nele, branch).
    //
    // A branch é a do worktree, não a que o quadro guardou: quem trabalha
    // renomeia a branch, ou troca de branch dentro do worktree, e a partir daí
    // o nome gravado no card não é mais o que o `gh` conhece. Perguntar pelo
    // nome velho não acha PR nenhum — e num workspace de vários repos isso
    // apagava o PR de todos de uma vez.
    let mut by_clone: BTreeMap<String, Vec<(String, String, String)>> = BTreeMap::new();
    for workspace in &alive {
        for repo in &workspace.repos {
            let branch =
                head_branch(Path::new(&repo.worktree)).unwrap_or_else(|| workspace.branch.clone());
            by_clone.entry(repo.path.clone()).or_default().push((
                workspace.id.clone(),
                repo.name.clone(),
                branch,
            ));
        }
    }

    let mut found: Vec<(String, String, Option<Pr>)> = Vec::new();
    for (clone, list) in by_clone {
        let prs = list_repo(Path::new(&clone));
        if prs.is_empty() {
            continue;
        }
        for (id, name, branch) in list {
            found.push((id, name, pick(&prs, &branch)));
        }
    }

    let mut moved = false;
    {
        let mut board = lock(&state.board);
        for (id, name, pr) in found {
            let Some(workspace) = board.workspace_mut(&id) else {
                continue;
            };
            let Some(repo) = workspace.repos.iter_mut().find(|repo| repo.name == name) else {
                continue;
            };
            moved |= write(repo, pr);
        }
    }
    if moved {
        publish(&app);
    }
}

/// Abre no navegador o PR desta branch num repositório do workspace — o que a
/// tela pediu pelo nome, ou o principal. O `gh` descobre e abre a URL; nenhuma
/// URL atravessa o IPC.
#[tauri::command(async)]
pub fn open_pr(state: State<AppState>, id: String, repo: String) -> Result<(), String> {
    let workspace =
        workspace_copy(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let repo = workspace
        .repos
        .iter()
        .find(|candidate| candidate.name == repo)
        .cloned()
        .unwrap_or_else(|| workspace.primary());
    // Com o número gravado no quadro, é ele que abre — inclusive com o worktree
    // devolvido, quando o `gh` roda de dentro do clone: PR mergeado continua
    // sendo lugar aonde se volta. Sem número, a branch do worktree responde.
    let (dir, what) = match (workspace.cleaned, repo.pr.as_ref()) {
        (false, None) => (
            repo.worktree.clone(),
            head_branch(Path::new(&repo.worktree)).ok_or_else(|| i18n::t("err.session.noPr"))?,
        ),
        (false, Some(pr)) => (repo.worktree.clone(), pr.number.to_string()),
        (true, Some(pr)) => (repo.path.clone(), pr.number.to_string()),
        (true, None) => return Err(i18n::t("err.session.noPr")),
    };
    let ok = Command::new("gh")
        .current_dir(&dir)
        .args(["pr", "view", what.as_str(), "--web"])
        .status()
        .map_err(i18n::io)?
        .success();
    ok.then_some(()).ok_or_else(|| i18n::t("err.session.noPr"))
}

pub(crate) fn pr_for_branch(worktree: &Path, branch: &str) -> Option<Pr> {
    pick(&list(worktree, &["--head", branch, "--limit", "5"]), branch)
}

/// Na mesma branch, um aberto manda mais que um fechado; entre iguais vale o
/// mais novo, que é a ordem devolvida pelo `gh`.
pub(crate) fn pick(prs: &[Pr], branch: &str) -> Option<Pr> {
    let mine = || prs.iter().filter(|pr| pr.head_ref_name == branch);
    mine()
        .find(|pr| pr.open())
        .or_else(|| mine().next())
        .cloned()
}

fn list_repo(repo: &Path) -> Vec<Pr> {
    list(repo, &["--limit", "60"])
}

fn list(dir: &Path, extra: &[&str]) -> Vec<Pr> {
    let out = Command::new("gh")
        .current_dir(dir)
        .args([
            "pr",
            "list",
            "--state",
            "all",
            "--json",
            "number,title,isDraft,state,headRefName",
        ])
        .args(extra)
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    serde_json::from_slice::<Vec<Pr>>(&out.stdout).unwrap_or_default()
}

/// Guarda no quadro o que o `gh` respondeu para cada repositório.
fn remember(app: &AppHandle, state: &State<AppState>, id: &str, found: Vec<(String, Option<Pr>)>) {
    let mut moved = false;
    {
        let mut board = lock(&state.board);
        let Some(workspace) = board.workspace_mut(id) else {
            return;
        };
        for (name, pr) in found {
            let Some(repo) = workspace.repos.iter_mut().find(|repo| repo.name == name) else {
                continue;
            };
            moved |= write(repo, pr);
        }
    }
    if moved {
        publish(app);
    }
}

/// Grava no repo o que o `gh` respondeu, e diz se o quadro mudou. Não achar
/// nada não apaga o que já se sabia: resposta vazia é `gh` mudo — sem rede, sem
/// login —, e a lista de um repositório movimentado tem tamanho, o PR de ontem
/// já saiu dela. Esquecer por causa disso fazia o botão da barra piscar entre
/// "Atualizar PR" e "Open PR".
fn write(repo: &mut Repo, pr: Option<Pr>) -> bool {
    if pr.is_none() && repo.pr.is_some() {
        return false;
    }
    if same(repo.pr.as_ref(), pr.as_ref()) {
        return false;
    }
    repo.pr = pr;
    true
}

fn same(left: Option<&Pr>, right: Option<&Pr>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            left.number == right.number
                && left.state == right.state
                && left.is_draft == right.is_draft
        }
        _ => false,
    }
}

fn head_branch(repo: &Path) -> Option<String> {
    let output = Command::new("git")
        .current_dir(repo)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !branch.is_empty() && branch != "HEAD").then_some(branch)
}

fn workspace_copy(state: &State<AppState>, id: &str) -> Option<Workspace> {
    lock(&state.board)
        .workspaces
        .iter()
        .find(|workspace| workspace.id == id)
        .cloned()
}

/// Os repositórios de um workspace que ainda tem worktree, na ordem dele — o
/// principal primeiro. Devolvido ao disco é lista vazia.
fn repos_of(state: &State<AppState>, id: &str) -> Vec<Repo> {
    lock(&state.board)
        .workspaces
        .iter()
        .find(|workspace| workspace.id == id && !workspace.cleaned)
        .map(|workspace| workspace.repos.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{pick, write};
    use crate::domain::Pr;
    use crate::state::Repo;

    fn pr(number: u64, branch: &str, state: &str) -> Pr {
        Pr {
            number,
            title: format!("PR {number}"),
            is_draft: false,
            state: state.into(),
            head_ref_name: branch.into(),
        }
    }

    #[test]
    fn aberto_manda_mais_que_fechado_na_mesma_branch() {
        let all = vec![
            pr(9, "outra/coisa", "OPEN"),
            pr(8, "meu/ajuste", "CLOSED"),
            pr(7, "meu/ajuste", "OPEN"),
        ];
        assert_eq!(pick(&all, "meu/ajuste").unwrap().number, 7);
        assert!(pick(&all, "nao/existe").is_none());
    }

    #[test]
    fn nao_achar_nao_apaga_o_pr_conhecido() {
        let mut repo = Repo {
            path: "/clone".into(),
            name: "repo".into(),
            worktree: "/worktree".into(),
            base: "origin/main".into(),
            pr: Some(pr(7, "meu/ajuste", "OPEN")),
        };
        assert!(!write(&mut repo, None));
        assert_eq!(repo.pr.as_ref().unwrap().number, 7);
        assert!(write(&mut repo, Some(pr(7, "meu/ajuste", "MERGED"))));
        assert_eq!(repo.pr.as_ref().unwrap().state, "MERGED");
        assert!(!write(&mut repo, Some(pr(7, "meu/ajuste", "MERGED"))));
    }

    #[test]
    fn sem_aberto_fica_com_o_mais_novo() {
        let all = vec![
            pr(12, "meu/ajuste", "MERGED"),
            pr(4, "meu/ajuste", "CLOSED"),
        ];
        let got = pick(&all, "meu/ajuste").unwrap();
        assert_eq!(got.number, 12);
        assert!(got.merged());
    }
}

pub struct TaskSnapshot {
    pub prs: BTreeMap<String, u64>,
    pub events: BTreeMap<String, String>,
    pub closed: bool,
}

/// O monitor usa apenas leituras do gh. Paginação inclui comentários gerais,
/// reviews e comentários em linhas; nenhuma dessas consultas chama um modelo.
pub fn task_snapshot(ws: &Workspace, run: &crate::actions::Run) -> Result<TaskSnapshot, String> {
    let mut snapshot = TaskSnapshot {
        prs: run.prs.clone(),
        events: BTreeMap::new(),
        closed: true,
    };
    let watch = run
        .profile
        .watch
        .as_ref()
        .ok_or_else(|| i18n::t("err.actions.invalid"))?;
    let mut viewer = None;
    for repo in &ws.repos {
        let dir = Path::new(&repo.worktree);
        let what = run
            .prs
            .get(&repo.name)
            .map(u64::to_string)
            .or_else(|| head_branch(dir))
            .ok_or_else(|| i18n::t("err.session.noPr"))?;
        // Sem PR ainda é espera, não erro. Falhas de autenticação/rede continuam visíveis.
        if !run.prs.contains_key(&repo.name) {
            let all = task_gh(
                dir,
                &[
                    "pr", "list", "--head", &what, "--state", "open", "--json", "number",
                    "--limit", "1",
                ],
            )?;
            if all.as_array().is_some_and(Vec::is_empty) {
                continue;
            }
        }
        let pr = task_gh(
            dir,
            &[
                "pr",
                "view",
                &what,
                "--json",
                "number,state,headRefOid,url,statusCheckRollup",
            ],
        )?;
        let number = pr["number"]
            .as_u64()
            .ok_or_else(|| i18n::t("err.actions.response"))?;
        snapshot.prs.insert(repo.name.clone(), number);
        if matches!(pr["state"].as_str(), Some("CLOSED" | "MERGED")) {
            continue;
        }
        if pr["state"] != "OPEN" {
            return Err(i18n::t("err.actions.response"));
        }
        snapshot.closed = false;
        let prefix = format!("{}:{number}", repo.name);
        if watch.comments {
            let login = match &viewer {
                Some(login) => login,
                None => {
                    viewer = Some(
                        task_gh(dir, &["api", "user"])?["login"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| i18n::t("err.actions.response"))?
                            .to_string(),
                    );
                    viewer.as_ref().unwrap()
                }
            };
            for (kind, path) in [
                (
                    "comment",
                    format!("repos/{{owner}}/{{repo}}/issues/{number}/comments?per_page=100"),
                ),
                (
                    "review",
                    format!("repos/{{owner}}/{{repo}}/pulls/{number}/reviews?per_page=100"),
                ),
                (
                    "inline",
                    format!("repos/{{owner}}/{{repo}}/pulls/{number}/comments?per_page=100"),
                ),
            ] {
                let pages = task_gh(dir, &["api", "--paginate", "--slurp", &path])?;
                let pages = pages
                    .as_array()
                    .ok_or_else(|| i18n::t("err.actions.response"))?;
                for page in pages {
                    for comment in page
                        .as_array()
                        .ok_or_else(|| i18n::t("err.actions.response"))?
                    {
                        if let Some((id, text)) = task_comment(comment, login) {
                            snapshot
                                .events
                                .insert(format!("{prefix}:{kind}:{id}"), text);
                        }
                    }
                }
            }
        }
        if watch.ci {
            let sha = pr["headRefOid"]
                .as_str()
                .ok_or_else(|| i18n::t("err.actions.response"))?;
            if let Some(checks) = pr["statusCheckRollup"].as_array() {
                for check in checks {
                    if let Some((name, result)) = task_check(check) {
                        snapshot.events.insert(
                            format!("{prefix}:ci:{sha}:{name}"),
                            format!(
                                "{}\n{sha}\n{name}: {result}",
                                pr["url"].as_str().unwrap_or("")
                            ),
                        );
                    }
                }
            }
        }
    }
    snapshot.closed &= !snapshot.prs.is_empty();
    Ok(snapshot)
}

fn task_comment(value: &serde_json::Value, viewer: &str) -> Option<(u64, String)> {
    let author = value["user"]["login"].as_str()?;
    if author == viewer {
        return None;
    }
    let body = value["body"].as_str().unwrap_or("");
    let state = value["state"].as_str().unwrap_or("");
    if body.is_empty() && state != "CHANGES_REQUESTED" {
        return None;
    }
    let body: String = body.chars().take(12_000).collect();
    Some((
        value["id"].as_u64()?,
        format!(
            "{}\n{}\n{author} {state}\n{body}",
            value["html_url"].as_str().unwrap_or(""),
            value["updated_at"]
                .as_str()
                .or(value["submitted_at"].as_str())
                .unwrap_or("")
        ),
    ))
}

fn task_check(value: &serde_json::Value) -> Option<(String, String)> {
    let result = value["conclusion"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| value["state"].as_str())?;
    if !matches!(
        result.to_ascii_uppercase().as_str(),
        "SUCCESS"
            | "FAILURE"
            | "ERROR"
            | "TIMED_OUT"
            | "CANCELLED"
            | "ACTION_REQUIRED"
            | "STARTUP_FAILURE"
    ) {
        return None;
    }
    let name = value["name"]
        .as_str()
        .or_else(|| value["context"].as_str())?;
    let url = value["detailsUrl"]
        .as_str()
        .or_else(|| value["targetUrl"].as_str())
        .unwrap_or("");
    Some((format!("{name} {url}"), result.to_string()))
}

/// Prazo também vale se o gh ficar preso. Leitores drenam os dois pipes para
/// que uma resposta grande não trave o processo antes do wait.
fn task_gh(dir: &Path, args: &[&str]) -> Result<serde_json::Value, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = Command::new("gh")
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(i18n::io)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        })
    };
    let output = read(Box::new(stdout));
    let errors = read(Box::new(stderr));
    let until = Instant::now() + Duration::from_secs(30);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(i18n::t("err.actions.timeout"));
            }
        }
    };
    let bytes = output
        .join()
        .map_err(|_| i18n::t("err.actions.response"))?
        .map_err(i18n::io)?;
    let errors = errors
        .join()
        .map_err(|_| i18n::t("err.actions.response"))?
        .map_err(i18n::io)?;
    if !status.success() {
        return Err(i18n::io(String::from_utf8_lossy(&errors)));
    }
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(i18n::t("err.actions.response"));
    }
    serde_json::from_slice(&bytes).map_err(i18n::io)
}

#[cfg(test)]
mod task_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ignores_own_comments_and_incomplete_checks() {
        let comment = json!({ "id": 1, "user": { "login": "owner" }, "body": "done", "html_url": "https://example.test/1", "updated_at": "now" });
        assert!(task_comment(&comment, "owner").is_none());
        assert!(task_comment(&comment, "reviewer")
            .unwrap()
            .1
            .contains("done"));
        assert!(
            task_check(&json!({"name":"test", "conclusion":"", "status":"IN_PROGRESS"})).is_none()
        );
        assert_eq!(
            task_check(&json!({"name":"test", "conclusion":"FAILURE", "detailsUrl":"run/2"}))
                .unwrap()
                .1,
            "FAILURE"
        );
        assert!(task_check(&json!({"context":"lint", "state":"PENDING"})).is_none());
        assert_eq!(
            task_check(&json!({"context":"lint", "state":"SUCCESS"}))
                .unwrap()
                .1,
            "SUCCESS"
        );
    }
}
