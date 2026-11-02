/**
 * Decide how much a single mention should count as a *recommendation*.
 *
 * HackerTube used an LLM pass to separate "you should watch this" from noise.
 * For repos a few transparent heuristics get most of the way there, and they
 * are deterministic, free and testable:
 *
 *  - Linking an issue, PR or commit is usually a bug report or a citation, not
 *    a recommendation, so those count for a quarter.
 *  - Self-promotion ("I built…", commenter owns the repo) still counts, but at
 *    half weight, and never as an independent recommender.
 *  - Recommendation language ("check out", "I use", "highly recommend", …)
 *    gives a small boost.
 *  - A story whose link *is* the repo counts as one mention by the submitter,
 *    plus a bonus for the points it earned.
 */
import type { LinkKind } from "./extract.ts";

export const KIND_WEIGHT: Record<LinkKind, number> = {
  repo: 1,
  path: 0.75,
  release: 0.75,
  issue: 0.25,
  pull: 0.25,
  commit: 0.25,
};

const RECOMMEND =
  /\b(check(ing)? (it |this |them )?out|highly recommend|i('d)? recommend|recommended|i (use|used|love|like)|we (use|used)|i've been using|been using|switched to|worth (a )?(look|try|checking)|give (it|this) a (try|shot|look)|my favou?rite|great (tool|library|project|alternative)|excellent|fantastic|awesome|amazing|underrated|life ?saver|game ?changer|the best|you (want|might like|should (try|look at|use))|have a look at|take a look at|try out|alternative)\b/i;

const SELF_PROMO =
  /\b(i|we) (made|built|wrote|created|maintain|developed|released|launched|open[- ]sourced|work on)\b|\bmy (own )?(project|library|lib|repo|tool|side project|app|implementation|attempt|version|fork)\b|\bshameless(ly)? plug\b|\b(i'?m|i am) the (author|maintainer|creator)\b|\bdisclaimer: i\b|\(author here\)|\bauthor here\b/i;

export function isRecommendation(text: string): boolean {
  return RECOMMEND.test(text);
}

export function isSelfPromotion(text: string, author: string, owner: string): boolean {
  if (author && owner && author.toLowerCase() === owner.toLowerCase()) return true;
  return SELF_PROMO.test(text);
}

export interface MentionSignals {
  kind: LinkKind | "story";
  self: boolean;
  recommend: boolean;
  /** Story points, for story mentions. */
  points?: number;
}

/** Weight of one mention, rounded to 2 decimals so the data stays compact. */
export function mentionWeight(s: MentionSignals): number {
  let w: number;
  if (s.kind === "story") {
    // 1 for the submission itself + up to ~1.5 for a big front-page hit.
    w = 1 + Math.min(1.5, Math.log10(1 + Math.max(0, s.points ?? 0)) / 2);
  } else {
    w = KIND_WEIGHT[s.kind];
    if (s.recommend) w *= 1.25;
  }
  if (s.self) w *= 0.5;
  return Math.round(w * 100) / 100;
}
