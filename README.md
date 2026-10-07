# noa

**noa** is a local-first AI CLI and router. A small local model (Ministral 3 3B) is the always-warm default: it answers what it can on your own machine, and escalates everything else — bigger local models first, then cloud APIs (Claude, Mistral); if needed with an improved rewritten prompt. It is built to be compiled with `deno compile` into a single executable and published to JSR so anyone can install it with `deno install -g jsr:@halvardm/noa` or `npm i -g jsr:@halvardm/noa`.

## The idea

Most AI usage is burned on trivial questions sent to expensive frontier models. noa inverts that: **the smallest sufficient model handles each request.**

The cascade:

```
Tier 0  local1  (default: Ministral 3 3B, always loaded, ~3GB) → answers easy things, classifies everything else
Tier 1  local2  (default: Ministral 3 8B, loaded on demand)    → moderate tasks
Tier 2  local3  (default: Ministral 3 14B, loaded on demand)   → demanding but self-contained tasks
Tier 3  cloud   (Mistral / Anthropic APIs)                       → heavy reasoning, code generation, frontier tasks
```

The tiers are semantic (difficulty), and there can be any number of them: the ordered `models` list in `config.json` defines both the models and the escalation order (position 1 = `local1`, and so on), each with an optional description the judge reads to route. Every entry has an optional `provider` property — unset (or `"ollama"`) means an Ollama model; `"mistral"` or `"anthropic"` puts a cloud model inside the cascade at that position. The judge assigns the tier; escalation only walks configured tiers. The implicit final cloud tier exists only when no entry in the list is a cloud model — a list containing one ends exactly where the user put it. An explicit empty list is a deliberate cloud-only setup (the judge is skipped; the raw question routes to cloud).

Flow of every request:

