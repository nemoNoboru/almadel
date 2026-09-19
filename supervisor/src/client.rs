//! Typed HTTP client for the Almadel agent API.
//!
//! Holds the registration token in memory only. Every agent-facing call after
//! registration carries `Authorization: Bearer <token>`; the token is never
//! logged or written to disk (see [`SecretString`]).

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A string that must never be logged or persisted (the registration token).
///
/// Its `Debug`/`Display` impls redact the contents. It is still `Clone` so the
/// value can be handed to the [`Client`] while the caller keeps a copy.
#[derive(Clone)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    /// The underlying value. Callers must treat it as secret.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString([REDACTED])")
    }
}

impl std::fmt::Display for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

/// Errors surfaced by the HTTP client.
#[derive(Debug, Error)]
pub enum ClientError {
    #[error("invalid server base URL: {0}")]
    InvalidBase(String),

    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },

    #[error("request failed: {0}")]
    Request(#[from] reqwest::Error),
}

// ---------------------------------------------------------------------------
// Wire types (mirror server/src/types.ts)
// ---------------------------------------------------------------------------

/// `GET /api/projects` returns only `{ id, name }`.
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
}

/// The full project shape (from `/api/projects/{id}/board`).
#[derive(Debug, Clone, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub git_remote: Option<String>,
    pub default_branch: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Column {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub position: i64,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub next_column: Option<String>,
    pub fail_column: Option<String>,
    pub wip_limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Ticket {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub body: Option<String>,
    pub column_id: String,
    pub state: String,
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub agent_id: Option<String>,
    pub priority: i64,
    pub claimed_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Board {
    pub project: Project,
    pub columns: Vec<Column>,
    pub tickets: Vec<Ticket>,
}

/// `POST /api/agents` request body.
#[derive(Debug, Clone, Serialize)]
pub struct Registration {
    pub project: String,
    pub repo_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opencode_version: Option<String>,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize)]
pub struct Capabilities {
    pub tools: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_hook: Option<bool>,
}

/// `POST /api/agents` response.
#[derive(Debug, Clone, Deserialize)]
pub struct RegistrationResult {
    pub agent_id: String,
    pub name: String,
    pub token: String,
    pub port_base: u16,
}

/// Slot telemetry that rides the claim body.
#[derive(Debug, Clone, Serialize)]
pub struct SlotTelemetry {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

/// `POST /api/claim` request body.
#[derive(Debug, Clone, Serialize)]
pub struct ClaimRequest {
    pub project: String,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<SlotTelemetry>,
}

/// The claim union (server/src/types.ts::Job).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Job {
    Task {
        project: String,
        ticket: String,
        prompt: String,
        branch: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        base_sha: Option<String>,
    },
    Reply {
        project: String,
        ticket: String,
        text: String,
    },
    Permission {
        project: String,
        ticket: String,
        permission_id: String,
        decision: String,
        scope: String,
    },
    Cancel {
        project: String,
        ticket: String,
    },
    Message {
        project: String,
        text: String,
    },
}

impl Job {
    pub fn type_name(&self) -> &'static str {
        match self {
            Job::Task { .. } => "task",
            Job::Reply { .. } => "reply",
            Job::Permission { .. } => "permission",
            Job::Cancel { .. } => "cancel",
            Job::Message { .. } => "message",
        }
    }
}

/// `POST /api/tickets/{id}/move` request body.
#[derive(Debug, Clone, Serialize)]
pub struct MoveRequest {
    pub column: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
}

/// `POST /api/tickets/{id}/comment` request body.
#[derive(Debug, Clone, Serialize)]
pub struct CommentRequest {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// A typed client for the Almadel agent API.
///
/// `Debug` is safe: the token field is a [`SecretString`] whose `Debug` output
/// is redacted.
#[derive(Debug)]
pub struct Client {
    http: reqwest::Client,
    base: reqwest::Url,
    token: Option<SecretString>,
}

impl Client {
    /// Build a client for the given server base URL (e.g. `http://127.0.0.1:8787`).
    pub fn new(base_url: &str) -> Result<Self, ClientError> {
        let base = reqwest::Url::parse(base_url.trim_end_matches('/'))
            .map_err(|e| ClientError::InvalidBase(e.to_string()))?;
        let http = reqwest::Client::builder().build()?;
        Ok(Self {
            http,
            base,
            token: None,
        })
    }

    /// Store the registration token in memory (replaces any previous token).
    pub fn set_token(&mut self, token: impl Into<String>) {
        self.token = Some(SecretString::new(token));
    }

