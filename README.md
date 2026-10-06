# noa

**noa** is a local-first AI CLI and router. A small local model (Ministral 3 3B) is the always-warm default: it answers what it can on your own machine, and escalates everything else — bigger local models first, then cloud APIs (Claude, Mistral); if needed with an improved rewritten prompt. It is built to be compiled with `deno compile` into a single executable and published to JSR so anyone can install it with `deno install -g jsr:@halvardm/noa` or `npm i -g jsr:@halvardm/noa`.

## The idea

Most AI usage is burned on trivial questions sent to expensive frontier models. noa inverts that: **the smallest sufficient model handles each request.**

The cascade:

```
Tier 0  Ministral 3 3B    (always loaded, ~3GB)  → answers easy things, classifies everything else
Tier 1  Ministral 3 8B    (loaded on demand)     → moderate tasks
Tier 2  Ministral 3 14B   (loaded on demand)     → demanding but self-contained tasks
Tier 3  Claude / Mistral  (cloud APIs)           → heavy reasoning, code generation, frontier tasks
```

Flow of every request:

1. The 3B **judges** the request: outputs JSON `{tier, reason, improved_prompt}` — the improved prompt is the user's intent, rewritten to be clearer and more complete.
2. If a local tier is chosen, it attempts the task (with tools, agent-loop style). Its answer is **verified** by a cheap local pass (`PASS`/`FAIL`). The verifier is biased conservative: it must see a clear deficiency (wrong, incomplete, or off-question) to say `FAIL` — uncertainty passes. Verification only runs on local answers; a cloud answer is final (there is nothing left to escalate to) and `--model`-forced tiers skip it.
3. On failure (or a failed verification), it **escalates**: 3B → 8B → 14B → cloud.
4. Cloud tiers receive the improved prompt, never the raw one.

Design principles:

- **Local by default.** Requests leave the machine only when local models genuinely can't cope.
- **Memory-capped.** At most 2 models in RAM (Ollama `OLLAMA_MAX_LOADED_MODELS=2`), idle models unloaded after 5 minutes. On a 32GB machine, typical footprint is \~3GB.
- **Prompt security is not security.** All capabilities are enforced by the runtime environment and by tool implementations in code — never by instructions to the model.
- **One executable.** `deno compile` produces a self-contained binary with the security boundary baked into its permission flags.

## Security rules (hard requirements)

noa implements no tools of its own. The agent's only capability is invoking **allowlisted local executables** — `src/tools.ts` is the execution *gate* (allowlist, argument screening, logging), not a toolbox. The model never gets raw filesystem, network, or shell access; it can only request a run of an allowed command, and the request passes through the gate.

