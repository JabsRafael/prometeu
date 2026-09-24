//! Starting a conversation from a skill (ADR 0057). The launcher's "Start with" catalog combines
//! standalone hub skills with the skills installed plugins ship in `skills/*/SKILL.md`. A chosen
//! skill is an ephemeral addition over the layered tool resolution of ADR 0045: its package joins
//! the resolved set of the conversation that started from it, and never any global, project or
//! workspace layer. The first message opens with one app-written line naming the skill and, when
//! the repository declares one, the artifact path from `[method] artifacts`.
use crate::{i18n, plugins, session::Launch, skills};
use serde::Serialize;
use std::path::Path;

/// A skill discovered inside an installed plugin package.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct PluginSkill {
    /// The hub ID of the plugin that ships the skill.
    pub plugin: String,
    /// The frontmatter `name`, or the skill's directory name when the frontmatter omits it.
    pub name: String,
    /// The frontmatter `description`, folded into one line; empty when absent.
    pub description: String,
}

/// A validated launcher choice. `id` is the wire and persisted form `<package>/<skill>`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Kickoff {
    pub id: String,
    /// The hub package the session must load: `skill-<id>` for a standalone skill, or the plugin.
    pub package: String,
    /// The skill name the opening line mentions.
    pub name: String,
    /// The plugin that ships the skill; `None` for a standalone skill.
    pub plugin: Option<String>,
}

/// Split `<package>/<skill>`. Skill names never contain a slash, so the last one separates them.
pub fn parse(id: &str) -> Option<(&str, &str)> {
    let (package, skill) = id.trim().rsplit_once('/')?;
    (!package.is_empty() && !skill.is_empty()).then_some((package, skill))
}

/// Resolve a launcher choice against the installed catalog. An empty ID means no kickoff; an ID the
/// catalog no longer has fails instead of silently starting without the method.
pub fn resolve(
    id: &str,
    standalone: &[skills::Skill],
    hub: &[plugins::Plugin],
) -> Result<Option<Kickoff>, String> {
    if id.trim().is_empty() {
        return Ok(None);
    }
    let missing = || i18n::ta("err.kickoff.missing", &[("skill", id.trim().to_string())]);
    let (package, skill) = parse(id).ok_or_else(missing)?;
    if !hub.iter().any(|p| p.id == package) {
        return Err(missing());
    }
    let kickoff = |plugin: Option<String>| Kickoff {
        id: format!("{package}/{skill}"),
        package: package.to_string(),
        name: skill.to_string(),
        plugin,
    };
    if standalone
        .iter()
        .any(|s| skills::package_id(&s.id) == package && s.id == skill)
    {
        return Ok(Some(kickoff(None)));
    }
    if standalone_package(standalone, package) {
        return Err(missing());
    }
    let found = discover(hub, standalone)
        .into_iter()
        .any(|s| s.plugin == package && s.name == skill);
    match found {
        true => Ok(Some(kickoff(Some(package.to_string())))),
        false => Err(missing()),
    }
}

fn standalone_package(standalone: &[skills::Skill], id: &str) -> bool {
    standalone.iter().any(|s| skills::package_id(&s.id) == id)
}

/// List the skills shipped by installed plugins. Standalone skill packages are excluded because the
/// launcher lists them from the skill hub. Only local folders are read: a `.zip` or URL source is
/// handed to the CLI as is, so its contents stay out of the catalog.
pub fn discover(hub: &[plugins::Plugin], standalone: &[skills::Skill]) -> Vec<PluginSkill> {
    let mut found: Vec<PluginSkill> = hub
        .iter()
        .filter(|p| !standalone_package(standalone, &p.id))
        .filter(|p| !plugins::remote(&p.source) && !p.source.ends_with(".zip"))
        .flat_map(|p| {
            package_skills(Path::new(&plugins::expand(&p.source)))
                .into_iter()
                .map(|(name, description)| PluginSkill {
                    plugin: p.id.clone(),
                    name,
                    description,
                })
        })
        .collect();
    found.sort_by(|a, b| (&a.plugin, &a.name).cmp(&(&b.plugin, &b.name)));
    found.dedup_by(|a, b| a.plugin == b.plugin && a.name == b.name);
    found
}

/// Read `skills/*/SKILL.md` below one package root, returning `(name, description)` pairs. A
/// missing directory or unreadable file contributes nothing.
fn package_skills(root: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(root.join("skills")) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let folder = entry.file_name().into_string().ok()?;
            let text = std::fs::read_to_string(entry.path().join("SKILL.md")).ok()?;
            let (name, description) = frontmatter(&text);
            let name = name.filter(|n| valid_name(n)).unwrap_or(folder);
            valid_name(&name).then(|| (name, description.unwrap_or_default()))
        })
        .collect()
}

