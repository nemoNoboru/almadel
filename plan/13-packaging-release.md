# 13 — Packaging & Release

How `almadel` (the server package) gets built, bundled, and distributed. This doc
supersedes the "Phase 5 — Packaging" sketch in `11-build-order.md` with the concrete
split between what is done now and what is deferred to a GitHub Actions release
workflow.

## Status: what's already in place

| Concern | State |
|---|---|
| `private: true` | **Intentionally kept.** The package is not published to npm. |
| CLI | `almadel serve` (and `almadel init`); `bin.almadel` → `src/cli.ts`. |
| UI bundling | `scripts/build-ui.ts` copies `web/dist` → `server/ui`. |
| UI discovery | `config.ts` `defaultStaticDir()` probes `../ui` (bundled) in addition to the dev-layout `web/dist` paths. |
| Publish whitelist | `files: ["src", "ui"]`. |
| Metadata | `license: MIT`, `engines.bun >= 1.1`, `description`. `repository` left blank until the repo exists. |

## Deferred to GitHub Actions (release workflow)

The workflow (`.github/workflows/release.yml`, triggered on a version tag like
`v0.1.0`) does the three steps that don't belong in the committed tree:

1. **Build the web app.** `web/` runs `bun install` + `bun run build`
   (`tsc -b && vite build`) to produce `web/dist`.
2. **Bundle the UI into the server.** `server/` runs `bun run build:ui`, copying
   `web/dist` → `server/ui` so the server ships its own frontend.
3. **Compile the CLI.** `bun build src/cli.ts --target bun --outdir dist`, then point
   `bin.almadel` at `dist/cli.js` (shebang `#!/usr/bin/env bun`) and switch `files`
   to `["dist", "ui"]`. This makes `bun add -g` install a compiled entrypoint rather
   than the TypeScript source.

## Release channel — GitHub, not npm

`private: true` means the package is deliberately not on npm. Distribution is via the
GitHub repo only. Two viable routes, both usable today:

- **Git install** — `bun add -g github:owner/almadel` (or a pinned
  `github:owner/almadel#<tag>`). Bun clones the repo and installs the package
  directly; no release asset required.
- **GitHub Releases** — the workflow tags a release and attaches the compiled
  tarball/binary as a release asset for download.

Because the repo currently has no `repository` URL, fill that field in when the repo
exists so the workflow and install URLs are concrete.

## Open items (fold into `12-open-questions.md` when convenient)

- Pin the Bun version used by the workflow (`engines` says `>=1.1`; the workflow
  should build with a pinned newer version).
- Decide whether `dist/` should also include `scripts/` (only if `build:ui` is meant
  to be run by end users; it is not — it is a release-time step).
