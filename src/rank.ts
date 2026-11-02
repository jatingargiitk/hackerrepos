/**
 * Ranking over the compact dataset. The browser (docs/index.html) carries a
 * line-for-line port of `scoreRepo`; test/site.test.ts keeps the two in sync.
 */

export const FLAG_SELF = 1;
export const FLAG_STORY = 2;

/** One mention: [unix day, author index, weight × 100, flags]. */
export type CompactMention = [number, number, number, number];

export interface RepoContext {
  /** HN item id of the comment or story. */
  i: number;
  /** Author. */
  a: string;
  /** Unix day. */
  t: number;
  /** Story id and title the comment was posted under. */
  k: number;
  s: string;
  /** Plain-text snippet around the link. */
  q: string;
  /** Story points, for story mentions. */
  p?: number;
}

export interface RepoRecord {
  /** owner/name as GitHub reports it (after following renames). */
  n: string;
  d?: string;
  l?: string;
  s?: number;
  /** Archived on GitHub. */
  a?: 1;
  /** Topics. */
  t?: string[];
  /** Created / last pushed, as YYYY-MM. */
  c?: string;
  u?: string;
  m: CompactMention[];
  x: RepoContext[];
}

export interface Dataset {
  version: 1;
  generated: string;
  /** Unix seconds covered by the crawl. */
  from: number;
  to: number;
  stats: { comments: number; stories: number; mentions: number; repos: number; listed: number };
  authors: string[];
  repos: RepoRecord[];
}

export interface Score {
  score: number;
  /** Distinct commenters who linked it and are not its author. */
  recommenders: number;
  mentions: number;
  /** Most recent mention in the window (unix day), or 0. */
  last: number;
}

export interface ScoreOptions {
  /** Only count mentions on or after this unix day. */
  sinceDay?: number;
  /** Exponential recency decay: a mention this many days old counts half. */
  halfLifeDays?: number;
  /** "Today" as a unix day (for the decay). */
  nowDay?: number;
}

/**
 * Score = Σ over distinct people of the *best* weight among their mentions.
 * One person linking the same repo fifty times still counts once.
 */
export function scoreRepo(mentions: CompactMention[], opts: ScoreOptions = {}): Score {
  const best = new Map<number, number>();
  const selfAuthors = new Set<number>();
  let count = 0;
  let last = 0;
  const since = opts.sinceDay ?? -Infinity;
  const now = opts.nowDay ?? 0;
  for (const [day, author, w100, flags] of mentions) {
    if (day < since) continue;
    count++;
    if (day > last) last = day;
    let w = w100 / 100;
    if (opts.halfLifeDays) w *= Math.pow(0.5, Math.max(0, now - day) / opts.halfLifeDays);
    if (flags & FLAG_SELF) selfAuthors.add(author);
    if (w > (best.get(author) ?? 0)) best.set(author, w);
  }
  let score = 0;
  let recommenders = 0;
  for (const [author, w] of best) {
    score += w;
    if (!selfAuthors.has(author)) recommenders++;
  }
  return { score: Math.round(score * 100) / 100, recommenders, mentions: count, last };
}

export type SortKey = "score" | "trending" | "stars" | "recent" | "recommenders";

export interface QueryOptions {
  /** e.g. "30d", "90d", "1y", "2y", "all" (default). */
  window?: string;
  language?: string;
  /** Hidden gems: under `gemStars` stars and at least 3 recommenders. */
  gems?: boolean;
  gemStars?: number;
  search?: string;
  sort?: SortKey;
  limit?: number;
  includeArchived?: boolean;
  /** Unix day treated as "now" (defaults to the dataset's end). */
  nowDay?: number;
}

export interface Ranked {
  repo: RepoRecord;
  score: Score;
}

/** Parse "30d" / "12w" / "6m" / "2y" / "all" into a number of days (Infinity for all). */
export function windowDays(w: string | undefined): number {
  if (!w || w === "all") return Infinity;
  const m = /^(\d+)\s*([dwmy])$/i.exec(w.trim());
  if (!m) throw new Error(`Bad window "${w}" (use e.g. 30d, 12w, 6m, 2y or all)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "d").toLowerCase();
  return n * (unit === "d" ? 1 : unit === "w" ? 7 : unit === "m" ? 30 : 365);
}

export const TRENDING_HALF_LIFE = 90;

export function query(data: Dataset, opts: QueryOptions = {}): Ranked[] {
  const nowDay = opts.nowDay ?? Math.floor(data.to / 86400);
  const days = windowDays(opts.window);
  const sinceDay = Number.isFinite(days) ? nowDay - days : undefined;
  const lang = opts.language?.toLowerCase();
  const needle = opts.search?.toLowerCase().trim();
  const sort = opts.sort ?? "score";
  const gemStars = opts.gemStars ?? 1000;
  const out: Ranked[] = [];
  for (const repo of data.repos) {
    if (lang && (repo.l ?? "").toLowerCase() !== lang) continue;
    if (!opts.includeArchived && repo.a) continue;
    if (needle && !`${repo.n} ${repo.d ?? ""} ${(repo.t ?? []).join(" ")}`.toLowerCase().includes(needle)) continue;
    const score = scoreRepo(repo.m, {
      sinceDay,
      nowDay,
      halfLifeDays: sort === "trending" ? TRENDING_HALF_LIFE : undefined,
    });
    if (score.mentions === 0) continue;
    if (opts.gems && ((repo.s ?? 0) >= gemStars || score.recommenders < 3)) continue;
    out.push({ repo, score });
  }
  const cmp: Record<SortKey, (a: Ranked, b: Ranked) => number> = {
    score: (a, b) => b.score.score - a.score.score,
    trending: (a, b) => b.score.score - a.score.score,
    recommenders: (a, b) => b.score.recommenders - a.score.recommenders || b.score.score - a.score.score,
    stars: (a, b) => (b.repo.s ?? 0) - (a.repo.s ?? 0),
    recent: (a, b) => b.score.last - a.score.last || b.score.score - a.score.score,
  };
  out.sort((a, b) => cmp[sort](a, b) || a.repo.n.localeCompare(b.repo.n));
  return opts.limit ? out.slice(0, opts.limit) : out;
}
