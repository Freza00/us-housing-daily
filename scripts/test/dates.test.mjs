import { test } from "node:test";
import assert from "node:assert/strict";
import {
  etWeekBounds,
  etMonthBounds,
  firstMondayOfMonth,
  isFirstMondayOfMonth,
  beijingDateStr,
  beijingDatesCoveringEtRange,
} from "../lib/dates.mjs";

test("etWeekBounds: Beijing Mon 2026-06-01 covers ET 2026-05-25 → 2026-05-31", () => {
  const r = etWeekBounds(new Date("2026-06-01T02:00:00Z"));
  assert.equal(r.periodStart, "2026-05-25");
  assert.equal(r.periodEnd, "2026-05-31");
});

test("etWeekBounds: handles year-crossing week (Beijing Mon 2027-01-04 → ET 2026-12-28 → 2027-01-03)", () => {
  const r = etWeekBounds(new Date("2027-01-04T02:00:00Z"));
  assert.equal(r.periodStart, "2026-12-28");
  assert.equal(r.periodEnd, "2027-01-03");
});

test("etMonthBounds: Beijing first-Mon of June 2026 (2026-06-01) covers ET May 2026", () => {
  const r = etMonthBounds(new Date("2026-06-01T02:30:00Z"));
  assert.equal(r.periodStart, "2026-05-01");
  assert.equal(r.periodEnd, "2026-05-31");
  assert.equal(r.label, "2026-05");
});

test("etMonthBounds: first-Mon of Jan 2027 covers Dec 2026", () => {
  const r = etMonthBounds(new Date("2027-01-04T02:30:00Z"));
  assert.equal(r.periodStart, "2026-12-01");
  assert.equal(r.periodEnd, "2026-12-31");
  assert.equal(r.label, "2026-12");
});

test("firstMondayOfMonth: June 2026 = June 1", () => {
  assert.equal(firstMondayOfMonth(2026, 6), "2026-06-01");
});

test("firstMondayOfMonth: Feb 2026 = Feb 2", () => {
  assert.equal(firstMondayOfMonth(2026, 2), "2026-02-02");
});

test("firstMondayOfMonth: Aug 2026 = Aug 3", () => {
  assert.equal(firstMondayOfMonth(2026, 8), "2026-08-03");
});

test("isFirstMondayOfMonth: true on 2026-06-01 Beijing morning", () => {
  assert.equal(isFirstMondayOfMonth(new Date("2026-06-01T02:30:00Z")), true);
});

test("isFirstMondayOfMonth: false on 2026-06-08 (second Mon)", () => {
  assert.equal(isFirstMondayOfMonth(new Date("2026-06-08T02:30:00Z")), false);
});

test("beijingDateStr: 2026-05-25T15:30Z is Beijing 2026-05-25", () => {
  assert.equal(beijingDateStr(new Date("2026-05-25T15:30:00Z").getTime()), "2026-05-25");
});

test("beijingDateStr: 2026-05-25T16:30Z is Beijing 2026-05-26", () => {
  assert.equal(beijingDateStr(new Date("2026-05-25T16:30:00Z").getTime()), "2026-05-26");
});

test("beijingDatesCoveringEtRange: ET week 2026-05-25 → 2026-05-31 maps to Beijing 2026-05-25 → 2026-06-01", () => {
  const dates = beijingDatesCoveringEtRange("2026-05-25", "2026-05-31");
  assert.deepEqual(dates, [
    "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28",
    "2026-05-29", "2026-05-30", "2026-05-31", "2026-06-01",
  ]);
});
