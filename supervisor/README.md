# alimiel

The Almadel supervisor: an out-of-process Rust worker that polls the Almadel
server and runs each ticket in a throwaway checkout. It replaces the
git/branch/dispatch half of the in-process opencode plugin.

Status: **Phase 0** — crate scaffold, configuration, and logging only. No HTTP
client, poll loop, git, or runner yet (those land in TCK-439 … TCK-443). See
`plan/alimiel.md` for the full design.

## Build & test

```sh
cargo build
cargo test
```

## Run

```sh
cargo run -- --server http://127.0.0.1:8787 --project almadel-api
```

Configuration is resolved with precedence **CLI flag > env var > default**:

| Field        | Flag              | Env               | Default            |
|--------------|-------------------|-------------------|--------------------|
| server       | `--server`        | `ALMADEL_SERVER`  | *(required)*       |
| project      | `--project`       | `ALMADEL_PROJECT` | *(required)*       |
| label        | `--label`         | `ALMADEL_LABEL`   | `$HOSTNAME`/`default` |
| workspace    | `--workspace`     | `ALMADEL_WORKSPACE` | `~/.alimiel/`    |
| opencode     | `--opencode`      | `OPENCODE_BIN`    | `opencode`         |
| opencode args| `--opencode-args` | `OPENCODE_ARGS`   | *(empty)*          |
| verbose      | *(env only)*      | `ALMADEL_VERBOSE` | `false`            |

`opencode` is a *command*, not a coupled binary path: it is spawned through a
shell (Phase 2) so the supervisor can drive multiple toolchains, not just
opencode.

Set `ALMADEL_VERBOSE=1` (or `true`) to emit `debug` logs; `RUST_LOG` overrides
both the default and the verbose flag.
