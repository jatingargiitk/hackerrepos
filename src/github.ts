/**
 * Enrich repos with GitHub metadata through the GraphQL API, 50 repos per
 * request (aliases), with an on-disk cache so refreshes only ask for what is
 * new or stale. `repository(owner, name)` follows renames and transfers, so
 * the returned `nameWithOwner` is used to merge old and new names.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RepoMeta {
  /** Canonical owner/name, or null when the repo is gone (deleted / private). */
  name: string | null;
  description?: string;
  language?: string;
  stars?: number;
  archived?: boolean;
  fork?: boolean;
  topics?: string[];
  createdAt?: string;
  pushedAt?: string;
  /** When we fetched it (ISO). */
  fetched: string;
}

export type MetaCache = Record<string, RepoMeta>;

const ENDPOINT = "https://api.github.com/graphql";
export const BATCH = 50;

/** GITHUB_TOKEN / GH_TOKEN, else whatever `gh auth token` prints, else null. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

const FIELDS = `nameWithOwner description stargazerCount isArchived isFork createdAt pushedAt
  primaryLanguage { name } repositoryTopics(first: 6) { nodes { topic { name } } }`;

/** Build one aliased GraphQL query for a batch of `owner/name` keys. */
export function buildQuery(keys: string[]): string {
  const parts = keys.map((key, i) => {
    const [owner, name] = key.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${FIELDS} }`;
  });
  return `query { rateLimit { remaining resetAt } ${parts.join("\n")} }`;
}

interface GqlRepo {
  nameWithOwner: string;
  description: string | null;
  stargazerCount: number;
  isArchived: boolean;
  isFork: boolean;
  createdAt: string;
  pushedAt: string | null;
  primaryLanguage: { name: string } | null;
  repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
}

export function parseRepo(r: GqlRepo | null | undefined, fetched: string): RepoMeta {
  if (!r) return { name: null, fetched };
  return {
    name: r.nameWithOwner,
    description: r.description?.trim() || undefined,
    language: r.primaryLanguage?.name,
    stars: r.stargazerCount,
    archived: r.isArchived || undefined,
    fork: r.isFork || undefined,
    topics: r.repositoryTopics.nodes.map((n) => n.topic.name),
    createdAt: r.createdAt,
    pushedAt: r.pushedAt ?? undefined,
    fetched,
  };
}

export async function loadCache(file: string): Promise<MetaCache> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as MetaCache;
  } catch {
    return {};
  }
}

export async function saveCache(file: string, cache: MetaCache): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache));
}

export interface EnrichOptions {
  token: string;
  cache: MetaCache;
  /** Re-fetch entries older than this many days (default 7). */
  maxAgeDays?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number, remaining?: number) => void;
  /** Called after each batch so long runs can checkpoint the cache. */
  onBatch?: (cache: MetaCache) => Promise<void> | void;
}

/** Valid GitHub names only; anything else would break the GraphQL query. */
export function isQueryable(key: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/i.test(key);
}

export async function enrich(keys: string[], opts: EnrichOptions): Promise<MetaCache> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAge = (opts.maxAgeDays ?? 7) * 86400_000;
  const now = Date.now();
  const todo = keys.filter((k) => {
    if (!isQueryable(k)) return false;
    const hit = opts.cache[k];
    return !hit || now - Date.parse(hit.fetched) > maxAge;
  });
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const { data, remaining } = await runBatch(batch, opts.token, fetchImpl);
      const fetched = new Date().toISOString();
      batch.forEach((key, i) => {
        opts.cache[key] = parseRepo(data[`r${i}`] as GqlRepo | null | undefined, fetched);
      });
      done += batch.length;
      opts.onProgress?.(done, todo.length, remaining);
      await opts.onBatch?.(opts.cache);
      if (remaining !== undefined && remaining < 50) {
        throw new Error("GitHub GraphQL rate limit nearly exhausted; re-run later (the cache keeps progress).");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker));
  return opts.cache;
}

async function runBatch(
  keys: string[],
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ data: Record<string, unknown>; remaining?: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "hackerrepos" },
        body: JSON.stringify({ query: buildQuery(keys) }),
      });
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 2000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
      // NOT_FOUND errors come back alongside partial data; a null alias = gone.
      const body = (await res.json()) as { data?: Record<string, unknown> & { rateLimit?: { remaining: number } } };
      if (!body.data) throw new Error("GitHub GraphQL returned no data");
      return { data: body.data, remaining: body.data.rateLimit?.remaining };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr;
}