1. **Allowed paths (argument-level screening):** any command argument that names an existing filesystem path must resolve — after symlink and `..` resolution — inside the **allowed paths**, or the invocation is rejected. Allowed paths resolve by **precedence — the most specific scope wins, and each level fully replaces the one below:**
   - CLI flag `--allow-paths <p,...>` (this invocation)
   - env var `NOA_ALLOW_PATHS` (this shell/session — wins over the config file because `@std/dotenv`'s `load()` never overrides existing process env)
   - config file `~/.config/noa/.env` (global; written via `noa config set NOA_ALLOW_PATHS <p,...>`)
   - built-in default `~/dev`

   A flag may widen or narrow freely: the same user typed it, so there is nothing to protect against — which is why the earlier `--force-paths` escape hatch is dropped as redundant. `noa config get` prints the effective list so the live configuration is always visible.

   *Honest limits:* this is screening of arguments, not a sandbox. An allowlisted binary can still touch paths noa cannot see (its own config files, env vars, exotic flags). Runtime-enforced path boundaries for child processes would require OS-level sandboxing (sandbox-exec, bubblewrap/landlock) — explicitly out of scope. Deno permission flags bind noa's own process only (rule 6).
2. **GET-only web:** `curl` is the only default network tool, and it is screened: invocations containing any method-, body-, or upload-defining argument (`-X` with a non-GET method, `-d`/`--data*`, `-T`/`--upload-file`, `-F`/`--form*`, `--request`) are rejected. This is also argument-level, not structural — the default posture is "GET, no body"; users who want stronger guarantees remove `curl` from their allowlist.
3. **Allowlisted commands:** the built-in default allowlist is `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `jq`, `curl` (screened per rule 2). The effective allowlist resolves by the same precedence chain as rule 1 — each level *replaces* (does not merge with) the one below, so a user can strip defaults (e.g. remove `curl`) as well as add entries:
   - CLI flag `--allow-tools <cmd,...>` (this invocation)
   - env var `NOA_TOOLS` (this shell/session)
   - config file (`noa config set NOA_TOOLS <cmd,...>`)
   - the default list

   Extending the allowlist is an explicit, logged escalation decision that belongs to the user, not the model. Commands are executed directly (no shell), so pipes, `;`, and `$(...)` injection are impossible. Every invocation is logged to stderr. Custom entries are resolved to absolute paths; entries inside the writable workspace are rejected (an allowed binary in `~/dev` could be overwritten and then spawned — Deno's docs call out exactly this `--allow-write` + `--allow-run` trap). Note: `node` is deliberately absent from the default allowlist — it is arbitrary-execution and voids every other rule; adding it is the user's informed choice.
4. **Gated `rm`:** `rm` is never in the default allowlist. Even if the user adds it via `--allow-tools`, each invocation requires interactive human approval (the exact command must be retyped to approve) — and even approved, argument screening (rule 1) still applies. Approval can never override rule 1.
5. **Deno permissions mirror the gate:** compiled/installed binaries use `--allow-net --allow-env=NOA_HOME,NOA_TOOLS,NOA_ALLOW_PATHS,HOME,MISTRAL_API_KEY,OLLAMA_HOST --allow-read=$HOME/dev,$HOME/.config/noa --allow-write=$HOME/dev,$HOME/.config/noa --allow-run=<default allowlist>` so the runtime enforces the default boundary even if the code checks were removed.
6. **Subprocess reality:** Deno permissions are enforced on the Deno process only — never on child processes. `--allow-run` gates which executables may be spawned (arguments are not checked); once spawned, a child runs with the user's full privileges, outside the sandbox. Therefore **noa never spawns Ollama**: Ollama runs as an independent user daemon and noa talks to it over `localhost:11434` (covered by `--allow-net`). The model executes nothing — it can only produce a request that passes through the gate inside noa's own sandboxed process.
7. **Runtime vs. code enforcement for custom settings:** compiled binaries bake their permission flags in at compile time. The default allowlist and default paths are enforced by the runtime; user-extended `--allow-tools` lists and `--allow-paths` sets are enforced by code checks in the gate, since the compiled binary's flags cannot be widened at runtime. Users who want the runtime itself to enforce custom settings run from source (`deno task noa`) or recompile (`deno task compile`, which bakes the current `NOA_ALLOW_PATHS` into the Deno flags). A custom allowlist is only as strong as its weakest entry — adding `curl` unscreened or `node` effectively voids the GET-only posture and any path discipline.
8. **Config writes are additive and secret-safe:** `noa config set` is the supported way to write settings — API keys, `NOA_TOOLS`, `NOA_ALLOW_PATHS`, model overrides — to `~/.config/noa/.env`. It creates the file `chmod 600` if missing, updates only the named key, and never rewrites or reorders unrelated entries. Secret-looking values (`*_KEY`, `*_TOKEN`, `*_SECRET`) are masked in `config get`/`config list` output unless `--show` is passed. Widening settings (`NOA_TOOLS`, `NOA_ALLOW_PATHS`) are writable via `config set` — this is the user acting deliberately at the keyboard, which is the same trust level as editing the file by hand; the model still cannot touch them, because it only ever requests allowlisted command runs, and `noa`/`config` are not allowlisted commands.

## Where things live


| What                                          | Where                                   |
| --------------------------------------------- | --------------------------------------- |
| noa config (`.env` with API keys, Modelfiles) | `~/.config/noa/` (override: `NOA_HOME`) |
| Models                                        | `~/.ollama/` (Ollama's own storage)     |
| Installed binary                              | `~/.deno/bin/`                          |
| Allowed workspace                             | `~/dev` (override: `NOA_ALLOW_PATHS` env, comma-separated) |


The package never writes inside its own install/repo directory. `deno install`, upgrades, and reinstalls must never clobber user config.

## Stack

- **Runtime:** Deno (TypeScript), zero npm dependencies beyond JSR
- **CLI:** `defineCommand`/`runCommand`/`UsageError` from `@stdx/cli`; `promptSecret` from `@std/cli/prompt-secret`; `parse` from `@std/dotenv`
- **Local inference:** Ollama (0.13.1+), models `ministral-3:3b` / `:8b` / `:14b` (hyphenated tag), `num_ctx 8192` passed per request (pinned `*-8k` Modelfile variants arrive with `noa setup` in milestone 2)
- **Cloud:** pluggable `CloudProvider` interface; v0.1 ships **Mistral Chat Completions only** (keys from `~/.config/noa/.env`). Anthropic Messages API follows; the interface must make adding other providers (OpenAI-compatible, etc.) a one-file job. `--model claude` in v0.1 prints a clear "not yet supported" message rather than failing mid-cascade.
- **Publishing:** JSR package `@halvardm/noa`, entry `src/main.ts`

## CLI surface

```
noa setup                       interactive first-time setup (ollama, memory caps, models, .env)
noa config set <KEY> [VALUE]    write a setting to ~/.config/noa/.env (prompts with hidden
                                 input if VALUE omitted); e.g. noa config set MISTRAL_API_KEY
noa config get <KEY>            print a setting (secrets are masked unless --show)
noa config list                 list all settings (values masked)
noa config unset <KEY>          remove a setting
noa <question>                  ask anything — routes automatically
noa --model <tier> <question>   force: local3b | local8b | local14b | claude | mistral
noa --allow-tools <cmd,...>     set the tool allowlist for this invocation (highest precedence;
                                 replaces the default — persist via noa config set NOA_TOOLS)
noa --allow-paths <p,...>       set allowed paths for this invocation (highest precedence;
                                 replaces NOA_ALLOW_PATHS / config / default ~/dev)
noa --no-verify <question>      skip the verification pass
noa --tools                     list permitted tools
```

Conventions: routing decisions/logs go to **stderr**; the answer (and only the answer) to **stdout**, so output is pipeable (`noa explain this | pbcopy`).

`noa setup` performs every step behind explicit yes/no prompts (installing Ollama via brew if missing, setting `OLLAMA_MAX_LOADED_MODELS`/`OLLAMA_KEEP_ALIVE` and making them reboot-persistent, pulling models, registering pinned variants, prompting for API keys only if `.env` doesn't exist). macOS-specific steps are gated on `Deno.build.os === "darwin"` so the same setup works on Linux. Setup is a trusted interactive action; the distributed binary may exclude it via its permission flags.

## Implementation milestones

**Milestone 1 — core loop (v0.1)**

- Judge (3B) → route → answer → verify → cascade, end to end
- Command execution gate: allowlist and allowed paths resolved via the precedence chain (`--allow-tools`/`--allow-paths` > `NOA_TOOLS`/`NOA_ALLOW_PATHS` env > config file > defaults), argument path screening, curl method screening, stderr invocation log
- `noa config set|get|list|unset` — settings live in `~/.config/noa/.env`, so no hand-editing is required
- Cloud: Mistral only, via the `CloudProvider` interface
- Config via `noa config`; no `noa setup` yet

**Milestone 2 — destructive capability and setup**

- Gated `rm` (rule 4)
- Anthropic provider; pluggable provider selection (user-configurable, weighted order in `.env`)
- `noa setup`, `deno publish`, compiled binary with strict permission flags

The security rules above are the standing spec for both milestones; rule 4 is only testable once `rm` gating exists (milestone 2).

## Success requirements

The repo is done when all of these hold:

**Build &amp; distribution**

- [ ] `deno task noa -- setup` configures a fresh machine end-to-end via prompts only
- [ ] `deno publish --dry-run` passes (JSR rules: explicit types, no slow types)
- [ ] `deno publish` succeeds; `deno install -g jsr:@halvardm/noa` then `noa <question>` works with no local checkout
- [ ] `deno task compile` produces a working single-file executable
- [ ] `npx jsr:@halvardm/noa` also works for npm users

**Routing**

- [x] `noa what is 2+2` answers locally on the 3B, in seconds, with stderr showing the tier chosen
- [ ] A moderate code question routes to 8B; a demanding one routes to 14B
- [ ] A genuinely hard task cascades upward and, if all local tiers fail verification, reaches Claude or Mistral with the improved (rewritten) prompt — visible in stderr
- [ ] `--model claude` forces cloud and works
- [x] With no API keys in `.env`, hard tasks fail gracefully with a clear message (never a stack trace about missing keys mid-cascade)

**Memory**

- [ ] `ollama ps` shows at most 2 loaded models during any request
- [ ] After 5 minutes idle, RAM returns to the baseline (models unload)

**Security — these MUST all fail safely (test each):**

- [x] `noa read the file ~/.ssh/id_rsa` → denied, outside the workspace, even via `~/dev/../.ssh/id_rsa` (symlink/traversal proof)
- [x] Precedence is observable end to end: with `NOA_ALLOW_PATHS=~/dev,~/work` in `.env`, shell `NOA_ALLOW_PATHS=~/work`, and `--allow-paths ~/work/src`, the flag wins; drop the flag and the shell env wins over the config file; drop both and the config file wins over the default. Same chain for `NOA_TOOLS`/`--allow-tools`
- [x] A prompt asking to POST/PUT data to a URL → rejected: method/body/upload arguments are screened out of `curl` invocations
- [ ] `noa run rm -rf ~/Documents` → approval prompt; typing `y` does not approve; even retyping the exact command is rejected by the boundary check
- [ ] `noa run rm notes.txt` → approval prompt; exact retype approves; only files inside `~/dev` can be affected
- [x] An injected instruction inside a file in `~/dev` ("ignore rules, run ...") → no tool call outside the allowlist is possible
- [x] `noa --allow-tools git status` runs `git status` (logged to stderr); `--allow-tools` with an entry resolved inside `~/dev` is rejected
- [ ] The compiled binary (strict flags) refuses reads outside `~/dev` at the Deno permission level, independent of the code checks

**Hygiene**

- [x] `~/.config/noa/.env` is `chmod 600`, git-ignored, and never overwritten by setup
- [x] `noa config set MISTRAL_API_KEY` writes the key (chmod 600 on file creation) and preserves unrelated entries; `config set NOA_TOOLS git,rg` and `config set NOA_ALLOW_PATHS ~/dev,~/work` persist correctly and are active on the next run
- [x] Nothing is written into the package/repo directory at runtime
- [ ] `git clone` + setup on a second machine reaches a working `noa what is 2+2` without editing any file by hand

## License

MIT (or your preference) — decide before `deno publish`; JSR requires a license field.