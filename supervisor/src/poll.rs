//! Long-poll claim loop and per-job task handling.
//!
//! The loop POSTs `/api/claim` with slot telemetry and dispatches the returned
//! job. `task` jobs are run through `opencode` (capturing the exit code): a
//! clean exit moves the ticket to its `next_column`; a non-zero exit comments
//! the error and moves it to its `fail_column`. Non-task jobs are logged and
//! ignored (Phase 1).

use std::time::{SystemTime, UNIX_EPOCH};

use tracing::{info, warn};

use crate::agent::AgentSession;
use crate::client::{Board, ClaimRequest, Client, ClientError, Job, Project, SlotTelemetry};
use crate::config::Config;
use crate::git::{self, Checkout, CommitMeta};
use crate::runner;

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
    let workdir = cfg.workspace.join(&task.ticket);
    info!(
        ticket = %task.ticket,
        branch = %task.branch,
        workdir = %workdir.display(),
        "preparing checkout"
    );

    let checkout = match git::prepare(
        project.git_remote.as_deref(),
        &project.default_branch,
        &task.branch,
        task.base_sha.as_deref(),
        &workdir,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            warn!(ticket = %task.ticket, error = %e, "checkout prepare failed");
            return fail_ticket(client, project, cfg, task, None, &format!("alimiel: {e}")).await;
        }
    };

    let run = runner::run(
        &cfg.opencode_bin,
        &cfg.opencode_args,
        task.model.as_deref(),
        &task.prompt,
        &checkout.path,
    )
    .await;

    let outcome = match run {
        Ok(output) if output.exit_code == 0 => {
            info!(ticket = %task.ticket, branch = %task.branch, "opencode succeeded");
            success_ticket(client, project, cfg, task, &checkout).await
        }
        Ok(output) => {
            warn!(ticket = %task.ticket, code = output.exit_code, "opencode failed");
            let body = format!(
                "alimiel: opencode exited {}. tail:\n{}",
                output.exit_code,
                runner::stderr_tail(&output.stderr, 4000)
            );
            fail_ticket(client, project, cfg, task, Some(&checkout), &body).await
        }
        Err(runner::RunnerError::Spawn(e)) => {
            warn!(ticket = %task.ticket, error = %e, "opencode spawn failed");
            let body = format!("alimiel: could not run opencode: {e}");
            fail_ticket(client, project, cfg, task, Some(&checkout), &body).await
        }
        Err(runner::RunnerError::NonZero { code, stderr_tail }) => {
            let body = format!("alimiel: opencode exited {code}. tail:\n{stderr_tail}");
            fail_ticket(client, project, cfg, task, Some(&checkout), &body).await
        }
    };

    git::cleanup(&checkout).await;
    outcome
}

/// The success path: commit + push, then move to the `next` column carrying the
/// real HEAD SHA (plan §9 step 4). A failed commit/push must never become a
/// clean move, so it falls through to the fail path (§13).
async fn success_ticket(
    client: &Client,
    project: &Project,
    cfg: &Config,
    task: &Task,
    checkout: &Checkout,
) -> Outcome {
    let (next_id, next_name) =
        match resolve_column(client, project, &task.ticket, ColumnTarget::Next).await {
            Ok(Some(col)) => col,
            Ok(None) => {
                warn!(ticket = %task.ticket, "no next_column; cannot release");
                return Outcome::Held;
            }
            Err(e) => {
                warn!(ticket = %task.ticket, error = %e, "could not resolve next column");
                return Outcome::Held;
            }
        };

    let meta = CommitMeta {
        ticket: task.ticket.clone(),
        column: next_name,
        label: cfg.label.clone(),
        note: None,
    };
    let sha = match commit_and_push(project, task, checkout, &meta).await {
        Ok(sha) => sha,
        Err(e) => {
            warn!(ticket = %task.ticket, error = %e, "commit/push failed");
            return fail_ticket(client, project, cfg, task, None, &format!("alimiel: {e}")).await;
        }
    };

    if let Err(e) = client
        .move_ticket(&task.ticket, &next_id, None, Some(&sha))
        .await
    {
        warn!(ticket = %task.ticket, column = %next_id, error = %e, "move to next column failed");
        return Outcome::Held;
    }
    Outcome::Released
}

