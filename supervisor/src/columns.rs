//! Column resolution (next / fail) for the task lifecycle.
//!
//! Resolves a ticket's outgoing column by fetching the project's column list
//! (`GET /api/projects/{id}/columns`) and the ticket's current column (via the
//! board), then mapping `next_column` / `fail_column` *names* back to column
//! ids (plan §12). Columns are re-fetched per task so board edits made in the
//! UI between tickets take effect without a restart.

use std::collections::HashMap;

use crate::client::{Client, ClientError, Column, Project};

/// Which outgoing column to resolve for a ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// The success column named by `next_column`.
    Next,
    /// The failure column named by `fail_column`.
    Fail,
}

/// Resolve the outgoing column for `ticket_id` against the live server.
///
/// Fetches the project's columns and the ticket's current column, then defers
/// to [`resolve_in`]. Returns `Ok(None)` when the ticket or its column cannot
/// be found, or when `next_column` is absent (the column is terminal).
pub async fn resolve(
    client: &Client,
    project: &Project,
    ticket_id: &str,
    target: Target,
) -> Result<Option<(String, String)>, ClientError> {
    let columns = client.get_columns(&project.id).await?;
    let board = client.get_board(&project.id).await?;
    let current = match board.tickets.iter().find(|t| t.id == ticket_id) {
        Some(t) => t.column_id.as_str(),
        None => return Ok(None),
    };
    Ok(resolve_in(&columns, current, target))
}

/// Pure resolution over an already-fetched column list (unit-testable).
///
/// `current_column_id` is the id of the column the ticket currently sits in.
///
/// * [`Target::Next`]: maps `current.next_column` (a name) to its id; `None`
///   when absent, i.e. the column is terminal (plan §12).
/// * [`Target::Fail`]: maps `current.fail_column` to its id; when absent, falls
///   back to the current column id so the ticket is never left held.
pub fn resolve_in(
    columns: &[Column],
    current_column_id: &str,
    target: Target,
) -> Option<(String, String)> {
    let current = columns.iter().find(|c| c.id == current_column_id)?;
    let by_name: HashMap<&str, &Column> = columns.iter().map(|c| (c.name.as_str(), c)).collect();

    let name = match target {
        Target::Next => current.next_column.as_deref()?,
        Target::Fail => match current.fail_column.as_deref() {
            Some(name) => name,
            None => return Some((current.id.clone(), current.name.clone())),
        },
    };

    let resolved = by_name.get(name)?;
    Some((resolved.id.clone(), resolved.name.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::Column;

    fn col(id: &str, name: &str, next: Option<&str>, fail: Option<&str>) -> Column {
        Column {
            id: id.into(),
            project_id: "p".into(),
            name: name.into(),
            position: 0,
            prompt: None,
            model: None,
            next_column: next.map(String::from),
            fail_column: fail.map(String::from),
            wip_limit: None,
        }
    }

    fn columns() -> Vec<Column> {
        vec![
            col("col-planning", "Planning", Some("Review"), Some("Failed")),
            col("col-review", "Review", Some("Implement"), None),
            col("col-failed", "Failed", None, None),
        ]
    }

    #[test]
    fn resolves_next_column_by_name() {
        let cols = columns();
        assert_eq!(
            resolve_in(&cols, "col-planning", Target::Next),
            Some(("col-review".to_string(), "Review".to_string()))
        );
    }

    #[test]
    fn resolves_fail_column_by_name() {
        let cols = columns();
        assert_eq!(
            resolve_in(&cols, "col-planning", Target::Fail),
            Some(("col-failed".to_string(), "Failed".to_string()))
        );
    }

    #[test]
    fn fail_without_fail_column_falls_back_to_current() {
        let cols = columns();
        assert_eq!(
            resolve_in(&cols, "col-review", Target::Fail),
            Some(("col-review".to_string(), "Review".to_string()))
        );
    }

    #[test]
    fn next_without_next_column_is_terminal() {
        let cols = columns();
        assert_eq!(resolve_in(&cols, "col-failed", Target::Next), None);
    }

    #[test]
    fn unknown_column_returns_none() {
        let cols = columns();
        assert_eq!(resolve_in(&cols, "col-missing", Target::Next), None);
        assert_eq!(resolve_in(&cols, "col-missing", Target::Fail), None);
    }

    #[test]
    fn dangling_fail_name_returns_none() {
        let cols = vec![col("col-a", "A", Some("B"), Some("Nope"))];
        assert_eq!(resolve_in(&cols, "col-a", Target::Fail), None);
    }
}
