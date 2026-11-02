/** Terminal rendering for the CLI. */
import type { Dataset, Ranked, RepoRecord } from "./rank.ts";

export interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
  orange: (s: string) => string;
  cyan: (s: string) => string;
}

export function makeStyle(color: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), orange: wrap(33, 39), cyan: wrap(36, 39) };
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function dayToDate(day: number): string {
  return new Date(day * 86400_000).toISOString().slice(0, 10);
}

export const hnItemUrl = (id: number) => `https://news.ycombinator.com/item?id=${id}`;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

export function formatTable(rows: Ranked[], style: Style, width = 100): string {
  if (rows.length === 0) return style.dim("No repos match.");
  const rankW = String(rows.length).length;
  const nameW = Math.min(36, Math.max(...rows.map((r) => r.repo.n.length)));
  const lines = rows.map((r, i) => {
    const rank = String(i + 1).padStart(rankW);
    const name = truncate(r.repo.n, nameW).padEnd(nameW);
    const recs = `${r.score.recommenders}`.padStart(4);
    const stars = r.repo.s === undefined ? "    -" : `★${compactNumber(r.repo.s)}`.padStart(6);
    const lang = truncate(r.repo.l ?? "", 10).padEnd(10);
    const used = rankW + nameW + 4 + 6 + 10 + 8;
    const desc = truncate(r.repo.d ?? "", Math.max(10, width - used));
    return `${style.dim(rank)} ${style.bold(name)} ${style.orange(recs)} ${stars} ${style.cyan(lang)} ${style.dim(desc)}`;
  });
  const header = style.dim(`${" ".repeat(rankW)} ${"repo".padEnd(nameW)} recs  stars lang`);
  return [header, ...lines].join("\n");
}

export function formatRepo(repo: RepoRecord, data: Dataset, style: Style): string {
  const recs = new Set(repo.m.map((m) => m[1])).size;
  const out: string[] = [];
  out.push(`${style.bold(repo.n)}  ${style.dim(`https://github.com/${repo.n}`)}`);
  if (repo.d) out.push(repo.d);
  const facts = [
    repo.s !== undefined ? `★ ${repo.s.toLocaleString("en-US")}` : null,
    repo.l ?? null,
    repo.a ? "archived" : null,
    `${repo.m.length} HN mentions by ${recs} people`,
    `first ${dayToDate(repo.m[0]?.[0] ?? 0)}, last ${dayToDate(repo.m[repo.m.length - 1]?.[0] ?? 0)}`,
  ].filter(Boolean);
  out.push(style.dim(facts.join(" · ")));
  out.push("");
  for (const c of repo.x) {
    const head = c.p !== undefined ? `${c.a} submitted it (${c.p} points)` : `${c.a} on "${truncate(c.s, 60)}"`;
    out.push(`${style.orange("▍")} ${style.bold(head)} ${style.dim(dayToDate(c.t))}`);
    if (c.p === undefined) out.push(`${style.orange("▍")} ${c.q}`);
    out.push(`${style.orange("▍")} ${style.dim(hnItemUrl(c.i))}`);
    out.push("");
  }
  void data;
  return out.join("\n").trimEnd();
}
