import { writeFileSync } from "node:fs";
import { activeBotId, completeOnboarding, rpc, signup, uniqueEmail } from "./helpers";
import type { Page } from "./test";
import { expect, test } from "./test";
import { finishedRuns, threadEntries } from "./thread-log";

type Rect = { x: number; y: number; width: number; height: number };
type Frame = {
  t: number;
  busy: boolean;
  clone: Rect | null;
  card: Rect;
  above: Rect;
  bubble: Rect | null;
  bubbleVisible: boolean;
  scrollTop: number;
  scrollMax: number;
  fold: number;
  rows: number;
  /** The old card fading as it folds, and the answer's bubble fading in. */
  ghost: number;
  bubbleOpacity: number;
};

const cities = { prompt: "pick from these cities with tappable choices", ready: "Seoul" };
const fridge = { prompt: "ask me three questions", ready: "Built-in, 54–56 cm" };

/** Opens a scripted question card after `history` earlier exchanges, scrolled to the end of the thread. */
async function openCard(page: Page, name: string, history = 0, { prompt, ready } = cities) {
  await signup(page, uniqueEmail(`${name}`), "password12", "Ask Motion");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  for (let turn = 1; turn <= history; turn++) {
    await page.getByPlaceholder(/Message/).fill(`note ${turn} for the motion check`);
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => finishedRuns(await threadEntries(page, { botId })).length, {
        timeout: 60_000,
      })
      .toBe(turn);
  }
  await page.getByPlaceholder(/Message/).fill(prompt);
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await rpc<{ run?: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status,
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  const first = page.getByRole("button", { name: ready, exact: true });
  if ((await first.count()) === 0) await page.reload({ waitUntil: "domcontentloaded" });
  await expect(first).toBeVisible({ timeout: 15_000 });
  return first;
}

/** Clicks and records every frame until `ms` after the commit has begun, which `started` marks. */
async function sampleCommit(
  page: Page,
  tile: ReturnType<Page["getByRole"]>,
  ms: number,
  started = "fieldset:disabled",
) {
  await page.evaluate(
    ([window_, started]) => {
      const transcript = document.querySelector('[data-testid="transcript"]') as HTMLElement;
      const card = document.querySelector('[data-slot="question-card"]') as HTMLElement;
      const rows = [...transcript.querySelectorAll("[data-message-id]")];
      const above = rows[rows.indexOf(card.closest("[data-message-id]") as Element) - 1] as Element;
      const rect = (element: Element | null) => {
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const flights: number[] = [];
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof HTMLElement && node.matches("[data-ask-flight]")) flights.push(1);
          }
        }
      }).observe(card, { childList: true, subtree: true });
      const frames: Frame[] = [];
      let heldAt: number | null = null;
      const probe = window as unknown as {
        commit: Promise<{ frames: Frame[]; flights: number[] }>;
      };
      probe.commit = new Promise((resolve) => {
        const step = (now: number) => {
          const bubble = card.querySelector('[data-slot="user-bubble"]');
          const frame = {
            t: now,
            busy: Boolean(card.querySelector(started)),
            clone: rect(card.querySelector("[data-ask-flight]")),
            card: rect(card) as Rect,
            above: rect(above) as Rect,
            bubble: rect(bubble),
            bubbleVisible: Boolean(bubble && getComputedStyle(bubble).visibility === "visible"),
            scrollTop: transcript.scrollTop,
            scrollMax: transcript.scrollHeight - transcript.clientHeight,
            fold: (card.firstElementChild as Element).getBoundingClientRect().height,
            rows: transcript.querySelectorAll("[data-message-id]").length,
            ghost: Math.max(
              0,
              ...[...(card.firstElementChild as Element).children]
                .filter((child) => !child.matches("[data-ask-flight]"))
                .map((child) => Number(getComputedStyle(child).opacity)),
            ),
            bubbleOpacity: bubble ? Number(getComputedStyle(bubble).opacity) : 0,
          };
          frames.push(frame);
          if (frame.busy && heldAt === null) heldAt = frame.t;
          if (heldAt !== null && frame.t - heldAt > window_) resolve({ frames, flights });
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },
    [ms, started] as const,
  );
  const clicked = await page.evaluate(() => performance.now());
  await tile.click();
  const { frames, flights } = await page.evaluate(
    () => (window as unknown as { commit: Promise<{ frames: Frame[]; flights: number[] }> }).commit,
  );
  return { frames, flights, clicked };
}

