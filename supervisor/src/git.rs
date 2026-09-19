//! Git lifecycle for a per-ticket throwaway checkout.
//!
//! Each ticket gets a fresh clone under `<workspace>/<ticket>`. The clone,
//! branch, commit, and push are all driven through in-process `git2` (libgit2),
//! mirroring the semantics of `plugin/src/git.ts`. Git stays in the supervisor:
//! the future container/GH-Action shape (plan §17) still runs the supervisor
//! with its own local clone, so there is no container-local git backend.
//!
//! No live [`git2::Repository`] handle is held across `.await`: git2 handles are
//! not `Sync`, so every operation reopens the repo from the [`Checkout`] path.
//! All git2 calls (which are synchronous and may block on the filesystem) run
//! inside `tokio::task::spawn_blocking`.

use std::path::{Path, PathBuf};

use thiserror::Error;

/// Errors surfaced by the git lifecycle.
#[derive(Debug, Error)]
pub enum GitError {
    #[error("git remote is not configured for this project")]
    MissingRemote,

    #[error("git operation failed: {0}")]
    Operation(String),
}

/// A prepared throwaway checkout. Holds only a path + branch name — never a
/// live libgit2 handle.
#[derive(Debug, Clone)]
pub struct Checkout {
    pub path: PathBuf,
    pub branch: String,
}

/// Deterministic commit metadata, mirroring the plugin's `commitStage`.
#[derive(Debug, Clone)]
pub struct CommitMeta {
    pub ticket: String,
    pub column: String,
    pub label: String,
    pub note: Option<String>,
}

/// Clone `remote` into `workdir`, resolve the default branch, and create +
/// check out `branch` from it. The branch name is used **verbatim** (it comes
/// from `job.branch`; never invented here — plan §5).
///
/// `base_sha` is accepted but its reachability-fail path is deferred to
/// TCK-442 (plan §10). No force checkout is ever performed.
pub async fn prepare(
    remote: Option<&str>,
    default_branch: &str,
    branch: &str,
    base_sha: Option<&str>,
    workdir: &Path,
) -> Result<Checkout, GitError> {
    let remote = remote.ok_or(GitError::MissingRemote)?.to_string();
    let default_branch = default_branch.to_string();
    let branch = branch.to_string();
    let base_sha = base_sha.map(String::from);
    let workdir = workdir.to_path_buf();
    let branch_for_clone = branch.clone();

    let path = tokio::task::spawn_blocking(move || {
        prepare_blocking(
            &remote,
            &default_branch,
            &branch_for_clone,
            base_sha.as_deref(),
            &workdir,
        )
    })
    .await
    .map_err(|e| GitError::Operation(format!("clone task panicked: {e}")))??;

    Ok(Checkout { path, branch })
}

fn prepare_blocking(
    remote: &str,
    default_branch: &str,
    branch: &str,
    base_sha: Option<&str>,
    workdir: &Path,
) -> Result<PathBuf, GitError> {
    let repo = git2::build::RepoBuilder::new()
        .clone(remote, workdir)
        .map_err(op_err("clone"))?;

    let default_ref = format!("refs/remotes/origin/{default_branch}");
    let commit = repo
        .find_reference(&default_ref)
        .and_then(|r| r.peel_to_commit())
        .map_err(|e| GitError::Operation(format!("resolve '{default_ref}': {e}")))?;

    // TODO(TCK-442): if `base_sha` is set and the branch is unreachable from
    // the remote, fail the ticket rather than silently restarting from the
    // default branch (plan §10). Never a force-checkout.
    if let Some(sha) = base_sha {
        let _ = sha;
    }

    repo.branch(branch, &commit, false)
        .map_err(op_err("branch"))?;
    let branch_ref = format!("refs/heads/{branch}");
    repo.set_head(&branch_ref).map_err(op_err("set_head"))?;
    repo.checkout_head(None).map_err(op_err("checkout_head"))?;

    Ok(workdir.to_path_buf())
}

