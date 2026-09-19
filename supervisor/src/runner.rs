//! opencode subprocess runner.
//!
//! Spawns `opencode run [--model <model>] <args> <prompt>` in the ticket's
//! workdir and captures stdout, stderr, and the exit code. opencode is invoked
//! non-interactively; its exit code decides the ticket outcome (plan §11).

use std::path::Path;

use thiserror::Error;
use tracing::debug;

/// Errors surfaced when running opencode.
#[derive(Debug, Error)]
pub enum RunnerError {
    /// The process could not be spawned at all.
    #[error("could not run opencode: {0}")]
    Spawn(#[from] std::io::Error),

    /// The process ran but exited non-zero (surfaced for API completeness; the
    /// caller branches on [`RunOutput::exit_code`] instead).
    #[error("opencode exited with {code}")]
    NonZero { code: i32, stderr_tail: String },
}

/// The captured output of a single `opencode run` invocation.
#[derive(Debug)]
pub struct RunOutput {
    pub stdout: String,
    pub stderr: String,
    /// Process exit code, or `-1` when killed by a signal.
    pub exit_code: i32,
}

/// Run opencode in `workdir`, capturing stdout + stderr + exit code.
///
/// `model` is passed through as `--model <model>` only when present. `args` are
/// the user-configured extra flags from `OPENCODE_ARGS`, inserted before the
/// prompt.
pub async fn run(
    bin: &str,
    args: &[String],
    model: Option<&str>,
    prompt: &str,
    workdir: &Path,
) -> Result<RunOutput, RunnerError> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("run");
    if let Some(model) = model {
        cmd.arg("--model").arg(model);
    }
    cmd.args(args);
    cmd.arg(prompt);
    cmd.current_dir(workdir);
    cmd.stdin(std::process::Stdio::null());

    debug!(bin = %bin, "spawning opencode");

    let output = cmd.output().await?;
    let exit_code = output.status.code().unwrap_or(-1);

    Ok(RunOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code,
    })
}

/// The last `max_chars` of `stderr`, trimmed, for use in a failure comment.
pub fn stderr_tail(stderr: &str, max_chars: usize) -> String {
    let trimmed = stderr.trim();
    if trimmed.len() <= max_chars {
        trimmed.to_string()
    } else {
        let mut cut = max_chars;
        while !trimmed.is_char_boundary(trimmed.len() - cut) {
            cut -= 1;
        }
        format!("…{}", &trimmed[trimmed.len() - cut..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captures_exit_code_and_streams() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-opencode");
        std::fs::write(
            &script,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"opencode 1.18.30\"; exit 0; fi\necho out-marker\necho err-marker 1>&2\nexit 7\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }

        let out = run(script.to_str().unwrap(), &[], None, "hello", dir.path())
            .await
            .unwrap();

        assert_eq!(out.exit_code, 7);
        assert!(out.stdout.contains("out-marker"));
        assert!(out.stderr.contains("err-marker"));
    }

    #[tokio::test]
    async fn passes_model_flag_through() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-opencode");
        std::fs::write(
            &script,
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"opencode 1.18.30\"; exit 0; fi\nfor a in \"$@\"; do echo \"$a\"; done\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).unwrap();
        }

        let out = run(
            script.to_str().unwrap(),
            &["--auto".to_string()],
            Some("provider/model"),
            "hello",
            dir.path(),
        )
        .await
        .unwrap();

        assert_eq!(out.exit_code, 0);
        let args: Vec<&str> = out.stdout.lines().collect();
        assert!(args.contains(&"run"));
        assert!(args.contains(&"--model"));
        assert!(args.contains(&"provider/model"));
        assert!(args.contains(&"--auto"));
        assert_eq!(args.last(), Some(&"hello"));
    }

    #[tokio::test]
    async fn spawn_failure_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = run(
            dir.path().join("does-not-exist").to_str().unwrap(),
            &[],
            None,
            "hello",
            dir.path(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, RunnerError::Spawn(_)));
    }

    #[test]
    fn tail_truncates_long_stderr() {
        let long = "x".repeat(10);
        assert_eq!(stderr_tail(&long, 4), "…xxxx");
        assert_eq!(stderr_tail("short", 100), "short");
        assert_eq!(stderr_tail("  padded  ", 100), "padded");
    }
}
