import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextShard, scoreRepo, type CompactMention, type ScoreOptions, type Score } from "../src/rank.ts";

const html = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");

function port<T>(name: string): T {
  const src = new RegExp(`// BEGIN ${name}\\n([\\s\\S]*?)// END ${name}`).exec(html)?.[1];
  if (!src) throw new Error(`${name} block not found in docs/index.html`);
  return new Function(`${src}; return ${name};`)() as T;
}
const siteScore = () => port<(m: CompactMention[], o?: ScoreOptions) => Score>("scoreRepo");

/** Small deterministic PRNG so the fuzz is reproducible. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("docs/index.html", () => {
  it("scores exactly like src/rank.ts", () => {
    const site = siteScore();
    const rand = rng(42);
    for (let t = 0; t < 300; t++) {
      const mentions: CompactMention[] = Array.from({ length: Math.floor(rand() * 12) }, () => [
        Math.floor(rand() * 7000) + 13000, Math.floor(rand() * 6), [25, 50, 75, 100, 125, 233][Math.floor(rand() * 6)]!, Math.floor(rand() * 4),
      ]);
      const opts: ScoreOptions = rand() < 0.5 ? {} : { sinceDay: 16000 + Math.floor(rand() * 4000), nowDay: 20400, halfLifeDays: rand() < 0.5 ? 90 : undefined };
      expect(site(mentions, opts)).toEqual(scoreRepo(mentions, opts));
    }
  });
  it("finds context shards exactly like src/rank.ts", () => {
    const shard = port<(name: string, shards: number) => string>("contextShard");
    for (const name of ["junegunn/fzf", "Fresh/Name", "a/b", "ÜBER/ünïcode", "x/" + "y".repeat(100)]) {
      for (const n of [8, 16, 256]) expect(shard(name, n)).toBe(contextShard(name, n));
    }
  });
  it("is self-contained: no external scripts or stylesheets", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });
  it("loads the dataset relative to the page (works on GitHub Pages)", () => {
    expect(html).toContain('fetch("data/repos.json")');
    expect(html).toContain('fetch("data/ctx/" + id + ".json")');
  });
  it("credits HackerTube", () => {
    expect(html).toContain("https://karpathy.bearblog.dev/hacker-tube/");
  });
});