1. The 3B **judges** the request: outputs JSON `{tier, reason, improved_prompt}` — the improved prompt is the user's intent, rewritten to be clearer and more complete.
2. If a local tier is chosen, it attempts the task (with tools, agent-loop style). Its answer is **verified** by a cheap local pass (`PASS`/`FAIL`). The verifier is biased conservative: it must see a clear deficiency (wrong, incomplete, or off-question) to say `FAIL` — uncertainty passes. Verification only runs on local answers; a cloud answer is final (there is nothing left to escalate to) and `--model`-forced tiers skip it.
3. On failure (or a failed verification), it **escalates**: 3B → 8B → 14B → cloud.
4. Cloud tiers receive the improved prompt, never the raw one.
5. `--model` is a hard override naming one model, and the raw question goes to exactly that model — no judge, no verification, no escalation. Without `--provider`, `--model` is always an **Ollama** tag (or a `localN` tier); `--provider mistral|anthropic` makes it a cloud model on that provider (the provider's default model when `--model` is unset).

Design principles:

- **Local by default.** Requests leave the machine only when local models genuinely can't cope.
- **Memory-capped.** At most 2 models in RAM (Ollama `OLLAMA_MAX_LOADED_MODELS=2`), idle models unloaded after 5 minutes. On a 32GB machine, typical footprint is \~3GB.
- **Prompt security is not security.** All capabilities are enforced by the runtime environment and by tool implementations in code — never by instructions to the model.
- **One executable.** `deno compile` produces a self-contained binary with the security boundary baked into its permission flags.

## Security rules (hard requirements)

noa implements no tools of its own. The agent's only capability is invoking **allowlisted local executables** — `src/tools.ts` is the execution *gate* (allowlist, argument screening, logging), not a toolbox. The model never gets raw filesystem, network, or shell access; it can only request a run of an allowed command, and the request passes through the gate.

1. **Allowed paths (argument-level screening):** any command argument that names an existing filesystem path must resolve — after symlink and `..` resolution — inside the **allowed paths**, or the invocation is rejected. Allowed paths resolve by **precedence — the most specific scope wins, and each level fully replaces the one below:**
   - CLI flag `--allow-paths <p,...>` (this invocation)
   - config file `~/.config/noa/config.json` (global; written via `noa config set NOA_ALLOW_PATHS <p,...>`)
   - built-in default: **the current directory** — the narrowest scope that is still useful. noa warns on stderr when the current directory is not `$HOME` or one of its folders and nothing was configured explicitly; a flag or config entry is a deliberate choice and never warns.

   A flag may widen or narrow freely: the same user typed it, so there is nothing to protect against — which is why the earlier `--force-paths` escape hatch is dropped as redundant. `noa config get` prints the effective list so the live configuration is always visible.

   *Honest limits:* this is screening of arguments, not a sandbox. An allowlisted binary can still touch paths noa cannot see (its own config files, env vars, exotic flags). Runtime-enforced path boundaries for child processes would require OS-level sandboxing (sandbox-exec, bubblewrap/landlock) — explicitly out of scope. Deno permission flags bind noa's own process only (rule 6).
2. **GET-only web:** `curl` is the only default network tool, and it is screened: invocations containing any method-, body-, or upload-defining argument (`-X` with a non-GET method, `-d`/`--data*`, `-T`/`--upload-file`, `-F`/`--form*`, `--request`) are rejected. This is also argument-level, not structural — the default posture is "GET, no body"; users who want stronger guarantees remove `curl` from their allowlist.
3. **Allowlisted commands:** there is **no built-in default** — no tools are callable until the user grants them, and noa logs a hint with the suggested example (`ls,cat,head,tail,wc,grep,find,jq,curl`, also shown in `--help`) whenever the allowlist is empty. The effective allowlist resolves by precedence — each level *replaces* (does not merge with) the one below:
   - CLI flag `--allow-tools <cmd,...>` (this invocation)
   - config file (`noa config set NOA_TOOLS <cmd,...>`)
   - nothing (no tools callable)

   Extending the allowlist is an explicit, logged escalation decision that belongs to the user, not the model. Commands are executed directly (no shell), so pipes, `;`, and `$(...)` injection are impossible. Every invocation is logged to stderr. Custom entries are resolved to absolute paths; entries inside the writable workspace are rejected (an allowed binary in `~/dev` could be overwritten and then spawned — Deno's docs call out exactly this `--allow-write` + `--allow-run` trap). Note: `node` is deliberately absent from the default allowlist — it is arbitrary-execution and voids every other rule; adding it is the user's informed choice.
4. **Gated `rm`:** `rm` is never in the default allowlist. Even if the user adds it via `--allow-tools`, each invocation requires interactive human approval (the exact command must be retyped to approve) — and even approved, argument screening (rule 1) still applies. Approval can never override rule 1.
5. **Deno permissions mirror the gate:** compiled/installed binaries use `--allow-net --allow-env=NOA_HOME,NOA_TOOLS,NOA_ALLOW_PATHS,HOME,MISTRAL_API_KEY,OLLAMA_HOST --allow-read=$HOME/dev,$HOME/.config/noa --allow-write=$HOME/dev,$HOME/.config/noa --allow-run=<the allowlist from NOA_TOOLS at compile time, none if unset>` so the runtime enforces the default boundary even if the code checks were removed.
6. **Subprocess reality:** Deno permissions are enforced on the Deno process only — never on child processes. `--allow-run` gates which executables may be spawned (arguments are not checked); once spawned, a child runs with the user's full privileges, outside the sandbox. Therefore **noa never spawns Ollama**: Ollama runs as an independent user daemon and noa talks to it over `localhost:11434` (covered by `--allow-net`). The model executes nothing — it can only produce a request that passes through the gate inside noa's own sandboxed process.
7. **Runtime vs. code enforcement for custom settings:** compiled binaries bake their permission flags in at compile time. A configured allowlist and configured paths are enforced by the runtime; user-extended `--allow-tools` lists and `--allow-paths` sets are enforced by code checks in the gate, since the compiled binary's flags cannot be widened at runtime. Users who want the runtime itself to enforce custom settings run from source with matching flags (`deno run --allow-run=<your,tools> --allow-read=<your,paths> ... src/main.ts`) or recompile (`deno task compile`, which bakes the current `NOA_TOOLS`/`NOA_ALLOW_PATHS` into the Deno flags). The `deno task noa` dev task carries the suggested example list as its `--allow-run` ceiling and the current directory as its read/write scope — the gate still enforces the actual configuration beneath it. A custom allowlist is only as strong as its weakest entry — adding `curl` unscreened or `node` effectively voids the GET-only posture and any path discipline.
8. **No secrets at rest:** API keys are **never stored**. `config set` refuses secret-looking keys (`*_KEY`, `*_TOKEN`, `*_SECRET`) with an export hint; a legacy `.env` migration skips them; and a key found in `config.json` is ignored with a stderr warning. Providers check that their key is present when selected and read it from the environment **at request time**, attaching it directly to the fetch request — the key never flows through the app. For everything else, `config set` writes one string setting to `~/.config/noa/config.json` (`chmod 600` on creation, additive, never reordering unrelated entries); the `models` list is edited by hand or via `noa setup`. Secret-looking values that someone hand-edits into the file are still masked in `config get`/`config list` output unless `--show` is passed. Widening settings (`NOA_TOOLS`, `NOA_ALLOW_PATHS`) are writable via `config set` — the user acting deliberately at the keyboard, the same trust level as editing the file by hand; the model still cannot touch them, because it only ever requests allowlisted command runs, and `noa`/`config` are not allowlisted commands.

## Where things live


| What                                          | Where                                   |
| --------------------------------------------- | --------------------------------------- |
| noa config (`config.json`, zod-validated, **no secrets**; legacy `.env` migrated on first load, secrets skipped) | `~/.config/noa/` (override: `NOA_HOME`) |
| Models                                        | `~/.ollama/` (Ollama's own storage)     |
| Installed binary                              | `~/.deno/bin/`                          |
| Allowed paths                                 | current directory (configure: `NOA_ALLOW_PATHS`, comma-separated) |


The package never writes inside its own install/repo directory. `deno install`, upgrades, and reinstalls must never clobber user config.

## Stack

- **Runtime:** Deno (TypeScript), JSR dependencies only (`@stdx/cli`, `@std/cli`, `@std/dotenv`, `@std/assert`, and `zod` via `jsr:@zod/zod` for config validation)
- **CLI:** `defineCommand`/`runCommand`/`UsageError` from `@stdx/cli`; `promptSecret` from `@std/cli/prompt-secret`; `parse` from `@std/dotenv`
- **Local inference:** Ollama (0.13.1+); the model cascade is user-defined in `config.json` as an ordered `models` list (any count, smallest to largest, each with an optional description the judge reads). Absent `models` falls back to `ministral-3:3b` / `:8b` / `:14b`. noa passes `num_ctx 8192` and `keep_alive 5m` per request, which achieves the memory cap without Modelfiles
- **Cloud:** pluggable `CloudProvider` interface — Mistral Chat Completions and Anthropic Messages API ship, provider order configured by `NOA_CLOUD` (default `mistral,anthropic`), models overridable via `NOA_MISTRAL_MODEL` / `NOA_ANTHROPIC_MODEL`; keys are read from the shell environment (`MISTRAL_API_KEY` / `ANTHROPIC_API_KEY`) at request time and never stored. Adding another provider is a one-file job.
- **Publishing:** JSR package `@halvardm/noa`, entry `src/main.ts`

## CLI surface

```
noa setup                       interactive first-time setup (models: default or custom, memory cap, keys)
noa config set <KEY> [VALUE]    write a setting to ~/.config/noa/config.json (prompts with hidden
                                 input if VALUE omitted); e.g. noa config set MISTRAL_API_KEY
noa config get <KEY>            print a setting (secrets are masked unless --show)
noa config list                 list all settings (values masked)
noa config unset <KEY>          remove a setting
noa <question>                  ask anything — routes automatically
noa --model <model> <question>  force one Ollama model — no routing, no verification, no escalation.
                                 Examples (the defaults): ministral-3:3b | ministral-3:8b |
                                 ministral-3:14b; any Ollama tag or localN tier also works.
                                 For cloud models, pair with --provider.
noa --provider <p> [model]      the cloud provider for --model: mistral | anthropic; the
                                 provider's default model is used when --model is unset
noa --allow-tools <cmd,...>     set the tool allowlist for this invocation (highest precedence;
                                 example: --allow-tools ls,cat,head,tail,wc,grep,find,jq,curl;
                                 persist via noa config set NOA_TOOLS)
noa --allow-paths <p,...>       set allowed paths for this invocation (highest precedence;
                                 replaces NOA_ALLOW_PATHS / config / default: the current directory)
noa --no-verify <question>      skip the verification pass
noa --tools                     list permitted tools
```

Conventions: routing decisions/logs go to **stderr**; the answer (and only the answer) to **stdout**, so output is pipeable (`noa explain this | pbcopy`).

`noa setup` first asks for **default or custom** models. Default runs a **systems check** (total RAM via `Deno.systemMemoryInfo`) and downloads only what the system can handle — 3b from 6GB, 8b from 12GB, 14b from 24GB — printing a note of what it downloads and what it skips (needs more RAM); the chosen subset is written to `config.json` so the cascade matches what is installed. Custom asks for an ordered, comma-separated model list (smallest to largest), then a one-line description of each model individually (the judge reads these descriptions to route), then pulls them. Everything runs behind explicit prompts, over the Ollama HTTP API only — noa never spawns anything (rule 6). Setup also persists `OLLAMA_MAX_LOADED_MODELS=2`/`OLLAMA_KEEP_ALIVE=5m` in the shell profile behind a prompt, and ends with a reminder to export `MISTRAL_API_KEY`/`ANTHROPIC_API_KEY` — keys are never stored (rule 8). Setup refuses non-interactive stdin with instructions; the compiled binary may exclude steps via its permission flags.

## Implementation milestones

**Milestone 1 — core loop (v0.1)**

- Judge (3B) → route → answer → verify → cascade, end to end
- Command execution gate: allowlist and allowed paths resolved via the precedence chain (`--allow-tools`/`--allow-paths` > `NOA_TOOLS`/`NOA_ALLOW_PATHS` env > config file > no tools / current directory), argument path screening, curl method screening, stderr invocation log
- `noa config set|get|list|unset` — settings live in `~/.config/noa/config.json`, so no hand-editing is required
- Cloud: Mistral only, via the `CloudProvider` interface
- Config via `noa config`; no `noa setup` yet

**Milestone 2 — destructive capability and setup**

- Gated `rm` (rule 4)
- Anthropic provider; weighted, configurable provider order (`NOA_CLOUD`)
- `noa setup` (interactive, HTTP-API based; noa never spawns anything)
- Compiled binary with strict permission flags baked from the environment at compile time (`scripts/compile.ts` maps `NOA_TOOLS` → `--allow-run`, `NOA_ALLOW_PATHS` → `--allow-read`/`--allow-write`); unset `NOA_TOOLS` compiles a binary that cannot spawn anything
- User-defined local models: the ordered `models` array in `config.json` (arbitrary count, per-model descriptions for the judge); setup offers default (with systems check) or custom

**Status:** implemented and tested; publishing to JSR/npm deliberately not done yet. The security rules above are the standing spec for both milestones.

## Settings reference

All non-secret settings live in `~/.config/noa/config.json` (JSON, validated with zod; flat string settings plus the `models` array), written via `noa config set` or by hand. Precedence: CLI flag > config file > built-in default; the environment holds only what is genuinely environmental — `NOA_HOME`, `HOME`, `OLLAMA_HOST`, and the two API keys. A legacy `.env` file is migrated once on first load (secrets skipped).

| Setting | Meaning | Default |
| --- | --- | --- |
| `models` | ordered array of `{model, description?, provider?}` — the cascade, any count; `provider` unset = Ollama, `"mistral"`/`"anthropic"` = a cloud model in the cascade; explicit `[]` is cloud-only | `[{ministral-3:3b ...}, {ministral-3:8b ...}, {ministral-3:14b ...}]` with the standard descriptions |
| `NOA_TOOLS` | Tool allowlist (comma-separated) | none (no tools callable) |
| `NOA_ALLOW_PATHS` | Allowed paths (comma-separated) | current directory |
| `NOA_CLOUD` | Cloud provider order | `mistral,anthropic` |
| `NOA_MISTRAL_MODEL` / `NOA_ANTHROPIC_MODEL` | Cloud model overrides | `mistral-large-latest` / `claude-sonnet-4-5` |
| `MISTRAL_API_KEY` / `ANTHROPIC_API_KEY` | Cloud API keys — **environment only, never stored** (export in your shell) | unset |
| `NOA_HOME` | Config directory | `~/.config/noa` |

## Success requirements

The repo is done when all of these hold:

**Build &amp; distribution**

- [ ] `deno task noa -- setup` configures a fresh machine end-to-end via prompts only
- [x] `deno publish --dry-run` passes (JSR rules: explicit types, no slow types)
- [ ] `deno publish` succeeds; `deno install -g jsr:@halvardm/noa` then `noa <question>` works with no local checkout
- [x] `deno task compile` produces a working single-file executable (verified live: routing, tool runs with baked `--allow-run`, runtime refusal of spawns when compiled without `NOA_TOOLS`, runtime refusal of reads outside the allowed paths)
- [ ] `npx jsr:@halvardm/noa` also works for npm users

**Routing**

- [x] `noa what is 2+2` answers locally on the 3B, in seconds, with stderr showing the tier chosen
- [ ] A moderate code question routes to 8B; a demanding one routes to 14B
- [ ] A genuinely hard task cascades upward and, if all local tiers fail verification, reaches Claude or Mistral with the improved (rewritten) prompt — visible in stderr
- [ ] `--provider anthropic` forces cloud and works (code paths unit-tested; needs a live key for full confirmation)
- [x] With no API keys configured, hard tasks fail gracefully with a clear message (never a stack trace about missing keys mid-cascade)

**Memory**

- [ ] `ollama ps` shows at most 2 loaded models during any request
- [ ] After 5 minutes idle, RAM returns to the baseline (models unload)

**Security — these MUST all fail safely (test each):**

- [x] `noa read the file ~/.ssh/id_rsa` → denied, outside the allowed paths, even via traversal or symlinks (proof in gate tests)
- [x] Precedence is observable end to end: with `NOA_ALLOW_PATHS=~/dev,~/work` in `config.json` and `--allow-paths ~/work/src`, the flag wins; drop the flag and the config file wins over the default (current directory). Same chain for `NOA_TOOLS`/`--allow-tools`
- [x] A prompt asking to POST/PUT data to a URL → rejected: method/body/upload arguments are screened out of `curl` invocations
- [x] `rm -rf <outside>` → approval prompt; typing `y` does not approve; approval can never override path screening (gate tests)
- [x] `rm notes.txt` → approval prompt; exact retype approves; only files inside the allowed paths can be affected (gate tests)
- [x] An injected instruction inside a file in `~/dev` ("ignore rules, run ...") → no tool call outside the allowlist is possible
- [x] `noa --allow-tools git status` runs `git status` (logged to stderr); `--allow-tools` with an entry resolved inside `~/dev` is rejected
- [x] The compiled binary (strict flags) refuses reads outside the allowed paths at the Deno permission level, independent of the code checks (verified live via `NOA_HOME` outside `--allow-read`)

**Hygiene**

- [x] `~/.config/noa/config.json` is `chmod 600`, git-ignored, and never overwritten by setup (a legacy `.env` is migrated once, verbatim, and left untouched)
- [x] `config set NOA_TOOLS git,rg` and `config set NOA_ALLOW_PATHS ~/dev,~/work` persist correctly and are active on the next run; `config set models` is refused with a hint to edit the file or rerun setup; `config set MISTRAL_API_KEY` is refused — secrets are never stored, keys come from the environment (verified live)
- [x] Nothing is written into the package/repo directory at runtime
- [ ] `git clone` + setup on a second machine reaches a working `noa what is 2+2` without editing any file by hand

## License

MIT — see [LICENSE](./LICENSE).