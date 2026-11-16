import { afterEach, expect, it, vi } from "vitest";
const driver = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("snowflake-sdk", () => ({ default: { createConnection: driver.create } }));
import { snowflakeConnector } from "../src/connectors/snowflake.ts";

const config = { account: "synthetic", username: "synthetic", warehouse: "synthetic", database: "synthetic", schema: "synthetic", poolSize: 3 };
function connection() {
  return { connect: vi.fn((done: (error: Error | null) => void) => done(null)),
    destroy: vi.fn((done: (error: Error | null) => void) => done(null)),
    execute: vi.fn((options: any) => options.complete(null, {}, [{ answer: 42 }])) };
}
afterEach(() => { driver.create.mockReset(); });

for (const size of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) it(`rejects invalid pool size ${size} without allocating handles`, async () => {
  await expect(snowflakeConnector({ ...config, poolSize: size })).rejects.toThrow("Connection pool size must be a positive integer");
  expect(driver.create).not.toHaveBeenCalled();
});

it("waits for late startup attempts and destroys every allocated handle after a connection failure", async () => {
  const early = connection(), failed = connection(), late = connection(), failure = new Error("Synthetic connection failure");
  let finish!: (error: Error | null) => void;
  failed.connect.mockImplementation(done => done(failure));
  late.connect.mockImplementation(done => { finish = done; });
  driver.create.mockReturnValueOnce(early).mockReturnValueOnce(failed).mockReturnValueOnce(late);
  let settled = false;
  const outcome = snowflakeConnector(config).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  await vi.waitFor(() => expect(late.connect).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  finish(null);
  expect(await outcome).toBe(failure);
  for (const c of [early, failed, late]) expect(c.destroy).toHaveBeenCalledOnce();
});

it("cleans successful handles even if a different connection factory throws synchronously", async () => {
  const early = connection(), late = connection(), failure = new Error("Synthetic factory failure");
  driver.create.mockReturnValueOnce(early).mockImplementationOnce(() => { throw failure; }).mockReturnValueOnce(late);
  await expect(snowflakeConnector(config)).rejects.toBe(failure);
  expect(early.destroy).toHaveBeenCalledOnce();
  expect(late.destroy).toHaveBeenCalledOnce();
});

it("cleans a handle whose connect call throws before installing its callback", async () => {
  const c = connection(), failure = new Error("Synthetic connect throw");
  c.connect.mockImplementation(() => { throw failure; }); driver.create.mockReturnValue(c);
  await expect(snowflakeConnector({ ...config, poolSize: 1 })).rejects.toBe(failure);
  expect(c.destroy).toHaveBeenCalledOnce();
});

it("preserves the startup error and still attempts all cleanup when destruction fails", async () => {
  const a = connection(), b = connection(), c = connection(), failure = new Error("Synthetic startup failure");
  a.destroy.mockImplementation(() => { throw new Error("Synthetic synchronous cleanup failure"); });
  b.destroy.mockImplementation(done => done(new Error("Synthetic callback cleanup failure")));
  c.connect.mockImplementation(done => done(failure));
  driver.create.mockReturnValueOnce(a).mockReturnValueOnce(b).mockReturnValueOnce(c);
  await expect(snowflakeConnector(config)).rejects.toBe(failure);
  for (const connection of [a,b,c]) expect(connection.destroy).toHaveBeenCalledOnce();
});

it("retains a healthy pool for queries and closes each connection only once", async () => {
  const a = connection(), b = connection(); driver.create.mockReturnValueOnce(a).mockReturnValueOnce(b);
  const conn = await snowflakeConnector({ ...config, poolSize: 2 });
  expect(a.destroy).not.toHaveBeenCalled(); expect(b.destroy).not.toHaveBeenCalled();
  expect((await conn.execute("SELECT synthetic")).rows).toEqual([[42]]);
  await Promise.all([conn.close(), conn.close()]);
  expect(a.destroy).toHaveBeenCalledOnce(); expect(b.destroy).toHaveBeenCalledOnce();
  await expect(conn.execute("SELECT late")).rejects.toThrow("connection was replaced");
});
