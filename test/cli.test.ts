import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { splitContexts } from "../src/build.ts";
import { contextShard, type Dataset } from "../src/rank.ts";

const day = 20393; // 2025-11-01
const data: Dataset = {
  version: 1, generated: "2026-11-02T00:00:00Z", from: 1199145600, to: day * 86400,
  stats: { comments: 10, stories: 2, mentions: 12, repos: 5, listed: 3 },
  authors: ["a", "b", "c"],
  repos: [
    { n: "junegunn/fzf", d: "A command-line fuzzy finder", l: "Go", s: 70000, m: [[day - 900, 0, 100, 0], [day - 800, 1, 125, 0], [day - 700, 2, 100, 0]],
      x: [{ i: 111, a: "b", t: day - 800, k: 1, s: "Ask HN: CLI tools?", q: "I use fzf every day, check it out" }] },
    { n: "tiny/gem", d: "Small but loved", l: "Rust", s: 200, m: [[day - 20, 0, 100, 0], [day - 10, 1, 100, 0], [day - 5, 2, 100, 0]], x: [] },
    { n: "big/launch", l: "C", s: 5000, m: [[day - 3, 1, 233, 2]], x: [{ i: 222, a: "b", t: day - 3, k: 222, s: "Show HN: Big", q: "Show HN: Big", p: 450 }] },
  ],
};

let file = "";
beforeAll(async () => {
  file = join(await mkdtemp(join(tmpdir(), "hr-cli-")), "repos.json");
  await writeFile(file, JSON.stringify(data));
});

describe("cli with contexts split into shards", () => {
  it("loads a repo's HN comments from ctx/<shard>.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hr-cli-split-"));
    const { data: core, files } = splitContexts(data, 8);
    await mkdir(join(dir, "ctx"));
    for (const [id, f] of files) await writeFile(join(dir, "ctx", `${id}.json`), JSON.stringify(f));
    await writeFile(join(dir, "repos.json"), JSON.stringify(core));
    expect(files.has(contextShard("junegunn/fzf", 8))).toBe(true);
    const lines: string[] = [];
    expect(await main(["show", "junegunn/fzf", "--data", join(dir, "repos.json")], (s) => lines.push(s))).toBe(0);
    expect(lines.join("\n")).toContain("I use fzf every day");
  });
});

async function run(...args: string[]) {
  const lines: string[] = [];
  const code = await main([...args, "--data", file], (s) => lines.push(s));
  return { code, out: lines.join("\n") };
}

describe("cli", () => {
  it("prints help and version", async () => {
    expect((await main(["--help"], () => {})).valueOf()).toBe(0);
    const lines: string[] = [];
    await main(["--version"], (s) => lines.push(s));
    expect(lines[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("ranks the top repos", async () => {
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out.split("\n")[1]).toContain("junegunn/fzf");
    expect(out).toContain("tiny/gem");
  });
  it("filters by window and language", async () => {
    expect((await run("-w", "30d")).out).not.toContain("junegunn/fzf");
    const rust = await run("--lang", "rust");
    expect(rust.out).toContain("tiny/gem");
    expect(rust.out).not.toContain("big/launch");
  });
  it("shows hidden gems", async () => {
    const { out } = await run("--gems");
    expect(out).toContain("tiny/gem");
    expect(out).not.toContain("fzf");
  });
  it("emits JSON", async () => {
    const rows = JSON.parse((await run("--json", "-n", "2")).out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ repo: "junegunn/fzf", url: "https://github.com/junegunn/fzf", recommenders: 3, stars: 70000 });
  });
  it("shows the HN comments behind a repo, accepting a GitHub URL", async () => {
    const { code, out } = await run("show", "https://github.com/JuneGunn/fzf/");
    expect(code).toBe(0);
    expect(out).toContain("I use fzf every day");
    expect(out).toContain("https://news.ycombinator.com/item?id=111");
    expect((await run("show", "big/launch")).out).toContain("submitted it (450 points)");
  });
  it("reports unknown repos with exit code 1", async () => {
    expect((await run("show", "no/such")).code).toBe(1);
  });
  it("prints stats", async () => {
    const { out } = await run("stats");
    expect(out).toContain("2008-01-01");
    expect(out).toContain("3 repos listed");
  });
  it("rejects bad input", async () => {
    await expect(run("--sort", "nope")).rejects.toThrow(/--sort/);
    await expect(run("-w", "soon")).rejects.toThrow(/Bad window/);
    await expect(run("frobnicate")).rejects.toThrow(/Unknown command/);
  });
});
