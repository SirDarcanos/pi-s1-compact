export type CompactEnvironmentKey = "URL" | "API_KEY" | "MODEL" | "THRESHOLD" | "TRIGGER_TOKENS"
  | "KEEP_THRESHOLD" | "KEEP_RECENT_TOKENS" | "MAX_PAYBACK_TURNS" | "TIMEOUT_MS" | "TRUNCATE_MIN_CHARS" | "LIVE";

/** New names win even when empty/invalid; validation/defaulting belongs to the consumer. */
export function compactEnvironmentValue(env: NodeJS.ProcessEnv, key: CompactEnvironmentKey): string | undefined {
  const legacy = key === "API_KEY" ? "NIMBLE_API_KEY" : `PI_NIMBLE_${key}`;
  return env[`PI_S1_COMPACT_${key}`] ?? env[legacy];
}
