# alimiel

The Almadel supervisor: an out-of-process Rust worker that polls the Almadel
server and runs each ticket in a throwaway checkout. It replaces the
git/branch/dispatch half of the in-process opencode plugin.

Status: **Phase 3** — column resolution, move, and comment are wired (TCK-441).
Each task clones the project's `git_remote` into `<workspace>/<ticket>`, checks
out a `run/<ticket>` branch from the default branch, runs `opencode run`, then
commits the result with a deterministic identity (`almadel[<label>]
<agent@almadel.local>`) and pushes it back to `origin`. On success the ticket
moves to its `next_column` (resolved by name via the columns endpoint) carrying
the real head SHA and a note; on failure it is commented and moved to its
`fail_column` (falling back to the current column when unset). Remaining work
(base-SHA reachability handling TCK-442, git credential minting TCK-444, and
the executor/native-harness seam TCK-443) lands in later phases. See
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

`opencode` is a *command*, not a coupled binary path: the runner spawns it
directly as `opencode run [--model <model>] <args> <prompt>` inside the ticket's
checkout, capturing stdout, stderr, and the exit code.

Set `ALMADEL_VERBOSE=1` (or `true`) to emit `debug` logs; `RUST_LOG` overrides
both the default and the verbose flag.
