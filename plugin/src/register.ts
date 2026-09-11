import type { AlmadelClient } from "./http.ts";
import type { AlmadelConfig } from "./config.ts";
import type { RegistrationResult } from "./types.ts";

/**
 * Registers (or re-registers) this slot with the server. The server upserts on
 * (project_id, repo_root, label), so re-join yields a fresh id + token.
 */
export async function registerAgent(
  client: AlmadelClient,
  cfg: AlmadelConfig,
): Promise<RegistrationResult> {
  const result = await client.register({
    project: cfg.project,
    repo_root: cfg.repoRoot,
    git_remote: cfg.gitRemote ?? undefined,
    default_branch: cfg.defaultBranch,
    label: cfg.label,
    opencode_version: cfg.opencodeVersion,
    capabilities: {
      tools: true,
      permission_hook: true,
    },
  });
  client.setAuth(result.token, result.agent_id);
  return result;
}
