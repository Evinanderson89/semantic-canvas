import { beforeEach, expect, it, vi } from "vitest";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
import { suggestDashboardStory } from "../src/agent/loop.ts";
import { additionKey } from "../src/suggest/reviewSession.ts";
beforeEach(() => { create.mockReset(); });

it("carries the building goal and choices forward while suppressing duplicates and dismissed additions", async () => {
  const existing = {metrics:["revenue"], title:"Revenue",reason:"Context",breakdown:"time" as const};
  const dismissed = {...existing,metrics:["users"],title:"Users"};
  const allowed = {...existing,metrics:["margin"],title:"Margin"};
  create.mockResolvedValue({content:[{type:"text",text:JSON.stringify({title:"Keep my title",layout:"exec-summary",order:["trend","trend","fake"],notes:[],summary:"Improve the layout",additions:[existing,dismissed,allowed,allowed,{...allowed,metrics:["fake"]}]})}]});
  const controller = new AbortController();
  const review = {goal:"Help the executive review",dashboardTitle:"Keep my title",decisions:[{key:additionKey(dismissed),label:"Skip Users",status:"dismissed" as const}]};
  const result = await suggestDashboardStory({provider:"anthropic",model:"test",apiKey:"test"},{signal:controller.signal},[{id:"trend",title:"Revenue",kind:"line",metrics:["revenue"],dimensions:["month:sold_on"]}], ["revenue","users","margin"].map(name=>({name,label:name,baseTable:"sales"})),review);
  expect(result.order).toEqual(["trend"]);
  expect(result.additions).toEqual([allowed]);
  expect(result.layout).toBe("exec-summary");
  expect(create.mock.calls[0][0].messages[0].content).toContain(JSON.stringify(review));
  expect(create.mock.calls[0][1].signal).toBe(controller.signal);
  expect(create.mock.calls[0][0].output_config.format.type).toBe("json_schema");
  expect(create.mock.calls[0][0].output_config.format.schema.required).toContain("order");
});

const valid = { title: "Revenue", layout: null, order: ["trend"], notes: [], additions: [], summary: "Lead with the trend." };
const response = (text: string, stop_reason = "end_turn") => ({ content: [{ type: "text", text }], stop_reason });
const review = (signal?: AbortSignal) => suggestDashboardStory({ provider: "anthropic", model: "test", apiKey: "test" }, { signal }, [{ id: "trend", title: "Revenue", kind: "line", metrics: ["revenue"], dimensions: ["month:sold_on"] }], [{ name: "revenue", label: "Revenue", baseTable: "sales" }]);

it("retries a truncated response with more room and returns only the complete review", async () => {
  create.mockResolvedValueOnce(response(JSON.stringify(valid), "max_tokens")).mockResolvedValueOnce(response(JSON.stringify(valid)));
  expect(await review()).toEqual(valid);
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls.map(([body]) => body.max_tokens)).toEqual([4096, 8192]);
});

it.each(["not JSON", "null", "[]", '{"title":"Missing required fields"}'])("recovers once from an unusable response: %s", async text => {
  create.mockResolvedValueOnce(response(text)).mockResolvedValueOnce(response(JSON.stringify(valid)));
  expect(await review()).toEqual(valid);
  expect(create).toHaveBeenCalledTimes(2);
});

it("stops after one recovery attempt and returns an actionable error", async () => {
  create.mockResolvedValue(response('{"title":'));
  await expect(review()).rejects.toThrow(/dashboard is unchanged.*Retry/);
  expect(create).toHaveBeenCalledTimes(2);
});

it("does not retry a refusal or a provider authentication failure", async () => {
  create.mockResolvedValueOnce(response("Unable to review", "refusal"));
  await expect(review()).rejects.toThrow(/declined/);
  expect(create).toHaveBeenCalledTimes(1);
  create.mockReset().mockRejectedValue(new Error("Authentication failed"));
  await expect(review()).rejects.toThrow(/Authentication/);
  expect(create).toHaveBeenCalledTimes(1);
});

it("does not retry or return a review after cancellation", async () => {
  const controller = new AbortController();
  create.mockImplementationOnce(async () => { controller.abort(); return response('{"title":', "max_tokens"); });
  await expect(review(controller.signal)).rejects.toThrow(/abort/i);
  expect(create).toHaveBeenCalledTimes(1);
});