/// The failure path: best-effort commit + push of the failed work, comment the
/// error, and move to the `fail` column (plan §9 step 4 else-branch).
async fn fail_ticket(
    client: &Client,
    project: &Project,
    cfg: &Config,
    task: &Task,
    checkout: Option<&Checkout>,
    body: &str,
) -> Outcome {
    let (fail_id, fail_name) =
        match resolve_column(client, project, &task.ticket, ColumnTarget::Fail).await {
            Ok(Some(col)) => col,
            Ok(None) => {
                warn!(ticket = %task.ticket, "no fail_column; leaving ticket held");
                return Outcome::Held;
            }
            Err(e) => {
                warn!(ticket = %task.ticket, error = %e, "could not resolve fail column");
                return Outcome::Held;
            }
        };

    if let Some(checkout) = checkout {
        let meta = CommitMeta {
            ticket: task.ticket.clone(),
            column: fail_name,
            label: cfg.label.clone(),
            note: None,
        };
        let _ = commit_and_push(project, task, checkout, &meta).await;
    }

    if let Err(e) = client.comment(&task.ticket, "comment", Some(body)).await {
        warn!(ticket = %task.ticket, error = %e, "fail comment failed");
    }

    if let Err(e) = client.move_ticket(&task.ticket, &fail_id, None, None).await {
        warn!(ticket = %task.ticket, column = %fail_id, error = %e, "move to fail column failed");
        return Outcome::Held;
    }
    Outcome::Released
}

/// Commit all changes, push (when a remote is configured), and return the HEAD
/// SHA to report in the move. Ordering mirrors the plugin's `almadel_move`:
/// commit → push → move, so a ticket's work is reachable before the server can
/// hand the next stage to another agent.
async fn commit_and_push(
    project: &Project,
    task: &Task,
    checkout: &Checkout,
    meta: &CommitMeta,
) -> Result<String, String> {
    let committed = git::commit_all(checkout, meta)
        .await
        .map_err(|e| format!("commit failed: {e}"))?;

    if project.git_remote.is_some() {
        git::push(checkout, &task.branch)
            .await
            .map_err(|e| format!("push failed: {e}"))?;
    }

    match committed {
        Some(sha) => Ok(sha),
        None => git::head_sha(checkout)
            .await
            .map_err(|e| format!("head_sha failed: {e}")),
    }
}

/// Which outgoing column to resolve for a ticket.
#[derive(Debug, Clone, Copy)]
enum ColumnTarget {
    Next,
    Fail,
}

/// Resolve the target column for `ticket` by fetching the board and reading
/// the current column's `next_column` / `fail_column` *name*, then mapping it
/// back to `(id, name)`. Returns `Ok(None)` when the ticket, its column, or the
/// referenced column name cannot be found.
async fn resolve_column(
    client: &Client,
    project: &Project,
    ticket_id: &str,
    target: ColumnTarget,
) -> Result<Option<(String, String)>, ClientError> {
    let board = client.get_board(&project.id).await?;
    Ok(resolve_column_in(&board, ticket_id, target))
}

/// Pure helper over an already-fetched board (unit-testable).
fn resolve_column_in(
    board: &Board,
    ticket_id: &str,
    target: ColumnTarget,
) -> Option<(String, String)> {
    let ticket = board.tickets.iter().find(|t| t.id == ticket_id)?;
    let column = board.columns.iter().find(|c| c.id == ticket.column_id)?;
    let name = match target {
        ColumnTarget::Next => column.next_column.as_deref()?,
        ColumnTarget::Fail => column.fail_column.as_deref()?,
    };
    let target = board.columns.iter().find(|c| c.name == name)?;
    Some((target.id.clone(), target.name.clone()))
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
        assert_eq!(resolve_column_in(&b, "TCK-1", ColumnTarget::Next), None);
        // "Review" not present in this minimal board
        assert_eq!(
            resolve_column_in(&b, "TCK-1", ColumnTarget::Fail),
            Some(("col-failed".to_string(), "Failed".to_string()))
        );
    }

    #[test]
    fn missing_ticket_or_column_returns_none() {
        let b = board();
        assert_eq!(resolve_column_in(&b, "TCK-999", ColumnTarget::Next), None);
    }
}
