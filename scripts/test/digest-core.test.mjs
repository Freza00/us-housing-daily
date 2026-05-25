import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadDailyHistory,
  reRankWithQuota,
  SECTIONS_DAILY,
} from "../lib/digest-core.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");

test("SECTIONS_DAILY: quotas sum to 20", () => {
  const sum = SECTIONS_DAILY.reduce((a, s) => a + s.quota, 0);
  assert.equal(sum, 20);
});

test("loadDailyHistory: real May 2026 files load + dedupe by link", () => {
  const dates = ["2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22", "2026-05-23"];
  const res = loadDailyHistory(dates, DATA_DIR);
  assert.ok(res.items.length > 0, "should load at least 1 item");
  assert.ok(res.loaded_dates.length >= 1);
  const links = res.items.map(it => it.link);
  assert.equal(new Set(links).size, links.length, "all links unique after dedupe");
  for (const it of res.items) {
    assert.ok(it.source_date, `item ${it.id} missing source_date`);
    assert.match(it.source_date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("loadDailyHistory: missing files reported in errors, doesn't throw", () => {
  const dates = ["2026-05-19", "1999-01-01"];
  const res = loadDailyHistory(dates, DATA_DIR);
  assert.ok(res.errors.find(e => e.includes("1999-01-01")), "missing date in errors");
  assert.ok(res.items.length > 0, "valid dates still loaded");
});

test("reRankWithQuota: respects section quotas + per-source cap", () => {
  const items = [];
  // 30 'national' items from one source — should cap to 2 in national section
  for (let i = 0; i < 30; i++) {
    items.push({
      id: `n${i}`, link: `https://x.com/n${i}`,
      source_id: "src-a", section: "national",
      importance: 5, score: 100 - i,
      published_at: Date.now() - i * 3600 * 1000,
    });
  }
  // 5 'cre' items from 5 distinct sources, all importance 5
  for (let i = 0; i < 5; i++) {
    items.push({
      id: `c${i}`, link: `https://x.com/c${i}`,
      source_id: `src-${i}`, section: "cre",
      importance: 5, score: 50,
      published_at: Date.now() - 2 * 3600 * 1000,
    });
  }
  const top = reRankWithQuota(items, SECTIONS_DAILY, { perSourceCap: 2 });
  const natCount = top.filter(it => it.section === "national").length;
  const creCount = top.filter(it => it.section === "cre").length;
  assert.ok(natCount <= 5, "national capped at quota=5");
  const srcACount = top.filter(it => it.source_id === "src-a").length;
  assert.ok(srcACount <= 2, "per-source cap holds");
  assert.ok(creCount <= 5, "cre capped at quota=5");
});

test("reRankWithQuota: sorts by importance*100 + score - age penalty", () => {
  const now = Date.now();
  const items = [
    { id: "old-hi-imp",  link: "u1", source_id: "s1", section: "national",
      importance: 5, score: 10, published_at: now - 7 * 24 * 3600 * 1000 },
    { id: "new-low-imp", link: "u2", source_id: "s2", section: "national",
      importance: 2, score: 90, published_at: now - 1 * 3600 * 1000 },
  ];
  const top = reRankWithQuota(items, SECTIONS_DAILY, { perSourceCap: 2 });
  // 5*100 + 10 - (168/168)*30 = 480 ≫ 2*100 + 90 - small = ~290
  assert.equal(top[0].id, "old-hi-imp", "high importance should win");
});

test("reRankWithQuota: drops items with no matching section", () => {
  const items = [
    { id: "a", link: "u1", source_id: "s", section: "national", importance: 5, score: 50, published_at: Date.now() },
    { id: "b", link: "u2", source_id: "s", section: "nonsense", importance: 5, score: 50, published_at: Date.now() },
  ];
  const top = reRankWithQuota(items, SECTIONS_DAILY, { perSourceCap: 2 });
  assert.equal(top.length, 1, "only matched section item survives");
  assert.equal(top[0].id, "a");
});

test("reRankWithQuota: result items don't carry _rerank internal field", () => {
  const items = [
    { id: "x", link: "u", source_id: "s", section: "national", importance: 5, score: 50, published_at: Date.now() },
  ];
  const top = reRankWithQuota(items, SECTIONS_DAILY, { perSourceCap: 2 });
  assert.equal(top[0]._rerank, undefined, "internal scoring field stripped");
});
