import { expect, it } from "vitest";
import { additionKey, hasEquivalentTile, rememberDecision, reviewContextSchema, type ReviewDecision } from "../src/suggest/reviewSession.ts";

it("keeps the latest choice and bounds the session history", () => {
  let choices: ReviewDecision[] = [];
  for (let i=0;i<25;i++) choices = rememberDecision(choices,{ key:`idea-${i}`,label:`Idea ${i}`,status:"applied" });
  choices = rememberDecision(choices,{ key:"idea-20",label:"Keep it out",status:"dismissed" });
  expect(choices).toHaveLength(20);
  expect(choices.filter(d=>d.key==="idea-20")).toEqual([{key:"idea-20",label:"Keep it out",status:"dismissed"}]);
  expect(choices[0].key).toBe("idea-5");
});

it("recognizes existing governed context regardless of chart label or metric ordering", () => {
  const idea = { metrics:["revenue","users"],breakdown:"time" };
  expect(additionKey(idea)).toBe(additionKey({metrics:["users","revenue","users"],breakdown:"time"}));
  expect(hasEquivalentTile([{kind:"line",metrics:["users","revenue"],dimensions:["month:sold_on"]}],idea)).toBe(true);
  expect(hasEquivalentTile([{kind:"metric",metrics:["users","revenue"],dimensions:["country"]}],idea)).toBe(false);
  expect(hasEquivalentTile([{kind:"text",metrics:["users","revenue"],dimensions:["month:sold_on"]}],idea)).toBe(false);
  expect(hasEquivalentTile([{metrics:["revenue"],dimensions:[]}],{metrics:["revenue"],breakdown:"none"})).toBe(true);
});

it("validates limits and preserves backwards compatibility for callers without review context", () => {
  expect(reviewContextSchema.parse({}).decisions).toEqual([]);
  expect(reviewContextSchema.safeParse({goal:"x".repeat(601)}).success).toBe(false);
  expect(reviewContextSchema.safeParse({decisions:[{key:"x",label:"x",status:"invented"}]}).success).toBe(false);
});
