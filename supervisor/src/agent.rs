//! Project resolution and agent registration.
//!
//! Resolution maps a user-supplied project name *or* id to a full [`Project`]
//! (capturing `git_remote` + `default_branch`). Registration POSTs to
//! `/api/agents` and returns the in-memory session (agent id + token +
//! port band). The token is kept in memory only.

use std::path::PathBuf;

use thiserror::Error;
use tracing::warn;

use crate::client::{
    Capabilities, Client, ClientError, Project, ProjectSummary, Registration, RegistrationResult,
    SecretString,
};
use crate::config::Config;

/// Fallback reported when `opencode --version` cannot be probed. It satisfies
/// the server's `>= minOpencodeVersion` gate (default `1.0.0`).
const FALLBACK_VERSION: &str = "1.0.0";

#[derive(Debug, Error)]
pub enum AgentError {
    #[error(transparent)]
    Client(#[from] ClientError),

    #[error("project '{0}' not found on the server")]
    ProjectNotFound(String),

    #[error("could not spawn opencode: {0}")]
    Spawn(std::io::Error),
}

/// The registration result the supervisor keeps for the life of the process.
#[derive(Debug, Clone)]
pub struct AgentSession {
    pub agent_id: String,
    pub name: String,
    pub token: SecretString,
    pub port_base: u16,
}

impl From<RegistrationResult> for AgentSession {
    fn from(r: RegistrationResult) -> Self {
        Self {
            agent_id: r.agent_id,
            name: r.name,
            token: SecretString::new(r.token),
            port_base: r.port_base,
        }
    }
}

/// Resolve the configured `project` (id or name) to its full [`Project`].
pub async fn resolve_project(client: &Client, project: &str) -> Result<Project, AgentError> {
    let summaries = client.list_projects().await?;
    let summary = find_project(&summaries, project)
        .ok_or_else(|| AgentError::ProjectNotFound(project.to_string()))?;
    // The list endpoint omits git_remote/default_branch; fetch the board for the
    // full project shape needed at registration.
    let board = client.get_board(&summary.id).await?;
    Ok(board.project)
}

/// Match a project by exact id first, then by exact name.
pub fn find_project<'a>(
    summaries: &'a [ProjectSummary],
    needle: &str,
) -> Option<&'a ProjectSummary> {
    summaries
        .iter()
        .find(|p| p.id == needle)
        .or_else(|| summaries.iter().find(|p| p.name == needle))
}

/// Register (or re-register) this slot and return the session.
pub async fn register(
    client: &Client,
    project: &Project,
    cfg: &Config,
) -> Result<AgentSession, AgentError> {
    let version = detect_opencode_version(&cfg.opencode_bin).await;
    if version.is_none() {
        warn!(
            opencode_bin = %cfg.opencode_bin,
            fallback = FALLBACK_VERSION,
            "could not detect opencode version; reporting fallback"
        );
    }
    let opencode_version = version.unwrap_or_else(|| FALLBACK_VERSION.to_string());

    let reg = Registration {
        project: project.id.clone(),
        repo_root: repo_root(cfg, &project.id),
        git_remote: project.git_remote.clone(),
        default_branch: Some(project.default_branch.clone()),
        label: Some(cfg.label.clone()),
        opencode_version: Some(opencode_version),
        capabilities: Capabilities {
            tools: true,
            permission_hook: None,
        },
    };

    let result = client.register(&reg).await?;
    Ok(AgentSession::from(result))
}

/// Deterministic repo root: `<workspace>/<project>`. Re-registration upserts
/// the same slot row on the server because this path never changes across
/// restarts for a given project + workspace.
pub fn repo_root(cfg: &Config, project_id: &str) -> String {
    PathBuf::from(&cfg.workspace)
        .join(project_id)
        .to_string_lossy()
        .into_owned()
}

/// Probe `opencode --version` and parse a dotted semver out of its stdout.
pub async fn detect_opencode_version(bin: &str) -> Option<String> {
    let out = tokio::process::Command::new(bin)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_semver(&String::from_utf8_lossy(&out.stdout))
}

/// Extract the first `major.minor[.patch…]` token from a version string.
pub fn parse_semver(s: &str) -> Option<String> {
    let start = s.find(|c: char| c.is_ascii_digit())?;
    let rest = &s[start..];
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(rest.len());
    let cand = &rest[..end];
    let mut parts = cand.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    if major.is_empty() || minor.is_empty() {
        return None;
    }
    Some(cand.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::ProjectSummary;

    #[test]
    fn parse_semver_extracts_version() {
        assert_eq!(parse_semver("1.18.30").as_deref(), Some("1.18.30"));
        assert_eq!(
            parse_semver("opencode 1.18.30 (rev 1234)").as_deref(),
            Some("1.18.30")
        );
        assert_eq!(parse_semver("0.5.0").as_deref(), Some("0.5.0"));
        assert_eq!(parse_semver("no version here"), None);
        assert_eq!(parse_semver(""), None);
    }

    #[test]
    fn find_project_prefers_id_then_name() {
        let projects = vec![
            ProjectSummary {
                id: "prj_1".into(),
                name: "alpha".into(),
            },
            ProjectSummary {
                id: "prj_2".into(),
                name: "beta".into(),
            },
        ];
        assert_eq!(find_project(&projects, "prj_2").unwrap().name, "beta");
        assert_eq!(find_project(&projects, "alpha").unwrap().id, "prj_1");
        assert!(find_project(&projects, "missing").is_none());
    }

    #[test]
    fn repo_root_is_deterministic() {
        let cfg = Config::resolve(
            crate::config::Cli {
                server: Some("http://x".into()),
                project: Some("p".into()),
                label: None,
                workspace: Some(PathBuf::from("/tmp/ws")),
                opencode: None,
                opencode_args: None,
            },
            &crate::config::OsEnv,
        )
        .unwrap();
        let a = repo_root(&cfg, "prj_1");
        let b = repo_root(&cfg, "prj_1");
        assert_eq!(a, b);
        assert_eq!(a, "/tmp/ws/prj_1");
    }
}
