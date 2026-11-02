import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crawl, fetchWindow, toItem, windowUrl, windows } from "../src/hn.ts";

/** A fake Algolia that holds `times` and enforces the 1,000-hit cap (scaled down to `cap`). */
function fakeAlgolia(times: number[], cap = 3) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const [lo, hi] = (u.searchParams.get("numericFilters") ?? "").match(/\d+/g)!.map(Number) as [number, number];
    const inside = times.filter((t) => t >= lo && t < hi);
    const hits = inside.slice(0, cap).map((t) => ({ objectID: String(t), author: `u${t}`, created_at_i: t, comment_text: `github.com/o/r${t}` }));
    return new Response(JSON.stringify({ nbHits: inside.length, hits }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("windowUrl", () => {
  it("asks for github.com comments in a half-open time window", () => {
    const u = new URL(windowUrl("comment", 10, 20));
    expect(u.searchParams.get("query")).toBe("github.com");
    expect(u.searchParams.get("tags")).toBe("comment");
    expect(u.searchParams.get("numericFilters")).toBe("created_at_i>=10,created_at_i<20");
    expect(u.searchParams.get("hitsPerPage")).toBe("1000");
    expect(u.searchParams.has("restrictSearchableAttributes")).toBe(false);
  });
  it("restricts stories to their url", () => {
    expect(new URL(windowUrl("story", 0, 1)).searchParams.get("restrictSearchableAttributes")).toBe("url");
  });
});

describe("windows", () => {
  it("covers the range without gaps", () => {
    expect(windows(0, 25, 10)).toEqual([[0, 10], [10, 20], [20, 25]]);
  });
});

describe("toItem", () => {
  it("maps comments and stories", () => {
    expect(toItem({ objectID: "5", author: "a", created_at_i: 9, comment_text: "x", story_id: 1, story_title: "T", story_url: "U" }, "comment"))
      .toEqual({ id: 5, type: "comment", author: "a", time: 9, html: "x", storyId: 1, storyTitle: "T", storyUrl: "U", points: 0 });
    expect(toItem({ objectID: "7", author: "b", created_at_i: 3, title: "Show HN", url: "https://github.com/a/b", points: 42 }, "story"))
      .toMatchObject({ id: 7, storyId: 7, storyUrl: "https://github.com/a/b", points: 42 });
  });
});

describe("fetchWindow", () => {
  it("halves windows until every slice fits under the cap", async () => {
    const times = [100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const { impl, calls } = fakeAlgolia(times);
    const items = await fetchWindow("comment", 0, 1000, impl);
    expect(items.map((i) => i.time).sort((a, b) => a - b)).toEqual(times);
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe("crawl", () => {
  it("caches settled windows and reuses them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hr-"));
    const { impl, calls } = fakeAlgolia([5, 15, 25]);
    const first = await crawl({ from: 0, to: 30, windowSec: 10, types: ["comment"], cacheDir: dir, fetchImpl: impl });
    expect(first.map((i) => i.id)).toEqual([5, 15, 25]);
    expect(await readdir(join(dir, "comment"))).toHaveLength(3);
    const before = calls.length;
    const second = await crawl({ from: 0, to: 30, windowSec: 10, types: ["comment"], cacheDir: dir, fetchImpl: impl });
    expect(second).toEqual(first);
    expect(calls.length).toBe(before);
  });
  it("retries transient errors", async () => {
    let n = 0;
    const impl = (async () => {
      if (n++ === 0) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ nbHits: 0, hits: [] }));
    }) as typeof fetch;
    expect(await fetchWindow("story", 0, 10, impl)).toEqual([]);
    expect(n).toBe(2);
  });
});