/** How far each frame has gone from `from` to `to`, as a fraction of the way. */
const progress = (values: number[], from: number, to: number) =>
  values.map((value) => (value - from) / (to - from));

/** The largest step back against the direction of travel, and the largest overshoot past `to`. */
function wobble(values: number[], from: number, to: number) {
  const sign = Math.sign(to - from);
  let best = from;
  let back = 0;
  let over = 0;
  for (const value of values) {
    if ((value - best) * sign > 0) best = value;
    back = Math.max(back, (best - value) * sign);
    over = Math.max(over, (value - to) * sign);
  }
  return { back, over };
}

/**
 * Holds the answer back from the server for `ms`, so the run resumes (and its working line lands
 * under the card) only once the movement has rested; ask-card-follow covers it landing mid-flight.
 */
const holdAnswer = (page: Page, ms: number) =>
  page.route("**/rpc/threads/answer", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue();
  });

/** The spring's steepest stretch moves 0.78% of the way per ms; no frame may outrun it. */
const STEEPEST_PER_MS = 0.0078;

for (const { viewport, history, band } of [
  { viewport: { width: 1440, height: 640 }, history: 2, band: "long thread" },
  { viewport: { width: 390, height: 700 }, history: 0, band: "short thread" },
]) {
  test(`the answer flies to its bubble while the card folds, in one movement (CA5, ${viewport.width}, ${band})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const seoul = await openCard(page, `ask-motion-${viewport.width}`, history);
    await holdAnswer(page, 1500);
    await expect(seoul).toBeInViewport();
    const { frames, flights } = await sampleCommit(page, seoul, 1000);

    const held = frames.findIndex((frame) => frame.busy);
    const first = frames.findIndex((frame) => frame.clone);
    const last = frames.findLastIndex((frame) => frame.clone);
    const before = frames[first - 1]!;
    const final = frames.at(-1)!;
    const flying = frames.slice(first, last + 1);
    const after = frames.slice(last + 1);
    const bubble = final.bubble!;
    const track = (pick: (frame: Frame) => number, from: number, to: number) => ({
      values: flying.map(pick),
      from,
      to,
    });
    const series = {
      cloneX: track((f) => f.clone!.x, flying[0]!.clone!.x, bubble.x),
      cloneY: track((f) => f.clone!.y, flying[0]!.clone!.y, bubble.y),
      cloneWidth: track((f) => f.clone!.width, flying[0]!.clone!.width, bubble.width),
      cardTop: track((f) => f.card.y, before.card.y, final.card.y),
      cardHeight: track((f) => f.fold, before.card.height, final.card.height),
      rowAbove: track((f) => f.above.y, before.above.y, final.above.y),
    };
    const moving = Object.entries(series).filter(([, s]) => Math.abs(s.to - s.from) >= 8);
    const curves = moving.map(([name, s]) => [name, progress(s.values, s.from, s.to)] as const);
    const spread = flying.map(
      (_, index) =>
        Math.max(...curves.map(([, p]) => p[index]!)) -
        Math.min(...curves.map(([, p]) => p[index]!)),
    );
    const ends = curves.map(([name, p]) => [name, p.findIndex((value) => value >= 0.995)] as const);
    const outrun = moving.map(([name, s]) => {
      const steps = s.values.map((value, index) => {
        const previous = index ? s.values[index - 1]! : s.from;
        const ms = flying[index]!.t - frames[first + index - 1]!.t;
        return Math.abs(value - previous) - Math.abs(s.to - s.from) * STEEPEST_PER_MS * ms;
      });
      return [name, Math.max(...steps)] as const;
    });
    const scrolled = before.scrollTop - final.scrollTop;
    const report = {
      viewport,
      band,
      frames: frames.length,
      longestFrameMs: Math.max(...frames.slice(1).map((f, i) => f.t - frames[i]!.t)),
      fillMs: Math.round(frames[first]!.t - frames[held]!.t),
      flightMs: Math.round(frames[last + 1]!.t - frames[first]!.t),
      fold: before.card.height - final.card.height,
      scrollRoom: before.scrollTop,
      scrolled,
      wobble: Object.fromEntries(
        Object.entries(series).map(([name, s]) => [name, wobble(s.values, s.from, s.to)]),
      ),
      maxCurveSpread: Math.max(...spread),
      endFrames: Object.fromEntries(ends),
      outrunPx: Object.fromEntries(outrun),
      finalDelta: {
        x: Math.abs(flying.at(-1)!.clone!.x - bubble.x),
        y: Math.abs(flying.at(-1)!.clone!.y - bubble.y),
        width: Math.abs(flying.at(-1)!.clone!.width - bubble.width),
        height: Math.abs(flying.at(-1)!.clone!.height - bubble.height),
      },
      rowAboveMoved: final.above.y - before.above.y,
    };
    writeFileSync(testInfo.outputPath("ca5-frames.json"), JSON.stringify(frames));
    writeFileSync(testInfo.outputPath("ca5-report.json"), JSON.stringify(report, null, 2));
    await testInfo.attach("ca5-report", { path: testInfo.outputPath("ca5-report.json") });

    expect(report.fold).toBeGreaterThan(200);
    // The long thread can give up the whole fold in scroll; the short one only part of it.
    if (history) expect(report.scrollRoom).toBeGreaterThanOrEqual(report.fold);
    else expect(report.scrollRoom).toBeLessThan(report.fold);
    expect(flights).toHaveLength(1);
    expect(report.fillMs).toBeGreaterThanOrEqual(64);
    expect(report.fillMs).toBeLessThanOrEqual(130);
    for (const { back, over } of Object.values(report.wobble)) {
      expect(back).toBeLessThanOrEqual(3);
      expect(over).toBeLessThanOrEqual(3);
    }
    for (const delta of Object.values(report.finalDelta)) expect(delta).toBeLessThanOrEqual(1);
    expect(report.maxCurveSpread).toBeLessThanOrEqual(0.05);
    const endFrames = ends.map(([, index]) => index);
    expect(Math.max(...endFrames) - Math.min(...endFrames)).toBeLessThanOrEqual(1);
    for (const [, px] of outrun) expect(px).toBeLessThanOrEqual(1);
    // The rows above come down by what the scroll gave up, then stay.
    expect(Math.abs(report.rowAboveMoved - scrolled)).toBeLessThanOrEqual(1);
    expect(new Set(after.map((f) => Math.round(f.above.y)))).toEqual(
      new Set([Math.round(final.above.y)]),
    );
    // Never the clone and the bubble at once, never neither.
    expect(flying.every((f) => !f.bubbleVisible)).toBe(true);
    expect(after.every((f) => f.bubbleVisible)).toBe(true);
    // The bot's reply lands after the window, so nothing else moved the thread.
    expect(new Set(frames.map((f) => f.rows)).size).toBe(1);
  });
}

test("with reduced motion the answer fades in after the same hold, with no flight (CA13)", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const seoul = await openCard(page, "ask-motion-reduced");
  const answered = page.waitForRequest((request) => request.url().includes("/rpc/threads/answer"));
  const { frames, flights, clicked } = await sampleCommit(page, seoul, 700);
  await answered;
  const held = frames.find((frame) => frame.busy)!;

  expect(flights).toEqual([]);
  expect(held.t - clicked).toBeGreaterThanOrEqual(640);
  // The card goes from its open height to its settled height in one step.
  expect(new Set(frames.map((frame) => Math.round(frame.card.height))).size).toBe(2);
  await expect(page.getByRole("group", { name: "Your answer: Seoul" })).toBeVisible();
});

test("an answer that fails mid-flight reopens the card on the choice, with no bubble left (CA4)", async ({
  page,
}) => {
  const seoul = await openCard(page, "ask-motion-failed");
  await page.route("**/rpc/threads/answer", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.abort();
  });
  const { frames } = await sampleCommit(page, seoul, 900);

  expect(frames.some((frame) => frame.clone)).toBe(true);
  expect(frames.at(-1)!.clone).toBeNull();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(seoul).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-slot="question-card"] [data-slot="user-bubble"]')).toHaveCount(
    0,
  );
  expect(
    await page.getByTestId("transcript").evaluate((element) => element.style.overflowAnchor),
  ).toBe("");
});

test("a stack's Send folds the card while the answers rise into their bubble, in one movement (CA5, stack)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  const builtIn = await openCard(page, "ask-motion-stack", 2, fridge);
  await holdAnswer(page, 1500);
  const card = page.locator('[data-slot="question-card"]');
  await builtIn.click();
  await expect(card.locator('[data-slot="stack-head"]')).toHaveText("Extras·1 more");
  await card.getByRole("button", { name: "Ice maker", exact: true }).click();
  await card.getByRole("button", { name: "Next", exact: true }).click();
  await card.getByRole("button", { name: "Skip", exact: true }).click();
  const send = card.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeInViewport();
  const { frames, flights } = await sampleCommit(page, send, 700, '[data-slot="user-bubble"]');

  const first = frames.findIndex((frame) => frame.busy);
  const before = frames[first - 1]!;
  const moving = frames.slice(first);
  const final = frames.at(-1)!;
  // Within the card: at the end of the thread the list's scroll brings the card down instead.
  const rise = (f: Frame) => f.bubble!.y - f.card.y;
  const series = {
    bubbleY: [moving.map(rise), rise(moving[0]!), rise(final)],
    // The clip that folds the old card exists only while it folds; then the card is its own height.
    cardHeight: [
      moving.map((f) => (f.fold > 0 ? f.fold : f.card.height)),
      before.card.height,
      final.card.height,
    ],
    rowAbove: [moving.map((f) => f.above.y), before.above.y, final.above.y],
  } as const;
  const report = {
    fold: before.card.height - final.card.height,
    rise: rise(moving[0]!) - rise(final),
    wobble: Object.fromEntries(
      Object.entries(series).map(([name, [values, from, to]]) => [name, wobble(values, from, to)]),
    ),
    endFrames: Object.fromEntries(
      Object.entries(series).map(([name, [values, from, to]]) => [
        name,
        progress(values, from, to).findIndex((value) => value >= 0.995),
      ]),
    ),
  };
  writeFileSync(testInfo.outputPath("ca5-stack-frames.json"), JSON.stringify(frames));
  writeFileSync(testInfo.outputPath("ca5-stack-report.json"), JSON.stringify(report, null, 2));
  await testInfo.attach("ca5-stack-report", { path: testInfo.outputPath("ca5-stack-report.json") });

  expect(flights).toEqual([]);
  // The bubble shows only once the old card has faded: never both at once.
  expect(frames.filter((f) => f.ghost > 0.01 && f.bubbleOpacity > 0.01)).toEqual([]);
  expect(report.fold).toBeGreaterThan(100);
  expect(report.rise).toBeGreaterThan(20);
  for (const { back, over } of Object.values(report.wobble)) {
    expect(back).toBeLessThanOrEqual(3);
    expect(over).toBeLessThanOrEqual(3);
  }
  const ends = Object.values(report.endFrames);
  expect(Math.max(...ends) - Math.min(...ends)).toBeLessThanOrEqual(1);
  expect(new Set(frames.map((f) => f.rows)).size).toBe(1);
});

test("a resize mid-flight lands the answer where its bubble now stands, without a jump (CA5)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  const seoul = await openCard(page, "ask-motion-resize");
  await page.evaluate(() => {
    const probe = window as unknown as { resizedAt: number };
    window.addEventListener("resize", () => {
      probe.resizedAt = performance.now();
    });
  });
  const flying = page.locator("[data-ask-flight]");
  const sampled = sampleCommit(page, seoul, 900);
  await expect(flying).toHaveCount(1);
  await page.setViewportSize({ width: 1100, height: 640 });
  const { frames } = await sampled;
  const resizedAt = await page.evaluate(
    () => (window as unknown as { resizedAt: number }).resizedAt,
  );
  const after = frames.filter((frame) => frame.t > resizedAt + 34);

  expect(after.length).toBeGreaterThan(10);
  expect(after.filter((frame) => frame.clone)).toEqual([]);
  expect(after.every((frame) => frame.bubbleVisible)).toBe(true);
});

type Move = {
  t: number;
  /** How much of each folded line shows, by its label: its opacity times the share the card does not clip. */
  lines: Record<string, number>;
  /** Where the row above the card stands. */
  above: number;
  /** The old question fading out over the card. */
  ghost: number;
  /** The question (or the recap's actions) fading in. */
  incoming: number;
};

/** Records every frame while `act` moves the stack on, for `ms`. */
async function sampleMove(page: Page, act: () => Promise<void>, ms: number) {
  await page.evaluate((window_) => {
    const card = document.querySelector('[data-slot="question-card"]') as HTMLElement;
    const seen = (element: Element | null | undefined) => {
      let opacity = 1;
      for (let node = element ?? null; node && node !== card; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      return element ? opacity : 0;
    };
    const live = (selector: string) =>
      [...card.querySelectorAll(selector)].filter(
        (element) => !element.closest("[data-ask-ghost]"),
      );
    const frames: Move[] = [];
    const start = performance.now();
    (window as unknown as { move: Promise<Move[]> }).move = new Promise((resolve) => {
      const step = (now: number) => {
        const incoming = live('[data-slot="stack-step"], [data-slot="framed-block-actions"]');
        const block = card.querySelector('[data-slot="framed-block"]') as Element;
        const shown = (line: Element) => {
          const box = block.getBoundingClientRect();
          const rect = line.getBoundingClientRect();
          const inside = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
          return seen(line) * Math.max(0, Math.min(1, inside / rect.height));
        };
        const row = card.closest("[data-message-id]") as Element;
        const rows = [...document.querySelectorAll("[data-message-id]")];
        frames.push({
          t: now - start,
          lines: Object.fromEntries(
            live('[data-slot="stack-line"]').map((line) => [
              line.firstElementChild?.textContent ?? "",
              Math.round(shown(line) * 1000) / 1000,
            ]),
          ),
          ghost: seen(card.querySelector("[data-ask-ghost]")),
          incoming: Math.max(0, ...incoming.map(seen)),
          above: (rows[rows.indexOf(row) - 1] as Element).getBoundingClientRect().top,
        });
        if (now - start > window_) resolve(frames);
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, ms);
  await act();
  return page.evaluate(() => (window as unknown as { move: Promise<Move[]> }).move);
}

/** Where the card's foot stands against the bottom of the thread, in px; positive is hidden. */
const footBelow = (page: Page) =>
  page.evaluate(() => {
    const transcript = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    const block = document.querySelector('[data-slot="question-card"] [data-slot="framed-block"]');
    return (
      (block as Element).getBoundingClientRect().bottom - transcript.getBoundingClientRect().bottom
    );
  });

/** The frames of a move from the first one where anything fades, after a tap's hold. */
const moving = (frames: Move[]) => {
  const fading = (f: Move) =>
    f.ghost > 0 || f.incoming < 0.999 || Object.values(f.lines).some((line) => line < 0.999);
  const first = frames.findIndex(fading);
  return first < 0 ? [] : frames.slice(first);
};

test("a stack moves on in place: kept lines stay, the card is never blank, its foot stays in view (CA5, stack)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 640 });
  const builtIn = await openCard(page, "ask-motion-advance", 2, fridge);
  const card = page.locator('[data-slot="question-card"]');
  const button = (name: string) => card.getByRole("button", { name, exact: true });
  await expect(builtIn).toBeInViewport();

  const first = moving(await sampleMove(page, () => builtIn.click(), 1300));
  await expect(card.locator('[data-slot="stack-head"]')).toHaveText("Extras·1 more");
  const afterFirst = await footBelow(page);
  await button("Ice maker").click();
  await expect(button("Next")).toBeVisible();
  await page.waitForTimeout(700);
  const afterTick = await footBelow(page);
  const second = moving(await sampleMove(page, () => button("Next").click(), 700));
  const third = moving(await sampleMove(page, () => button("Skip").click(), 700));
  await expect(button("Send")).toBeVisible();
  await page.waitForTimeout(100);
  const afterRecap = await footBelow(page);
  const report = { first, second, third, afterFirst, afterTick, afterRecap };
  writeFileSync(testInfo.outputPath("stack-moves.json"), JSON.stringify(report));

  for (const frames of [first, second, third]) {
    expect(frames.length).toBeGreaterThan(10);
    // The thread above moves on the spring or not at all: no frame jumps. A step is measured
    // per 60 Hz frame elapsed, so a frame the browser drops does not count as a jump.
    const travel = Math.abs(frames.at(-1)!.above - frames[0]!.above);
    const steps = frames
      .slice(1)
      .map(
        (f, i) =>
          Math.abs(f.above - frames[i]!.above) /
          Math.max(1, Math.round((f.t - frames[i]!.t) / (1000 / 60))),
      );
    expect(Math.max(...steps)).toBeLessThanOrEqual(travel * 0.2 + 1);
    // Never a blank card: what leaves and what arrives overlap.
    expect(Math.min(...frames.map((f) => Math.max(f.ghost, f.incoming)))).toBeGreaterThan(0.4);
  }
  // The lines already folded never fade, into the recap included.
  for (const frame of second) expect(frame.lines.Format).toBe(1);
  for (const frame of third) expect([frame.lines.Format, frame.lines.Extras]).toEqual([1, 1]);
  // A newly folded line shows once the old question is gone, so its answer never shows twice.
  const twice = (frames: Move[], label: string) =>
    frames.filter((f) => f.ghost > 0.01 && (f.lines[label] ?? 0) > 0.01);
  expect([twice(first, "Format"), twice(second, "Extras")]).toEqual([[], []]);
  for (const below of [afterFirst, afterTick, afterRecap]) expect(below).toBeLessThanOrEqual(0);
});
