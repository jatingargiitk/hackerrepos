/**
 * The data pipeline: crawl → aggregate → enrich → compact dataset.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aggregate, pickContexts, recommenderCount, type RawMention } from "./aggregate.ts";
import { enrich, loadCache, resolveToken, saveCache, type MetaCache } from "./github.ts";
import { crawl, type HnItem } from "./hn.ts";
import { FLAG_SELF, FLAG_STORY, scoreRepo, type CompactMention, type Dataset, type RepoRecord } from "./rank.ts";

export interface AssembleOptions {
  from: number;
  to: number;
  /** Minimum distinct recommenders to be listed (default 3)… */
  minRecommenders?: number;
  /** …or a single HN story about the repo with at least this many points (default 100). */
  minStoryPoints?: number;
  contexts?: number;
  generated?: string;
}

/** Is this repo worth looking up on GitHub / listing at all? */
export function isCandidate(mentions: RawMention[], minRecommenders = 3, minStoryPoints = 100): boolean {
  if (recommenderCount(mentions) >= minRecommenders) return true;
  return mentions.some((m) => m.story && m.points >= minStoryPoints);
}

/**
 * Repos that HN links as references, not recommendations (GitHub's DMCA
 * notices and policies). Listing them would crowd out actual projects.
 */
export const NOT_PROJECTS = new Set(["github/dmca", "github/site-policy", "github/gov-takedowns"]);

const yyyymm = (iso?: string) => (iso ? iso.slice(0, 7) : undefined);

/**
 * Merge renamed repos (via GitHub's canonical name), drop deleted ones and
 * produce the compact, sorted dataset the site and CLI read.
 */
export function assemble(
  byRepo: Map<string, RawMention[]>,
  meta: MetaCache | null,
  items: { comments: number; stories: number },
  opts: AssembleOptions,
): Dataset {
  const minRec = opts.minRecommenders ?? 3;
  const minPts = opts.minStoryPoints ?? 100;
  let mentionCount = 0;
  for (const list of byRepo.values()) mentionCount += list.length;

  // 1. Canonicalise and merge. Candidacy is decided *after* merging, so an old
  // and a new name that each have one recommender still add up.
  const merged = new Map<string, { name: string; key: string; mentions: RawMention[] }>();
  for (const [key, mentions] of byRepo) {
    if (!meta && !isCandidate(mentions, minRec, minPts)) continue;
    const info = meta?.[key];
    if (meta && (!info || info.name === null)) continue; // gone or never looked up
    const name = info?.name ?? mostCommonName(mentions);
    const canon = name.toLowerCase();
    if (NOT_PROJECTS.has(canon)) continue;
    const slot = merged.get(canon);
    if (slot) slot.mentions.push(...mentions);
    else merged.set(canon, { name, key, mentions: [...mentions] });
  }

  for (const [canon, slot] of merged) {
    if (!isCandidate(dedupeByItem(slot.mentions), minRec, minPts)) merged.delete(canon);
  }

  // 2. Author index (most frequent first keeps indexes short).
  const freq = new Map<string, number>();
  for (const { mentions } of merged.values()) for (const m of mentions) freq.set(m.author, (freq.get(m.author) ?? 0) + 1);
  const authors = [...freq.keys()].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.localeCompare(b));
  const authorIdx = new Map(authors.map((a, i) => [a, i]));

  // 3. Compact records.
  const repos: RepoRecord[] = [];
  for (const [canon, { name, mentions }] of merged) {
    const deduped = dedupeByItem(mentions);
    if (!isCandidate(deduped, minRec, minPts)) continue;
    deduped.sort((a, b) => a.day - b.day || a.itemId - b.itemId);
    const info = meta ? findMeta(meta, canon, deduped) : undefined;
    const rec: RepoRecord = {
      n: name,
      m: deduped.map((m): CompactMention => [
        m.day, authorIdx.get(m.author) ?? 0, Math.round(m.weight * 100), (m.self ? FLAG_SELF : 0) | (m.story ? FLAG_STORY : 0),
      ]),
      x: pickContexts(deduped, opts.contexts ?? 5).map((m) => ({
        i: m.itemId, a: m.author, t: m.day, k: m.storyId, s: m.storyTitle, q: clip(m.snippet, 280),
        ...(m.story ? { p: m.points } : {}),
      })),
    };
    if (info) {
      if (info.description) rec.d = clip(info.description, 200);
      if (info.language) rec.l = info.language;
      if (info.stars !== undefined) rec.s = info.stars;
      if (info.archived) rec.a = 1;
      if (info.topics?.length) rec.t = info.topics.slice(0, 6);
      rec.c = yyyymm(info.createdAt);
      rec.u = yyyymm(info.pushedAt);
    }
    repos.push(rec);
  }
  const scores = new Map(repos.map((r) => [r, scoreRepo(r.m).score]));
  repos.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.n.localeCompare(b.n));

  return {
    version: 1,
    generated: opts.generated ?? new Date().toISOString(),
    from: opts.from,
    to: opts.to,
    stats: { comments: items.comments, stories: items.stories, mentions: mentionCount, repos: byRepo.size, listed: repos.length },
    authors,
    repos,
  };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

