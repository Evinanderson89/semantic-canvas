import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small, safe renderer for agent-generated text -- Explain,
 * Beautify, and the dashboard-story summary/notes/additions all come back
 * as plain strings from the model, and the model reaches for **bold**,
 * `code`, and "- " bullets often enough that showing the string as-is
 * means literal asterisks and backticks on screen instead of the
 * formatting they were meant to be. Only React elements are ever produced
 * here (never dangerouslySetInnerHTML), so there's no HTML-injection
 * surface. Fenced code preserves whitespace and literal Markdown; unsupported
 * syntax stays text. HTML is never interpreted.
 */
export function renderMarkdown(text: string): ReactNode {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let fence: { character: string; length: number; lines: string[] } | null = null;
  const flushBullets = () => {
    if (!bullets.length) return;
    blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{renderInline(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const raw of lines) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(raw);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
        blocks.push(<pre key={blocks.length}><code>{fence.lines.join("\n")}</code></pre>); fence = null;
      } else fence.lines.push(raw);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) {
      flushBullets(); fence = { character: opening[1][0], length: opening[1].length, lines: [] }; continue;
    }
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)/.exec(line);
    if (bullet) { bullets.push(bullet[1]); continue; }
    flushBullets();
    if (line) blocks.push(<p key={blocks.length}>{renderInline(line)}</p>);
  }
  flushBullets();
  if (fence) blocks.push(<pre key={blocks.length}><code>{fence.lines.join("\n")}</code></pre>);
  return <>{blocks}</>;
}

/** Inline-only variant (bold/code, no block-level p/ul) for text that has
 *  to stay on one line -- e.g. mixed with other text in the same <p>. */
export function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined) parts.push(<b key={key++}>{m[1]}</b>);
    else parts.push(<code key={key++}>{m[2]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return parts;
}
