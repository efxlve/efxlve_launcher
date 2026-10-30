/**
 * Markdown-lite: the small subset the notes editor promises.
 *
 * The source is escaped first and every rule after that only adds tags, so a
 * note can never inject markup. Checklists carry their source index in
 * `data-note-check`, which is what lets the preview flip `- [ ]` to `- [x]`
 * in the body.
 */

import { esc } from "../../core/utils";

export interface MarkdownResult {
  html: string;
  /** How many checklist boxes the render produced, in order. */
  checks: number;
}

const CHECK_LINE = /^(\s*[-*]\s+\[)([ xX])(\]\s?)(.*)$/;

function inline(raw: string, images: string[]): string {
  // Escape once; the replacements below only add tags, and the stashed parts
  // (code, links, images) are restored after the emphasis rules so their
  // content is never re-processed.
  let text = esc(raw);
  const tokens: string[] = [];
  const stash = (html: string): string => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  text = text.replace(/`([^`]+)`/g, (_, code: string) => stash(`<code>${code}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(note-image:(\d+)\)/g, (_, alt: string, index: string) => {
    const data = images[Number(index)];
    if (!data || !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(data)) return "";
    return stash(
      `<img class="notes-inline-image" src="${esc(data)}" alt="${alt}" loading="lazy" />`,
    );
  });
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label: string, url: string) =>
      stash(`<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`),
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<em>$2</em>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => tokens[Number(index)] ?? "");
  return text;
}

/** Renders the supported subset: headings, lists, checklists, quotes, code,
 * rules, links and the inline emphasis. */
export function renderMarkdownLite(source: string, images: string[] = []): MarkdownResult {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let checks = 0;
  let paragraph: string[] = [];
  let list: "ul" | "ol" | "check" | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map((line) => inline(line, images)).join("<br />")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    out.push(list === "check" ? "</ul>" : `</${list}>`);
    list = null;
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    out.push(`<blockquote>${quote.map((line) => inline(line, images)).join("<br />")}</blockquote>`);
    quote = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushAll();
      code = [];
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2], images)}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushAll();
      out.push("<hr />");
      continue;
    }

    const check = CHECK_LINE.exec(line);
    if (check) {
      flushParagraph();
      flushQuote();
      if (list !== "check") {
        flushList();
        out.push('<ul class="notes-checklist">');
        list = "check";
      }
      const done = check[2].toLowerCase() === "x";
      const index = checks;
      checks += 1;
      out.push(
        `<li class="notes-check${done ? " is-done" : ""}">` +
          `<button type="button" class="notes-check-box" data-note-check="${index}" role="checkbox" aria-checked="${done}">${done ? "✓" : ""}</button>` +
          `<span>${inline(check[4], images)}</span></li>`,
      );
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      flushQuote();
      if (list !== "ul") {
        flushList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(bullet[1], images)}</li>`);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      flushQuote();
      if (list !== "ol") {
        flushList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(numbered[1], images)}</li>`);
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }

  if (code) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  flushAll();
  return { html: out.join(""), checks };
}

/** Flips the nth checklist line between `[ ]` and `[x]`. */
export function toggleChecklist(source: string, index: number): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = CHECK_LINE.exec(lines[i]);
    if (!match) continue;
    if (seen === index) {
      const next = match[2].toLowerCase() === "x" ? " " : "x";
      lines[i] = `${match[1]}${next}${match[3]}${match[4]}`;
      return lines.join("\n");
    }
    seen += 1;
  }
  return source;
}

/** A list preview: markers gone, one line, cut at `max`. */
export function notePreview(source: string, max = 120): string {
  const text = source
    .replace(/!\[[^\]]*\]\(note-image:\d+\)/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, ""))
    .join(" ")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The label a scope shows in the list: the game title when it is known. */
export function scopeTail(scope: string): string {
  const index = scope.indexOf("::");
  return index < 0 ? scope : scope.slice(index + 2);
}
