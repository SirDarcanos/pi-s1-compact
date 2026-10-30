import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Inspect bound registrations, not package names. The unmodified legacy extension cannot honor a new lock. */
export function activationConflict(pi: Pick<ExtensionAPI, "getCommands">): string | undefined {
  try {
    const commands = pi.getCommands().filter(c => c.source === "extension");
    const own = commands.filter(c => /^s1-compact(?::\d+)?$/.test(c.name));
    if (own.length !== 1 || !own[0]?.sourceInfo?.path) return "Ambiguous pruning ownership; unload duplicate extensions";
    const owner = own[0].sourceInfo.path;
    const foreign = commands.filter(c => /^nimble-(?:compact|reset|status)(?::\d+)?$/.test(c.name)
      && (!c.sourceInfo?.path || c.sourceInfo.path !== owner));
    if (foreign.length) return `Legacy pruner active at ${foreign[0]!.sourceInfo?.path || "unknown source"}; unload one extension`;
    // Missing native commands may mean a registration displaced or obscured ownership. Fail closed.
    for (const name of ["s1-compact-settings", "s1-compact-reset", "s1-compact-status"]) {
      if (commands.filter(c => c.name === name && c.sourceInfo?.path === owner).length !== 1) {
        return "Ambiguous S1 command ownership; unload duplicate extensions";
      }
    }
  } catch { return "Pruning ownership unavailable; Pi >=1.0.0 is required"; }
}
