import { describe, expect, it } from "vitest";
import { buildQuery, enrich, isQueryable, parseRepo, resolveToken, type MetaCache } from "../src/github.ts";

const gql = (name: string, stars = 10) => ({
  nameWithOwner: name, description: " A tool ", stargazerCount: stars, isArchived: false, isFork: false,
  createdAt: "2015-01-02T00:00:00Z", pushedAt: "2026-10-01T00:00:00Z",
  primaryLanguage: { name: "Rust" }, repositoryTopics: { nodes: [{ topic: { name: "cli" } }] },
});

describe("buildQuery", () => {
  it("aliases one repository() per key and asks for the rate limit", () => {
    const q = buildQuery(["a/b", "c/d.js"]);
    expect(q).toContain('r0: repository(owner: "a", name: "b")');
    expect(q).toContain('r1: repository(owner: "c", name: "d.js")');
    expect(q).toContain("rateLimit");
  });
});

describe("parseRepo", () => {
  it("keeps the canonical name and trims fields", () => {
    expect(parseRepo(gql("New/Name"), "t")).toEqual({
      name: "New/Name", description: "A tool", language: "Rust", stars: 10, archived: undefined, fork: undefined,
      topics: ["cli"], createdAt: "2015-01-02T00:00:00Z", pushedAt: "2026-10-01T00:00:00Z", fetched: "t",
    });
  });
  it("marks missing repos as gone", () => {
    expect(parseRepo(null, "t")).toEqual({ name: null, fetched: "t" });
  });
});

describe("isQueryable", () => {
  it("accepts valid names and rejects junk", () => {
    expect(isQueryable("rust-lang/rust")).toBe(true);
    expect(isQueryable('a/b"){x}')).toBe(false);
    expect(isQueryable("a")).toBe(false);
  });
});

describe("resolveToken", () => {
  it("prefers GITHUB_TOKEN, then GH_TOKEN", () => {
    expect(resolveToken({ GITHUB_TOKEN: "one", GH_TOKEN: "two" })).toBe("one");
    expect(resolveToken({ GH_TOKEN: "two" })).toBe("two");
  });
});

describe("enrich", () => {
  it("batches uncached keys, follows renames and records deleted repos", async () => {
    const bodies: string[] = [];
    const impl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ data: { rateLimit: { remaining: 4000 }, r0: gql("Owner/Renamed"), r1: null } }));
    }) as typeof fetch;
    const cache: MetaCache = { "cached/repo": { name: "cached/repo", fetched: new Date().toISOString() } };
    await enrich(["old/name", "gone/repo", "cached/repo", "bad name/x"], { token: "t", cache, fetchImpl: impl });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("cached");
    expect(cache["old/name"]?.name).toBe("Owner/Renamed");
    expect(cache["gone/repo"]?.name).toBeNull();
  });
  it("refetches stale entries", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: { r0: gql("a/b", 99) } }));
    }) as typeof fetch;
    const cache: MetaCache = { "a/b": { name: "a/b", stars: 1, fetched: "2020-01-01T00:00:00Z" } };
    await enrich(["a/b"], { token: "t", cache, fetchImpl: impl, maxAgeDays: 7 });
    expect(calls).toBe(1);
    expect(cache["a/b"]?.stars).toBe(99);
  });
});
