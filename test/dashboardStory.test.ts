import { expect, it, vi } from "vitest";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
import { suggestDashboardStory } from "../src/agent/loop.ts";
import { additionKey } from "../src/suggest/reviewSession.ts";

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
});
