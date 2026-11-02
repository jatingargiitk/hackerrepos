import { describe, expect, it } from "vitest";
import { FLAG_SELF, FLAG_STORY, query, scoreRepo, windowDays, type CompactMention, type Dataset, type RepoRecord } from "../src/rank.ts";

const repo = (n: string, m: CompactMention[], extra: Partial<RepoRecord> = {}): RepoRecord => ({ n, m, x: [], ...extra });

describe("scoreRepo", () => {
  it("counts each person once, at their best weight", () => {
    const s = scoreRepo([[1, 0, 100, 0], [2, 0, 100, 0], [3, 0, 125, 0], [4, 1, 25, 0]]);
    expect(s).toEqual({ score: 1.5, recommenders: 2, mentions: 4, last: 4 });
  });
  it("does not count self-promoters as recommenders", () => {
    const s = scoreRepo([[1, 0, 50, FLAG_SELF], [2, 1, 100, 0]]);
    expect(s.recommenders).toBe(1);
    expect(s.score).toBe(1.5);
  });
  it("applies the window", () => {
    expect(scoreRepo([[10, 0, 100, 0], [20, 1, 100, 0]], { sinceDay: 15 })).toMatchObject({ score: 1, mentions: 1 });
  });
  it("halves a mention one half-life old", () => {
    expect(scoreRepo([[0, 0, 100, 0]], { halfLifeDays: 90, nowDay: 90 }).score).toBe(0.5);
  });
  it("returns zeros for nothing", () => {
    expect(scoreRepo([])).toEqual({ score: 0, recommenders: 0, mentions: 0, last: 0 });
  });
});

describe("windowDays", () => {
  it.each([["30d", 30], ["2w", 14], ["6m", 180], ["2y", 730], ["all", Infinity], [undefined, Infinity]])("%s", (w, d) => {
    expect(windowDays(w)).toBe(d);
  });
  it("rejects nonsense", () => {
    expect(() => windowDays("soon")).toThrow(/Bad window/);
  });
});

const day = 20000;
const data: Dataset = {
  version: 1, generated: "2026-11-02T00:00:00Z", from: 0, to: day * 86400,
  stats: { comments: 0, stories: 0, mentions: 0, repos: 0, listed: 0 },
  authors: ["a", "b", "c", "d"],
  repos: [
    repo("old/famous", [[day - 3000, 0, 100, 0], [day - 3000, 1, 100, 0], [day - 2900, 2, 100, 0]], { l: "C", s: 50000 }),
    repo("new/hot", [[day - 10, 0, 100, 0], [day - 5, 1, 100, 0]], { l: "Rust", s: 300, d: "fast thing" }),
    repo("small/gem", [[day - 400, 0, 100, 0], [day - 300, 1, 100, 0], [day - 200, 3, 100, 0]], { l: "Go", s: 120, t: ["cli"] }),
    repo("dead/repo", [[day - 1, 0, 100, 0], [day - 1, 1, 100, 0], [day - 1, 2, 100, 0], [day - 1, 3, 100, 0]], { a: 1 }),
    repo("story/only", [[day - 100, 2, 230, FLAG_STORY]], { l: "Rust", s: 9000 }),
  ],
};

describe("query", () => {
  it("ranks all-time by score and hides archived repos", () => {
    expect(query(data).map((r) => r.repo.n)).toEqual(["old/famous", "small/gem", "story/only", "new/hot"]);
  });
  it("can include archived repos", () => {
    expect(query(data, { includeArchived: true })[0]?.repo.n).toBe("dead/repo");
  });
  it("filters by window", () => {
    expect(query(data, { window: "30d" }).map((r) => r.repo.n)).toEqual(["new/hot"]);
  });
  it("filters by language, case-insensitively", () => {
    expect(query(data, { language: "rust" }).map((r) => r.repo.n)).toEqual(["story/only", "new/hot"]);
  });
  it("finds hidden gems", () => {
    expect(query(data, { gems: true }).map((r) => r.repo.n)).toEqual(["small/gem"]);
  });
  it("searches names, descriptions and topics", () => {
    expect(query(data, { search: "FAST" }).map((r) => r.repo.n)).toEqual(["new/hot"]);
    expect(query(data, { search: "cli" }).map((r) => r.repo.n)).toEqual(["small/gem"]);
  });
  it("sorts by trending, stars and recency", () => {
    expect(query(data, { sort: "trending" })[0]?.repo.n).toBe("new/hot");
    expect(query(data, { sort: "stars" })[0]?.repo.n).toBe("old/famous");
    expect(query(data, { sort: "recent" })[0]?.repo.n).toBe("new/hot");
  });
  it("limits", () => {
    expect(query(data, { limit: 2 })).toHaveLength(2);
  });
});
