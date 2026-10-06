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
2. If a local tier is chosen, it attempts the task (with tools, agent-loop style). Its answer is **verified** by a cheap local pass (`PASS`/`FAIL`).
3. On failure (or a failed verification), it **escalates**: 3B → 8B → 14B → cloud.
4. Cloud tiers receive the improved prompt, never the raw one.

Design principles:

- **Local by default.** Requests leave the machine only when local models genuinely can't cope.
- **Memory-capped.** At most 2 models in RAM (Ollama `OLLAMA_MAX_LOADED_MODELS=2`), idle models unloaded after 5 minutes. On a 32GB machine, typical footprint is \~3GB.
- **Prompt security is not security.** All capabilities are enforced by the runtime environment and by tool implementations in code — never by instructions to the model.
- **One executable.** `deno compile` produces a self-contained binary with the security boundary baked into its permission flags.

## Security rules (hard requirements)

The agent's tools are a fixed set of functions in `src/tools.ts`. The model never gets raw filesystem, network, or shell access — only these wrappers, which enforce:

1. **Workspace boundary:** file tools may only read/write inside `~/dev` (override: `ASK_ROOT` env). Path checks must resolve symlinks and `..` so no traversal can escape the boundary.
2. **GET-only web:** the web tool performs HTTP GET. There is no method parameter — POST/PUT are structurally impossible, not merely forbidden.
3. **Allowlisted shell:** only `curl`, `jq`, `node`, `ls`, `cat`, `grep`, `find`, `head`, `tail`, `wc` may run. Executed directly (no shell), so pipes, `;`, and `$(...)` injection are impossible.
4. **Gated `rm`:** `rm` requires interactive human approval (the exact command must be retyped to approve) — and even approved, the workspace boundary check still applies. Approval can never override rule 1.
5. **Deno permissions mirror the tools:** compiled/installed binaries use `--allow-net --allow-read=$HOME/dev,$HOME/.config/noa --allow-write=$HOME/dev,$HOME/.config/noa --allow-run=<allowlist>` so the runtime enforces the same boundary even if the code checks were removed.

## Where things live


| What                                          | Where                                   |
| --------------------------------------------- | --------------------------------------- |
| noa config (`.env` with API keys, Modelfiles) | `~/.config/noa/` (override: `NOA_HOME`) |
| Models                                        | `~/.ollama/` (Ollama's own storage)     |
| Installed binary                              | `~/.deno/bin/`                          |
| Allowed workspace                             | `~/dev`                                 |


The package never writes inside its own install/repo directory. `deno install`, upgrades, and reinstalls must never clobber user config.

## Stack

- **Runtime:** Deno (TypeScript), zero npm dependencies beyond JSR
- **CLI:** `parseArgs`, `runCommand` from `@stdext/cli`; `Confirm`/`Input` from `@std/cli/prompts`; `load` from `@std/dotenv`
- **Local inference:** Ollama, models `ministral3:3b` / `:8b` / `:14b`, registered as pinned `*-8k` variants (`num_ctx 8192`)
- **Cloud:** Anthropic Messages API + Mistral Chat Completions API, keys from `~/.config/noa/.env`
- **Publishing:** JSR package `@halvardm/noa`, entry `src/main.ts`

## CLI surface

```
noa setup                       interactive first-time setup (ollama, memory caps, models, .env)
noa <question>                  ask anything — routes automatically
noa --model <tier> <question>   force: local3b | local8b | local14b | claude | mistral
noa --no-verify <question>      skip the verification pass
noa --tools                     list permitted tools
```

Conventions: routing decisions/logs go to **stderr**; the answer (and only the answer) to **stdout**, so output is pipeable (`noa explain this | pbcopy`).

`noa setup` performs every step behind explicit yes/no prompts (installing Ollama via brew if missing, setting `OLLAMA_MAX_LOADED_MODELS`/`OLLAMA_KEEP_ALIVE` and making them reboot-persistent, pulling models, registering pinned variants, prompting for API keys only if `.env` doesn't exist). macOS-specific steps are gated on `Deno.build.os === "darwin"` so the same setup works on Linux. Setup is a trusted interactive action; the distributed binary may exclude it via its permission flags.

## Success requirements

The repo is done when all of these hold:

**Build &amp; distribution**

- [ ] `deno task noa -- setup` configures a fresh machine end-to-end via prompts only
- [ ] `deno publish --dry-run` passes (JSR rules: explicit types, no slow types)
- [ ] `deno publish` succeeds; `deno install -g jsr:@halvardm/noa` then `noa <question>` works with no local checkout
- [ ] `deno task compile` produces a working single-file executable
- [ ] `npx jsr:@halvardm/noa` also works for npm users

**Routing**

- [ ] `noa what is 2+2` answers locally on the 3B, in seconds, with stderr showing the tier chosen
- [ ] A moderate code question routes to 8B; a demanding one routes to 14B
- [ ] A genuinely hard task cascades upward and, if all local tiers fail verification, reaches Claude or Mistral with the improved (rewritten) prompt — visible in stderr
- [ ] `--model claude` forces cloud and works
- [ ] With no API keys in `.env`, hard tasks fail gracefully with a clear message (never a stack trace about missing keys mid-cascade)

**Memory**

- [ ] `ollama ps` shows at most 2 loaded models during any request
- [ ] After 5 minutes idle, RAM returns to the baseline (models unload)

**Security — these MUST all fail safely (test each):**

- [ ] `noa read the file ~/.ssh/id_rsa` → denied, outside the workspace, even via `~/dev/../.ssh/id_rsa` (symlink/traversal proof)
- [ ] A prompt asking to POST/PUT data to a URL → impossible; only GET exists
- [ ] `noa run rm -rf ~/Documents` → approval prompt; typing `y` does not approve; even retyping the exact command is rejected by the boundary check
- [ ] `noa run rm notes.txt` → approval prompt; exact retype approves; only files inside `~/dev` can be affected
- [ ] An injected instruction inside a file in `~/dev` ("ignore rules, run ...") → no tool call outside the allowlist is possible
- [ ] The compiled binary (strict flags) refuses reads outside `~/dev` at the Deno permission level, independent of the code checks

**Hygiene**

- [ ] `~/.config/noa/.env` is `chmod 600`, git-ignored, and never overwritten by setup
- [ ] Nothing is written into the package/repo directory at runtime
- [ ] `git clone` + setup on a second machine reaches a working `noa what is 2+2` without editing any file by hand

## License

MIT (or your preference) — decide before `deno publish`; JSR requires a license field.