    fn url(&self, path: &str) -> reqwest::Url {
        self.base
            .join(path)
            .expect("relative path must resolve against base URL")
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(t) => req.bearer_auth(t.expose()),
            None => req,
        }
    }

    async fn check(&self, resp: reqwest::Response) -> Result<reqwest::Response, ClientError> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let code = status.as_u16();
        let body = resp.text().await.unwrap_or_default();
        let message = extract_error(&body).unwrap_or_else(|| {
            if body.is_empty() {
                format!("HTTP {code}")
            } else {
                body
            }
        });
        Err(ClientError::Http {
            status: code,
            message,
        })
    }

    /// `GET /api/projects` → `[{ id, name }]`.
    pub async fn list_projects(&self) -> Result<Vec<ProjectSummary>, ClientError> {
        let resp = self.http.get(self.url("api/projects")).send().await?;
        let resp = self.check(resp).await?;
        Ok(resp.json().await?)
    }

    /// `GET /api/projects/{id}/board` → full project + columns + tickets.
    pub async fn get_board(&self, project_id: &str) -> Result<Board, ClientError> {
        let path = format!("api/projects/{project_id}/board");
        let resp = self.http.get(self.url(&path)).send().await?;
        let resp = self.check(resp).await?;
        Ok(resp.json().await?)
    }

    /// `GET /api/projects/{id}/columns` → the ordered column list.
    pub async fn get_columns(&self, project_id: &str) -> Result<Vec<Column>, ClientError> {
        let path = format!("api/projects/{project_id}/columns");
        let resp = self.http.get(self.url(&path)).send().await?;
        let resp = self.check(resp).await?;
        Ok(resp.json().await?)
    }

    /// `POST /api/agents` → `{ agent_id, name, token, port_base }`.
    pub async fn register(&self, reg: &Registration) -> Result<RegistrationResult, ClientError> {
        let resp = self
            .http
            .post(self.url("api/agents"))
            .json(reg)
            .send()
            .await?;
        let resp = self.check(resp).await?;
        Ok(resp.json().await?)
    }

    /// `POST /api/claim` → `Some(job)` or `None` on `204` (poll-window timeout).
    pub async fn claim(&self, req: &ClaimRequest) -> Result<Option<Job>, ClientError> {
        let resp = self
            .http
            .post(self.url("api/claim"))
            .json(req)
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        let resp = self.check(resp).await?;
        Ok(Some(resp.json().await?))
    }

    /// `POST /api/tickets/{id}/move`.
    pub async fn move_ticket(
        &self,
        ticket_id: &str,
        column_id: &str,
        note: Option<&str>,
        head_sha: Option<&str>,
    ) -> Result<(), ClientError> {
        let body = MoveRequest {
            column: column_id.to_string(),
            note: note.map(String::from),
            head_sha: head_sha.map(String::from),
        };
        let path = format!("api/tickets/{ticket_id}/move");
        let resp = self
            .auth(self.http.post(self.url(&path)))
            .json(&body)
            .send()
            .await?;
        self.check(resp).await?;
        Ok(())
    }

    /// `POST /api/tickets/{id}/comment`.
    pub async fn comment(
        &self,
        ticket_id: &str,
        kind: &str,
        body: Option<&str>,
    ) -> Result<(), ClientError> {
        let body = CommentRequest {
            kind: kind.to_string(),
            body: body.map(String::from),
        };
        let path = format!("api/tickets/{ticket_id}/comment");
        let resp = self
            .auth(self.http.post(self.url(&path)))
            .json(&body)
            .send()
            .await?;
        self.check(resp).await?;
        Ok(())
    }
}

/// Extract the server's `{ "error": "..." }` message, if the body parses as JSON.
fn extract_error(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value.get("error")?.as_str().map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_string_redacts() {
        let s = SecretString::new("tok_secret_123");
        assert_eq!(format!("{s:?}"), "SecretString([REDACTED])");
        assert_eq!(format!("{s}"), "[REDACTED]");
        assert_eq!(s.expose(), "tok_secret_123");
    }

    #[test]
    fn extract_error_parses_server_body() {
        assert_eq!(
            extract_error(r#"{"error":"nope","issues":[]}"#).as_deref(),
            Some("nope")
        );
        assert_eq!(extract_error("plain text"), None);
        assert_eq!(extract_error(r#"{"no":"error"}"#), None);
    }

    #[test]
    fn job_type_names() {
        let job = Job::Message {
            project: "p".into(),
            text: "hi".into(),
        };
        assert_eq!(job.type_name(), "message");
    }
}
