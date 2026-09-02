//! Não deixar o Mac dormir.
//!
//! Quem faz isso no macOS é o `caffeinate`, que já vem instalado. Enquanto ele
//! está de pé, `-i` impede o repouso por ociosidade, `-d` mantém a tela ligada e
//! `-s` cobre as demais tentativas de repouso enquanto o Mac está na tomada.
//! Sem `-d`, a tela apagava normalmente e a escolha parecia não ter funcionado;
//! sem `-s`, só o repouso estritamente classificado como ocioso era impedido.
//!
//! O `-w` do nosso próprio pid é o que faz isto não ter limpeza: o
//! `caffeinate` espera o app terminar e sai junto. Mesmo o app morrendo de
//! SIGKILL, ninguém fica segurando o Mac acordado para sempre.
//!
//! Quando ligar é decisão da tela (ver `statusbar.ts`): é ela que sabe o modo
//! escolhido e quais agentes estão trabalhando agora.

use crate::lock::lock;
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};

fn running() -> &'static Mutex<Option<Child>> {
    static RUNNING: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(None))
}

/// Liga ou desliga. Chamar duas vezes com o mesmo valor não faz nada — a tela
/// avisa a cada mudança de quadro, e subir um `caffeinate` por turno de agente
/// seria um processo novo a cada meia dúzia de segundos.
#[tauri::command]
pub fn set_awake(on: bool) -> Result<(), String> {
    let mut child = lock(running());
    // Um `caffeinate` que morreu sozinho (alguém o matou, o sistema o levou)
    // não pode virar um "já está ligado" para sempre: sem isto, ligar de novo
    // seria um clique que não faz nada e um Mac que dorme mesmo assim.
    let mut alive = child.take();
    if let Some(caffeinate) = &mut alive {
        // `Ok(None)` é o único "ainda de pé": `Ok(Some(status))` é já saiu, e
        // `Err` é não sei mais dele.
        if !matches!(caffeinate.try_wait(), Ok(None)) {
            alive = None;
        }
    }
    match (on, alive) {
        (true, Some(alive)) => *child = Some(alive),
        (true, None) => {
            let spawned = Command::new("/usr/bin/caffeinate")
                .args(["-d", "-i", "-s", "-w", &std::process::id().to_string()])
                .spawn()
                .map_err(|error| error.to_string())?;
            *child = Some(spawned);
        }
        (false, Some(mut alive)) => {
            let _ = alive.kill();
            let _ = alive.wait();
        }
        (false, None) => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sobe um `caffeinate` de verdade e o derruba. Ele sai junto com este
    /// processo de teste por causa do `-w`, então nem falhando fica alguém
    /// segurando a máquina acordada.
    #[test]
    fn liga_tela_e_sistema_desliga_e_nao_sobe_dois() {
        set_awake(true).expect("caffeinate não subiu");
        let first = lock(running()).as_ref().map(|c| c.id());
        assert!(first.is_some());

        // Não basta o filho existir: foi justamente usar só `-i` que deixou a
        // tela apagar e fez a opção parecer quebrada para quem estava olhando.
        let command = Command::new("/bin/ps")
            .args(["-p", &first.unwrap().to_string(), "-o", "command="])
            .output()
            .expect("não leu o caffeinate");
        let command = String::from_utf8_lossy(&command.stdout);
        assert!(command.contains("caffeinate -d -i -s -w"), "{command}");

        set_awake(true).expect("segundo pedido");
        assert_eq!(lock(running()).as_ref().map(|c| c.id()), first);

        set_awake(false).expect("desligar");
        assert!(lock(running()).is_none());
        // Desligar o que já está desligado não é erro nem processo novo.
        set_awake(false).expect("desligar de novo");
        assert!(lock(running()).is_none());
    }
}
