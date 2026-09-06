import { describe, expect, it } from "vitest";
import { slugForFilename, toCsv } from "../src/app/export.ts";

describe("toCsv", () => {
  it("joins plain values with commas and CRLF line endings", () => {
    expect(toCsv(["month", "mrr"], [["2026-01", 100], ["2026-02", 120]]))
      .toBe("month,mrr\r\n2026-01,100\r\n2026-02,120\r\n");
  });

  it("quotes a field containing a comma", () => {
    expect(toCsv(["label"], [["Acme, Inc."]])).toBe('label\r\n"Acme, Inc."\r\n');
  });

  it("quotes and doubles an embedded quote", () => {
    expect(toCsv(["label"], [['He said "hi"']])).toBe('label\r\n"He said ""hi"""\r\n');
  });

  it("quotes a field containing a newline", () => {
    expect(toCsv(["notes"], [["line one\nline two"]])).toBe('notes\r\n"line one\nline two"\r\n');
  });

  it("renders null/undefined as an empty field, not the string \"null\"", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,\r\n");
  });
});

describe("slugForFilename", () => {
  it("lowercases and hyphenates", () => {
    expect(slugForFilename("Starting MRR (USD), Ending MRR (USD)")).toBe("starting-mrr-usd-ending-mrr-usd");
  });

  it("falls back to a default for an all-punctuation title", () => {
    expect(slugForFilename("!!!")).toBe("export");
  });
});
