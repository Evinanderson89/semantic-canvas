import { afterEach, expect, it, vi } from "vitest";
const driver = vi.hoisted(() => ({ statements: [] as any[] }));
vi.mock("snowflake-sdk", () => ({ default: { createConnection: () => ({
  connect(done: (error: null) => void) { done(null); },
  execute(options: any) {
    const statement = { options, cancel: vi.fn((done: (error: null) => void) => done(null)) };
    driver.statements.push(statement); return statement;
  },
  destroy(done: (error: null) => void) { done(null); },
}) } }));
import { snowflakeConnector } from "../src/connectors/snowflake.ts";
const open = () => snowflakeConnector({ account: "synthetic", username: "synthetic", warehouse: "synthetic", database: "synthetic", schema: "synthetic", poolSize: 1 });
afterEach(() => { driver.statements.length = 0; vi.useRealTimers(); });

it("cancels only the running statement and holds its lease until completion is confirmed", async () => {
  const conn = await open(), controller = new AbortController();
  const first = expect(conn.execute("SELECT first", 1, undefined, { signal: controller.signal, timeoutMs: 10000 })).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(driver.statements).toHaveLength(1));
  const statement = driver.statements[0];
  expect(statement.options.parameters).toEqual({ STATEMENT_TIMEOUT_IN_SECONDS: 10, STATEMENT_QUEUED_TIMEOUT_IN_SECONDS: 10 });
  const second = conn.execute("SELECT second");
  controller.abort();
  expect(statement.cancel).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(driver.statements).toHaveLength(1);
  statement.options.complete(new Error("Statement canceled"), statement, []);
  await first;
  await vi.waitFor(() => expect(driver.statements).toHaveLength(2));
  expect(driver.statements[1].cancel).not.toHaveBeenCalled();
  expect(driver.statements[1].options.parameters).toBeUndefined();
  driver.statements[1].options.complete(null, driver.statements[1], [{ answer: 42 }]);
  expect((await second).rows).toEqual([[42]]);
  await conn.close();
});

it("enforces a client deadline and waits for completion even if cancellation fails", async () => {
  vi.useFakeTimers();
  const conn = await open();
  const pending = expect(conn.execute("SELECT slow", 1, undefined, { timeoutMs: 1500 })).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(0);
  const statement = driver.statements[0];
  statement.cancel.mockImplementation(() => { throw new Error("Synthetic cancellation failure"); });
  expect(statement.options.parameters.STATEMENT_TIMEOUT_IN_SECONDS).toBe(2);
  await vi.advanceTimersByTimeAsync(1500);
  expect(statement.cancel).toHaveBeenCalledOnce();
  expect(conn.stats()).toMatchObject({ free: 0 });
  statement.options.complete(new Error("Warehouse statement timeout"), statement, []);
  await pending;
  expect(conn.stats()).toMatchObject({ free: 1 });
  await conn.close();
});
