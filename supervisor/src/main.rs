mod config;

use anyhow::Result;
use clap::Parser;
use tracing::{debug, info};
use tracing_subscriber::EnvFilter;

use config::{Cli, Config, OsEnv};

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg = Config::resolve(cli, &OsEnv)?;

    init_tracing(cfg.verbose)?;
    log_config(&cfg);

    Ok(())
}

/// Install the tracing subscriber. `ALMADEL_VERBOSE` selects `debug`, otherwise
/// `info`; an explicit `RUST_LOG` always wins over both.
fn init_tracing(verbose: bool) -> Result<()> {
    let filter = match std::env::var("RUST_LOG") {
        Ok(spec) => EnvFilter::try_new(spec)?,
        Err(_) if verbose => EnvFilter::try_new("debug")?,
        Err(_) => EnvFilter::try_new("info")?,
    };
    tracing_subscriber::fmt().with_env_filter(filter).init();
    Ok(())
}

/// Emit a startup banner (always) and the resolved config (debug only).
/// The config carries no secrets; that invariant must hold when the agent
/// token is added in later phases.
fn log_config(cfg: &Config) {
    info!(version = env!("CARGO_PKG_VERSION"), "alimiel starting");
    debug!(
        server = %cfg.server,
        project = %cfg.project,
        label = %cfg.label,
        workspace = %cfg.workspace.display(),
        opencode_bin = %cfg.opencode_bin,
        opencode_args = ?cfg.opencode_args,
        verbose = cfg.verbose,
        "resolved configuration"
    );
}
