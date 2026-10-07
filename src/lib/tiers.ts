import type { Tier } from "./judge.ts";
import type { TierTarget } from "./router.ts";
import type { ModelEntry } from "./config.ts";

/** The tiers of the user's cascade and their models. */
export interface Tiers {
  /** Tier names in escalation order: `local1`..`localN`. */
  readonly order: readonly Tier[];
  /** Tier -> the user's description of what the model is for. */
  readonly descriptions: Readonly<Record<string, string>>;
  /** Tier -> provider and model (unset provider means Ollama). */
  readonly targets: Readonly<Record<string, TierTarget>>;
}

/**
 * Maps the config's `rules` onto positional tiers. The rules are
 * ordered by `complexity` first (ties keep their file order): the
 * position in that order is the escalation order (`local1`..`localN`),
 * the first Ollama entry is the judge/verifier, and a `provider` on an
 * entry routes that tier to a cloud model.
 */
export function resolveTiers(rules: ModelEntry[]): Tiers {
  const ordered = [...rules].sort((a, b) => a.complexity - b.complexity);
  const order: Tier[] = ordered.map((_, index) => `local${index + 1}`);
  const descriptions: Record<string, string> = {};
  const targets: Record<string, TierTarget> = {};
  ordered.forEach((entry, index) => {
    const tier = order[index];
    if (entry.description !== undefined) descriptions[tier] = entry.description;
    targets[tier] = { provider: entry.provider, model: entry.model };
  });
  return { order, descriptions, targets };
}
