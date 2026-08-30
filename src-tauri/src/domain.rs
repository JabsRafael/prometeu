//! Tipos de domínio que atravessam estado, serviços e IPC. Eles não pertencem
//! ao adaptador que os descobre (`session`/`gh`): mantê-los aqui evita que o
//! estado persistido dependa de um módulo de comandos Tauri.

/// O PR desta branch, como o `gh` o descreve.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub is_draft: bool,
    /// `OPEN`, `MERGED` ou `CLOSED`.
    #[serde(default)]
    pub state: String,
    /// Campo de transporte do `gh`, usado para casar resposta e workspace; não
    /// faz parte do board.json nem do contrato do front.
    #[serde(default, skip_serializing)]
    pub head_ref_name: String,
}

impl Pr {
    pub fn merged(&self) -> bool {
        self.state == "MERGED"
    }

    pub fn open(&self) -> bool {
        self.state == "OPEN"
    }
}
