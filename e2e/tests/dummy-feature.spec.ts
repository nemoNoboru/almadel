import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SERVER_URL = process.env.ALMADEL_E2E_SERVER_URL!;
const PROJECT = process.env.ALMADEL_E2E_PROJECT ?? "almadel-api";
const FEATURE_REPO = process.env.ALMADEL_E2E_FEATURE_REPO!;

const TICKET_TITLE = "Add a hello feature";
const TICKET_BODY =
  "Create a file named hello.txt at the repository root containing exactly the text `hello world` " +
  "(no quotes, no trailing newline). The existing test suite must pass.";

test.setTimeout(15 * 60 * 1000);

const column = (id: string) => `[data-testid="column-drop-${id}"]`;
const card = (title: string) => `[role="button"][draggable="true"]:has-text("${title}")`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBoard(): Promise<any> {
  const res = await fetch(`${SERVER_URL}/api/projects/${PROJECT}/board`);
  if (!res.ok) throw new Error(`board fetch failed: ${res.status}`);
  return res.json();
}

async function getTicket(title: string): Promise<any> {
  const board = await fetchBoard();
  return board.tickets.find((t: any) => t.title === title) ?? null;
}

async function waitForTicket(
  title: string,
  predicate: (t: any) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const t = await getTicket(title);
    if (t) {
      last = t;
      if (predicate(t)) return t;
    }
    await sleep(2000);
  }
  throw new Error(
    `ticket "${title}" never satisfied predicate (last: ${JSON.stringify(last)})`,
  );
}

async function dragToColumn(page: import("@playwright/test").Page, title: string, columnId: string) {
  const source = page.locator(card(title)).first();
  await expect(source).toBeVisible({ timeout: 15_000 });
  const target = page.locator(column(columnId));
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend");
}

test("dummy feature flows Spec -> Done via a real agent", async ({ page }) => {
  await page.goto(`${SERVER_URL}/p/${PROJECT}`);

  // 1. Create the ticket in Spec (a human gate)
  await page.locator(column("col-spec")).getByRole("button", { name: "New card" }).click();
  await page.locator("#ticket-title").fill(TICKET_TITLE);
  await page.locator("#ticket-body").fill(TICKET_BODY);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(column("col-spec")).locator(card(TICKET_TITLE))).toBeVisible({
    timeout: 15_000,
  });

  // 2. Human gate: Spec -> Planning; the agent plans and moves it to Review
  await dragToColumn(page, TICKET_TITLE, "col-planning");
  await waitForTicket(TICKET_TITLE, (t) => t.column_id === "col-review", 180_000);

  // 3. Human gate: Review -> Implement; the agent implements, tests, and lands it
  await page.goto(`${SERVER_URL}/p/${PROJECT}`);
  await dragToColumn(page, TICKET_TITLE, "col-implement");
  const done = await waitForTicket(
    TICKET_TITLE,
    (t) => t.column_id === "col-done",
    300_000,
  );

  // 4. The agent worked on the ticket's own branch
  expect(done.branch).toMatch(/^run\/TCK-/);

  // 5. The agent posted a plan during the Planning stage
  const thread = await (await fetch(`${SERVER_URL}/api/tickets/${done.id}`)).json();
  expect(thread.comments.some((c: any) => c.kind === "plan")).toBe(true);

  // 6. The real artifact landed in the feature repo
  const content = await readFile(resolve(FEATURE_REPO, "hello.txt"), "utf8");
  expect(content.trim()).toBe("hello world");

  // 7. The web UI shows the ticket in Done
  await page.goto(`${SERVER_URL}/p/${PROJECT}`);
  await expect(page.locator(column("col-done")).locator(card(TICKET_TITLE))).toBeVisible({
    timeout: 15_000,
  });
});
