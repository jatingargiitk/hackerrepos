import { describe, expect, it } from "vitest";
import { aggregate } from "../src/aggregate.ts";
import { assemble, isCandidate, splitContexts } from "../src/build.ts";
import type { MetaCache } from "../src/github.ts";
import type { HnItem } from "../src/hn.ts";
import { FLAG_STORY, contextCount, contextShard } from "../src/rank.ts";

const DAY = 86400;
let nextId = 1;
const c = (author: string, html: string, day = 100): HnItem => ({
  id: nextId++, type: "comment", author, time: day * DAY, html, storyId: 1, storyTitle: "Thread", storyUrl: "", points: 0,
});
const story = (author: string, url: string, points: number): HnItem => ({
  id: nextId++, type: "story", author, time: 50 * DAY, html: "", storyId: 0, storyTitle: "Show HN: it", storyUrl: url, points,
});

const items = [
  c("a", "I use github.com/old/name"),
  c("b", "github.com/fresh/name is great"),
  c("c", "github.com/Old/Name"),
  c("a", "github.com/solo/one"),
  c("x", "github.com/gone/repo"),
  c("y", "github.com/gone/repo"),
  story("s", "https://github.com/big/launch", 450),
  story("t", "https://github.com/small/launch", 12),
];

const fetched = "2026-11-01T00:00:00Z";
const meta: MetaCache = {
  "old/name": { name: "Fresh/Name", stars: 5, language: "Go", description: "d", fetched, createdAt: "1970-03-01T00:00:00Z", pushedAt: "2026-10-01T00:00:00Z" },
  "fresh/name": { name: "Fresh/Name", stars: 5, language: "Go", description: "d", fetched },
  "gone/repo": { name: null, fetched },
  "big/launch": { name: "big/launch", stars: 9000, fetched, archived: true, topics: ["x"] },
};

describe("isCandidate", () => {
  const by = aggregate(items);
  it("needs three recommenders (by default) or a big story", () => {
    expect(isCandidate(by.get("old/name")!)).toBe(false);
    expect(isCandidate(by.get("old/name")!, 2)).toBe(true);
    expect(isCandidate(by.get("solo/one")!)).toBe(false);
    expect(isCandidate(by.get("big/launch")!)).toBe(true);
    expect(isCandidate(by.get("small/launch")!)).toBe(false);
  });
});

describe("assemble", () => {
  const data = assemble(aggregate(items), meta, { comments: 6, stories: 2 }, { from: 0, to: 200 * DAY, generated: "g" });

  it("merges renamed repos under GitHub's canonical name (2 + 1 recommenders = listed) and drops deleted ones", () => {
    expect(data.repos.map((r) => r.n)).toEqual(["Fresh/Name", "big/launch"]);
    expect(data.repos[0]?.m).toHaveLength(3);
  });
  it("carries GitHub metadata in compact form", () => {
    expect(data.repos[0]).toMatchObject({ d: "d", l: "Go", s: 5, c: "1970-03", u: "2026-10" });
    expect(data.repos[1]).toMatchObject({ a: 1, t: ["x"] });
  });
  it("encodes mentions as [day, author index, weight×100, flags]", () => {
    const [d, ai, w, f] = data.repos[1]!.m[0]!;
    expect([d, data.authors[ai], f]).toEqual([50, "s", FLAG_STORY]);
    expect(w).toBeGreaterThan(200);
  });
  it("keeps context with HN ids", () => {
    expect(data.repos[0]?.x?.map((x) => x.a).sort()).toEqual(["a", "b", "c"]);
    expect(data.repos[1]?.x?.[0]).toMatchObject({ a: "s", p: 450 });
  });
  it("reports stats", () => {
    expect(data.stats).toEqual({ comments: 6, stories: 2, mentions: 8, repos: 6, listed: 2 });
    expect(data.generated).toBe("g");
  });
  it("works without GitHub metadata", () => {
    const bare = assemble(aggregate(items), null, { comments: 6, stories: 2 }, { from: 0, to: 1, minRecommenders: 2 });
    expect(bare.repos.map((r) => r.n).sort()).toEqual(["big/launch", "gone/repo", "old/name"]);
  });
  it("ignores mentions from before the repo was created (an earlier repo with that name)", () => {
    const old = ["p", "q", "r"].map((a) => c(a, "github.com/someone/reborn", 100));
    const fresh = c("s", "github.com/someone/reborn", 400);
    const m: MetaCache = { "someone/reborn": { name: "someone/reborn", stars: 3, fetched, createdAt: new Date(300 * DAY * 1000).toISOString() } };
    expect(assemble(aggregate([...old, fresh]), m, { comments: 4, stories: 0 }, { from: 0, to: 500 * DAY }).repos).toEqual([]);
    const ok: MetaCache = { "someone/reborn": { ...m["someone/reborn"]!, createdAt: new Date(50 * DAY * 1000).toISOString() } };
    expect(assemble(aggregate([...old, fresh]), ok, { comments: 4, stories: 0 }, { from: 0, to: 500 * DAY }).repos[0]?.m).toHaveLength(4);
  });
  it("never lists reference repos like github/dmca", () => {
    const dmca = ["p", "q", "r"].map((a) => c(a, "see github.com/github/dmca/blob/master/2014/foo.md"));
    const d = assemble(aggregate(dmca), null, { comments: 3, stories: 0 }, { from: 0, to: 1 });
    expect(d.repos).toEqual([]);
  });
});

describe("splitContexts", () => {
  const data = assemble(aggregate(items), meta, { comments: 6, stories: 2 }, { from: 0, to: 200 * DAY, generated: "g" });
  const { data: core, files } = splitContexts(data, 16);
  it("moves contexts into shard files keyed by lower-cased name", () => {
    expect(core.ctx).toBe(16);
    expect(core.repos.every((r) => r.x === undefined)).toBe(true);
    const shard = files.get(contextShard("Fresh/Name", 16));
    expect(shard?.["fresh/name"]).toEqual(data.repos[0]?.x);
  });
  it("keeps the context count for the site's Why? button", () => {
    expect(core.repos.map(contextCount)).toEqual(data.repos.map(contextCount));
    expect(contextCount(core.repos[0]!)).toBe(3);
  });
  it("leaves the input untouched", () => {
    expect(data.repos[0]?.x).toHaveLength(3);
  });
});

describe("contextShard", () => {
  it("is case-insensitive, two hex digits and spreads names out", () => {
    expect(contextShard("Fresh/Name", 256)).toBe(contextShard("fresh/name", 256));
    expect(contextShard("a/b", 256)).toMatch(/^[0-9a-f]{2}$/);
    const ids = new Set(Array.from({ length: 2000 }, (_, i) => contextShard(`owner${i}/repo`, 256)));
    expect(ids.size).toBeGreaterThan(240);
  });
});
