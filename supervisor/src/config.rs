use std::ffi::OsString;
use std::path::PathBuf;

use clap::Parser;
use thiserror::Error;

/// Error resolving the supervisor configuration.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing required configuration: {0} (set --{1} or {2})")]
    Missing(&'static str, &'static str, &'static str),
}

/// A source of environment variables, decoupled from the process env so
/// resolution is unit-testable without mutating global state.
pub trait Env {
    fn var(&self, key: &str) -> Option<String>;
    fn var_os(&self, key: &str) -> Option<OsString>;
}

/// The process environment.
pub struct OsEnv;

impl Env for OsEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    fn var_os(&self, key: &str) -> Option<OsString> {
        std::env::var_os(key)
    }
}

/// CLI surface. Values are resolved with precedence CLI flag > env var >
/// default (clap's `env` attribute fills from the environment when the flag is
/// absent). Required and multi-source defaults are finalized in [`Config::resolve`].
#[derive(Debug, Clone, Parser)]
#[command(
    name = "alimiel",
    version,
    about = "Almadel supervisor: polls the Almadel server and runs tickets"
)]
pub struct Cli {
    /// Almadel server base URL
    #[arg(long, env = "ALMADEL_SERVER")]
    pub server: Option<String>,

    /// Project name or id
    #[arg(long, env = "ALMADEL_PROJECT")]
    pub project: Option<String>,

    /// Upsert key + commit identity suffix
    #[arg(long, env = "ALMADEL_LABEL")]
    pub label: Option<String>,

    /// Base dir for ephemeral clones
    #[arg(long, env = "ALMADEL_WORKSPACE")]
    pub workspace: Option<PathBuf>,

    /// Command used to run opencode (spawned through a shell; defaults to `opencode`)
    #[arg(long, env = "OPENCODE_BIN")]
    pub opencode: Option<String>,

    /// Extra args passed to `opencode run` (space-separated)
    #[arg(long, env = "OPENCODE_ARGS")]
    pub opencode_args: Option<String>,
}

/// Fully resolved configuration.
///
/// Never contains secrets; the agent token does not exist in Phase 0 and, once
/// it does, must be kept out of this struct so `Debug` can never leak it.
#[derive(Debug, Clone)]
pub struct Config {
    pub server: String,
    pub project: String,
    pub label: String,
    pub workspace: PathBuf,
    pub opencode_bin: String,
    pub opencode_args: Vec<String>,
    pub verbose: bool,
}

impl Config {
    /// Resolve a parsed CLI (already filled from env by clap) plus the env
    /// source into a concrete [`Config`].
    pub fn resolve(cli: Cli, env: &dyn Env) -> Result<Config, ConfigError> {
        let server = cli
            .server
            .or_else(|| env.var("ALMADEL_SERVER"))
            .filter(|s| !s.trim().is_empty())
            .ok_or(ConfigError::Missing("server", "server", "ALMADEL_SERVER"))?;

        let project = cli
            .project
            .or_else(|| env.var("ALMADEL_PROJECT"))
            .filter(|s| !s.trim().is_empty())
            .ok_or(ConfigError::Missing(
                "project",
                "project",
                "ALMADEL_PROJECT",
            ))?;

        let label = cli
            .label
            .or_else(|| env.var("ALMADEL_LABEL"))
            .or_else(|| env.var("HOSTNAME"))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "default".to_string());

        let workspace = cli
            .workspace
            .or_else(|| env.var("ALMADEL_WORKSPACE").map(PathBuf::from))
            .unwrap_or_else(|| default_workspace(env));

        let opencode_bin = cli
            .opencode
            .or_else(|| env.var("OPENCODE_BIN"))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "opencode".to_string());

        let opencode_args = cli
            .opencode_args
            .or_else(|| env.var("OPENCODE_ARGS"))
            .map(|s| s.split_whitespace().map(String::from).collect())
            .unwrap_or_default();

        let verbose = env
            .var("ALMADEL_VERBOSE")
            .map(|v| matches!(v.trim(), "1" | "true" | "True" | "TRUE"))
            .unwrap_or(false);

        Ok(Config {
            server,
            project,
            label,
            workspace,
            opencode_bin,
            opencode_args,
            verbose,
        })
    }
}

