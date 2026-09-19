use anyhow::{Context, Result};
use clap::Parser;
use tracing::{debug, info};
use tracing_subscriber::EnvFilter;

use alimiel::agent;
use alimiel::client;
use alimiel::config::{Cli, Config, OsEnv};
use alimiel::poll;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg = Config::resolve(cli, &OsEnv)?;

    init_tracing(cfg.verbose)?;
    log_config(&cfg);

    std::fs::create_dir_all(&cfg.workspace)
        .with_context(|| format!("creating workspace {}", cfg.workspace.display()))?;

    let mut client = client::Client::new(&cfg.server)?;
    let project = agent::resolve_project(&client, &cfg.project).await?;
    info!(
        project_id = %project.id,
        project_name = %project.name,
        git_remote = ?project.git_remote,
        default_branch = %project.default_branch,
        "resolved project"
    );

    let session = agent::register(&client, &project, &cfg).await?;
    info!(
        agent_id = %session.agent_id,
        name = %session.name,
        port_base = session.port_base,
        "registered agent"
    );
    client.set_token(session.token.expose());

    poll::run(&client, &session, &project, &cfg).await;
    Ok(())
}

fn init_tracing(verbose: bool) -> Result<()> {
    let filter = if std::env::var("RUST_LOG").is_ok() {
        EnvFilter::from_default_env()
    } else if verbose {
        EnvFilter::new("debug")
    } else {
        EnvFilter::new("info")
    };
    tracing_subscriber::fmt().with_env_filter(filter).init();
    Ok(())
}

fn log_config(cfg: &Config) {
    info!(
        name = env!("CARGO_PKG_NAME"),
        version = env!("CARGO_PKG_VERSION"),
        "starting"
    );
    debug!(
        server = %cfg.server,
        project = %cfg.project,
        label = %cfg.label,
        workspace = %cfg.workspace.display(),
        opencode_bin = %cfg.opencode_bin,
        opencode_args = ?cfg.opencode_args,
        verbose = cfg.verbose,
        "configuration"
    );
}
