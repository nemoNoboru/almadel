import type { AlmadelClient } from "./http.ts";
import type { AlmadelState, PendingPermission } from "./state.ts";
import type { PermissionRequest } from "./types.ts";

/** Never escalate read-only checks — they don't touch the outside world. */
const READ_ONLY_PERMISSIONS = new Set([
  "read",
  "glob",
  "grep",
  "bash:read",
]);

/**
 * Destructive git subcommands that must never reach a human for approval — a
 * rubber-stamp of `git reset --hard` can destroy a stage. `req.permission`
 * carries the raw command string for bash permissions (no `tool` field), which
 * is exactly what the tool/command ternary below distinguishes. Guardrail, not
 * a sandbox: shell quoting defeats a regex, but it stops the common accident.
 */
const FORBIDDEN_GIT = /\bgit\s+(checkout|switch|reset|rebase|stash|worktree)\b/;

/**
 * Decides a permission request.
 *
 * 1. read-only -> allow (never escalates)
 * 2. otherwise -> forward to server via /permission-request (blocks server-side
 *    until a human decides or timeout) and reply with the mapped decision.
 *
 * Returns the reply to send back to opencode, or null if the decision was
 * already resolved elsewhere (e.g. timeout is handled as reject).
 */
export async function decidePermission(
  client: AlmadelClient,
  state: AlmadelState,
  req: PermissionRequest,
): Promise<{ response: "once" | "always" | "reject" }> {
  // Hard-deny tier above the read-only check: destructive git commands are
  // never forwarded to a human for approval.
  if (!req.tool && FORBIDDEN_GIT.test(req.permission)) {
    return { response: "reject" };
  }

  if (READ_ONLY_PERMISSIONS.has(req.permission)) {
    return { response: "always" };
  }

  const ticket = state.currentTicket;
  if (!ticket) {
    // No ticket held: safest default is to reject.
    return { response: "reject" };
  }

  const result = await client.requestPermission(ticket, {
    tool: req.tool ? req.permission : undefined,
    command: req.tool ? undefined : req.permission,
  });

  if ("timeout" in result && result.timeout) {
    return { response: "reject" };
  }
  if (result.decision === "deny") {
    return { response: "reject" };
  }
  // allow
  if (result.scope === "once") return { response: "once" };
  return { response: "always" };
}

/** Registers a pending permission so the reply job can resolve it. */
export function parkPermission(
  state: AlmadelState,
  req: PermissionRequest,
): PendingPermission {
  const pending: PendingPermission = {
    sessionID: req.sessionID,
    permissionID: req.id,
    ticket: state.currentTicket ?? "",
    resolve: () => {},
  };
  state.pendingPermissions.set(req.id, pending);
  return pending;
}

export function resolvePermission(state: AlmadelState, permissionID: string) {
  const pending = state.pendingPermissions.get(permissionID);
  if (!pending) return false;
  state.pendingPermissions.delete(permissionID);
  return pending;
}
