import { spawnSync } from "node:child_process";
import { AlmadelError } from "./http.ts";

export interface AlmadelConfig {
  serverUrl: string;
  project: string;
  repoRoot: string;
  defaultBranch: string;
  gitRemote: string | null;
  label: string;
  opencodeVersion: string;
  token: string | null;
}

function run(cmd: string, args: string[], cwd: string): string | null {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) return null;
  return res.stdout?.trim() || null;
}

/**
 * Derives configuration from environment + the slot directory.
 *
 * The project is NEVER inferred from the git remote. It must be supplied via
 * ALMADEL_JOIN (env) or the interactive `/almadel join` command. Enlistment is
 * per-process and never persisted to disk.
 *
 * The worker does not fetch or interrogate the git remote. The slot directory
 * is the repository; if a specific remote must be fetched, the ticket prompt
 * tells the agent to do it.
 */
export function loadConfig(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): AlmadelConfig {
  const serverUrl = env.ALMADEL_SERVER ?? "";
  const project = env.ALMADEL_JOIN ?? "";
  const token = env.ALMADEL_TOKEN ?? null;

  const defaultBranch =
    run("git", ["symbolic-ref", "--short", "HEAD"], directory) ?? "main";

  // Push URL only: the remote is reported to the server for the mismatch check
  // and surfaced to the agent so it can push its branch / open a PR. The project
  // identity is NEVER inferred from it.
  const gitRemote =
    run("git", ["config", "--get", "remote.origin.pushurl"], directory) ??
    run("git", ["config", "--get", "remote.origin.url"], directory);

  const label = env.ALMADEL_LABEL ?? env.HOSTNAME ?? "default";
  const opencodeVersion = env.OPENCODE_VERSION ?? "0.0.0";

  return {
    serverUrl,
    project,
    repoRoot: directory,
    defaultBranch,
    gitRemote,
    label,
    opencodeVersion,
    token,
  };
}

/** True when both ALMADEL_JOIN and ALMADEL_TOKEN are present (headless enlist). */
export function hasEnvEnlistment(cfg: AlmadelConfig): boolean {
  return cfg.project !== "" && cfg.token !== null;
}

/** Resolve a project name to its id via the server. */
export async function resolveProjectId(
  projects: { id: string; name: string }[],
  ref: string,
): Promise<string> {
  const byId = projects.find((p) => p.id === ref);
  if (byId) return byId.id;
  const byName = projects.find((p) => p.name === ref);
  if (byName) return byName.id;
  throw new AlmadelError(
    `unknown project '${ref}' (known: ${projects.map((p) => `${p.name}:${p.id}`).join(", ")})`,
    404,
  );
}

export type { AlmadelConfig as Config };
