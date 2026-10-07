import type { ChatAnswer, ChatMessage, ToolSpec } from "./ollama.ts";
import type { CloudProvider } from "./cloud.ts";
import type { RunResult } from "./tools.ts";
import { judge, type Judgment, type Tier, type TierInfo } from "./judge.ts";
import { verify } from "./verify.ts";

/** A chat function bound to a model, with JSON mode and tool support. */
export type ChatFn = (
  messages: readonly ChatMessage[],
  options?: { json?: boolean; tools?: readonly ToolSpec[] },
) => Promise<ChatAnswer>;

/** What the model may request: one allowlisted command run. */
export const RUN_COMMAND_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "Run one allowlisted local command (no shell) and return its output. Use it to inspect files, search text, or fetch a URL with GET.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "the command to run" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "its arguments, one per element",
        },
      },
      required: ["command"],
    },
  },
};

/**
 * A model forced by `--model`: bypasses the judge, verification, and the
 * cascade entirely — the raw question goes to exactly this model.
 */
/** Where a tier's model is served: Ollama or a cloud provider. */
export interface TierTarget {
  /** `"ollama"`, `"mistral"`, or `"anthropic"`. */
  readonly provider: string;
  /** The model tag on that provider. */
  readonly model: string;
}

/**
 * A model forced by `--model`/`--provider`: bypasses the judge,
 * verification, and the cascade — the raw question goes to exactly this
 * model. `--model` without `--provider` is always an Ollama tag (or a
 * `localN` tier); `--provider` names the cloud provider for the model.
 */
export type ForcedTarget =
  | { readonly kind: "cloud"; readonly provider: string; readonly model?: string }
  | { readonly kind: "tier"; readonly tier: string }
  | { readonly kind: "model"; readonly model: string };

/** Dependencies of the cascade, injected for testing. */
export interface CascadeDeps {
  /** Chat function per purpose: `judge`, `verify`, or an Ollama tier name. */
  readonly chatFor: (purpose: string) => ChatFn;
  /** The configured tiers in escalation order (user-defined models). */
  readonly localTiers: readonly Tier[];
  /** The user's description per tier, fed to the judge prompt. */
  readonly tierDescriptions?: Readonly<Record<string, string>>;
  /** Which provider and model serves each tier (unset provider = Ollama). */
  readonly tierTargets?: Readonly<Record<string, TierTarget>>;
  /** The execution gate the agent loop runs commands through. */
  readonly gate: {
    run(command: string, args: readonly string[]): Promise<RunResult>;
  };
  /** The configured cloud providers, in user-preference order. */
  readonly clouds?: readonly CloudProvider[];
  /** Chat function for a direct Ollama model tag (`--model <tag>`). */
  readonly chatForModel?: (model: string) => ChatFn;
  /** The model forced by `--model`; bypasses judge, verify, and cascade. */
  readonly forced?: ForcedTarget;
  /** Skip the verification pass (`--no-verify`). */
  readonly noVerify?: boolean;
  /** Log sink (stderr in the CLI). */
  readonly onLog?: (message: string) => void;
  /** Max tool rounds per local answer; defaults to 6. */
  readonly maxToolRounds?: number;
}

const AGENT_SYSTEM = `You are a local coding assistant with a run_command tool that executes allowlisted local commands (no shell). You get exactly one turn to answer: never ask the user to run something or offer to do it — just do it with the tool and report the result. You do not know the current date, time, or machine state: any question about live system information requires a command (e.g. \`date\`). Prefer acting with the tool over describing hypothetical output; the tool enforces the security rules and its rejections are final — report them honestly rather than guessing. When you already know the answer, answer directly in plain text.`;

/**
 * Routes a question through the cascade:
 * judge → local tier (with tools) → verify → escalate → cloud.
 * Returns the final answer; logs every routing decision via `onLog`.
 */
