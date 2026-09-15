//! Layered tool selection: compose the global, project and workspace layers into the hub IDs a
//! session injects, one axis at a time. Pure (no Tauri, filesystem or network), so the chain is
//! testable without a board or a repository. See ADR 0043 and docs/contracts/plugin-marketplace.md.

use serde::{Deserialize, Serialize};

/// What a layer does with the set inherited from the layers above it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Base {
    /// Replace the inherited set with `add`; an empty `add` selects nothing from the hub.
    None,
    /// Apply `add` and `remove` over the inherited set. A hand-written layer that omits `base`
    /// means this, so declaring only `add` never erases what came from above.
    #[default]
    Inherit,
}

/// One axis of one layer. The layer itself is `Option<Selection>`: `None` inherits everything from
/// the layers above and contributes nothing.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct Selection {
    #[serde(default)]
    pub base: Base,
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

impl Selection {
    /// Replace the inherited set.
    pub fn only(add: Vec<String>) -> Selection {
        Selection {
            base: Base::None,
            add,
            remove: Vec::new(),
        }
    }
}

/// The three independent axes of one layer. Shared by the board's global layer, the `[tools]` table
/// of the project settings and the workspace triple, so all three deserialize identically. An absent
/// axis inherits from the layer above it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct Tools {
    #[serde(default)]
    pub mcp: Option<Selection>,
    #[serde(default)]
    pub plugins: Option<Selection>,
    #[serde(default)]
    pub skills: Option<Selection>,
}

/// Resolve one axis across the three layers, in order, and keep only IDs the hub still has, so a
/// layer written before a package was removed still resolves. Within a layer `add` comes first and
/// `remove` has the last word; the order of the inherited set is preserved and additions follow it.
pub fn resolve(
    global: &Option<Selection>,
    project: &Option<Selection>,
    workspace: &Option<Selection>,
    hub: &[String],
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for layer in [global, project, workspace] {
        let Some(selection) = layer else { continue };
        if selection.base == Base::None {
            ids.clear();
        }
        for id in &selection.add {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        ids.retain(|id| !selection.remove.contains(id));
    }
    ids.retain(|id| hub.contains(id));
    ids
}

#[cfg(test)]
mod tests {
    use super::{resolve, Base, Selection, Tools};

    fn names(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn replace(add: &[&str]) -> Selection {
        Selection::only(names(add))
    }

    fn delta(add: &[&str], remove: &[&str]) -> Selection {
        Selection {
            base: Base::Inherit,
            add: names(add),
            remove: names(remove),
        }
    }

    #[test]
    fn nenhuma_camada_declarada_nao_injeta_nada() {
        assert_eq!(resolve(&None, &None, &None, &names(&["a"])), names(&[]));
    }

    #[test]
    fn global_serve_de_base_enquanto_projeto_e_workspace_herdam() {
        let got = resolve(
            &Some(replace(&["a", "b"])),
            &None,
            &None,
            &names(&["a", "b", "c"]),
        );
        assert_eq!(got, names(&["a", "b"]));
    }

    #[test]
    fn base_none_substitui_o_que_veio_de_cima() {
        let got = resolve(
            &Some(replace(&["a", "b"])),
            &Some(replace(&["c"])),
            &None,
            &names(&["a", "b", "c"]),
        );
        assert_eq!(got, names(&["c"]));
    }

    #[test]
    fn base_none_sem_add_apaga_a_heranca() {
        let got = resolve(
            &Some(replace(&["a", "b"])),
            &None,
            &Some(replace(&[])),
            &names(&["a", "b"]),
        );
        assert_eq!(got, names(&[]));
    }

    #[test]
    fn base_inherit_adiciona_no_fim_e_remove_do_meio() {
        let got = resolve(
            &Some(replace(&["a", "b"])),
            &Some(delta(&["c"], &["a"])),
            &Some(delta(&["d"], &[])),
            &names(&["a", "b", "c", "d"]),
        );
        assert_eq!(got, names(&["b", "c", "d"]));
    }

    #[test]
    fn remocao_na_ultima_camada_vence_adicao_na_primeira() {
        let got = resolve(
            &Some(replace(&["a", "b"])),
            &None,
            &Some(delta(&[], &["a"])),
            &names(&["a", "b"]),
        );
        assert_eq!(got, names(&["b"]));
    }

    #[test]
    fn remove_tem_a_ultima_palavra_na_mesma_camada() {
        let got = resolve(
            &None,
            &Some(delta(&["a", "b"], &["a"])),
            &None,
            &names(&["a", "b"]),
        );
        assert_eq!(got, names(&["b"]));
    }

    #[test]
    fn id_fora_do_hub_e_ignorado_e_o_resto_resolve() {
        let got = resolve(
            &Some(replace(&["gone"])),
            &Some(delta(&["a", "also-gone"], &[])),
            &None,
            &names(&["a", "b"]),
        );
        assert_eq!(got, names(&["a"]));
    }

    #[test]
    fn add_repetido_nao_duplica() {
        let got = resolve(
            &Some(replace(&["a"])),
            &Some(delta(&["a", "b"], &[])),
            &Some(delta(&["b"], &[])),
            &names(&["a", "b"]),
        );
        assert_eq!(got, names(&["a", "b"]));
    }

    #[test]
    fn a_camada_aceita_null_e_o_objeto_do_contrato() {
        let inherit: Option<Selection> = serde_json::from_str("null").unwrap();
        assert_eq!(inherit, None);

        let none: Option<Selection> =
            serde_json::from_str(r#"{"base":"none","add":["a"],"remove":[]}"#).unwrap();
        assert_eq!(none, Some(replace(&["a"])));

        // A layer may declare only one of the deltas.
        let partial: Selection =
            serde_json::from_str(r#"{"base":"inherit","remove":["a"]}"#).unwrap();
        assert_eq!(partial, delta(&[], &["a"]));

        // An omitted `base` inherits instead of erasing the layers above.
        let implicit: Selection = serde_json::from_str(r#"{"add":["a"]}"#).unwrap();
        assert_eq!(implicit.base, Base::Inherit);
    }

    #[test]
    fn a_forma_serializada_e_a_do_contrato() {
        let json = serde_json::to_string(&Some(replace(&[]))).unwrap();
        assert_eq!(json, r#"{"base":"none","add":[],"remove":[]}"#);
        assert_eq!(serde_json::to_string(&None::<Selection>).unwrap(), "null");
    }

    #[test]
    fn a_tabela_tools_do_toml_vira_uma_camada() {
        #[derive(serde::Deserialize)]
        struct File {
            #[serde(default)]
            tools: Tools,
        }

        let parsed: File = toml::from_str(
            r#"
[scripts]
setup = "npm install"

[tools]
mcp = { base = "inherit", add = ["notion"] }
plugins = { base = "none", add = ["revisor"] }
"#,
        )
        .unwrap();
        assert_eq!(parsed.tools.mcp, Some(delta(&["notion"], &[])));
        assert_eq!(parsed.tools.plugins, Some(replace(&["revisor"])));
        // An absent axis inherits the layers above it.
        assert_eq!(parsed.tools.skills, None);
    }
}
