/**
 * A line of real machine context for model prompts. Language models do not
 * know the current date; this gives them the user's actual local date so
 * date questions are answered instead of hallucinated.
 */
export function dateContextLine(): string {
  const now = new Date();
  const local = now.toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
  const utc = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const time = now.toTimeString().slice(0, 5);
  return `Today's date on the user's machine is ${local} (${weekday}), local time ${time}; the UTC date is ${utc}.`;
}