export async function cascade(
  question: string,
  deps: CascadeDeps,
): Promise<string> {
  const log = deps.onLog ?? (() => {});
  const clouds = deps.clouds ?? [];
  const localTiers = deps.localTiers ?? [];
  const targets = deps.tierTargets ?? {};

  // Logs show the model, not the positional tier name; a tier without a
  // configured target (tests, legacy callers) falls back to its name.
  const tierLabel = (tier: string): string => {
    const target = targets[tier];
    if (target === undefined) return tier;
    return target.provider === undefined || target.provider === "ollama"
      ? target.model
      : `${target.model} via ${target.provider}`;
  };

  // A forced model bypasses the judge, verification, and the cascade:
  // the raw question goes to exactly this model.
  const forced = deps.forced;
  if (forced !== undefined) {
    if (forced.kind === "cloud") {
      const provider = clouds.find((p) => p.name === forced.provider);
      if (provider === undefined) {
        const setting = forced.provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : "MISTRAL_API_KEY";
        throw new Error(
          `${forced.provider} is not configured — export ${setting} in your shell`,
        );
      }
      const model = forced.model !== undefined ? ` ${forced.model}` : "";
      log(`forced: ${forced.provider}${model} (raw question, no cascade)`);
      return provider.chat(question, forced.model);
    }
    let chat: ChatFn;
    let label: string;
    if (forced.kind === "tier") {
      if (!localTiers.includes(forced.tier)) {
        throw new Error(
          `${forced.tier} is not configured — check the models list in config.json or force another tier`,
        );
      }
      chat = deps.chatFor(forced.tier);
      label = tierLabel(forced.tier);
    } else {
      if (deps.chatForModel === undefined) {
        throw new Error("direct model forcing is not available");
      }
      chat = deps.chatForModel(forced.model);
      label = forced.model;
    }
    log(`forced: ${label} (raw question, no cascade, no verification)`);
    const answer = await agentLoop(question, label, chat, deps, log);
    if (answer === "") {
      throw new Error(`${label} produced no answer`);
    }
    return answer;
  }

  const ollamaTiers = localTiers.filter((tier) =>
    targets[tier] === undefined || targets[tier].provider === "ollama"
  );

  // Without any Ollama model there is nothing to judge with: the raw
  // question goes to cloud (the improved prompt needs the judge).
  if (localTiers.length === 0) {
    if (clouds.length === 0) {
      throw new Error(
        "no local model is configured and no cloud provider is configured — add models to config.json or a cloud API key",
      );
    }
    log("no local models configured — routing to cloud with the raw question");
    return cloudChain(question, clouds, undefined, log);
  }

  let judgment: Judgment;
  if (ollamaTiers.length === 0) {
    // Only cloud models configured: judging would cost money per request;
    // walk the whole cascade with the raw question instead.
    log("no ollama models configured — skipping the judge");
    judgment = {
      tier: localTiers[0],
      reason: "no ollama judge",
      improvedPrompt: question,
    };
  } else {
    try {
      judgment = await judge(question, {
        chat: deps.chatFor("judge"),
        tiers: localTiers.map((name): TierInfo => ({
          name,
          description: deps.tierDescriptions?.[name],
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Ollama is not running")) throw error;
      // The judge's model is unavailable: route the raw question through the
      // smallest configured tier and keep going.
      log(`judge failed (${message}) — falling back to the raw question`);
      judgment = {
        tier: localTiers[0],
        reason: "judge unavailable",
        improvedPrompt: question,
      };
    }
  }
  const judgedModel = targets[judgment.tier] !== undefined
    ? ` model=${targets[judgment.tier].model}`
    : "";
  log(
    `judge: tier=${judgment.tier}${judgedModel} reason=${judgment.reason || "(none)"} improved="${judgment.improvedPrompt}"`,
  );

  // The implicit final cloud tier only exists when no configured tier is a
  // cloud model — otherwise the user's list already ends wherever they chose.
  const hasCloudTier = localTiers.some((tier) => targets[tier] !== undefined &&
    targets[tier].provider !== "ollama"
  );
  const plan = planTiers(judgment.tier, localTiers, !hasCloudTier);
  const verifying = !deps.noVerify;

  for (const tier of plan) {
    if (tier === "cloud") {
      if (clouds.length === 0) {
        throw new Error(
          "no local model passed verification and no cloud provider is configured — export MISTRAL_API_KEY (or ANTHROPIC_API_KEY) in your shell",
        );
      }
      return cloudChain(judgment.improvedPrompt, clouds, undefined, log);
    }

    const target = targets[tier];
    let answer: string;
    if (target !== undefined && target.provider !== "ollama") {
      // A cloud model inside the user's cascade: answered by its provider.
      const provider = clouds.find((p) => p.name === target.provider);
      if (provider === undefined) {
        log(
          `tier: ${tier} (${target.model}) needs ${target.provider}, which is not configured — escalating`,
        );
        continue;
      }
      log(`tier: ${tierLabel(tier)} (attempting)`);
      try {
        answer = await provider.chat(judgment.improvedPrompt, target.model);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`tier: ${tierLabel(tier)} failed (${message}) — escalating`);
        continue;
      }
    } else {
      log(`tier: ${tierLabel(tier)} (attempting)`);
      try {
        answer = await agentLoop(
          judgment.improvedPrompt,
          tierLabel(tier),
          deps.chatFor(tier),
          deps,
          log,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Ollama is not running")) throw error;
        // A broken tier (model missing, HTTP error) escalates rather than
        // crashing the whole request.
        log(`tier: ${tier} failed (${message}) — escalating`);
        continue;
      }
    }
    if (answer === "") {
      log(`tier: ${tierLabel(tier)} produced no answer (escalating)`);
      continue;
    }
    if (!verifying) return answer;
    const verdict = await verify(
      question,
      answer,
      { chat: deps.chatFor("verify") },
    );
    if (verdict.pass) {
      log(`verify: PASS (${verdict.reason})`);
      return answer;
    }
    log(`verify: FAIL (${verdict.reason}) — escalating`);
  }

  // The plan always ends with cloud, so this is unreachable; kept for safety.
  throw new Error("the cascade exhausted every tier without an answer");
}

/**
 * The escalation order from the judge's starting tier, walking only the
 * configured local tiers. A judged-but-absent tier starts at the bottom.
 * The implicit final cloud tier is appended only when the user's cascade
 * contains no cloud model of its own.
 */
export function planTiers(
  judged: Tier,
  localTiers: readonly Tier[],
  appendCloud = true,
): Tier[] {
  if (judged === "cloud") return appendCloud ? ["cloud"] : [...localTiers];
  const startIdx = localTiers.indexOf(judged);
  const chain = startIdx === -1 ? [...localTiers] : localTiers.slice(startIdx);
  if (appendCloud) chain.push("cloud");
  return chain;
}

/** Tries the configured cloud providers in order; returns the first answer. */
async function cloudChain(
  prompt: string,
  clouds: readonly CloudProvider[],
  forcedCloud: string | undefined,
  log: (message: string) => void,
): Promise<string> {
  const chain = forcedCloud !== undefined
    ? clouds.filter((p) => p.name === forcedCloud)
    : clouds;
  const failures: string[] = [];
  for (const provider of chain) {
    log(`cloud: ${provider.name} (answer is final, no verification)`);
    try {
      return await provider.chat(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`cloud: ${provider.name} failed (${message})`);
      failures.push(`${provider.name}: ${message}`);
    }
  }
  throw new Error(`all cloud providers failed — ${failures.join("; ")}`);
}

async function agentLoop(
  prompt: string,
  label: string,
  chat: ChatFn,
  deps: CascadeDeps,
  log: (message: string) => void,
): Promise<string> {
  const maxRounds = deps.maxToolRounds ?? 6;
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM },
    { role: "user", content: prompt },
  ];
  for (let round = 0; round < maxRounds; round++) {
    const answer = await chat(messages, { tools: [RUN_COMMAND_TOOL] });
    if (answer.toolCalls.length === 0) return answer.content;
    messages.push({ role: "assistant", content: answer.content, toolCalls: answer.toolCalls });
    for (const call of answer.toolCalls) {
      if (call.name !== "run_command") {
        messages.push({
          role: "tool",
          toolName: call.name,
          content: JSON.stringify({ error: "unknown tool" }),
        });
        continue;
      }
      const command = String(call.args.command ?? "");
      const args = Array.isArray(call.args.args)
        ? call.args.args.map(String)
        : [];
      log(`tool: ${command} ${args.join(" ")}`);
      let result: string;
      try {
        const run = await deps.gate.run(command, args);
        result = JSON.stringify({
          code: run.code,
          stdout: run.stdout.slice(0, 10_000),
          stderr: run.stderr.slice(0, 10_000),
        });
      } catch (error) {
        result = JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      messages.push({ role: "tool", toolName: call.name, content: result });
    }
  }
  log(`${label} hit the tool-round limit without a final answer`);
  return "";
}
