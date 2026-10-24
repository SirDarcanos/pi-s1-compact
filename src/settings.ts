import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const LOCAL_PROVIDER = "s1-compact-ollama";
export interface Selection { provider: string; id: string; destination: string; api: string; registryDestination?: string }
export interface Settings { version: 1; classifier: Selection; automatic: boolean }
export interface SettingsStore { load(): Promise<Settings | undefined>; save(settings: Settings): Promise<void> }
export const settingsPath = () => join(homedir(), ".pi", "agent", "s1-compact.json");

export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object");
  const s = value as Record<string, unknown>, c = s.classifier as Record<string, unknown> | undefined;
  if (s.version !== 1 || typeof s.automatic !== "boolean" || !c || typeof c !== "object" || Array.isArray(c)
    || Object.keys(s).some(k => !["version", "classifier", "automatic"].includes(k))
    || Object.keys(c).some(k => !["provider", "id", "destination", "api", "registryDestination"].includes(k))
    || (c.registryDestination !== undefined && (typeof c.registryDestination !== "string" || !c.registryDestination.length || c.registryDestination.length > 2048))
    || ![c.provider, c.id, c.destination, c.api].every(v => typeof v === "string" && v.length > 0 && v.length <= 2048)) {
    throw new Error("Invalid s1-compact settings; use /s1-compact-settings to repair (no fallback)");
  }
  return s as unknown as Settings;
}

export function fileSettingsStore(path = settingsPath()): SettingsStore {
  return {
    async load() {
      let text: string;
      try { text = await readFile(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      try { return parseSettings(JSON.parse(text)); }
      catch { throw new Error("Invalid s1-compact settings; scoring paused. Repair with /s1-compact-settings"); }
    },
    async save(settings) {
      parseSettings(settings);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(settings, null, 2) + "\n"); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    },
  };
}
