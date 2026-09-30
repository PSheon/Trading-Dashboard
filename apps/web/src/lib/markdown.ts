/**
 * The small Markdown subset the long-form pages use (docs/content/*.md):
 * headings, paragraphs, bullet and numbered lists, pipe tables, block
 * quotes, `---`, `<small>` lines and HTML comments (dropped); inline
 * **bold**, [links](/path), `code` and the owner's 【待填：…】 placeholders.
 * Parsing is pure (tested in test/content.test.ts); rendering lives in
 * components/content/markdown.tsx.
 */

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "quote"; text: string }
  | { type: "small"; text: string }
  | { type: "hr" };

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "placeholder"; text: string };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      flush();
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      flush();
      blocks.push({ type: "hr" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const small = /^<small>([\s\S]*)<\/small>$/.exec(trimmed);
    if (small) {
      flush();
      blocks.push({ type: "small", text: small[1].trim() });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) quote.push(lines[i++].trim().replace(/^>\s?/, ""));
      i--;
      blocks.push({ type: "quote", text: quote.join(" ") });
      continue;
    }
    const bullet = /^[-*]\s+/;
    const numbered = /^\d+\.\s+/;
    if (bullet.test(trimmed) || numbered.test(trimmed)) {
      flush();
      const ordered = numbered.test(trimmed);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        if (marker.test(current)) items.push(current.replace(marker, ""));
        // An indented line continues the item above it.
        else if (current !== "" && /^\s+/.test(lines[i]) && items.length > 0) items[items.length - 1] += ` ${current}`;
        else break;
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (trimmed.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      i--;
      const [head = [], separator, ...body] = rows;
      const hasSeparator = separator?.every((c) => /^:?-{2,}:?$/.test(c));
      blocks.push({ type: "table", head, rows: hasSeparator ? body : rows.slice(1) });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

/** Splits a line into inline runs. Unclosed markers stay as text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const push = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        push();
        out.push({ type: "bold", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (link) {
        push();
        out.push({ type: "link", href: link[2], children: parseInline(link[1]) });
        i += link[0].length;
        continue;
      }
    }
    if (rest.startsWith("`")) {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        push();
        out.push({ type: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("【待填")) {
      const end = text.indexOf("】", i);
      if (end > i) {
        push();
        out.push({ type: "placeholder", text: text.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  push();
  return out;
}

/** Plain text of a line (for titles and metadata). */
export function inlineText(text: string): string {
  const flat = (nodes: Inline[]): string =>
    nodes.map((n) => (n.type === "text" || n.type === "code" || n.type === "placeholder" ? n.text : flat(n.children))).join("");
  return flat(parseInline(text));
}
