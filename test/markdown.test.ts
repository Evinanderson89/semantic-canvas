import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../src/app/markdown.tsx";

it("keeps fenced SQL and code literal, indented and HTML-escaped", () => {
  const html = renderToStaticMarkup(renderMarkdown("Before\n```sql\nSELECT '**literal**';\n  -- keep indent\n- not a bullet\n<script>alert(1)</script>\n```\nAfter"));
  expect(html).toContain("<pre><code>SELECT &#x27;**literal**&#x27;;\n  -- keep indent\n- not a bullet\n&lt;script&gt;");
  expect(html).not.toMatch(/<script>|<li>|<b>/);
  expect(html).toContain("</code></pre><p>After</p>");
});
it("preserves unfinished fences and does not close a fence with another marker", () => {
  expect(renderToStaticMarkup(renderMarkdown("~~~\n  x\n```\n  y"))).toBe("<pre><code>  x\n```\n  y</code></pre>");
});
