import type { ChatAnswer, ChatMessage, ToolSpec } from "./ollama.ts";
import type { CloudProvider } from "./cloud.ts";
import type { RunResult } from "./tools.ts";
import { judge, type Judgment, type Tier } from "./judge.ts";
import { verify } from "./verify.ts";

/** A chat function bound to a model, with JSON mode and tool support. */
export type ChatFn = (
  messages: readonly ChatMessage[],
  options?: { json?: boolean; tools?: readonly ToolSpec[] },
) => Promise<ChatAnswer>;

/** The local tiers in escalation order. */
const LOCAL_TIERS: readonly Tier[] = ["local3b", "local8b", "local14b"];

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

/** Dependencies of the cascade, injected for testing. */
export interface CascadeDeps {
  /** Chat function per purpose: `judge`, `verify`, or a tier name. */
  readonly chatFor: (purpose: string) => ChatFn;
  /** The execution gate the agent loop runs commands through. */
  readonly gate: {
    run(command: string, args: readonly string[]): Promise<RunResult>;
  };
  /** The cloud provider, when one is configured. */
  readonly cloud?: CloudProvider;
  /** A tier forced by `--model`; skips verification and the cascade. */
  readonly forcedTier?: "local3b" | "local8b" | "local14b" | "mistral";
  /** Skip the verification pass (`--no-verify`). */
  readonly noVerify?: boolean;
  /** Log sink (stderr in the CLI). */
  readonly onLog?: (message: string) => void;
  /** Max tool rounds per local answer; defaults to 6. */
  readonly maxToolRounds?: number;
}

const AGENT_SYSTEM = `You are a local coding assistant with a run_command tool that executes allowlisted local commands (no shell). When the user asks to run, read, list, or fetch something, use the tool instead of describing hypothetical output; the tool enforces the security rules and its rejections are final — report them honestly rather than guessing. When you know the answer, answer directly in plain text.`;

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

  // A forced cloud tier must not require Ollama at all; fail fast with the
  // config remedy before anything local runs.
  if (deps.forcedTier === "mistral" && deps.cloud === undefined) {
    throw new Error(
      "no cloud provider configured — run `noa config set MISTRAL_API_KEY`",
    );
  }

  const judgment: Judgment = await judge(question, {
    chat: deps.chatFor("judge"),
  });
  log(
    `judge: tier=${judgment.tier} reason=${judgment.reason || "(none)"} improved="${judgment.improvedPrompt}"`,
  );

  const plan = planTiers(judgment.tier, deps.forcedTier);
  const verifying = deps.forcedTier === undefined && !deps.noVerify;

  for (const tier of plan) {
    if (tier === "cloud") {
      if (deps.cloud === undefined) {
        if (deps.forcedTier === "mistral") {
          throw new Error(
            "no cloud provider configured — run `noa config set MISTRAL_API_KEY`",
          );
        }
        throw new Error(
          "no local model passed verification and no cloud provider is configured — run `noa config set MISTRAL_API_KEY`",
        );
      }
      log(`cloud: ${deps.cloud.name} (answer is final, no verification)`);
      return await deps.cloud.chat(judgment.improvedPrompt);
    }

    log(`tier: ${tier} (attempting)`);
    const answer = await agentLoop(judgment.improvedPrompt, tier, deps, log);
    if (answer === "") {
      log(`tier: ${tier} produced no answer (escalating)`);
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

/** The escalation order from the judge's (or forced) starting tier. */
export function planTiers(
  judged: Tier,
  forced: CascadeDeps["forcedTier"],
): Tier[] {
  if (forced === "mistral") return ["cloud"];
  const start = forced ?? judged;
  const chain: Tier[] = [];
  if (start === "cloud") return ["cloud"];
  const startIdx = LOCAL_TIERS.indexOf(start);
  for (const tier of LOCAL_TIERS.slice(startIdx)) chain.push(tier);
  if (startIdx !== -1 || forced === undefined) chain.push("cloud");
  return chain;
}

async function agentLoop(
  prompt: string,
  tier: Tier,
  deps: CascadeDeps,
  log: (message: string) => void,
): Promise<string> {
  const chat = deps.chatFor(tier);
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
  log(`tier: ${tier} hit the tool-round limit without a final answer`);
  return "";
}
