//! End-to-end flow through a wiremock server with a fake `opencode` binary.
//!
//! Exercises "from the very start": resolve project → register → claim a task →
//! run opencode → release (move to next column) on exit 0, or mark errored
//! (comment + move to fail column) on non-zero exit.

use std::path::{Path, PathBuf};

use alimiel::agent;
use alimiel::client::{ClaimRequest, Client, Job, SlotTelemetry};
use alimiel::config::Config;
use alimiel::poll::{self, Outcome};
use serde_json::json;
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn board_body() -> serde_json::Value {
    json!({
        "project": {
            "id": "p1",
            "name": "alpha",
            "git_remote": null,
            "default_branch": "main",
            "created_at": 1
        },
        "columns": [
            { "id": "col-planning", "project_id": "p1", "name": "Planning", "position": 1,
              "prompt": "plan {{ticket.id}}", "model": null,
              "next_column": "Review", "fail_column": "Failed", "wip_limit": null },
            { "id": "col-review", "project_id": "p1", "name": "Review", "position": 2,
              "prompt": null, "model": null, "next_column": null, "fail_column": null, "wip_limit": null },
            { "id": "col-failed", "project_id": "p1", "name": "Failed", "position": 3,
              "prompt": null, "model": null, "next_column": null, "fail_column": null, "wip_limit": null }
        ],
        "tickets": [
            { "id": "TCK-1", "project_id": "p1", "title": "do work", "body": null,
              "column_id": "col-planning", "state": "running", "branch": "run/TCK-1",
              "head_sha": null, "agent_id": "agt_1", "priority": 0,
              "claimed_at": 1, "created_at": 1 }
        ]
    })
}

async fn mount_common_routes(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/api/projects"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!([{ "id": "p1", "name": "alpha" }])),
        )
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api/projects/p1/board"))
        .respond_with(ResponseTemplate::new(200).set_body_json(board_body()))
        .mount(server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/agents"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "agent_id": "agt_1", "name": "test", "token": "tok_1", "port_base": 8000
        })))
        .mount(server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/tickets/TCK-1/move"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/tickets/TCK-1/comment"))
        .respond_with(ResponseTemplate::new(204))
        .mount(server)
        .await;
}

fn task_job() -> Job {
    Job::Task {
        project: "p1".into(),
        ticket: "TCK-1".into(),
        prompt: "plan TCK-1".into(),
        branch: "run/TCK-1".into(),
        model: None,
        base_sha: None,
    }
}

/// Write a fake `opencode` shell script that reports a version and exits with
/// `exit_code` for any non-`--version` invocation. Returns its absolute path.
fn fake_opencode(dir: &Path, exit_code: i32) -> PathBuf {
    let script = dir.join("opencode-mock");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"opencode 1.18.30\"; exit 0; fi\nexit {exit_code}\n"
        ),
    )
    .unwrap();
    let mut perms = std::fs::metadata(&script).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
    }
    std::fs::set_permissions(&script, perms).unwrap();
    script
}

fn config(server_uri: &str, workspace: &Path, opencode_bin: PathBuf) -> Config {
    Config {
        server: server_uri.to_string(),
        project: "alpha".into(),
        label: "test".into(),
        workspace: workspace.to_path_buf(),
        opencode_bin: opencode_bin.to_string_lossy().into_owned(),
        opencode_args: vec![],
        verbose: false,
    }
}

async fn request_bodies(server: &MockServer, path: &str) -> Vec<serde_json::Value> {
    let requests = server.received_requests().await.unwrap();
    requests
        .iter()
        .filter(|r| r.url.path() == path)
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect()
}

