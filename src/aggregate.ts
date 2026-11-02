/**
 * Turn crawled HN items into per-repo mention lists.
 */
import { extractRepos, htmlToText, parseRepoUrl, snippetAround } from "./extract.ts";
import { isRecommendation, isSelfPromotion, mentionWeight } from "./classify.ts";
import type { HnItem } from "./hn.ts";

export interface RawMention {
  /** Lower-cased owner/name. */
  key: string;
  /** owner/name as written in the link. */
  name: string;
  day: number;
  author: string;
  weight: number;
  self: boolean;
  story: boolean;
  recommend: boolean;
  itemId: number;
  storyId: number;
  storyTitle: string;
  snippet: string;
  points: number;
}

export const DAY = 86400;

export function mentionsFromItem(item: HnItem): RawMention[] {
  const day = Math.floor(item.time / DAY);
  if (item.type === "story") {
    const link = parseRepoUrl(item.storyUrl);
    if (!link || (link.kind !== "repo" && link.kind !== "path" && link.kind !== "release")) return [];
    const owner = link.name.split("/")[0] ?? "";
    const self = isSelfPromotion(item.storyTitle.replace(/^show hn:?/i, ""), item.author, owner);
    return [{
      key: link.key, name: link.name, day, author: item.author,
      weight: mentionWeight({ kind: "story", self, recommend: false, points: item.points }),
      self, story: true, recommend: false, itemId: item.id, storyId: item.id,
      storyTitle: item.storyTitle, snippet: item.storyTitle, points: item.points,
    }];
  }

  const links = extractRepos(item.html);
  if (links.length === 0) return [];
  // Comments under a story that *is* this repo are discussion, not recommendations.
  const threadRepo = parseRepoUrl(item.storyUrl)?.key;
  const text = htmlToText(item.html);
  const recommend = isRecommendation(text);
  const out: RawMention[] = [];
  for (const link of links) {
    if (link.key === threadRepo) continue;
    const owner = link.name.split("/")[0] ?? "";
    // "I built X" only pins self-promotion on a repo when it is the sole link.
    const self = links.length === 1 ? isSelfPromotion(text, item.author, owner) : item.author.toLowerCase() === owner.toLowerCase();
    out.push({
      key: link.key, name: link.name, day, author: item.author,
      weight: mentionWeight({ kind: link.kind, self, recommend }),
      self, story: false, recommend, itemId: item.id, storyId: item.storyId,
      storyTitle: item.storyTitle, snippet: snippetAround(text, link.index), points: 0,
    });
  }
  return out;
}

/** Group all mentions by repo key. */
export function aggregate(items: Iterable<HnItem>): Map<string, RawMention[]> {
  const byRepo = new Map<string, RawMention[]>();
  for (const item of items) {
    for (const m of mentionsFromItem(item)) {
      const list = byRepo.get(m.key);
      if (list) list.push(m);
      else byRepo.set(m.key, [m]);
    }
  }
  return byRepo;
}

/** Distinct non-self authors: the "recommenders" count before any windowing. */
export function recommenderCount(mentions: RawMention[]): number {
  const selfAuthors = new Set(mentions.filter((m) => m.self).map((m) => m.author));
  return new Set(mentions.filter((m) => !selfAuthors.has(m.author)).map((m) => m.author)).size;
}

/**
 * Up to `max` mentions worth showing as context: one per person, preferring
 * recommendation language, non-self, big stories, longer snippets, then recency.
 */
export function pickContexts(mentions: RawMention[], max = 5): RawMention[] {
  const rank = (m: RawMention) =>
    (m.self ? 0 : 4) + (m.recommend ? 2 : 0) + (m.story ? Math.min(3, Math.log10(1 + m.points)) : 0) +
    Math.min(1, m.snippet.length / 200) + m.day / 1e6;
  const sorted = [...mentions].sort((a, b) => rank(b) - rank(a));
  const seen = new Set<string>();
  const out: RawMention[] = [];
  for (const m of sorted) {
    if (seen.has(m.author)) continue;
    seen.add(m.author);
    out.push(m);
    if (out.length >= max) break;
  }
  return out;
}
