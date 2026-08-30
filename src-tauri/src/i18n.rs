//! O back não escreve frase.
//!
//! Toda mensagem que chega aos olhos de alguém — erro de comando, nota de
//! atividade num card — sai daqui como um código estável e os pedaços que
//! entram nos buracos. Quem monta a frase, no idioma que a pessoa escolheu, é
//! o front: `src/i18n.ts`, `fromBack`.
//!
//! O que atravessa a ponte continua sendo `String`, que é o que os
//! `Result<_, String>` de todo comando já carregavam. O formato é
//! `i18n:{"code":"err.linear.off","args":{"path":"…"}}`; o que não começar com
//! `i18n:` o front mostra como veio, e é assim que erro de plugin ou pânico
//! continua legível em vez de virar chave crua na tela.
//!
//! O catálogo dos códigos mora no front, em `src/i18n.pt.ts` — um lugar só, e
//! não um por linguagem de programação.

use std::collections::BTreeMap;
use std::sync::Mutex;

/// O idioma da tela, que o front conta ao subir e sempre que muda.
///
/// Quase nada aqui precisa dele: código não tem idioma. Precisam as poucas
/// frases que o back escreve por inteiro porque não passam pela tela — a linha
/// de saída que vai para dentro da rolagem do terminal, o aviso que entra na
/// fala do agente, a página que o navegador mostra no fim do OAuth. Uma janela,
/// um idioma; por isso um estático, e não um campo em cada chamada.
static LANG: Mutex<String> = Mutex::new(String::new());

#[tauri::command]
pub fn set_lang(lang: String) {
    *LANG.lock().unwrap_or_else(|e| e.into_inner()) = lang;
}

pub fn lang() -> String {
    LANG.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Português, ou o inglês que é o outro lado de tudo. Enquanto o front não
/// contou (o app acabou de subir), é português — que é o que o app era antes
/// de falar dois idiomas.
pub fn pt() -> bool {
    !lang().starts_with("en")
}

/// O idioma é um estático, e o cargo roda cada teste numa thread: dois testes
/// trocando o idioma ao mesmo tempo leem o do outro. Quem mexer, segura isto.
#[cfg(test)]
pub static TEST_LANG: Mutex<()> = Mutex::new(());

/// Uma das duas frases, na que a pessoa lê. Só para o punhado de textos que o
/// back escreve inteiros; tudo mais é código, e o catálogo mora no front.
pub fn pick(pt_br: &str, en: &str) -> String {
    if pt() {
        pt_br.to_string()
    } else {
        en.to_string()
    }
}

/// Um código sem buraco nenhum.
pub fn t(code: &str) -> String {
    format!("i18n:{}", serde_json::json!({ "code": code }))
}

/// Um código e o que vai nos buracos. As chaves são as mesmas que aparecem
/// entre chaves na frase do catálogo.
pub fn ta(code: &str, args: &[(&str, String)]) -> String {
    let map: BTreeMap<&str, &str> = args.iter().map(|(k, v)| (*k, v.as_str())).collect();
    format!("i18n:{}", serde_json::json!({ "code": code, "args": map }))
}

/// O que uma biblioteca disse, quando não há nada melhor a dizer. Continua em
/// inglês (é o que a biblioteca fala), mas passa pelo catálogo do mesmo jeito —
/// e é lá que se decide como emoldurá-lo.
pub fn io(cause: impl ToString) -> String {
    ta("err.io", &[("cause", cause.to_string())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sem_idioma_ainda_e_portugues() {
        let _guard = TEST_LANG.lock().unwrap_or_else(|e| e.into_inner());
        set_lang(String::new());
        assert!(pt());
        set_lang("en".into());
        assert!(!pt());
        set_lang("pt-BR".into());
        assert!(pt());
    }

    #[test]
    fn codigo_sem_argumento_e_so_o_codigo() {
        assert_eq!(t("err.pty.gone"), r#"i18n:{"code":"err.pty.gone"}"#);
    }

    #[test]
    fn argumentos_saem_em_ordem_e_escapados() {
        let got = ta("err.session.notGit", &[("path", "/tmp/a\"b".into())]);
        assert_eq!(
            got,
            r#"i18n:{"args":{"path":"/tmp/a\"b"},"code":"err.session.notGit"}"#
        );
    }
}
