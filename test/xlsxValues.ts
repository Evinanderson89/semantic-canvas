import { strFromU8, unzipSync } from "fflate";

/** Inspect the emitted ZIP/XML rather than the exporter's input cell objects.
 * This intentionally reads only the plain shared-string/number/boolean cells
 * used by these exports; browser tests also parse XML with DOMParser. */
export function workbookXml(bytes: Uint8Array) {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, content]) => [name, strFromU8(content)]));
}
export function sheetCells(files: Record<string, string>, sheet = 1) {
  const text = (value: string) => value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (all, entity: string) => {
    if (entity[0] === "#") return String.fromCodePoint(entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity] ?? all;
  }).replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const strings = [...files["xl/sharedStrings.xml"].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => text(m[1]));
  return Object.fromEntries([...files[`xl/worksheets/sheet${sheet}.xml`].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(m => {
    const address = /\br="([^"]+)"/.exec(m[1])![1], type = /\bt="([^"]+)"/.exec(m[1])?.[1] ?? "n";
    const raw = /<v>([\s\S]*?)<\/v>/.exec(m[2])?.[1];
    return [address, { type, value: raw == null ? null : type === "s" ? strings[Number(raw)] : type === "b" ? raw === "1" : Number(raw) }];
  }));
}