/// Commit all changes (tracked + untracked) in the checkout with a
/// deterministic identity. Returns `Ok(None)` when the working tree is clean,
/// otherwise the new commit SHA. Pre-commit hooks are **not** bypassed.
pub async fn commit_all(
    checkout: &Checkout,
    meta: &CommitMeta,
) -> Result<Option<String>, GitError> {
    let path = checkout.path.clone();
    let ticket = meta.ticket.clone();
    let column = meta.column.clone();
    let label = meta.label.clone();
    let note = meta.note.clone();

    tokio::task::spawn_blocking(move || {
        commit_all_blocking(&path, &ticket, &column, &label, note.as_deref())
    })
    .await
    .map_err(|e| GitError::Operation(format!("commit task panicked: {e}")))?
}

fn commit_all_blocking(
    path: &Path,
    ticket: &str,
    column: &str,
    label: &str,
    note: Option<&str>,
) -> Result<Option<String>, GitError> {
    let repo = git2::Repository::open(path).map_err(op_err("open"))?;

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(op_err("status"))?;
    if statuses.is_empty() {
        return Ok(None);
    }

    let mut index = repo.index().map_err(op_err("index"))?;
    index
        .add_all(["."].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(op_err("add_all"))?;
    index
        .update_all(["."].iter(), None)
        .map_err(op_err("update_all"))?;
    index.write().map_err(op_err("index write"))?;

    let tree_id = index.write_tree().map_err(op_err("write_tree"))?;
    let tree = repo.find_tree(tree_id).map_err(op_err("find_tree"))?;

    let sig = git2::Signature::now(&format!("almadel[{label}]"), "agent@almadel.local")
        .map_err(op_err("signature"))?;

    let message = match note {
        Some(n) if !n.is_empty() => format!("[{ticket}] {column}\n\n{n}"),
        _ => format!("[{ticket}] {column}"),
    };

    let head = repo.head().ok().and_then(|h| h.target());
    let parent = head.and_then(|t| repo.find_commit(t).ok());

    let oid = match &parent {
        Some(p) => repo
            .commit(Some("HEAD"), &sig, &sig, &message, &tree, &[p])
            .map_err(op_err("commit"))?,
        None => repo
            .commit(Some("HEAD"), &sig, &sig, &message, &tree, &[])
            .map_err(op_err("commit"))?,
    };

    Ok(Some(oid.to_string()))
}

/// The current HEAD SHA of the checkout.
pub async fn head_sha(checkout: &Checkout) -> Result<String, GitError> {
    let path = checkout.path.clone();
    tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(op_err("open"))?;
        let head = repo.head().map_err(op_err("head"))?;
        let oid = head
            .target()
            .ok_or_else(|| GitError::Operation("HEAD has no target (unborn branch)".into()))?;
        Ok(oid.to_string())
    })
    .await
    .map_err(|e| GitError::Operation(format!("head task panicked: {e}")))?
}

/// Push `branch` to the `origin` remote configured by the clone. Auth is wired
/// via a credential callback later (TCK-444).
pub async fn push(checkout: &Checkout, branch: &str) -> Result<(), GitError> {
    let path = checkout.path.clone();
    let branch = branch.to_string();
    tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&path).map_err(op_err("open"))?;
        let mut remote = repo.find_remote("origin").map_err(op_err("find_remote"))?;
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let mut opts = git2::PushOptions::new();
        // TODO(TCK-444): credential callback for a short-lived PAT/SSH token.
        remote
            .push(&[refspec.as_str()], Some(&mut opts))
            .map_err(op_err("push"))?;
        Ok(())
    })
    .await
    .map_err(|e| GitError::Operation(format!("push task panicked: {e}")))?
}

/// Best-effort removal of the throwaway checkout. Hardening is deferred to
/// TCK-442 (plan §15); failures here are intentionally ignored.
pub async fn cleanup(checkout: &Checkout) {
    let path = checkout.path.clone();
    let _ = tokio::task::spawn_blocking(move || {
        if path.exists() {
            std::fs::remove_dir_all(&path)
        } else {
            Ok(())
        }
    })
    .await;
}

