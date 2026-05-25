import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThemesResponse } from "../lib/digest-core.mjs";

test("parseThemesResponse: well-formed JSON returns themes array", () => {
  const raw = `{"themes":[{"title":"利率上行预期回潮","item_indices":[1,3,7]},{"title":"机构资本回笼","item_indices":[5,12]}]}`;
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i + 1}` }));
  const res = parseThemesResponse(raw, items);
  assert.equal(res.length, 2);
  assert.equal(res[0].title, "利率上行预期回潮");
  assert.deepEqual(res[0].item_ids, ["id-1", "id-3", "id-7"]);
});

test("parseThemesResponse: extracts JSON from markdown fence", () => {
  const raw = "```json\n{\"themes\":[{\"title\":\"X\",\"item_indices\":[1]}]}\n```";
  const items = [{ id: "id-1" }];
  const res = parseThemesResponse(raw, items);
  assert.equal(res.length, 1);
});

test("parseThemesResponse: extracts JSON from prose-wrapped output", () => {
  const raw = "Here are the themes:\n{\"themes\":[{\"title\":\"Y\",\"item_indices\":[2]}]}\n\nNote: these are summarized.";
  const items = [{ id: "id-1" }, { id: "id-2" }];
  const res = parseThemesResponse(raw, items);
  assert.equal(res.length, 1);
  assert.deepEqual(res[0].item_ids, ["id-2"]);
});

test("parseThemesResponse: drops out-of-range indices silently", () => {
  const raw = `{"themes":[{"title":"X","item_indices":[1,999,2]}]}`;
  const items = [{ id: "id-1" }, { id: "id-2" }];
  const res = parseThemesResponse(raw, items);
  assert.deepEqual(res[0].item_ids, ["id-1", "id-2"]);
});

test("parseThemesResponse: drops themes with zero valid item_ids", () => {
  const raw = `{"themes":[{"title":"Empty","item_indices":[999]},{"title":"OK","item_indices":[1]}]}`;
  const items = [{ id: "id-1" }];
  const res = parseThemesResponse(raw, items);
  assert.equal(res.length, 1);
  assert.equal(res[0].title, "OK");
});

test("parseThemesResponse: malformed string returns empty (fail-open)", () => {
  assert.deepEqual(parseThemesResponse("not json at all", [{ id: "x" }]), []);
});

test("parseThemesResponse: empty / null input returns []", () => {
  assert.deepEqual(parseThemesResponse("", [{ id: "x" }]), []);
  assert.deepEqual(parseThemesResponse(null, [{ id: "x" }]), []);
  assert.deepEqual(parseThemesResponse(undefined, [{ id: "x" }]), []);
});

test("parseThemesResponse: caps title length to 50 chars", () => {
  const longTitle = "本周主线".repeat(30);
  const raw = JSON.stringify({ themes: [{ title: longTitle, item_indices: [1] }] });
  const res = parseThemesResponse(raw, [{ id: "id-1" }]);
  assert.ok(res[0].title.length <= 50);
});

test("parseThemesResponse: ignores non-object response", () => {
  assert.deepEqual(parseThemesResponse(`[1,2,3]`, [{ id: "x" }]), []);
});

test("generateThemes: returns error when callLLM is not provided", async () => {
  const { generateThemes } = await import("../lib/digest-core.mjs");
  const r = await generateThemes([{ id: "x" }], {});
  assert.equal(r.themes.length, 0);
  assert.match(r.error, /callLLM/);
});

test("generateThemes: returns error when items is empty", async () => {
  const { generateThemes } = await import("../lib/digest-core.mjs");
  const r = await generateThemes([], { callLLM: async () => "{}" });
  assert.equal(r.themes.length, 0);
  assert.match(r.error, /empty/);
});

test("generateThemes: passes correct prompts to callLLM", async () => {
  const { generateThemes } = await import("../lib/digest-core.mjs");
  let receivedSystem, receivedUser;
  const fakeLLM = async (s, u) => {
    receivedSystem = s; receivedUser = u;
    return `{"themes":[{"title":"主线A","item_indices":[1,2]}]}`;
  };
  const items = [
    { id: "id-1", section: "national", importance: 5, title_zh: "标题1", summary_zh: "摘要1" },
    { id: "id-2", section: "cre", importance: 4, title_zh: "标题2", summary_zh: "摘要2" },
  ];
  const r = await generateThemes(items, { callLLM: fakeLLM, periodLabel: "本周" });
  assert.equal(r.themes.length, 1);
  assert.match(receivedSystem, /本周/);
  assert.match(receivedUser, /\[1\] section=national/);
  assert.match(receivedUser, /\[2\] section=cre/);
});

test("generateThemes: LLM throw becomes error in result (fail-open)", async () => {
  const { generateThemes } = await import("../lib/digest-core.mjs");
  const r = await generateThemes(
    [{ id: "x", title_zh: "T", summary_zh: "S", section: "national", importance: 5 }],
    { callLLM: async () => { throw new Error("boom"); } }
  );
  assert.equal(r.themes.length, 0);
  assert.match(r.error, /LLM call failed.*boom/);
});

test("generateThemes: LLM returns garbage → returns error + raw_preview", async () => {
  const { generateThemes } = await import("../lib/digest-core.mjs");
  const r = await generateThemes(
    [{ id: "x", title_zh: "T", summary_zh: "S", section: "national", importance: 5 }],
    { callLLM: async () => "I am not JSON" }
  );
  assert.equal(r.themes.length, 0);
  assert.match(r.error, /parse returned 0/);
  assert.ok(r.raw_preview);
});
