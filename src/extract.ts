/**
 * Pull GitHub repository references out of Hacker News comment / story HTML.
 *
 * HN (and the Algolia mirror) stores comments as lightly escaped HTML, e.g.
 * `<a href="https:&#x2F;&#x2F;github.com&#x2F;foo&#x2F;bar">…</a>`, and long
 * link texts are truncated with "...". We decode entities, scan both hrefs and
 * bare text, normalise every hit to `owner/name` and classify what kind of
 * page was linked (repo root, a file, an issue, a PR, …).
 */

export type LinkKind = "repo" | "path" | "issue" | "pull" | "commit" | "release";

export interface RepoLink {
  /** Lower-cased `owner/name`, the dedupe key. */
  key: string;
  /** `owner/name` with the casing used in the first link we saw. */
  name: string;
  kind: LinkKind;
  /** Character offset of the link in the decoded plain text (-1 if unknown). */
  index: number;
}

/**
 * First path segments on github.com that are site pages, not users or orgs.
 * A link like github.com/features/actions must never become a "repo".
 */
export const RESERVED_OWNERS = new Set([
  "about", "account", "apps", "blog", "codespaces", "collections", "contact", "customer-stories",
  "dashboard", "enterprise", "events", "explore", "features", "git-guides", "github-copilot",
  "issues", "login", "logout", "marketplace", "new", "notifications", "orgs", "organizations",
  "pricing", "pulls", "readme", "search", "security", "settings", "site", "sponsors", "stars",
  "team", "topics", "trending", "users", "watching", "join", "home", "edu", "resources",
  "solutions", "copilot", "models", "premium-support", "mobile", "nonprofit", "signup", "status",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** Decode the handful of HTML entities HN actually emits (plus numeric ones). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** HN comment HTML → plain text (paragraphs become blank lines). */
export function htmlToText(html: string): string {
  const withBreaks = html.replace(/<p>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n");
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";
const NAME = "[A-Za-z0-9._-]{1,100}";
const GH_URL = new RegExp(
  `(?:https?://)?(?:www\\.)?github\\.com/(${OWNER})/(${NAME})((?:[/?#][^\\s"'<>()\\[\\]{}]*)?)`,
  "gi",
);

/** Normalise a raw repo-name capture: drop ".git", trailing punctuation and "..." truncation. */
export function cleanRepoName(raw: string): string | null {
  let name = raw.replace(/\.{3,}.*$/, "");
  name = name.replace(/[.,;:!?]+$/, "");
  name = name.replace(/\.git$/i, "");
  name = name.replace(/[.,;:!?]+$/, "");
  if (!name || name === "." || name === "..") return null;
  return name;
}

/** Map the path after `owner/name` to a link kind. */
export function classifyPath(rest: string): LinkKind {
  const path = rest.split(/[?#]/)[0] ?? "";
  const seg = path.split("/").filter(Boolean);
  const first = (seg[0] ?? "").toLowerCase();
  switch (first) {
    case "":
      return "repo";
    case "issues":
    case "discussions":
      return "issue";
    case "pull":
    case "pulls":
      return "pull";
    case "commit":
    case "commits":
    case "compare":
    case "blame":
      return "commit";
    case "releases":
    case "tags":
      return "release";
    case "tree":
      // github.com/o/r/tree/main is still the repo front page.
      return seg.length <= 2 ? "repo" : "path";
    default:
      return "path";
  }
}

/** Parse one github.com URL (or URL-ish string). Returns null for non-repo pages. */
export function parseRepoUrl(url: string): Omit<RepoLink, "index"> | null {
  GH_URL.lastIndex = 0;
  const m = GH_URL.exec(decodeEntities(url));
  if (!m) return null;
  return toLink(m[1] ?? "", m[2] ?? "", m[3] ?? "");
}

function toLink(owner: string, rawName: string, rest: string): Omit<RepoLink, "index"> | null {
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  const name = cleanRepoName(rawName);
  if (!name) return null;
  const full = `${owner}/${name}`;
  return { key: full.toLowerCase(), name: full, kind: classifyPath(rest) };
}

/**
 * Every distinct repo referenced in a comment. Links inside `href` attributes
 * win over the (possibly truncated) visible text; one entry per repo, keeping
 * the most "recommendation-like" kind (repo > path > release > issue > pull > commit).
 */
export function extractRepos(html: string): RepoLink[] {
  const text = htmlToText(html);
  const hrefs = [...html.matchAll(/href="([^"]*)"/gi)].map((m) => decodeEntities(m[1] ?? "")).join(" ");
  const sources = [hrefs, text];
  const byKey = new Map<string, RepoLink>();
  for (const [si, src] of sources.entries()) {
    GH_URL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GH_URL.exec(src)) !== null) {
      // Visible text truncated by HN ("github.com/foo/barbaz...") is unreliable.
      if (si === 1 && /\.{3}/.test(m[2] ?? "") ) continue;
      const link = toLink(m[1] ?? "", m[2] ?? "", m[3] ?? "");
      if (!link) continue;
      const index = text.toLowerCase().indexOf(link.key.split("/")[0] + "/");
      const prev = byKey.get(link.key);
      if (!prev || KIND_RANK[link.kind] < KIND_RANK[prev.kind]) {
        byKey.set(link.key, { ...link, name: prev?.name ?? link.name, index: prev?.index ?? index });
      }
    }
  }
  return [...byKey.values()];
}

const KIND_RANK: Record<LinkKind, number> = { repo: 0, path: 1, release: 2, issue: 3, pull: 4, commit: 5 };

/** ~`max` characters of plain text centred on `index`, with ellipses where cut. */
export function snippetAround(text: string, index: number, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const at = index < 0 ? 0 : Math.min(index, flat.length);
  let start = Math.max(0, at - Math.floor(max / 3));
  let end = Math.min(flat.length, start + max);
  start = Math.max(0, end - max);
  // Snap to word boundaries.
  if (start > 0) start = flat.indexOf(" ", start) + 1 || start;
  if (end < flat.length) end = flat.lastIndexOf(" ", end) > start ? flat.lastIndexOf(" ", end) : end;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}