#[tokio::test]
async fn success_claims_runs_and_moves_to_next_column() {
    let server = MockServer::start().await;
    mount_common_routes(&server).await;
    Mock::given(method("POST"))
        .and(path("/api/claim"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "task", "project": "p1", "ticket": "TCK-1", "prompt": "plan TCK-1",
            "branch": "run/TCK-1", "model": null, "base_sha": null
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let opencode = fake_opencode(tmp.path(), 0);
    let cfg = config(&server.uri(), tmp.path(), opencode);

    let mut client = Client::new(&server.uri()).unwrap();
    let project = agent::resolve_project(&client, "alpha").await.unwrap();
    assert_eq!(project.id, "p1");

    let session = agent::register(&client, &project, &cfg).await.unwrap();
    assert_eq!(session.agent_id, "agt_1");
    client.set_token(session.token.expose());

    let job = client
        .claim(&ClaimRequest {
            project: "p1".into(),
            agent: "agt_1".into(),
            slot: Some(SlotTelemetry {
                status: "idle".into(),
                ticket: None,
                since: None,
            }),
        })
        .await
        .unwrap()
        .expect("task job");

    let outcome = poll::handle_job(&client, &project, &cfg, job).await;
    assert_eq!(outcome, Outcome::Released);

    let moves = request_bodies(&server, "/api/tickets/TCK-1/move").await;
    assert_eq!(moves.len(), 1);
    assert_eq!(moves[0]["column"], "col-review");
}

#[tokio::test]
async fn failure_comments_and_moves_to_fail_column() {
    let server = MockServer::start().await;
    mount_common_routes(&server).await;

    let tmp = TempDir::new().unwrap();
    let opencode = fake_opencode(tmp.path(), 1);
    let cfg = config(&server.uri(), tmp.path(), opencode);

    let mut client = Client::new(&server.uri()).unwrap();
    let project = agent::resolve_project(&client, "alpha").await.unwrap();
    let session = agent::register(&client, &project, &cfg).await.unwrap();
    client.set_token(session.token.expose());

    let outcome = poll::handle_job(&client, &project, &cfg, task_job()).await;
    assert_eq!(outcome, Outcome::Released);

    let comments = request_bodies(&server, "/api/tickets/TCK-1/comment").await;
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0]["kind"], "comment");
    assert!(
        comments[0]["body"]
            .as_str()
            .unwrap()
            .contains("opencode exited"),
        "unexpected comment body: {}",
        comments[0]["body"]
    );

    let moves = request_bodies(&server, "/api/tickets/TCK-1/move").await;
    assert_eq!(moves.len(), 1);
    assert_eq!(moves[0]["column"], "col-failed");
}

#[tokio::test]
async fn non_task_jobs_are_ignored() {
    let server = MockServer::start().await;
    mount_common_routes(&server).await;

    let tmp = TempDir::new().unwrap();
    let opencode = fake_opencode(tmp.path(), 0);
    let cfg = config(&server.uri(), tmp.path(), opencode);

    let client = Client::new(&server.uri()).unwrap();
    let project = agent::resolve_project(&client, "alpha").await.unwrap();

    let job = Job::Message {
        project: "p1".into(),
        text: "hi".into(),
    };
    let outcome = poll::handle_job(&client, &project, &cfg, job).await;
    assert_eq!(outcome, Outcome::Ignored);

    // No move, no comment.
    let moves = request_bodies(&server, "/api/tickets/TCK-1/move").await;
    assert!(moves.is_empty());
}

#[tokio::test]
async fn opencode_spawn_failure_is_not_a_crash() {
    // A non-existent opencode binary must yield an error path (mark errored),
    // never a panic.
    let server = MockServer::start().await;
    mount_common_routes(&server).await;

    let tmp = TempDir::new().unwrap();
    let cfg = config(&server.uri(), tmp.path(), tmp.path().join("does-not-exist"));

    let mut client = Client::new(&server.uri()).unwrap();
    let project = agent::resolve_project(&client, "alpha").await.unwrap();
    let session = agent::register(&client, &project, &cfg).await.unwrap();
    client.set_token(session.token.expose());

    // Version detection fails → falls back to 1.0.0, registration still works.
    let outcome = poll::handle_job(&client, &project, &cfg, task_job()).await;
    assert_eq!(outcome, Outcome::Released);

    let comments = request_bodies(&server, "/api/tickets/TCK-1/comment").await;
    assert_eq!(comments.len(), 1);
    assert!(
        comments[0]["body"]
            .as_str()
            .unwrap()
            .contains("could not run opencode")
    );
    let moves = request_bodies(&server, "/api/tickets/TCK-1/move").await;
    assert_eq!(moves[0]["column"], "col-failed");
}
