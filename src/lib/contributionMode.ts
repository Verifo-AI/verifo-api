// Tiered contribution modes: not every device can run a local AI model, so we
// auto-classify a node's real contribution based on its actual reported
// hardware at link time instead of forcing every contributor onto the same
// "compute" path. This is what lets a cheap laptop or phone-class device join
// the network honestly, without lying about being able to run inference.
export const CONTRIBUTION_MODES = ["compute", "relay", "witness"] as const;
export type ContributionMode = (typeof CONTRIBUTION_MODES)[number];

// Thresholds are a tunable business parameter, not a hard technical limit —
// they decide whether a device is even attempted for local-model inference.
const WITNESS_MAX_RAM_GB = 2; // below this, don't even ask the device to try AI work
const RELAY_MAX_RAM_GB = 7; // enough to relay tasks reliably, not enough to trust for local inference

export function classifyContributionMode(ramGb: number, gpu: string | null | undefined): ContributionMode {
  if (!Number.isFinite(ramGb) || ramGb <= WITNESS_MAX_RAM_GB) {
    return "witness";
  }
  if (ramGb <= RELAY_MAX_RAM_GB && !gpu) {
    return "relay";
  }
  if (ramGb <= RELAY_MAX_RAM_GB) {
    // Has a GPU but modest RAM — still safer to relay than risk a bad local run.
    return "relay";
  }
  return "compute";
}

// Witness nodes never run AI work, so they can't earn per-task reward. Instead
// they earn a small, honest reward for real, signature-verified uptime — paid
// per heartbeat, capped so spamming the endpoint can't inflate it.
export const WITNESS_REWARD_MICROS_PER_SECOND = 3; // ~ $0.26/day if online 24/7
export const WITNESS_REWARD_MAX_ELAPSED_SEC = 60; // cap per heartbeat (heartbeats land every 30s)

// Browser Mode (no-install, heartbeat/task loop runs as JS in an open tab)
// intentionally earns less than CLI Mode (dedicated process, uptime
// independent of any tab). This isn't a penalty — it reflects that browser
// uptime is inherently less reliable (tab close, phone lock, etc), so we
// never want to promise the same reward for a fundamentally less reliable
// contribution. Applied as a flat multiplier on top of the same reward
// formulas CLI nodes use, so there's still only one reward code path.
export const BROWSER_MODE_REWARD_MULTIPLIER = 0.4;
