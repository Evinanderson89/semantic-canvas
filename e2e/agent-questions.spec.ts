import { expect, test } from "@playwright/test";

for (const failure of ["json", "non-json", "unconfirmed"] as const) test(`failed ${failure} clarification answer stays editable and retries without losing text`, async ({ page }) => {
  await page.clock.install();
  const question = { id: "synthetic-q", question: "Which reporting period should this dashboard use?" };
  const answers: string[] = []; let pending = true, failPoll = false;
  await page.route("**/api/agent/questions", route => failPoll
    ? route.fulfill({ status: 503, json: { error: "Question service unavailable" } })
    : route.fulfill({ json: { questions: pending ? [question] : [] } }));
  await page.route("**/api/agent/questions/*/answer", route => {
    answers.push(route.request().postDataJSON().answer);
    if (answers.length === 1) return failure === "json"
      ? route.fulfill({ status: 503, json: { error: "Please retry your answer" } })
      : failure === "non-json" ? route.fulfill({ status: 502, contentType: "text/plain", body: "Unavailable" })
      : route.fulfill({ json: { ok: false } });
    pending = false; return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const panel = page.locator(".agent-ask"), input = panel.getByPlaceholder("Type your answer…");
  await input.fill("The last complete quarter, using our fiscal calendar.");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText(failure === "json" ? "Please retry" : failure === "non-json" ? "502" : "confirm");
  await expect(input).toHaveValue("The last complete quarter, using our fiscal calendar.");
  // A failed background refresh must not hide the question or reset its draft.
  failPoll = true; await page.clock.fastForward(1600);
  await expect(panel.getByRole("heading")).toHaveText(question.question);
  await expect(input).toHaveValue("The last complete quarter, using our fiscal calendar.");
  await input.fill("March through May, our last complete fiscal quarter.");
  failPoll = false;
  await panel.getByRole("button", { name: "Retry answer", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(answers).toEqual(["The last complete quarter, using our fiscal calendar.", "March through May, our last complete fiscal quarter."]);
});

test("failed option answer can be retried and an old poll cannot reopen an acknowledged question", async ({ page }) => {
  await page.clock.install();
  const question = { id: "synthetic-choice", question: "Which audience should this serve?", options: ["Executive", "Analyst"] };
  const answers: string[] = [];
  // Deliberately stale list, including after the answer succeeds.
  await page.route("**/api/agent/questions", route => route.fulfill({ json: { questions: [question] } }));
  await page.route("**/api/agent/questions/*/answer", route => {
    answers.push(route.request().postDataJSON().answer);
    return answers.length === 1 ? route.fulfill({ status: 503, json: { error: "Try again shortly" } }) : route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const panel = page.locator(".agent-ask");
  await panel.getByRole("button", { name: "Executive", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Try again shortly");
  await panel.getByRole("button", { name: "Retry answer", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.clock.fastForward(1600);
  await expect(panel).toHaveCount(0);
  expect(answers).toEqual(["Executive", "Executive"]);
});

test("polling cannot advance the question while its answer is still being sent", async ({ page }) => {
  await page.clock.install();
  const first = { id: "first", question: "Which reporting period?" }, next = { id: "next", question: "Which audience?" };
  let polls = 0, posted = false, sent = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/agent/questions", route => {
    polls++; return route.fulfill({ json: { questions: sent ? [next] : [first] } });
  });
  await page.route("**/api/agent/questions/*/answer", async route => {
    posted = true; await gate; sent = true; await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const panel = page.locator(".agent-ask"), input = panel.getByLabel("Your answer", { exact: true });
  await input.fill("Last complete month");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => posted).toBe(true);
  const before = polls;
  await page.clock.fastForward(5000);
  expect(polls).toBe(before);
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue("Last complete month");
  release(); await expect(panel).toHaveCount(0);
  await page.clock.fastForward(1600);
  await expect(panel.getByRole("heading")).toHaveText(next.question);
  await expect(input).toHaveValue(""); await expect(input).toBeEnabled();
});
