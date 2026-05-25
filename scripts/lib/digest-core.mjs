// Shared utilities for weekly/monthly digests and adaptive-window logic.

// Adaptive window selection: pick the smallest window (24/48/72h) whose
// candidate pool meets the freshness threshold. Returns { hours, pool_sizes }.
// Thresholds derived from observed split: normal weekdays sit at 128–155;
// holiday/weekend collapses sit at 38–39. 60 separates them; 30 is the
// floor below which 48h doesn't recover enough.
export function selectEffectiveWindow({ pool24, pool48, pool72 }) {
  const pool_sizes = { "24h": pool24, "48h": pool48, "72h": pool72 };
  if (pool24 >= 60) return { hours: 24, pool_sizes };
  if (pool48 >= 30) return { hours: 48, pool_sizes };
  return { hours: 72, pool_sizes };
}
