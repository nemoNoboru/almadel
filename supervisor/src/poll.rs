//! Long-poll claim loop and per-job task handling.
//!
//! The loop POSTs `/api/claim` with slot telemetry and dispatches the returned
//! job. `task` jobs are run through `opencode` (capturing the exit code): a
//! clean exit moves the ticket to its `next_column`; a non-zero exit comments
//! the error and moves it to its `fail_column`. Non-task jobs are logged and
//! ignored (Phase 1).

use std::time::{SystemTime, UNIX_EPOCH};

use tracing::{debug, info, warn};

use crate::agent::AgentSession;
use crate::client::{Board, ClaimRequest, Client, ClientError, Job, Project, SlotTelemetry};
use crate::config::Config;

/// Sleep applied after a claim failure, doubled on each consecutive failure.
const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 30_000;

/// How a single claim+handle cycle resolved the held ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The ticket was moved (success or fail) and the agent released.
    Released,
    /// The ticket is still held (move/comment failed); keep reporting `working`.
    Held,
    /// A non-task job was ignored.
    Ignored,
}

/// Run the poll loop forever. Never returns in normal operation.
pub async fn run(client: &Client, session: &AgentSession, project: &Project, cfg: &Config) {
    let mut current_ticket: Option<String> = None;
    let mut backoff_ms = BACKOFF_BASE_MS;
    loop {
        let status = if current_ticket.is_some() {
            "working"
        } else {
            "idle"
        };
        let claim = ClaimRequest {
            project: project.id.clone(),
            agent: session.agent_id.clone(),
            slot: Some(SlotTelemetry {
                status: status.to_string(),
                ticket: current_ticket.clone(),
                since: Some(now_ms()),
            }),
        };
        match client.claim(&claim).await {
            Ok(None) => {
                backoff_ms = BACKOFF_BASE_MS;
            }
            Ok(Some(job)) => {
                backoff_ms = BACKOFF_BASE_MS;
                if let Job::Task { ticket, .. } = &job {
                    current_ticket = Some(ticket.clone());
                }
                match handle_job(client, project, cfg, job).await {
                    Outcome::Released | Outcome::Ignored => current_ticket = None,
                    Outcome::Held => {
                        warn!(ticket = ?current_ticket, "ticket still held; release will be retried on next claim");
                    }
                }
            }
            Err(e) => {
                warn!(error = %e, "claim failed");
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(BACKOFF_CAP_MS);
            }
        }
    }
}

/// The fields of a `task` job needed to run it.
struct Task {
    ticket: String,
    prompt: String,
    branch: String,
    model: Option<String>,
    base_sha: Option<String>,
}

/// Handle a single job (public for integration testing).
pub async fn handle_job(client: &Client, project: &Project, cfg: &Config, job: Job) -> Outcome {
    match job {
        Job::Task {
            ticket,
            prompt,
            branch,
            model,
            base_sha,
            ..
        } => {
            info!(ticket = %ticket, branch = %branch, "running task");
            let task = Task {
                ticket,
                prompt,
                branch,
                model,
                base_sha,
            };
            handle_task(client, project, cfg, &task).await
        }
        other => {
            info!(job = other.type_name(), "ignoring non-task job");
            Outcome::Ignored
        }
    }
}

async fn handle_task(client: &Client, project: &Project, cfg: &Config, task: &Task) -> Outcome {
    let run = run_opencode(cfg, &task.prompt, task.model.as_deref()).await;
    match run {
        Ok(()) => {
            info!(ticket = %task.ticket, branch = %task.branch, "opencode succeeded");
            let next = match resolve_column(client, project, &task.ticket, ColumnTarget::Next).await
            {
                Ok(Some(id)) => id,
                Ok(None) => {
                    warn!(ticket = %task.ticket, "no next_column; cannot release");
                    return Outcome::Held;
                }
                Err(e) => {
                    warn!(ticket = %task.ticket, error = %e, "could not resolve next column");
                    return Outcome::Held;
                }
            };
            if let Err(e) = client
                .move_ticket(&task.ticket, &next, None, task.base_sha.as_deref())
                .await
            {
                warn!(ticket = %task.ticket, column = %next, error = %e, "move to next column failed");
                return Outcome::Held;
            }
            Outcome::Released
        }
        Err(reason) => {
            warn!(ticket = %task.ticket, %reason, "opencode failed");
            let body = format!("alimiel: {reason}");
            if let Err(e) = client.comment(&task.ticket, "comment", Some(&body)).await {
                warn!(ticket = %task.ticket, error = %e, "fail comment failed");
            }
            let fail = match resolve_column(client, project, &task.ticket, ColumnTarget::Fail).await
            {
                Ok(Some(id)) => id,
                Ok(None) => {
                    warn!(ticket = %task.ticket, "no fail_column; leaving ticket held");
                    return Outcome::Held;
                }
                Err(e) => {
                    warn!(ticket = %task.ticket, error = %e, "could not resolve fail column");
                    return Outcome::Held;
                }
            };
            if let Err(e) = client.move_ticket(&task.ticket, &fail, None, None).await {
                warn!(ticket = %task.ticket, column = %fail, error = %e, "move to fail column failed");
                return Outcome::Held;
            }
            Outcome::Released
        }
    }
}

