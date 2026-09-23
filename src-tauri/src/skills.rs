//! Standalone skills are local definitions installed through the existing plugin hub, respecting
//! workspace and provider selections.
use crate::{i18n, paths, plugins};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct Skill {
    pub id: String,
    pub description: String,
    pub content: String,
}

pub fn validate(skill: &Skill) -> Result<(), String> {
    if skill.id.is_empty()
        || skill.id.len() > 56
        || !skill.id.as_bytes()[0].is_ascii_alphanumeric()
        || !skill
            .id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        || skill.description.trim().is_empty()
        || skill.description.chars().count() > 2000
        || skill.content.trim().is_empty()
        || skill.content.len() > 65_536
    {
        return Err(i18n::t("err.catalog.invalid"));
    }
    Ok(())
}

pub fn load() -> Vec<Skill> {
    std::fs::read_to_string(paths::root().join("skills.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn store(skills: &[Skill]) -> Result<(), String> {
    for skill in skills {
        validate(skill)?;
    }
    paths::write_private(
        &paths::root().join("skills.json"),
        &serde_json::to_string_pretty(skills).map_err(|error| error.to_string())?,
    )
}

pub fn package_id(id: &str) -> String {
    format!("skill-{id}")
}

fn package(skill: &Skill, root: &Path, hub: &[plugins::Plugin]) -> Result<plugins::Plugin, String> {
    validate(skill)?;
    let plugin = plugins::Plugin {
        id: package_id(&skill.id),
        source: root
            .join("skills-packages")
            .join(&skill.id)
            .to_string_lossy()
            .into_owned(),
        note: skill.description.clone(),
        made: false,
        from: String::new(),
    };
    if hub
        .iter()
        .any(|existing| existing.id == plugin.id && existing.source != plugin.source)
    {
        return Err(i18n::t("err.catalog.invalid"));
    }
    Ok(plugin)
}

fn materialize(skill: &Skill, plugin: &plugins::Plugin) -> Result<(), String> {
    let root = Path::new(&plugin.source);
    let manifest = serde_json::to_string_pretty(&serde_json::json!({
        "name": plugin.id,
        "description": skill.description,
        "version": "0.0.0",
    }))
    .map_err(|error| error.to_string())?;
    // JSON strings are valid YAML scalars, including escaped newlines.
    let body = format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}\n",
        serde_json::to_string(&skill.id).map_err(|error| error.to_string())?,
        serde_json::to_string(&skill.description).map_err(|error| error.to_string())?,
        skill.content,
    );
    paths::write_private(&root.join("skills").join(&skill.id).join("SKILL.md"), &body)?;
    paths::write_private(&root.join(".claude-plugin/plugin.json"), &manifest)?;
    let mut native: serde_json::Value =
        serde_json::from_str(&manifest).map_err(|error| error.to_string())?;
    native["skills"] = serde_json::json!("./skills/");
    paths::write_private(
        &root.join(".codex-plugin/plugin.json"),
        &serde_json::to_string_pretty(&native).map_err(|error| error.to_string())?,
    )?;
    Ok(())
}

/// Installation does not activate a skill; workspace selection controls injection.
pub fn save_local(skill: Skill) -> Result<Vec<Skill>, String> {
    let plugin = package(&skill, &paths::root(), &plugins::load())?;
    materialize(&skill, &plugin)?;
    let mut skills = load();
    skills.retain(|existing| existing.id != skill.id);
    skills.push(skill);
    skills.sort_by(|a, b| a.id.cmp(&b.id));
    store(&skills)?;
    plugins::save_local(plugin)?;
    Ok(skills)
}

/// Uninstalling preserves files and does not delete the Cloud definition.
pub fn remove_local(id: &str) -> Result<Vec<Skill>, String> {
    let mut skills = load();
    if let Some(skill) = skills.iter().find(|skill| skill.id == id) {
        let plugin = package(skill, &paths::root(), &plugins::load())?;
        plugins::remove_hub(&plugin.id)?;
    }
    skills.retain(|skill| skill.id != id);
    store(&skills)?;
    Ok(skills)
}