/// A skill name the kickoff ID can carry: non-empty, bounded, and without a slash or line break.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 64
        && !name.contains(['/', '\n', '\r'])
        && !name.starts_with('.')
}

/// Extract `name` and `description` from YAML frontmatter. Only the scalar forms skills use are
/// understood — plain, single- or double-quoted, and folded or literal blocks — so the backend
/// needs no YAML dependency. Values are folded into one line for display.
pub(crate) fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (None, None);
    }
    let body: Vec<&str> = lines.take_while(|l| l.trim_end() != "---").collect();
    let value = |key: &str| -> Option<String> {
        let at = body.iter().position(|l| {
            l.strip_prefix(key)
                .is_some_and(|rest| rest.trim_start().starts_with(':'))
        })?;
        let raw = body[at][key.len()..].trim_start()[1..].trim();
        let folded = if raw.is_empty() || raw.starts_with('>') || raw.starts_with('|') {
            body[at + 1..]
                .iter()
                .take_while(|l| l.trim().is_empty() || l.starts_with([' ', '\t']))
                .map(|l| l.trim())
                .collect::<Vec<_>>()
                .join(" ")
        } else if raw.starts_with('"') {
            serde_json::from_str::<String>(raw)
                .unwrap_or_else(|_| raw.trim_matches('"').to_string())
        } else if let Some(inner) = raw.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
            inner.replace("''", "'")
        } else {
            raw.to_string()
        };
        let line = folded.split_whitespace().collect::<Vec<_>>().join(" ");
        (!line.is_empty()).then_some(line)
    };
    (value("name"), value("description"))
}

/// Guarantee the kickoff package in a launch without touching any selection layer. The package
/// joins the axis its ID belongs to (`skill-<id>` rides the skills axis, like the axis setters
/// require); a package the hub no longer has is ignored, like an ID removed from a layer.
pub(crate) fn ensure(launch: &mut Launch, id: &str, hub: &[String]) {
    let Some((package, _)) = parse(id) else {
        return;
    };
    if !hub.iter().any(|h| h == package) {
        return;
    }
    let axis = match package.starts_with("skill-") {
        true => &mut launch.skills,
        false => &mut launch.plugins,
    };
    let list = axis.get_or_insert_with(Vec::new);
    if !list.iter().any(|p| p == package) {
        list.push(package.to_string());
    }
}

/// The app-written opening line of the first message. It is agent-facing text rendered by the
/// backend in the display language, like other agent-injected notices; the transcript keeps it
/// verbatim afterwards. `artifacts` is already relative to the agent's working directory.
pub fn opening_line(kickoff: &Kickoff, artifacts: Option<&str>) -> String {
    let name = &kickoff.name;
    let (from_pt, from_en) = match &kickoff.plugin {
        Some(plugin) => (
            format!(" do plugin \"{plugin}\""),
            format!(" from the \"{plugin}\" plugin"),
        ),
        None => (String::new(), String::new()),
    };
    match artifacts {
        Some(path) => i18n::pick(
            &format!("Use a skill \"{name}\"{from_pt} nesta conversa e grave os artefatos dela em `{path}/`."),
            &format!("Use the \"{name}\" skill{from_en} for this conversation and write its artifacts under `{path}/`."),
        ),
        None => i18n::pick(
            &format!("Use a skill \"{name}\"{from_pt} nesta conversa."),
            &format!("Use the \"{name}\" skill{from_en} for this conversation."),
        ),
    }
}

