/**
 * The small Markdown subset the transcript renders: fenced code, inline code,
 * bold, italic, headings, bullet lists, links and paragraphs.
 *
 * Everything is HTML-escaped *before* any markup is added. The old renderer
 * escaped only fenced code and passed the rest of the model's reply to
 * innerHTML as it was, so a reply containing `<img src=x onerror=…>` ran
 * script in this page — and a reply can be steered by what a tool fetched.
 * This page can POST /api/permission, so that script could have approved a
 * parked tool call. Now the only tags in the output are the ones added here.
 */
export function renderMarkdown(text: string): string {
  const blocks: string[] = [];
  // Fenced code first, so nothing inside it is treated as markup.
  let out = text.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
    blocks.push(
      `<pre class="md-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(code.trimEnd())}</code></pre>`,
    );
    return `\u0000${blocks.length - 1}\u0000`;
  });

  out = escapeHtml(out)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');

  const html: string[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) html.push(`<ul>${list.map((li) => `<li>${li}</li>`).join("")}</ul>`);
    list = [];
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };

  for (const line of out.split("\n")) {
    const block = line.match(/^\u0000(\d+)\u0000$/);
    const heading = line.match(/^(#{1,3}) (.+)$/);
    const bullet = line.match(/^\s*[-*] (.+)$/);
    if (block) {
      flushPara();
      flushList();
      html.push(blocks[Number(block[1])]!);
    } else if (heading) {
      flushPara();
      flushList();
      const level = heading[1]!.length + 1; // # → h2: the page already has a title
      html.push(`<h${level}>${heading[2]}</h${level}>`);
    } else if (bullet) {
      flushPara();
      list.push(bullet[1]!);
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  // A fence left open by a still-streaming reply: show what there is as code.
  return html.join("").replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)] ?? "");
}

const CARET = '<span class="caret" aria-hidden="true"></span>';

/**
 * Put the streaming caret at the end of the last line of text, not on a line
 * of its own after the last paragraph.
 */
export function withCaret(html: string): string {
  const last = html.match(/(<\/code><\/pre>|<\/li><\/ul>|<\/p>|<\/h[2-4]>)$/);
  return last ? `${html.slice(0, -last[0].length)}${CARET}${last[0]}` : html + CARET;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
