import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

test("build-weekly: end-to-end smoke writes a non-empty digest",
  { skip: !process.env.RUN_SMOKE },
  () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-weekly-smoke-"));
    try {
      // Beijing 2026-05-25 02:00 UTC = Beijing Mon 10:00. ET week = 2026-05-18 → 2026-05-24.
      const r = spawnSync("node", ["scripts/build-weekly.mjs"], {
        cwd: ROOT,
        env: {
          ...process.env,
          LLM_SKIP: "1",
          PUBLISH_NOW: "2026-05-25T02:00:00Z",
          DIGEST_OUT_DIR: outDir,
        },
        stdio: "inherit",
      });
      assert.equal(r.status, 0, "build-weekly.mjs exited 0");

      const out = JSON.parse(fs.readFileSync(path.join(outDir, "latest.json"), "utf8"));
      assert.equal(out.kind, "weekly");
      assert.equal(out.period_start, "2026-05-18");
      assert.equal(out.period_end, "2026-05-24");
      assert.ok(out.items.length > 0, "must produce at least 1 item");
      assert.ok(out.items.length <= 20, "no more than 20 items");
      assert.ok(Array.isArray(out.themes), "themes array exists");
      assert.equal(out.themes.length, 0, "LLM_SKIP → empty themes");

      const dates = JSON.parse(fs.readFileSync(path.join(outDir, "dates.json"), "utf8"));
      assert.ok(dates.includes("2026-05-18"), "dates.json includes period_start");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
);