#[tauri::command(async)]
pub fn skill_hub() -> Vec<Skill> {
    let _sync = crate::catalog::guard();
    load()
}

#[tauri::command(async)]
pub fn skill_save(
    app: AppHandle,
    skill: Skill,
    revision: Option<u64>,
) -> Result<Vec<Skill>, String> {
    let _sync = crate::catalog::guard();
    package(&skill, &paths::root(), &plugins::load())?;
    crate::catalog::save_skill(&app, &skill, revision)?;
    save_local(skill)
}

#[tauri::command(async)]
pub fn skill_remove(_app: AppHandle, id: String) -> Result<Vec<Skill>, String> {
    let _sync = crate::catalog::guard();
    remove_local(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_limits_and_keeps_packages_separate() {
        let skill = Skill {
            id: "review".into(),
            description: "Use when reviewing: \"code\".\nDo not publish.".into(),
            content: "# Review\n\nRead the diff.".into(),
        };
        assert!(validate(&skill).is_ok());
        for id in ["", "../escape", "-review", "Review", "ação"] {
            assert!(validate(&Skill {
                id: id.into(),
                ..skill.clone()
            })
            .is_err());
        }
        assert!(validate(&Skill {
            id: "a".repeat(56),
            ..skill.clone()
        })
        .is_ok());
        assert!(validate(&Skill {
            id: "a".repeat(57),
            ..skill.clone()
        })
        .is_err());
        assert!(validate(&Skill {
            description: "á".repeat(2000),
            ..skill.clone()
        })
        .is_ok());
        assert!(validate(&Skill {
            description: "a".repeat(2001),
            ..skill.clone()
        })
        .is_err());
        assert!(validate(&Skill {
            content: "a".repeat(65_536),
            ..skill.clone()
        })
        .is_ok());
        assert!(validate(&Skill {
            content: "á".repeat(32_769),
            ..skill.clone()
        })
        .is_err());
        assert!(validate(&Skill {
            content: " \n".into(),
            ..skill.clone()
        })
        .is_err());

        let root = std::env::temp_dir().join(format!("prometeu-skills-{}", uuid::Uuid::new_v4()));
        let plugin = package(&skill, &root, &[]).unwrap();
        assert_eq!(plugin.id, "skill-review");
        assert_eq!(
            Path::new(&plugin.source),
            root.join("skills-packages/review")
        );
        assert!(!plugin.made);
        let occupied = plugins::Plugin {
            source: root.join("plugins/review").display().to_string(),
            ..plugin.clone()
        };
        assert!(package(&skill, &root, &[occupied]).is_err());
        assert!(package(&skill, &root, std::slice::from_ref(&plugin)).is_ok());
        materialize(&skill, &plugin).unwrap();
        let body =
            std::fs::read_to_string(Path::new(&plugin.source).join("skills/review/SKILL.md"))
                .unwrap();
        assert!(body.contains("name: \"review\"\n"));
        assert!(body.contains(
            "description: \"Use when reviewing: \\\"code\\\".\\nDo not publish.\"\n---\n"
        ));
        assert!(body.ends_with("# Review\n\nRead the diff.\n"));
        for directory in [".claude-plugin", ".codex-plugin"] {
            let manifest: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(
                    Path::new(&plugin.source)
                        .join(directory)
                        .join("plugin.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(manifest["name"], "skill-review");
            if directory == ".codex-plugin" {
                assert_eq!(manifest["skills"], "./skills/");
            }
        }
        let updated = Skill {
            content: "New instruction.".into(),
            ..skill
        };
        materialize(&updated, &plugin).unwrap();
        let body =
            std::fs::read_to_string(Path::new(&plugin.source).join("skills/review/SKILL.md"))
                .unwrap();
        assert!(body.ends_with("New instruction.\n"));
        assert!(!body.contains("Read the diff."));
        std::fs::remove_dir_all(root).unwrap();
    }
}