function findMeta(meta: MetaCache, canon: string, mentions: RawMention[]) {
  for (const m of mentions) {
    const info = meta[m.key];
    if (info?.name && info.name.toLowerCase() === canon) return info;
  }
  return undefined;
}

function mostCommonName(mentions: RawMention[]): string {
  const counts = new Map<string, number>();
  for (const m of mentions) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? mentions[0]?.name ?? "";
}

/** A comment linking both the old and new name of a repo counts once. */
function dedupeByItem(mentions: RawMention[]): RawMention[] {
  const byItem = new Map<number, RawMention>();
  for (const m of mentions) {
    const prev = byItem.get(m.itemId);
    if (!prev || m.weight > prev.weight) byItem.set(m.itemId, m);
  }
  return [...byItem.values()];
}

export interface BuildOptions extends AssembleOptions {
  cacheDir: string;
  out: string;
  github?: boolean;
  token?: string | null;
  log?: (msg: string) => void;
}

export async function build(opts: BuildOptions): Promise<Dataset> {
  const log = opts.log ?? (() => {});
  log(`Crawling HN ${new Date(opts.from * 1000).toISOString().slice(0, 10)} → ${new Date(opts.to * 1000).toISOString().slice(0, 10)}…`);
  let windowsDone = 0;
  const items: HnItem[] = await crawl({
    from: opts.from,
    to: opts.to,
    cacheDir: join(opts.cacheDir, "hn"),
    onProgress: () => {
      if (++windowsDone % 100 === 0) log(`  ${windowsDone} windows`);
    },
  });
  const comments = items.filter((i) => i.type === "comment").length;
  log(`  ${comments} comments and ${items.length - comments} stories mention github.com`);
  const byRepo = aggregate(items);
  log(`  ${byRepo.size} distinct repos linked`);

  let meta: MetaCache | null = null;
  if (opts.github !== false) {
    const token = opts.token ?? resolveToken();
    if (!token) throw new Error("No GitHub token: set GITHUB_TOKEN, log in with `gh auth login`, or pass --no-github.");
    const cacheFile = join(opts.cacheDir, "github.json");
    meta = await loadCache(cacheFile);
    // One recommender short of the bar: a repo linked under an old and a new
    // name only adds up after GitHub tells us they are the same repo.
    const lookup = Math.max(1, (opts.minRecommenders ?? 3) - 1);
    const keys = [...byRepo].filter(([, m]) => isCandidate(m, lookup, opts.minStoryPoints)).map(([k]) => k);
    log(`Enriching ${keys.length} candidate repos from GitHub…`);
    let batches = 0;
    await enrich(keys, {
      token,
      cache: meta,
      onProgress: (done, total, remaining) => {
        if (done === total || done % 2000 < 50) log(`  ${done}/${total} (rate limit left: ${remaining ?? "?"})`);
      },
      onBatch: async (c) => {
        if (++batches % 20 === 0) await saveCache(cacheFile, c);
      },
      onStop: (done, wanted) =>
        log(`  Stopped at ${done}/${wanted} to stay inside the GitHub rate limit; using cached metadata for the rest.`),
    });
    await saveCache(cacheFile, meta);
  }

  const data = assemble(byRepo, meta, { comments, stories: items.length - comments }, opts);
  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out, JSON.stringify(data));
  log(`Wrote ${data.repos.length} repos to ${opts.out}`);
  return data;
}