/// Default workspace: `$HOME/.alimiel/`, falling back to `.` when HOME is unset.
fn default_workspace(env: &dyn Env) -> PathBuf {
    match env.var_os("HOME") {
        Some(home) => PathBuf::from(home).join(".alimiel"),
        None => PathBuf::from("."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct TestEnv(HashMap<String, String>);

    impl TestEnv {
        fn new(pairs: &[(&str, &str)]) -> Self {
            Self(
                pairs
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            )
        }

        fn empty() -> Self {
            Self(HashMap::new())
        }
    }

    impl Env for TestEnv {
        fn var(&self, key: &str) -> Option<String> {
            self.0.get(key).cloned()
        }

        fn var_os(&self, key: &str) -> Option<OsString> {
            self.0.get(key).map(OsString::from)
        }
    }

    fn empty_cli() -> Cli {
        Cli {
            server: None,
            project: None,
            label: None,
            workspace: None,
            opencode: None,
            opencode_args: None,
        }
    }

    #[test]
    fn requires_server_and_project() {
        let err = Config::resolve(empty_cli(), &TestEnv::empty()).unwrap_err();
        assert!(matches!(err, ConfigError::Missing("server", ..)));

        let env = TestEnv::new(&[("ALMADEL_SERVER", "http://x")]);
        let err = Config::resolve(empty_cli(), &env).unwrap_err();
        assert!(matches!(err, ConfigError::Missing("project", ..)));
    }

    #[test]
    fn resolves_from_env() {
        let env = TestEnv::new(&[
            ("ALMADEL_SERVER", "http://127.0.0.1:8787"),
            ("ALMADEL_PROJECT", "almadel-api"),
        ]);
        let cfg = Config::resolve(empty_cli(), &env).unwrap();
        assert_eq!(cfg.server, "http://127.0.0.1:8787");
        assert_eq!(cfg.project, "almadel-api");
    }

    #[test]
    fn cli_overrides_env() {
        let env = TestEnv::new(&[
            ("ALMADEL_SERVER", "http://env"),
            ("ALMADEL_PROJECT", "env-project"),
            ("ALMADEL_LABEL", "env-label"),
        ]);
        let cli = Cli {
            server: Some("http://cli".to_string()),
            project: Some("cli-project".to_string()),
            ..empty_cli()
        };
        let cfg = Config::resolve(cli, &env).unwrap();
        assert_eq!(cfg.server, "http://cli");
        assert_eq!(cfg.project, "cli-project");
        assert_eq!(cfg.label, "env-label");
    }

    #[test]
    fn label_defaults_to_hostname_then_default() {
        let env = TestEnv::new(&[
            ("ALMADEL_SERVER", "http://x"),
            ("ALMADEL_PROJECT", "p"),
            ("HOSTNAME", "my-host"),
        ]);
        assert_eq!(Config::resolve(empty_cli(), &env).unwrap().label, "my-host");

        let env = TestEnv::new(&[
            ("ALMADEL_SERVER", "http://x"),
            ("ALMADEL_PROJECT", "p"),
            ("ALMADEL_LABEL", "laptop"),
            ("HOSTNAME", "my-host"),
        ]);
        assert_eq!(Config::resolve(empty_cli(), &env).unwrap().label, "laptop");

        let env = TestEnv::new(&[("ALMADEL_SERVER", "http://x"), ("ALMADEL_PROJECT", "p")]);
        assert_eq!(Config::resolve(empty_cli(), &env).unwrap().label, "default");
    }

    #[test]
    fn verbose_parsing() {
        let base = &[("ALMADEL_SERVER", "http://x"), ("ALMADEL_PROJECT", "p")];

        let mut env = TestEnv::new(base);
        env.0.insert("ALMADEL_VERBOSE".into(), "1".into());
        assert!(Config::resolve(empty_cli(), &env).unwrap().verbose);

        let mut env = TestEnv::new(base);
        env.0.insert("ALMADEL_VERBOSE".into(), "true".into());
        assert!(Config::resolve(empty_cli(), &env).unwrap().verbose);

        let mut env = TestEnv::new(base);
        env.0.insert("ALMADEL_VERBOSE".into(), "0".into());
        assert!(!Config::resolve(empty_cli(), &env).unwrap().verbose);

        assert!(
            !Config::resolve(empty_cli(), &TestEnv::new(base))
                .unwrap()
                .verbose
        );
    }

    #[test]
    fn workspace_defaults_to_home_then_dot() {
        let env = TestEnv::new(&[
            ("ALMADEL_SERVER", "http://x"),
            ("ALMADEL_PROJECT", "p"),
            ("HOME", "/home/me"),
        ]);
        assert_eq!(
            Config::resolve(empty_cli(), &env).unwrap().workspace,
            PathBuf::from("/home/me/.alimiel")
        );

        let env = TestEnv::new(&[("ALMADEL_SERVER", "http://x"), ("ALMADEL_PROJECT", "p")]);
        assert_eq!(
            Config::resolve(empty_cli(), &env).unwrap().workspace,
            PathBuf::from(".")
        );
    }

    #[test]
    fn opencode_defaults_and_override() {
        let env = TestEnv::new(&[("ALMADEL_SERVER", "http://x"), ("ALMADEL_PROJECT", "p")]);
        assert_eq!(
            Config::resolve(empty_cli(), &env).unwrap().opencode_bin,
            "opencode"
        );
        assert!(
            Config::resolve(empty_cli(), &env)
                .unwrap()
                .opencode_args
                .is_empty()
        );

        let env = TestEnv::new(&[
            ("ALMADEL_SERVER", "http://x"),
            ("ALMADEL_PROJECT", "p"),
            ("OPENCODE_BIN", "/usr/local/bin/opencode"),
            ("OPENCODE_ARGS", "--auto --yolo"),
        ]);
        let cfg = Config::resolve(empty_cli(), &env).unwrap();
        assert_eq!(cfg.opencode_bin, "/usr/local/bin/opencode");
        assert_eq!(
            cfg.opencode_args,
            vec!["--auto".to_string(), "--yolo".to_string()]
        );
    }
}
