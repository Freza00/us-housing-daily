import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

test("build-monthly: end-to-end smoke with FORCE_RUN=1",
  { skip: !process.env.RUN_SMOKE },
  () => {
    // 2026-06-01 IS the first Mon of June 2026; FORCE_RUN bypasses the gate so the
    // smoke can run on any day. PUBLISH_NOW is pinned for deterministic output.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-monthly-smoke-"));
    try {
      const r = spawnSync("node", ["scripts/build-monthly.mjs"], {
        cwd: ROOT,
        env: {
          ...process.env,
          LLM_SKIP: "1",
          PUBLISH_NOW: "2026-06-01T02:30:00Z",
          FORCE_RUN: "1",
          DIGEST_OUT_DIR: outDir,
        },
        stdio: "inherit",
      });
      assert.equal(r.status, 0);

      const out = JSON.parse(fs.readFileSync(path.join(outDir, "latest.json"), "utf8"));
      assert.equal(out.kind, "monthly");
      assert.equal(out.period_start, "2026-05-01");
      assert.equal(out.period_end, "2026-05-31");
      assert.equal(out.period_label, "2026-05");
      assert.ok(out.items.length > 0);
      assert.ok(out.items.length <= 20);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);

test("build-monthly: self-gates and exits 0 on non-first-Monday",
  { skip: !process.env.RUN_SMOKE },
  () => {
    // 2026-06-08 is the SECOND Monday of June; without FORCE_RUN the script should no-op.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-monthly-gate-"));
    try {
      const r = spawnSync("node", ["scripts/build-monthly.mjs"], {
        cwd: ROOT,
        env: {
          ...process.env,
          LLM_SKIP: "1",
          PUBLISH_NOW: "2026-06-08T02:30:00Z",
          DIGEST_OUT_DIR: outDir,
        },
        stdio: "pipe",
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout.toString(), /not the first Monday/i);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);
