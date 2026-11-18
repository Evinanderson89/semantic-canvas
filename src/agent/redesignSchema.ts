import { z } from "zod";
import { proposalSchema } from "../canvas/proposals.ts";
import { filterSchema, tileSchema } from "../compiler/schema.ts";

// Creation needs fewer options than the persisted document. Keeping this
// contract small leaves room for strict decoding; existing tile styling,
// filters and other properties are preserved by the normal proposal applier.
// Required fields in each shape avoid an exponential grammar from combinations
// of optional persisted-tile settings. Arrays may be empty when not applicable.
const common = {
  id: tileSchema.shape.id,
  layout: tileSchema.shape.layout.omit({ z: true }),
  section: tileSchema.shape.section.unwrap().describe("Heading ID, or null for no section"),
};
const empty = z.array(z.string()).max(0).describe("Must be [] for a non-metric tile");
const filterCommon = { id: filterSchema.shape.id, field: filterSchema.shape.field, source: filterSchema.shape.source, exclude: z.boolean() };
const filters = z.array(z.discriminatedUnion("mode", [
  z.object({ ...filterCommon, mode: z.literal("discrete"), values: filterSchema.shape.values.unwrap() }).strict(),
  z.object({ ...filterCommon, mode: z.literal("range"), min: filterSchema.shape.min.unwrap(), max: filterSchema.shape.max.unwrap(), maxExclusive: z.boolean() }).strict(),
])).max(100);
const format = tileSchema.shape.format.unwrap();
const newTile = z.discriminatedUnion("kind", [
  z.object({
    ...common, kind: z.literal("metric"), title: tileSchema.shape.title.unwrap(),
    metrics: tileSchema.shape.metrics.min(1),
    dimensions: tileSchema.shape.dimensions.removeDefault().describe("Governed dimensions. Period KPIs and prior/yoy comparisons need exactly one time dimension, such as month:date_field from the catalog. [] means an aggregate, not the latest period."),
    chart: tileSchema.shape.chart.unwrap(), compare: tileSchema.shape.compare.unwrap().describe("Use none for aggregates without a time dimension. prior/yoy require exactly one governed time dimension; chart:kpi alone does not establish a reporting period."),
    where: filters, limit: tileSchema.shape.limit.unwrap(),
    format: format.pick({ number: true, palette: true }).required(),
  }).strict(),
  z.object({
    ...common, kind: z.enum(["heading", "text"]), text: tileSchema.shape.text.unwrap(),
    metrics: empty, dimensions: empty,
    format: format.pick({ textSize: true, textAlign: true }).required(),
  }).strict(),
  z.object({ ...common, kind: z.literal("divider"), metrics: empty, dimensions: empty }).strict(),
]);

const actions = proposalSchema.shape.actions.element.options.map(action =>
  action.shape.type.value === "add" ? action.extend({ tile: newTile }).describe(action.description ?? "Add a tile") : action,
);
export const redesignToolSchema = proposalSchema.extend({
  actions: z.array(z.discriminatedUnion("type", actions as [typeof actions[number], ...typeof actions])).min(1).max(30),
});

type Schema = Record<string, any>;
const bounds = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems"]);
const scalar = new Set(["type", "enum", "const", "default", "description", "title", "$ref", "format", "pattern", "required", "additionalProperties"]);

/** Provider-supported JSON Schema only. Keep discriminators/enums enforceable,
 * and retain unsupported bounds as instructions plus local Zod validation.
 * Do not use the SDK output-format transformer here: this installed version
 * moves enum/const into descriptions, losing action-type constraints. */
export function strictToolSchema(input: Schema): Schema {
  if (input.$ref && Object.keys(input).some(key => !["$ref", "title", "description"].includes(key)))
    throw new Error("Inline strict tool schema references with sibling constraints");
  const output: Schema = {}, constraints: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "$schema") continue;
    if (bounds.has(key) || key === "minItems" && value > 1) {
      constraints.push(`${key}: ${JSON.stringify(value)}`);
    } else if (key === "properties" || key === "$defs") {
      output[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, strictToolSchema(schema as Schema)]));
    } else if (key === "anyOf" || key === "oneOf") {
      output.anyOf = value.map(strictToolSchema);
    } else if (key === "items") {
      output.items = strictToolSchema(value);
    } else if (scalar.has(key) || key === "minItems") {
      output[key] = value;
    } else {
      throw new Error(`Unsupported strict tool schema keyword: ${key}`);
    }
  }
  if (output.type === "object" && output.additionalProperties !== false)
    throw new Error("Strict tool objects must reject additional properties");
  if (output.type === "object" && output.properties && (output.properties.type?.const === "format" || "at" in output.properties && "label" in output.properties && "kind" in output.properties))
    output.required = Object.keys(output.properties);
  if (constraints.length) output.description = [output.description, `Local validation requires ${constraints.join(", ")}.`].filter(Boolean).join("\n");
  return output;
}
