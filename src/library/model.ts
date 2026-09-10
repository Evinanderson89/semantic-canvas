import { z } from "zod";
import { canvasSchema, dashboardSchema } from "../compiler/schema.ts";

const id = z.string().min(1).max(256);
const name = z.string().trim().min(1).max(100);
export const folderSchema = z.object({ id, name, parentId: id.nullable().default(null), revision: z.number().int().nonnegative().default(0) }).strict();
export const viewSaveSchema = z.object({ id, name, description: z.string().max(1000).default(""), folderId: id.nullable().default(null),
  revision: z.number().int().nonnegative().default(0), spec: dashboardSchema.refine(s => s.tiles.length > 0, "Choose at least one tile to save as a view"), canvas: canvasSchema,
}).strict().refine(v => (v.spec.tabs?.length ?? 1) === 1, "A reusable view contains one canvas section");
export const itemKindSchema = z.enum(["dashboard", "view"]);
export type LibraryKind = z.infer<typeof itemKindSchema>;
export type LibraryFolder = z.infer<typeof folderSchema>;
export type LibraryView = z.infer<typeof viewSaveSchema>;
export interface LibraryItem { id: string; kind: LibraryKind; name: string; description: string; folderId: string | null; revision: number; updatedAt: string; tileCount: number; isTemplate?: boolean }
export interface CoreLibrary { folders: LibraryFolder[]; items: LibraryItem[] }
export const itemUpdateSchema = z.object({ revision: z.number().int().positive(), name: name.optional(), folderId: id.nullable().optional() }).strict();

export function folderPath(folders: LibraryFolder[], id: string | null): LibraryFolder[] {
  const path: LibraryFolder[] = [], seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id); const folder = folders.find(f => f.id === id); if (!folder) break;
    path.unshift(folder); id = folder.parentId;
  }
  return path;
}
