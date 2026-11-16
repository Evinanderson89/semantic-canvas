import { expect, it, vi } from "vitest";
const driver = vi.hoisted(() => ({ options: [] as any[], connection: null as any }));
vi.mock("snowflake-sdk", () => ({ default: { createConnection: (config: any) => {
  driver.connection = config;
  return {
  connect(callback: (error: null) => void) { callback(null); },
  execute(options: any) {
    driver.options.push(options);
    // Model the documented driver's Number-as-string option. No warehouse call.
    options.complete(null, {}, [{ account_id: options.fetchAsString?.includes("Number") ? "9007199254740993" : 9007199254740992,
      legacy_bigint: 9007199254740993n, small_count: 2n, amount: "12345678901234567890.12345678",
      absent: config.representNullAsStringNull === false ? null : "NULL", literal_text: "NULL" }]);
  },
  destroy(callback: (error: null) => void) { callback(null); },
}; } } }));
import { snowflakeConnector } from "../src/connectors/snowflake.ts";

it("requests exact numeric text before SDK decoding and preserves large BigInt fallbacks", async () => {
  const conn = await snowflakeConnector({ account: "synthetic", username: "synthetic", warehouse: "synthetic", database: "synthetic", schema: "synthetic", poolSize: 1 });
  try {
    const result = await conn.execute("SELECT synthetic_values");
    expect(driver.options[0].fetchAsString).toEqual(["Number"]);
    expect(driver.connection.representNullAsStringNull).toBe(false);
    expect(JSON.parse(JSON.stringify(result)).rows).toEqual([["9007199254740993", "9007199254740993", 2, "12345678901234567890.12345678", null, "NULL"]]);
  } finally { await conn.close(); }
});
