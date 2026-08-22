//! Um `Mutex` envenenado é um app morto.
//!
//! `lock().unwrap()` parece inofensivo até o primeiro panic: quem entra em
//! panic segurando o lock **envenena** o mutex, e todo `unwrap()` seguinte
//! entra em panic também. Num app com uma thread por PTY, uma por conexão de
//! hook e os comandos do Tauri, isso é o quadro inteiro parando de responder
//! até o usuário reiniciar — por causa de um `find` que não achou.
//!
//! Aqui o veneno é ignorado de propósito. O dado protegido é o quadro: um
//! `Vec` de workspaces que nenhum panic deixa pela metade — não há invariante
//! entre dois campos que um panic no meio possa quebrar. Continuar com o que
//! está lá é melhor do que não continuar.

use std::sync::{Mutex, MutexGuard};

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poison| poison.into_inner())
}
