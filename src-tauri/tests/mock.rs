//! O contrato entre o front e o back, verificado no texto dos dois lados.
//!
//! Há dois backs: o Rust de verdade e o `src/mock.ts`, que é o que faz a UI
//! rodar no navegador — onde se mexe na tela sem subir o Tauri, e por onde um
//! Playwright entra, já que a webview do Tauri no macOS não fala CDP.
//!
//! Os dois só servem enquanto respondem os mesmos comandos que o front chama, e
//! nada avisa quando um nasce só de um lado. O sintoma é tela em branco meia
//! hora depois, com o back devolvendo `null` calado. Este teste é o aviso.
//!
//! Casar texto com regex é grosseiro, e de propósito: a alternativa é uma macro
//! que gere as duas listas, e o custo dela não se paga por uma checagem que
//! `cargo test` faz em milissegundos.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Comandos cujo retorno o front joga fora — manda e segue. Para esses, o
/// `default: return null` do mock é a resposta certa, e exigir um `case` seria
/// pedir código que não faz nada.
const VOID: [&str; 13] = [
    "add_project",
    "remove_workspace",
    "close_tab",
    "focus_tab",
    "reveal",
    "pty_write",
    "pty_resize",
    "decide_permission",
    "answer_questions",
    "close_dock",
    "look_at",
    "team_config_set",
    "set_shared",
];

fn repo() -> PathBuf {
    // O crate é `src-tauri/`; o front é o irmão dele.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(repo().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// Todo `invoke("nome")` e `invoke<T>("nome")` de `src/*.ts`, tirando os
/// `plugin:*` que são do próprio Tauri e não do Prometeu.
fn invoked() -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for entry in std::fs::read_dir(repo().join("src")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("ts") {
            continue;
        }
        // O mock é o back, não quem chama: os nomes dele estão em `case`.
        if path.file_name().and_then(|n| n.to_str()) == Some("mock.ts") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for piece in text.split("invoke").skip(1) {
            // `invoke<Tipo>("nome"` ou `invoke("nome"`. O que vem logo depois
            // separa a chamada do `import { invoke } from "..."`, que também
            // tem uma string na frente e viraria um comando fantasma.
            if !piece.starts_with('(') && !piece.starts_with('<') {
                continue;
            }
            // O nome é o primeiro trecho entre aspas antes de qualquer outra
            // coisa acontecer.
            let Some(open) = piece.find('"') else {
                continue;
            };
            if piece[..open].contains(';') || piece[..open].contains('\n') {
                continue;
            }
            let rest = &piece[open + 1..];
            let Some(close) = rest.find('"') else {
                continue;
            };
            let name = &rest[..close];
            if !name.starts_with("plugin:") {
                found.insert(name.to_string());
            }
        }
    }
    assert!(
        found.len() > 20,
        "o varredor não achou os invokes: {found:?}"
    );
    found
}

/// Os nomes de dentro do `generate_handler!`, que é a lista de verdade.
fn registered() -> BTreeSet<String> {
    let text = read("src-tauri/src/main.rs");
    let start = text
        .find("generate_handler![")
        .expect("sem generate_handler!");
    let block = &text[start..text[start..].find(']').unwrap() + start];
    block
        .lines()
        .filter(|line| line.contains("::"))
        // O comando pode estar num submódulo (`session::diff::workspace_diff`):
        // para o contrato IPC importa sempre o último segmento.
        .filter_map(|line| line.trim().trim_end_matches(',').rsplit("::").next())
        .map(str::to_string)
        .collect()
}

/// Os `case "nome":` do mock.
fn mocked() -> BTreeSet<String> {
    read("src/mock.ts")
        .split("case \"")
        .skip(1)
        .filter_map(|piece| piece.split('"').next())
        .filter(|name| !name.starts_with("plugin:"))
        .map(str::to_string)
        .collect()
}

#[test]
fn tudo_que_o_front_chama_existe_no_rust() {
    let registered = registered();
    let missing: Vec<_> = invoked()
        .into_iter()
        .filter(|c| !registered.contains(c))
        .collect();
    assert!(
        missing.is_empty(),
        "o front chama comando que o generate_handler! não registra: {missing:?}"
    );
}

#[test]
fn tudo_que_o_front_chama_existe_no_mock() {
    let mocked = mocked();
    let missing: Vec<_> = invoked()
        .into_iter()
        .filter(|c| !mocked.contains(c) && !VOID.contains(&c.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "src/mock.ts não responde: {missing:?} — sem isso a UI no navegador \
         recebe null e quebra calada. Ou escreva o `case`, ou ponha em VOID se \
         o retorno for jogado fora."
    );
}
