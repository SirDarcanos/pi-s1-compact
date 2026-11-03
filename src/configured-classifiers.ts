import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateEndpoint } from "./engine/request.ts";
import { ollamaSystemOneClassifier } from "./nimble-registry.ts";

export const classifierCatalogPath = () => join(homedir(), ".pi", "agent", "s1-compact-classifiers.json");
export interface ConfiguredClassifier {
  name: string;
  protocol: "ollama-systemone";
  model: string;
  endpoint: string;
  contextWindow: number;
  apiKeyEnv?: string;
}

/** Validate the entire catalog before registering anything. Never echo configuration/credentials in errors. */
export function parseClassifierCatalog(value: unknown): ConfiguredClassifier[] {
  const fail = (message: string): never => { throw new Error(`Classifier catalog: ${message}; scoring paused, no fallback`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected version 1 object");
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || Object.keys(root).some(k => !["version", "classifiers"].includes(k))
    || !Array.isArray(root.classifiers) || root.classifiers.length > 32) return fail("expected version 1 and up to 32 classifiers");
  const names = new Set<string>();
  return root.classifiers.map((entry: unknown, index: number) => {
    const invalid = () => fail(`invalid entry ${index + 1} (name, model, endpoint, contextWindow and optional apiKeyEnv required; text boolean questions only)`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid();
    const c = entry as Record<string, unknown>;
    if (c.protocol !== "ollama-systemone") return fail(`entry ${index + 1}: supported protocol is ollama-systemone (text boolean questions via /systemone); chat/completions and image capabilities are unsupported`);
    if (Object.keys(c).some(k => !["name", "protocol", "model", "endpoint", "contextWindow", "apiKeyEnv"].includes(k))
      || typeof c.name !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(c.name) || names.has(c.name)
      || typeof c.model !== "string" || !c.model.trim() || c.model.length > 256 || /[\x00-\x1f\x7f]/.test(c.model)
      || typeof c.endpoint !== "string" || c.endpoint.length > 2048
      || !Number.isSafeInteger(c.contextWindow) || (c.contextWindow as number) < 2000
      || (c.apiKeyEnv !== undefined && (typeof c.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.apiKeyEnv)))) return invalid();
    let endpoint: URL;
    try { endpoint = new URL(validateEndpoint(c.endpoint)); } catch { return invalid(); }
    if (!endpoint.pathname.endsWith("/systemone")) return fail(`entry ${index + 1}: endpoint must end in /systemone`);
    names.add(c.name);
    return { ...c, endpoint: endpoint.href } as unknown as ConfiguredClassifier;
  });
}

/** User-global configuration only: project files cannot introduce evidence destinations. */
export function registerConfiguredClassifiers(pi: ExtensionAPI, path = classifierCatalogPath(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Classifier catalog unreadable; scoring paused, no fallback"); }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("Classifier catalog invalid JSON; scoring paused, no fallback"); }
    const catalog = parseClassifierCatalog(value);
    const keys = catalog.map(c => {
      if (!c.apiKeyEnv) return "ollama";
      const key = env[c.apiKeyEnv];
      if (!key?.trim()) throw new Error("Classifier catalog credential environment variable unavailable; scoring paused, no fallback");
      return key;
    });
    for (const [index, c] of catalog.entries()) {
      const endpoint = new URL(c.endpoint);
      endpoint.pathname = endpoint.pathname.slice(0, -"systemone".length);
      pi.registerProvider(`s1-compact-config-${c.name}`, {
        name: `S1 Compact · ${c.name}`, baseUrl: endpoint.href, apiKey: keys[index],
        classifiers: { "typesafe-system-one": ollamaSystemOneClassifier },
        models: [{ type: "classifier", id: c.model, name: c.model, api: "typesafe-system-one",
          input: ["text"], contextWindow: c.contextWindow,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      });
    }
  } catch (error) {
    // Registration errors may include provider-supplied private data; expose only our validation errors.
    return error instanceof Error && error.message.startsWith("Classifier catalog")
      ? error.message : "Classifier catalog registration failed; scoring paused, no fallback";
  }
}