/// Spawn `opencode run [--model <model>] <args> <prompt>` in the workspace and
/// capture the exit code. Returns `Err(reason)` on spawn failure or non-zero exit.
async fn run_opencode(cfg: &Config, prompt: &str, model: Option<&str>) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(&cfg.opencode_bin);
    cmd.arg("run");
    if let Some(model) = model {
        cmd.arg("--model").arg(model);
    }
    cmd.args(&cfg.opencode_args);
    cmd.arg(prompt);
    cmd.current_dir(&cfg.workspace);

    debug!(bin = %cfg.opencode_bin, "spawning opencode");
    let status = cmd
        .status()
        .await
        .map_err(|e| format!("could not run opencode: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("opencode exited with {status}"))
    }
}

/// Which outgoing column to resolve for a ticket.
#[derive(Debug, Clone, Copy)]
enum ColumnTarget {
    Next,
    Fail,
}

/// Resolve the target column id for `ticket` by fetching the board and reading
/// the current column's `next_column` / `fail_column` *name*, then mapping it
/// back to an id. Returns `Ok(None)` when the ticket, its column, or the
/// referenced column name cannot be found.
async fn resolve_column(
    client: &Client,
    project: &Project,
    ticket_id: &str,
    target: ColumnTarget,
) -> Result<Option<String>, ClientError> {
    let board = client.get_board(&project.id).await?;
    Ok(resolve_column_in(&board, ticket_id, target))
}

/// Pure helper over an already-fetched board (unit-testable).
fn resolve_column_in(board: &Board, ticket_id: &str, target: ColumnTarget) -> Option<String> {
    let ticket = board.tickets.iter().find(|t| t.id == ticket_id)?;
    let column = board.columns.iter().find(|c| c.id == ticket.column_id)?;
    let name = match target {
        ColumnTarget::Next => column.next_column.as_deref()?,
        ColumnTarget::Fail => column.fail_column.as_deref()?,
    };
    board
        .columns
        .iter()
        .find(|c| c.name == name)
        .map(|c| c.id.clone())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{Board, Column, Project, Ticket};

    fn board() -> Board {
        Board {
            project: Project {
                id: "p".into(),
                name: "p".into(),
                git_remote: None,
                default_branch: "main".into(),
                created_at: 0,
            },
            columns: vec![
                Column {
                    id: "col-planning".into(),
                    project_id: "p".into(),
                    name: "Planning".into(),
                    position: 1,
                    prompt: Some("plan".into()),
                    model: None,
                    next_column: Some("Review".into()),
                    fail_column: Some("Failed".into()),
                    wip_limit: None,
                },
                Column {
                    id: "col-failed".into(),
                    project_id: "p".into(),
                    name: "Failed".into(),
                    position: 6,
                    prompt: None,
                    model: None,
                    next_column: None,
                    fail_column: None,
                    wip_limit: None,
                },
            ],
            tickets: vec![Ticket {
                id: "TCK-1".into(),
                project_id: "p".into(),
                title: "t".into(),
                body: None,
                column_id: "col-planning".into(),
                state: "running".into(),
                branch: Some("run/TCK-1".into()),
                head_sha: None,
                agent_id: Some("agt_1".into()),
                priority: 0,
                claimed_at: None,
                created_at: 0,
            }],
        }
    }

    #[test]
    fn resolves_next_and_fail_column_by_name() {
        let b = board();
        assert_eq!(
            resolve_column_in(&b, "TCK-1", ColumnTarget::Next).as_deref(),
            None // "Review" not present in this minimal board
        );
        assert_eq!(
            resolve_column_in(&b, "TCK-1", ColumnTarget::Fail).as_deref(),
            Some("col-failed")
        );
    }

    #[test]
    fn missing_ticket_or_column_returns_none() {
        let b = board();
        assert_eq!(resolve_column_in(&b, "TCK-999", ColumnTarget::Next), None);
    }
}
