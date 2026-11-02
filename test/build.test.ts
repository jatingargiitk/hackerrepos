import { describe, expect, it } from "vitest";
import { aggregate } from "../src/aggregate.ts";
import { assemble, isCandidate } from "../src/build.ts";
import type { MetaCache } from "../src/github.ts";
import type { HnItem } from "../src/hn.ts";
import { FLAG_STORY } from "../src/rank.ts";

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
  "old/name": { name: "Fresh/Name", stars: 5, language: "Go", description: "d", fetched, createdAt: "2019-04-01T00:00:00Z", pushedAt: "2026-10-01T00:00:00Z" },
  "fresh/name": { name: "Fresh/Name", stars: 5, language: "Go", description: "d", fetched },
  "gone/repo": { name: null, fetched },
  "big/launch": { name: "big/launch", stars: 9000, fetched, archived: true, topics: ["x"] },
};

describe("isCandidate", () => {
  const by = aggregate(items);
  it("needs two recommenders or a big story", () => {
    expect(isCandidate(by.get("old/name")!)).toBe(true);
    expect(isCandidate(by.get("solo/one")!)).toBe(false);
    expect(isCandidate(by.get("big/launch")!)).toBe(true);
    expect(isCandidate(by.get("small/launch")!)).toBe(false);
  });
});

describe("assemble", () => {
  const data = assemble(aggregate(items), meta, { comments: 6, stories: 2 }, { from: 0, to: 200 * DAY, generated: "g" });

  it("merges renamed repos under GitHub's canonical name and drops deleted ones", () => {
    expect(data.repos.map((r) => r.n)).toEqual(["Fresh/Name", "big/launch"]);
    expect(data.repos[0]?.m).toHaveLength(3);
  });
  it("carries GitHub metadata in compact form", () => {
    expect(data.repos[0]).toMatchObject({ d: "d", l: "Go", s: 5, c: "2019-04", u: "2026-10" });
    expect(data.repos[1]).toMatchObject({ a: 1, t: ["x"] });
  });
  it("encodes mentions as [day, author index, weight×100, flags]", () => {
    const [d, ai, w, f] = data.repos[1]!.m[0]!;
    expect([d, data.authors[ai], f]).toEqual([50, "s", FLAG_STORY]);
    expect(w).toBeGreaterThan(200);
  });
  it("keeps context with HN ids", () => {
    expect(data.repos[0]?.x.map((x) => x.a).sort()).toEqual(["a", "b", "c"]);
    expect(data.repos[1]?.x[0]).toMatchObject({ a: "s", p: 450 });
  });
  it("reports stats", () => {
    expect(data.stats).toEqual({ comments: 6, stories: 2, mentions: 8, repos: 6, listed: 2 });
    expect(data.generated).toBe("g");
  });
  it("works without GitHub metadata", () => {
    const bare = assemble(aggregate(items), null, { comments: 6, stories: 2 }, { from: 0, to: 1 });
    expect(bare.repos.map((r) => r.n).sort()).toEqual(["big/launch", "gone/repo", "old/name"]);
  });
  it("never lists reference repos like github/dmca", () => {
    const dmca = ["p", "q", "r"].map((a) => c(a, "see github.com/github/dmca/blob/master/2014/foo.md"));
    const d = assemble(aggregate(dmca), null, { comments: 3, stories: 0 }, { from: 0, to: 1 });
    expect(d.repos).toEqual([]);
  });
});
