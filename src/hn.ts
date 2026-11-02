/**
 * Crawl Hacker News comments and stories that mention github.com through the
 * Algolia HN Search API (https://hn.algolia.com/api).
 *
 * Algolia returns at most 1,000 hits per query, so we walk the timeline in
 * windows and recursively halve any window that reports more hits than that.
 * Finished windows (older than two days, so no more edits) are cached on disk
 * as compact JSON, which makes re-runs and the scheduled refresh incremental.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ALGOLIA = "https://hn.algolia.com/api/v1/search_by_date";
const MAX_HITS = 1000;

export type ItemType = "comment" | "story";

/** The fields we keep from an Algolia hit (short keys keep the cache small). */
export interface HnItem {
  id: number;
  type: ItemType;
  author: string;
  /** Unix seconds. */
  time: number;
  /** Comment HTML, or the story's self-text. */
  html: string;
  /** Story id the item belongs to (itself for stories). */
  storyId: number;
  storyTitle: string;
  /** The story's link (for comments: the parent story's link). */
  storyUrl: string;
  /** Points (stories only; Algolia does not expose comment scores). */
  points: number;
}

interface AlgoliaHit {
  objectID: string;
  author?: string;
  created_at_i?: number;
  comment_text?: string | null;
  story_text?: string | null;
  story_id?: number | null;
  story_title?: string | null;
  story_url?: string | null;
  title?: string | null;
  url?: string | null;
  points?: number | null;
}

interface AlgoliaPage {
  nbHits: number;
  hits: AlgoliaHit[];
}

export function toItem(hit: AlgoliaHit, type: ItemType): HnItem {
  const id = Number(hit.objectID);
  if (type === "story") {
    return {
      id, type, author: hit.author ?? "", time: hit.created_at_i ?? 0,
      html: hit.story_text ?? "", storyId: id, storyTitle: hit.title ?? "",
      storyUrl: hit.url ?? "", points: hit.points ?? 0,
    };
  }
  return {
    id, type, author: hit.author ?? "", time: hit.created_at_i ?? 0,
    html: hit.comment_text ?? "", storyId: hit.story_id ?? 0, storyTitle: hit.story_title ?? "",
    storyUrl: hit.story_url ?? "", points: 0,
  };
}

export function windowUrl(type: ItemType, start: number, end: number): string {
  const params = new URLSearchParams({
    query: "github.com",
    tags: type,
    numericFilters: `created_at_i>=${start},created_at_i<${end}`,
    hitsPerPage: String(MAX_HITS),
    attributesToHighlight: "",
    attributesToRetrieve:
      "author,created_at_i,comment_text,story_text,story_id,story_title,story_url,title,url,points",
  });
  // For stories we only want ones whose *link* is on github.com.
  if (type === "story") params.set("restrictSearchableAttributes", "url");
  return `${ALGOLIA}?${params}`;
}

export interface CrawlOptions {
  from: number;
  to: number;
  types?: ItemType[];
  cacheDir?: string;
  /** Initial window size in seconds (default 7 days). */
  windowSec?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (info: { type: ItemType; start: number; end: number; hits: number; cached: boolean }) => void;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<AlgoliaPage> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { "user-agent": "hackerrepos (+https://github.com/jatingargiitk/hackerrepos)" } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return (await res.json()) as AlgoliaPage;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** Split [from, to) into consecutive windows of `size` seconds. */
export function windows(from: number, to: number, size: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = from; s < to; s += size) out.push([s, Math.min(to, s + size)]);
  return out;
}

/** Fetch one window, halving it until every piece fits under Algolia's cap. */
export async function fetchWindow(
  type: ItemType,
  start: number,
  end: number,
  fetchImpl: typeof fetch = fetch,
): Promise<HnItem[]> {
  const page = await getJson(windowUrl(type, start, end), fetchImpl);
  if (page.nbHits > page.hits.length && end - start > 60) {
    const mid = Math.floor((start + end) / 2);
    const [a, b] = await Promise.all([fetchWindow(type, start, mid, fetchImpl), fetchWindow(type, mid, end, fetchImpl)]);
    return [...a, ...b];
  }
  return page.hits.map((h) => toItem(h, type));
}

/** Crawl every window in [from, to), using and filling the on-disk cache. */
export async function crawl(opts: CrawlOptions): Promise<HnItem[]> {
  const types = opts.types ?? ["story", "comment"];
  const size = opts.windowSec ?? 7 * 86400;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const settledBefore = Math.floor(Date.now() / 1000) - 2 * 86400;
  const jobs: Array<{ type: ItemType; start: number; end: number }> = [];
  for (const type of types) for (const [start, end] of windows(opts.from, opts.to, size)) jobs.push({ type, start, end });

  const results: HnItem[][] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i]!;
      const file = opts.cacheDir ? join(opts.cacheDir, job.type, `${job.start}-${job.end}.json`) : null;
      let items: HnItem[] | null = null;
      let cached = false;
      if (file) {
        try {
          items = JSON.parse(await readFile(file, "utf8")) as HnItem[];
          cached = true;
        } catch {
          items = null;
        }
      }
      if (!items) {
        items = await fetchWindow(job.type, job.start, job.end, fetchImpl);
        if (file && job.end <= settledBefore) {
          await mkdir(join(opts.cacheDir!, job.type), { recursive: true });
          await writeFile(file, JSON.stringify(items));
        }
      }
      results[i] = items;
      opts.onProgress?.({ ...job, hits: items.length, cached });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  // Dedupe by id: adjacent windows never overlap, but be defensive.
  const seen = new Set<number>();
  return results.flat().filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
}