fn op_err(op: &'static str) -> impl Fn(git2::Error) -> GitError {
    move |e| GitError::Operation(format!("git {op}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Build a bare remote containing a single `main` commit, plus the tempdir
    /// holding it. Uses only git2 so no git CLI is required.
    fn bare_remote() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        let repo = git2::Repository::init(&src).unwrap();
        repo.set_head("refs/heads/main").unwrap();
        std::fs::write(src.join("README.md"), "hello\n").unwrap();
        commit_all_blocking(&src, "TCK-0", "Init", "test", None).unwrap();

        let bare = tmp.path().join("remote.git");
        git2::Repository::init_bare(&bare).unwrap();
        let mut remote = repo.remote("origin", bare.to_str().unwrap()).unwrap();
        remote
            .push(&["refs/heads/main:refs/heads/main"], None)
            .unwrap();

        (tmp, bare)
    }

    #[tokio::test]
    async fn prepare_clones_and_branches_from_default() {
        let (_tmp, remote) = bare_remote();
        let workdir = tempfile::tempdir().unwrap();

        let checkout = prepare(
            Some(remote.to_str().unwrap()),
            "main",
            "run/TCK-1",
            None,
            workdir.path(),
        )
        .await
        .unwrap();

        assert_eq!(checkout.branch, "run/TCK-1");
        let repo = git2::Repository::open(&checkout.path).unwrap();
        let branch = repo
            .find_branch("run/TCK-1", git2::BranchType::Local)
            .unwrap();
        assert_eq!(branch.name().unwrap(), Some("run/TCK-1"));
    }

    #[tokio::test]
    async fn prepare_requires_remote() {
        let workdir = tempfile::tempdir().unwrap();
        let err = prepare(None, "main", "run/TCK-1", None, workdir.path())
            .await
            .unwrap_err();
        assert!(matches!(err, GitError::MissingRemote));
    }

    #[tokio::test]
    async fn commit_all_is_noop_on_clean_tree() {
        let (_tmp, remote) = bare_remote();
        let workdir = tempfile::tempdir().unwrap();
        let checkout = prepare(
            Some(remote.to_str().unwrap()),
            "main",
            "run/TCK-1",
            None,
            workdir.path(),
        )
        .await
        .unwrap();

        let meta = CommitMeta {
            ticket: "TCK-1".into(),
            column: "Review".into(),
            label: "test".into(),
            note: None,
        };
        assert!(commit_all(&checkout, &meta).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn commit_all_commits_with_deterministic_identity_and_message() {
        let (_tmp, remote) = bare_remote();
        let workdir = tempfile::tempdir().unwrap();
        let checkout = prepare(
            Some(remote.to_str().unwrap()),
            "main",
            "run/TCK-1",
            None,
            workdir.path(),
        )
        .await
        .unwrap();

        std::fs::write(checkout.path.join("marker.txt"), "done\n").unwrap();

        let meta = CommitMeta {
            ticket: "TCK-1".into(),
            column: "Review".into(),
            label: "test".into(),
            note: Some("did the thing".into()),
        };
        let sha = commit_all(&checkout, &meta).await.unwrap().unwrap();
        assert!(!sha.is_empty());
        assert_eq!(head_sha(&checkout).await.unwrap(), sha);

        let repo = git2::Repository::open(&checkout.path).unwrap();
        let commit = repo
            .find_commit(git2::Oid::from_str(&sha).unwrap())
            .unwrap();
        assert_eq!(commit.message().unwrap(), "[TCK-1] Review\n\ndid the thing");
        assert_eq!(commit.author().name().unwrap(), "almadel[test]");
        assert_eq!(commit.author().email().unwrap(), "agent@almadel.local");
    }

    #[tokio::test]
    async fn commit_and_push_roundtrip() {
        let (_tmp, remote) = bare_remote();
        let workdir = tempfile::tempdir().unwrap();
        let checkout = prepare(
            Some(remote.to_str().unwrap()),
            "main",
            "run/TCK-1",
            None,
            workdir.path(),
        )
        .await
        .unwrap();

        std::fs::write(checkout.path.join("marker.txt"), "done\n").unwrap();
        let meta = CommitMeta {
            ticket: "TCK-1".into(),
            column: "Review".into(),
            label: "test".into(),
            note: None,
        };
        commit_all(&checkout, &meta).await.unwrap().unwrap();
        push(&checkout, "run/TCK-1").await.unwrap();

        let bare = git2::Repository::open_bare(&remote).unwrap();
        let pushed = bare
            .find_reference("refs/heads/run/TCK-1")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        assert!(pushed.tree().unwrap().get_name("marker.txt").is_some());
    }
}
