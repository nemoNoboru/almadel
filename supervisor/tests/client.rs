//! HTTP client tests against a wiremock server.

use alimiel::client::{Capabilities, ClaimRequest, Client, Job, Registration, SlotTelemetry};
use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn registration() -> Registration {
    Registration {
        project: "almadel-api".into(),
        repo_root: "/ws/almadel-api".into(),
        git_remote: None,
        default_branch: Some("main".into()),
        label: Some("default".into()),
        opencode_version: Some("1.0.0".into()),
        capabilities: Capabilities {
            tools: true,
            permission_hook: None,
        },
    }
}

#[tokio::test]
async fn list_projects_parses_summaries() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/projects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "id": "p1", "name": "alpha" },
            { "id": "p2", "name": "beta" }
        ])))
        .mount(&server)
        .await;

    let client = Client::new(&server.uri()).unwrap();
    let projects = client.list_projects().await.unwrap();
    assert_eq!(projects.len(), 2);
    assert_eq!(projects[0].id, "p1");
    assert_eq!(projects[1].name, "beta");
}

#[tokio::test]
async fn get_board_parses_board() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/projects/p1/board"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "project": {
                "id": "p1",
                "name": "alpha",
                "git_remote": "https://example.com/a.git",
                "default_branch": "main",
                "created_at": 1
            },
            "columns": [],
            "tickets": []
        })))
        .mount(&server)
        .await;

    let client = Client::new(&server.uri()).unwrap();
    let board = client.get_board("p1").await.unwrap();
    assert_eq!(board.project.id, "p1");
    assert_eq!(
        board.project.git_remote.as_deref(),
        Some("https://example.com/a.git")
    );
}

#[tokio::test]
async fn register_posts_body_and_parses_result() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/agents"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "agent_id": "agt_1",
            "name": "default",
            "token": "tok_1",
            "port_base": 8000
        })))
        .mount(&server)
        .await;

    let client = Client::new(&server.uri()).unwrap();
    let result = client.register(&registration()).await.unwrap();
    assert_eq!(result.agent_id, "agt_1");
    assert_eq!(result.token, "tok_1");
    assert_eq!(result.port_base, 8000);

    let requests = server.received_requests().await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["project"], "almadel-api");
    assert_eq!(body["repo_root"], "/ws/almadel-api");
    assert_eq!(body["capabilities"]["tools"], true);
    assert_eq!(body["opencode_version"], "1.0.0");
}

#[tokio::test]
async fn register_surfaces_server_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/agents"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "error": "almadel requires plugin tool support (capabilities.tools)"
        })))
        .mount(&server)
        .await;

    let client = Client::new(&server.uri()).unwrap();
    let err = client.register(&registration()).await.unwrap_err();
    match err {
        alimiel::client::ClientError::Http { status, message } => {
            assert_eq!(status, 409);
            assert!(message.contains("capabilities.tools"), "{message}");
        }
        other => panic!("expected Http error, got {other:?}"),
    }
}

#[tokio::test]
async fn claim_returns_none_on_204() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/claim"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let client = Client::new(&server.uri()).unwrap();
    let req = ClaimRequest {
        project: "p".into(),
        agent: "agt_1".into(),
        slot: Some(SlotTelemetry {
            status: "idle".into(),
            ticket: None,
            since: Some(1),
        }),
    };
    assert!(client.claim(&req).await.unwrap().is_none());
}

#[tokio::test]
async fn claim_parses_task_job() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/claim"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "task",
            "project": "p",
            "ticket": "TCK-1",
            "prompt": "do the thing",
            "branch": "run/TCK-1",
            "model": null,
            "base_sha": null
        })))
        .mount(&server)
        .await;

    let client = Client::new(&server.uri()).unwrap();
    let req = ClaimRequest {
        project: "p".into(),
        agent: "agt_1".into(),
        slot: None,
    };
    match client.claim(&req).await.unwrap() {
        Some(Job::Task {
            ticket,
            prompt,
            branch,
            model,
            ..
        }) => {
            assert_eq!(ticket, "TCK-1");
            assert_eq!(prompt, "do the thing");
            assert_eq!(branch, "run/TCK-1");
            assert!(model.is_none());
        }
        other => panic!("expected task job, got {other:?}"),
    }
}

#[tokio::test]
async fn move_ticket_sends_bearer_and_column() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/tickets/TCK-1/move"))
        .and(header("Authorization", "Bearer tok_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(&server)
        .await;

    let mut client = Client::new(&server.uri()).unwrap();
    client.set_token("tok_1");
    client
        .move_ticket("TCK-1", "col-review", None, None)
        .await
        .unwrap();

    let requests = server.received_requests().await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["column"], "col-review");
}

#[tokio::test]
async fn comment_sends_kind_and_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/tickets/TCK-1/comment"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let mut client = Client::new(&server.uri()).unwrap();
    client.set_token("tok_1");
    client
        .comment("TCK-1", "comment", Some("alimiel: failed"))
        .await
        .unwrap();

    let requests = server.received_requests().await.unwrap();
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["kind"], "comment");
    assert_eq!(body["body"], "alimiel: failed");
}
