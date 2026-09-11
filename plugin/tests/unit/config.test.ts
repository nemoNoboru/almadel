import { describe, expect, test } from "bun:test";
import { loadConfig, hasEnvEnlistment, resolveProjectId } from "../../src/config.ts";
import { AlmadelError } from "../../src/http.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("loadConfig", () => {
  test("project is NEVER inferred from git remote", () => {
    const cfg = loadConfig("/some/dir", {
      ALMADEL_SERVER: "http://srv",
      ALMADEL_JOIN: "",
    });
    expect(cfg.project).toBe("");
  });

  test("headless enlistment requires both join and token", () => {
    const cfg = loadConfig("/d", {
      ALMADEL_SERVER: "http://srv",
      ALMADEL_JOIN: "p",
    });
    expect(hasEnvEnlistment(cfg)).toBe(false);

    const cfg2 = loadConfig("/d", {
      ALMADEL_SERVER: "http://srv",
      ALMADEL_JOIN: "p",
      ALMADEL_TOKEN: "tok",
    });
    expect(hasEnvEnlistment(cfg2)).toBe(true);
  });

  test("label defaults deterministically", () => {
    const cfg = loadConfig("/d", { HOSTNAME: "myhost" });
    expect(cfg.label).toBe("myhost");
  });

  test("derives git_remote from the origin remote (pushurl preferred)", () => {
    const dir = mkdtempSync(join(tmpdir(), "almadel-cfg-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync("git", ["remote", "add", "origin", "git@github.com:me/api.git"], { cwd: dir });
      const cfg = loadConfig(dir, {});
      expect(cfg.gitRemote).toBe("git@github.com:me/api.git");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git_remote is null when there is no origin", () => {
    const cfg = loadConfig("/some/dir", { ALMADEL_SERVER: "http://srv" });
    expect(cfg.gitRemote).toBeNull();
  });
});

describe("resolveProjectId", () => {
  test("resolves by id first, then name", async () => {
    const projects = [
      { id: "id1", name: "Project One" },
      { id: "id2", name: "Project Two" },
    ];
    expect(await resolveProjectId(projects, "id2")).toBe("id2");
    expect(await resolveProjectId(projects, "Project One")).toBe("id1");
  });

  test("throws on unknown", async () => {
    await expect(resolveProjectId([{ id: "id1", name: "One" }], "nope")).rejects.toThrow(
      AlmadelError,
    );
  });
});
