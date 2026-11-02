import { describe, expect, it } from "vitest";
import { aggregate, mentionsFromItem, pickContexts, recommenderCount, type RawMention } from "../src/aggregate.ts";
import type { HnItem } from "../src/hn.ts";

const DAY = 86400;
const comment = (id: number, author: string, html: string, extra: Partial<HnItem> = {}): HnItem => ({
  id, type: "comment", author, time: 100 * DAY + id, html, storyId: 1, storyTitle: "Ask HN: Favourite CLI tools?",
  storyUrl: "", points: 0, ...extra,
});

describe("mentionsFromItem", () => {
  it("turns a comment into one mention per repo with a snippet", () => {
    const ms = mentionsFromItem(comment(5, "alice", "I use github.com/junegunn/fzf and github.com/BurntSushi/ripgrep"));
    expect(ms.map((m) => [m.key, m.weight, m.recommend, m.self])).toEqual([
      ["junegunn/fzf", 1.25, true, false],
      ["burntsushi/ripgrep", 1.25, true, false],
    ]);
    expect(ms[0]?.snippet).toContain("github.com/junegunn/fzf");
    expect(ms[0]?.day).toBe(100);
  });
  it("skips the repo a thread is about", () => {
    const ms = mentionsFromItem(comment(6, "bob", "see github.com/a/b/issues/3 and github.com/c/d", { storyUrl: "https://github.com/A/B" }));
    expect(ms.map((m) => m.key)).toEqual(["c/d"]);
  });
  it("marks the owner's own links as self-promotion", () => {
    const [m] = mentionsFromItem(comment(7, "carol", "github.com/carol/thing"));
    expect(m).toMatchObject({ self: true, weight: 0.5 });
  });
  it("only applies 'I built' to a single-link comment", () => {
    const ms = mentionsFromItem(comment(8, "dan", "I built a thing like github.com/x/one and github.com/y/two"));
    expect(ms.every((m) => !m.self)).toBe(true);
  });
  it("turns a github story into a story mention weighted by points", () => {
    const story: HnItem = { id: 9, type: "story", author: "eve", time: 0, html: "", storyId: 9, storyTitle: "Show HN: Thing", storyUrl: "https://github.com/eve2/thing", points: 99 };
    expect(mentionsFromItem(story)).toMatchObject([{ key: "eve2/thing", story: true, weight: 2, points: 99 }]);
  });
  it("ignores stories that link a GitHub issue", () => {
    const story: HnItem = { id: 10, type: "story", author: "f", time: 0, html: "", storyId: 10, storyTitle: "Bug", storyUrl: "https://github.com/a/b/issues/1", points: 500 };
    expect(mentionsFromItem(story)).toEqual([]);
  });
});

describe("aggregate", () => {
  it("groups across items", () => {
    const by = aggregate([comment(1, "a", "github.com/x/y"), comment(2, "b", "github.com/X/Y"), comment(3, "c", "github.com/z/w")]);
    expect([...by.keys()]).toEqual(["x/y", "z/w"]);
    expect(by.get("x/y")).toHaveLength(2);
  });
});

const m = (author: string, extra: Partial<RawMention> = {}): RawMention => ({
  key: "x/y", name: "x/y", day: 1, author, weight: 1, self: false, story: false, recommend: false,
  itemId: 1, storyId: 1, storyTitle: "", snippet: "s", points: 0, ...extra,
});

describe("recommenderCount", () => {
  it("counts distinct non-self authors", () => {
    expect(recommenderCount([m("a"), m("a"), m("b"), m("c", { self: true }), m("c")])).toBe(2);
  });
});

describe("pickContexts", () => {
  it("prefers third-party recommendations, one per person", () => {
    const picked = pickContexts([m("self", { self: true, recommend: true }), m("plain"), m("fan", { recommend: true }), m("fan", { recommend: true })], 2);
    expect(picked.map((p) => p.author)).toEqual(["fan", "plain"]);
  });
});
