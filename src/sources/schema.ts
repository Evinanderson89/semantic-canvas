import type { CatalogTable, Connector } from "../connectors/types.ts";
import { visibleModel, type Model } from "../semantic/model.ts";

type SchemaConnector = Pick<Connector, "label"> & {
  schema?(): Promise<Pick<CatalogTable, "name" | "columns">[]>;
};

/** The caller must resolve source authorization before requesting discovery.
 * Raw connector metadata is an administrator surface. Other roles discover
 * their semantic catalog, so connector capabilities cannot broaden visibility. */
export async function discoverSchema(model: Model, role: "viewer" | "editor" | "admin", label: string, connector: SchemaConnector) {
  if (role === "admin" && typeof connector.schema === "function") {
    return { tables: await connector.schema(), source: connector.label, scope: "warehouse" as const };
  }
  return {
    tables: Object.values(visibleModel(model, role).tables).map(table => ({
      name: table.name, columns: table.columns.map(column => ({ name: column.name, type: column.type })),
    })),
    source: `${label} (from the semantic model)`, scope: "semantic-model" as const,
  };
}
