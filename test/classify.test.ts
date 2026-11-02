import { describe, expect, it } from "vitest";
import { isRecommendation, isSelfPromotion, mentionWeight } from "../src/classify.ts";

describe("isRecommendation", () => {
  it.each([
    "Check out ripgrep, it's much faster",
    "I highly recommend this",
    "I've been using it for years",
    "We switched to it last year",
    "Have a look at github.com/a/b",
    "fzf is a game changer",
  ])("yes: %s", (t) => expect(isRecommendation(t)).toBe(true));
  it.each([
    "This crashes, see the issue",
    "The bug was introduced in this commit",
  ])("no: %s", (t) => expect(isRecommendation(t)).toBe(false));
});

describe("isSelfPromotion", () => {
  it("flags the repo owner", () => {
    expect(isSelfPromotion("neutral text", "Alice", "alice")).toBe(true);
  });
  it.each(["I built this last year", "Shameless plug:", "my side project does this", "Author here!", "I'm the maintainer"])(
    "flags %j",
    (t) => expect(isSelfPromotion(t, "bob", "carol")).toBe(true),
  );
  it("does not flag third-party praise", () => {
    expect(isSelfPromotion("Their library is excellent", "bob", "carol")).toBe(false);
  });
});

describe("mentionWeight", () => {
  it("weights repo links fully and bug links at a quarter", () => {
    expect(mentionWeight({ kind: "repo", self: false, recommend: false })).toBe(1);
    expect(mentionWeight({ kind: "issue", self: false, recommend: false })).toBe(0.25);
    expect(mentionWeight({ kind: "commit", self: false, recommend: false })).toBe(0.25);
    expect(mentionWeight({ kind: "path", self: false, recommend: false })).toBe(0.75);
  });
  it("boosts recommendation language and halves self-promotion", () => {
    expect(mentionWeight({ kind: "repo", self: false, recommend: true })).toBe(1.25);
    expect(mentionWeight({ kind: "repo", self: true, recommend: false })).toBe(0.5);
  });
  it("gives stories a capped bonus for points", () => {
    expect(mentionWeight({ kind: "story", self: false, recommend: false, points: 0 })).toBe(1);
    expect(mentionWeight({ kind: "story", self: false, recommend: false, points: 99 })).toBe(2);
    expect(mentionWeight({ kind: "story", self: false, recommend: false, points: 100000 })).toBe(2.5);
  });
});
