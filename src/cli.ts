#!/usr/bin/env node
/**
 * hackerrepos: the GitHub repos Hacker News keeps recommending.
 *
 *   npx hackerrepos                       top repos, all time
 *   npx hackerrepos -w 1y -l rust         top Rust repos of the last year
 *   npx hackerrepos --gems                hidden gems (<1k stars, 3+ recommenders)
 *   npx hackerrepos show tmux/tmux        the HN comments that recommended it
 *   npx hackerrepos build                 rebuild the dataset from HN + GitHub
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "./build.ts";
import { formatRepo, formatTable, makeStyle } from "./format.ts";
import { contextShard, query, type ContextShard, type Dataset, type RepoContext, type RepoRecord, type SortKey } from "./rank.ts";

const VERSION = "0.1.0";
export const DEFAULT_DATA = new URL("../docs/data/repos.json", import.meta.url);
/** The npm package ships only repos.json; `show` fetches quotes from the site. */
export const REMOTE_DATA = "https://jatingargiitk.github.io/hackerrepos/data/repos.json";

const HELP = `hackerrepos ${VERSION}: the GitHub repos Hacker News keeps recommending

Usage
  hackerrepos [top] [options]        rank repos (default command)
  hackerrepos show <owner/repo>      the HN comments that recommended a repo
  hackerrepos stats                  what the dataset covers
  hackerrepos build [options]        rebuild the dataset from HN Algolia + GitHub

Options for top
  -w, --window <w>     only mentions in the last 30d, 12w, 6m, 1y, 5y... (default: all)
  -l, --lang <name>    only repos in this language (e.g. rust, go, python)
  -q, --search <text>  match name, description and topics
  -s, --sort <key>     score | trending | recommenders | stars | recent
  -g, --gems           hidden gems: under 1k stars, recommended by 3+ people
  -n, --limit <n>      how many to show (default 25)
      --json           machine-readable output
      --data <path>    dataset to read (default: bundled docs/data/repos.json)

Options for build
      --from <date>    start of the crawl (default 2008-01-01)
      --to <date>      end of the crawl (default: now)
      --out <path>     where to write (default docs/data/repos.json)
      --cache <dir>    HN + GitHub cache directory (default .cache)
      --no-github      skip GitHub enrichment (no token needed)

  -h, --help, -v, --version`;

export async function loadData(path: string | URL = DEFAULT_DATA): Promise<Dataset> {
  const text = /^https?:\/\//.test(String(path))
    ? await (await fetch(String(path))).text()
    : await readFile(path, "utf8");
  const data = JSON.parse(text) as Dataset;
  if (data.version !== 1 || !Array.isArray(data.repos)) throw new Error(`${String(path)} is not a hackerrepos dataset`);
  return data;
}

/** A repo's HN contexts: inline, or from the ctx/<shard>.json next to the dataset. */
export async function loadContexts(
  path: string | URL, data: Dataset, repo: RepoRecord, fallback?: string,
): Promise<RepoContext[]> {
  if (repo.x || !data.ctx || !repo.w) return repo.x ?? [];
  const shard = `ctx/${contextShard(repo.n, data.ctx)}.json`;
  const base = path instanceof URL ? path : /^https?:\/\//.test(path) ? new URL(path) : pathToFileURL(resolve(path));
  for (const file of [new URL(shard, base), ...(fallback ? [new URL(shard, fallback)] : [])]) {
    try {
      let text: string;
      if (file.protocol === "file:") text = await readFile(file, "utf8");
      else {
        const res = await fetch(file, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        text = await res.text();
      }
      return (JSON.parse(text) as ContextShard)[repo.n.toLowerCase()] ?? [];
    } catch {
      // try the next source
    }
  }
  return [];
}

const SORTS: SortKey[] = ["score", "trending", "recommenders", "stars", "recent"];

export async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      window: { type: "string", short: "w" },
      lang: { type: "string", short: "l" },
      search: { type: "string", short: "q" },
      sort: { type: "string", short: "s" },
      gems: { type: "boolean", short: "g" },
      limit: { type: "string", short: "n" },
      json: { type: "boolean" },
      data: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      out: { type: "string" },
      cache: { type: "string" },
      "no-github": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return out(HELP), 0;
  if (values.version) return out(VERSION), 0;
  const style = makeStyle(!values.json && process.stdout.isTTY === true && !process.env.NO_COLOR);
  const [cmd = "top", ...rest] = positionals;

  if (cmd === "build") {
    const to = values.to ? Date.parse(values.to) / 1000 : Math.floor(Date.now() / 1000);
    const from = Date.parse(values.from ?? "2008-01-01") / 1000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("Bad --from/--to dates");
    await build({
      from: Math.floor(from), to: Math.floor(to),
      out: values.out ?? "docs/data/repos.json",
      cacheDir: values.cache ?? ".cache",
      github: !values["no-github"],
      log: (m) => console.error(m),
    });
    return 0;
  }

  const data = await loadData(values.data ?? DEFAULT_DATA);

  if (cmd === "stats") {
    const d = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
    const s = data.stats;
    const lines = [
      `HN ${d(data.from)} → ${d(data.to)} (built ${data.generated.slice(0, 10)})`,
      `${s.comments.toLocaleString("en-US")} comments and ${s.stories.toLocaleString("en-US")} stories linking github.com`,
      `${s.mentions.toLocaleString("en-US")} repo mentions of ${s.repos.toLocaleString("en-US")} distinct repos`,
      `${s.listed.toLocaleString("en-US")} repos listed (3+ recommenders, or a 100+ point story)`,
    ];
    out(values.json ? JSON.stringify({ from: data.from, to: data.to, generated: data.generated, ...s }) : lines.join("\n"));
    return 0;
  }

  if (cmd === "show") {
    const want = (rest[0] ?? "").replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").toLowerCase();
    if (!want) throw new Error("Usage: hackerrepos show <owner/repo>");
    const repo = data.repos.find((r) => r.n.toLowerCase() === want);
    if (!repo) {
      out(`${want} is not in the dataset (it needs 3+ distinct HN recommenders, or a 100+ point story).`);
      return 1;
    }
    const full = { ...repo, x: await loadContexts(values.data ?? DEFAULT_DATA, data, repo, values.data ? undefined : REMOTE_DATA) };
    out(values.json ? JSON.stringify(full, null, 2) : formatRepo(full, data, style));
    return 0;
  }

  if (cmd !== "top") throw new Error(`Unknown command "${cmd}". Try --help.`);
  const sort = (values.sort ?? "score") as SortKey;
  if (!SORTS.includes(sort)) throw new Error(`--sort must be one of ${SORTS.join(", ")}`);
  const limit = Number(values.limit ?? 25);
  const rows = query(data, {
    window: values.window, language: values.lang, search: values.search, gems: values.gems, sort,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 25,
  });
  if (values.json) {
    out(JSON.stringify(rows.map((r) => ({
      repo: r.repo.n, url: `https://github.com/${r.repo.n}`, description: r.repo.d ?? null, language: r.repo.l ?? null,
      stars: r.repo.s ?? null, ...r.score,
    })), null, 2));
  } else {
    out(formatTable(rows, style, process.stdout.columns || 100));
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
const isBin = process.argv[1]?.endsWith("/hackerrepos") || process.argv[1]?.endsWith("/cli.js");
if (invokedDirectly || isBin) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`hackerrepos: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
