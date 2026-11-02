import { describe, expect, it } from "vitest";
import {
  classifyPath, cleanRepoName, decodeEntities, extractRepos, htmlToText, parseRepoUrl, snippetAround,
} from "../src/extract.ts";

const a = (url: string, text = url) =>
  `<a href="${url.replace(/\//g, "&#x2F;")}" rel="nofollow">${text.replace(/\//g, "&#x2F;")}</a>`;

describe("decodeEntities / htmlToText", () => {
  it("decodes HN's hex, decimal and named entities", () => {
    expect(decodeEntities("https:&#x2F;&#x2F;x &amp; y &#39;z&#39; &quot;q&quot;")).toBe(`https://x & y 'z' "q"`);
  });
  it("leaves unknown entities alone", () => {
    expect(decodeEntities("&bogus; &#x110000;")).toBe("&bogus; &#x110000;");
  });
  it("turns paragraphs into blank lines and strips tags", () => {
    expect(htmlToText("first<p>second <i>it</i>")).toBe("first\n\nsecond it");
  });
});

describe("cleanRepoName", () => {
  it.each([
    ["repo.git", "repo"],
    ["repo.", "repo"],
    ["my-repo_", "my-repo_"],
    ["re...", "re"],
    ["socket.io", "socket.io"],
    ["..", null],
  ])("%s → %s", (raw, want) => {
    expect(cleanRepoName(raw)).toBe(want);
  });
});

describe("classifyPath", () => {
  it.each([
    ["", "repo"],
    ["/", "repo"],
    ["#readme", "repo"],
    ["?tab=readme-ov-file", "repo"],
    ["/tree/main", "repo"],
    ["/tree/main/src", "path"],
    ["/blob/main/README.md", "path"],
    ["/issues/12", "issue"],
    ["/discussions/3", "issue"],
    ["/pull/7", "pull"],
    ["/commit/abc", "commit"],
    ["/compare/a...b", "commit"],
    ["/releases/tag/v1", "release"],
    ["/wiki", "path"],
  ])("%j → %s", (rest, kind) => {
    expect(classifyPath(rest)).toBe(kind);
  });
});

describe("parseRepoUrl", () => {
  it("normalises case, www, protocol and .git", () => {
    expect(parseRepoUrl("http://www.GitHub.com/Tmux/Tmux.git")).toEqual({ key: "tmux/tmux", name: "Tmux/Tmux", kind: "repo" });
  });
  it("rejects github site pages", () => {
    for (const u of ["https://github.com/features/actions", "https://github.com/orgs/foo/people", "https://github.com/sponsors/bar", "https://github.com/topics/rust"]) {
      expect(parseRepoUrl(u)).toBeNull();
    }
  });
  it("rejects user pages and gists", () => {
    expect(parseRepoUrl("https://github.com/torvalds")).toBeNull();
    expect(parseRepoUrl("https://gist.github.com/x/abc")).toBeNull();
    expect(extractRepos("notgithub.com/a/b")).toEqual([]);
  });
  it("rejects invalid owners", () => {
    expect(parseRepoUrl("https://github.com/-bad/repo")).toBeNull();
  });
});

describe("extractRepos", () => {
  it("reads links from HN-escaped hrefs", () => {
    const html = `Check out ${a("https://github.com/BurntSushi/ripgrep")}, it is great`;
    expect(extractRepos(html)).toMatchObject([{ key: "burntsushi/ripgrep", name: "BurntSushi/ripgrep", kind: "repo" }]);
  });
  it("prefers the href over truncated visible text", () => {
    const html = a("https://github.com/sharkdp/hyperfine-benchmarks/blob/main/x.md", "https://github.com/sharkdp/hyperfine-ben...");
    expect(extractRepos(html).map((l) => l.key)).toEqual(["sharkdp/hyperfine-benchmarks"]);
  });
  it("ignores truncated bare text names", () => {
    expect(extractRepos("see github.com/foo/barbazq... for more")).toEqual([]);
  });
  it("finds bare (unlinked) mentions", () => {
    expect(extractRepos("I use github.com/junegunn/fzf daily.")).toMatchObject([{ key: "junegunn/fzf", kind: "repo" }]);
  });
  it("dedupes one repo linked several ways and keeps the best kind", () => {
    const html = `${a("https://github.com/x/y/issues/1")} and ${a("https://github.com/x/y")} and github.com/X/Y/pull/3`;
    const links = extractRepos(html);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ key: "x/y", kind: "repo" });
  });
  it("returns several distinct repos", () => {
    const html = `${a("https://github.com/a/one")}<p>${a("https://github.com/b/two/tree/dev/src")}`;
    expect(extractRepos(html).map((l) => [l.key, l.kind])).toEqual([["a/one", "repo"], ["b/two", "path"]]);
  });
  it("handles trailing sentence punctuation and parentheses", () => {
    expect(extractRepos("(see github.com/a/b). Also https://github.com/c/d.").map((l) => l.key)).toEqual(["a/b", "c/d"]);
  });
  it("records where the link appears in the text", () => {
    const [link] = extractRepos("lots of words before github.com/a/b");
    expect(link?.index).toBe("lots of words before github.com/".length);
  });
});

describe("snippetAround", () => {
  it("returns short text unchanged", () => {
    expect(snippetAround("short and sweet", 3)).toBe("short and sweet");
  });
  it("windows long text around the index on word boundaries", () => {
    const text = `${"lorem ipsum ".repeat(60)}TARGET ${"dolor sit ".repeat(60)}`;
    const s = snippetAround(text, text.indexOf("TARGET"), 120);
    expect(s).toContain("TARGET");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(122);
  });
});