/// Expose skills shipped inside installed plugins to the launcher's "Start with" catalog.
#[tauri::command(async)]
pub fn plugin_skills() -> Vec<PluginSkill> {
    let _sync = crate::catalog::guard();
    discover(&plugins::load(), &skills::load())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(id: &str, source: &str) -> plugins::Plugin {
        plugins::Plugin {
            id: id.into(),
            source: source.into(),
            note: String::new(),
            made: false,
            from: String::new(),
        }
    }

    fn skill(id: &str) -> skills::Skill {
        skills::Skill {
            id: id.into(),
            description: "d".into(),
            content: "c".into(),
        }
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn frontmatter_reads_the_scalar_forms_skills_use() {
        assert_eq!(
            frontmatter("---\nname: discovery\ndescription: Interview first.\n---\n# Body\n"),
            (Some("discovery".into()), Some("Interview first.".into()))
        );
        assert_eq!(
            frontmatter("---\nname: \"spec\"\ndescription: 'It''s \"quoted\"'\n---\n"),
            (Some("spec".into()), Some("It's \"quoted\"".into()))
        );
        assert_eq!(
            frontmatter(
                "---\nname: plan\ndescription: >-\n  Use when\n  planning.\nother: x\n---\n"
            ),
            (Some("plan".into()), Some("Use when planning.".into()))
        );
        assert_eq!(
            frontmatter("---\nname: \"a\\nb\"\n---\n"),
            (Some("a b".into()), None)
        );
        assert_eq!(frontmatter("# No frontmatter\nname: x\n"), (None, None));
        assert_eq!(
            frontmatter("---\nnames: x\ndescription:\n---\n"),
            (None, None)
        );
    }

    #[test]
    fn discovery_reads_local_plugin_packages_and_skips_standalone_and_remote_sources() {
        let root = std::env::temp_dir().join(format!("prometeu-kickoff-{}", uuid::Uuid::new_v4()));
        let kit = root.join("sdd-kit");
        write(
            &kit,
            "skills/specify/SKILL.md",
            "---\nname: specify\ndescription: Write a spec.\n---\n",
        );
        write(
            &kit,
            "skills/clarify/SKILL.md",
            "---\ndescription: Ask.\n---\n",
        );
        write(&kit, "skills/templates/readme.md", "not a skill");
        let package = root.join("skills-packages/review");
        write(
            &package,
            "skills/review/SKILL.md",
            "---\nname: review\ndescription: Review.\n---\n",
        );
        let hub = [
            plugin("sdd-kit", &kit.display().to_string()),
            plugin("skill-review", &package.display().to_string()),
            plugin("remote", "https://example.com/p.zip"),
            plugin("gone", &root.join("missing").display().to_string()),
        ];
        let found = discover(&hub, &[skill("review")]);
        assert_eq!(
            found,
            vec![
                PluginSkill {
                    plugin: "sdd-kit".into(),
                    name: "clarify".into(),
                    description: "Ask.".into()
                },
                PluginSkill {
                    plugin: "sdd-kit".into(),
                    name: "specify".into(),
                    description: "Write a spec.".into()
                },
            ]
        );

        assert_eq!(resolve("", &[skill("review")], &hub), Ok(None));
        let standalone = resolve("skill-review/review", &[skill("review")], &hub)
            .unwrap()
            .unwrap();
        assert_eq!(standalone.package, "skill-review");
        assert_eq!(standalone.plugin, None);
        let bundled = resolve("sdd-kit/specify", &[skill("review")], &hub)
            .unwrap()
            .unwrap();
        assert_eq!(bundled.plugin.as_deref(), Some("sdd-kit"));
        assert_eq!(bundled.name, "specify");
        for missing in [
            "sdd-kit/unknown",
            "skill-review/other",
            "absent/specify",
            "no-slash",
        ] {
            let error = resolve(missing, &[skill("review")], &hub).unwrap_err();
            assert!(error.contains("err.kickoff.missing"), "{missing}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ensure_adds_the_package_to_its_axis_without_duplicates() {
        let hub = vec!["sdd-kit".to_string(), "skill-review".to_string()];
        let mut inherit = Launch::default();
        ensure(&mut inherit, "sdd-kit/specify", &hub);
        assert_eq!(inherit.plugins, Some(vec!["sdd-kit".to_string()]));
        assert_eq!(inherit.skills, None);

        let mut chosen = Launch {
            skills: Some(vec!["skill-other".into()]),
            ..Default::default()
        };
        ensure(&mut chosen, "skill-review/review", &hub);
        ensure(&mut chosen, "skill-review/review", &hub);
        assert_eq!(
            chosen.skills,
            Some(vec!["skill-other".to_string(), "skill-review".to_string()])
        );
        assert_eq!(chosen.plugins, None);

        let mut removed = Launch::default();
        ensure(&mut removed, "uninstalled/x", &hub);
        ensure(&mut removed, "", &hub);
        assert_eq!(removed.plugins, None);
        assert_eq!(removed.skills, None);
    }

    #[test]
    fn opening_line_names_the_skill_and_only_a_declared_path() {
        let _guard = i18n::TEST_LANG.lock().unwrap_or_else(|e| e.into_inner());
        i18n::set_lang("en".into());
        let bundled = Kickoff {
            id: "sdd-kit/specify".into(),
            package: "sdd-kit".into(),
            name: "specify".into(),
            plugin: Some("sdd-kit".into()),
        };
        assert_eq!(
            opening_line(&bundled, Some("docs/specs")),
            "Use the \"specify\" skill from the \"sdd-kit\" plugin for this conversation and write its artifacts under `docs/specs/`."
        );
        let standalone = Kickoff {
            plugin: None,
            ..bundled
        };
        assert_eq!(
            opening_line(&standalone, None),
            "Use the \"specify\" skill for this conversation."
        );
        i18n::set_lang("pt-BR".into());
        assert_eq!(
            opening_line(&standalone, Some("app/docs/specs")),
            "Use a skill \"specify\" nesta conversa e grave os artefatos dela em `app/docs/specs/`."
        );
    }
}
