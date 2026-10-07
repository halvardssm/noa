import { ModelEntry } from "./config.ts";

export const DEFAULT_MODEL_DATA: DefaultModelData[] = [
  {
    complexity: 1,
    provider: "ollama",
    model: "ministral-3:3b",
    description:
      "trivial questions, chat, simple lookups, basic arithmetic, formatting.",
    minRamGb: 6,
    sizeGb: "3.0GB",
  },
  {
    complexity: 10,
    provider: "ollama",
    model: "ministral-3:8b",
    description:
      "moderate tasks: summarizing, explaining, simple code questions.",
    minRamGb: 12,
    sizeGb: "6.0GB",
  },
  {
    complexity: 30,
    provider: "ollama",
    model: "ministral-3:14b",
    description:
      "demanding but self-contained tasks: multi-step reasoning, code generation and review.",
    minRamGb: 24,
    sizeGb: "9.1GB",
  },
];

export function defaultModelsFor(
  totalGb: number = Number.MAX_SAFE_INTEGER,
): DefaultModelData[] {
  return DEFAULT_MODEL_DATA.filter((spec) => totalGb >= spec.minRamGb);
}

/** A default-cascade model and how much RAM it needs to be comfortable. */
export interface DefaultModelData extends ModelEntry {
  minRamGb: number;
  sizeGb: string;
}
