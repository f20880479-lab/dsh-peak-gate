/**
 * dsh-peak-gate — real-DOM smoke test (jsdom + real React 18 render).
 *
 * Verifies what the pure-Node integration tests cannot: the bundle's apply()
 * runs against a real DOM, injects its styles and portal container, the
 * capture listeners intercept a real Enter dispatch, and — crucially — the
 * confirmation card is actually RENDERED by React, then the "send now" button
 * performs the real submit and closes the card.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(__dirname, "..", "lib", "client.js");

// --- real DOM --------------------------------------------------------------

const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
  url: "http://127.0.0.1:43120/",
  pretendToBeVisual: true
});
const { window } = dom;
// Spread jsdom's window onto globalThis (data properties only — accessors like
// jsdom's own `window.window` would shadow Node globals with read-only getters).
for (const key of Object.getOwnPropertyNames(window)) {
  const desc = Object.getOwnPropertyDescriptor(window, key);
  if (desc === undefined || !("value" in desc)) continue;
  if (key in globalThis) continue;
  try {
    Object.defineProperty(globalThis, key, { ...desc, configurable: true });
  } catch {}
}
for (const key of ["window", "document", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { value: window[key] ?? window, writable: true, configurable: true });
}

// --- module loading (react from the DSH checkout, served like the browser) --

let bundleDef = null;
window.__ModuleLoader__ = { load: (def) => { bundleDef = def; } };

const checkoutRequire = createRequire("D:/download/dsh/DSH Desktop/resources/app.asar.unpacked/node_modules/react/package.json");
const requireShim = (spec) => {
  if (spec === "react") return checkoutRequire("react");
  if (spec === "react-dom/client") return checkoutRequire("react-dom/client");
  throw new Error("unexpected require: " + spec);
};

const code = readFileSync(CLIENT_PATH, "utf8");
const sandbox = { window, document: window.document, require: requireShim, Element: window.Element };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
assert.ok(bundleDef !== null, "bundle must register via __ModuleLoader__.load");
const plugin = bundleDef.factory(requireShim);
const I = plugin._internals;

// --- ctx stub (DOM-independent) --------------------------------------------

const TUE_PEAK = new Date("2026-08-25T02:00:00Z"); // Beijing 10:00 Tuesday
const dict = {
  "card.title": "现在处于高峰计费时段",
  "card.body": "当前北京时间 {time}。工作日高峰时段为 {windows}",
  "card.note": "本次高峰段持续至 {end}。",
  "card.mute": "本次高峰段内不再提示（至 {end}）",
  "card.countdown": "距空闲时段还有 {countdown}",
  "card.sendNow": "立即发送（高峰价）",
  "card.waitOffPeak": "等到空闲时段（自动发送）",
  "card.closeAria": "关闭",
  "card.eyebrow": "峰谷计费 · dsh-peak-gate",
  "queue.title": "待发送队列（空闲时段自动发送）",
  "queue.empty": "队列为空。",
  "queue.removeAria": "从队列删除",
  "queue.clear": "清空队列",
  "queue.done": "完成",
  "queue.closeAria": "关闭",
  "cmd.help": "/peakgate hold 消息 — 排队\n/peakgate list — 查看队列"
};
const t = (key, params) => {
  let text = dict[key] ?? key;
  if (params) text = text.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
  return text;
};

let submitCalls = 0;
let inputState = { draft: "hello world", phase: "plain", imageIds: [] };
const cleanups = [];
const slotRegistrations = [];
const ctx = {
  sessions: {
    list: { getSnapshot: () => ({ current: "s1" }), subscribe: () => () => {} },
    provideInfo: (id) =>
      id === "s1"
        ? {
            sessionId: id,
            hooks: { input: { getSnapshot: () => inputState } },
            props: {
              inputActions: {
                submit: () => { submitCalls += 1; },
                setDraft: (text) => { inputState = { ...inputState, draft: text }; }
              }
            }
          }
        : undefined
  },
  slots: {
    inject: (key, factory) => {
      slotRegistrations.push({ key, factory });
      return () => {};
    }
  },
  locale: { register: () => {}, bind: () => t },
  effect: (fn) => {
    const result = fn();
    cleanups.push(result);
    return result;
  }
};

let testCount = 0;
async function test(name, fn) {
  testCount += 1;
  try {
    await fn();
    console.log(`  ok ${testCount}: ${name}`);
  } catch (error) {
    console.error(`  FAIL ${testCount}: ${name}`);
    throw error;
  }
}
/** Let React's scheduler flush its pending work (MessageChannel-based). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// --- the smoke test ---------------------------------------------------------

I.setNow(TUE_PEAK);

await test("apply() injects styles and the portal container into the real DOM", () => {
  plugin.apply(ctx);
  const styles = document.querySelectorAll("style[data-plugin-css]");
  assert.ok(styles.length >= 2, `expected >=2 injected styles, got ${styles.length}`);
  assert.ok(document.body.querySelector("[data-dsh-peak-gate-root]") !== null, "portal container must be in body");
  assert.equal(slotRegistrations.length, 1);
  assert.equal(slotRegistrations[0].key, "settings.general.item");
});

await test("a real Enter dispatch on the composer textarea renders the confirmation card", async () => {
  // Build the composer structure with real DOM.
  const seat = document.createElement("div");
  seat.setAttribute("data-composer-seat", "");
  const textarea = document.createElement("textarea");
  textarea.value = "hello world";
  seat.appendChild(textarea);
  document.body.appendChild(seat);

  const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  const dispatched = textarea.dispatchEvent(event);
  assert.equal(dispatched, false, "the interception must preventDefault (dispatchEvent returns false)");
  await tick();

  const backdrop = document.querySelector(".dsh-pg-backdrop");
  assert.ok(backdrop !== null, "the gate card must be rendered by React");
  const title = backdrop.querySelector(".dsh-pg-title");
  assert.ok(title !== null && title.textContent.includes("高峰计费"), `unexpected title: ${title?.textContent}`);
  const buttons = backdrop.querySelectorAll(".dsh-pg-footer button");
  assert.equal(buttons.length, 2, "card must offer send-now and wait-off-peak");
});

await test("clicking 'send now' performs the real submit and closes the card", async () => {
  submitCalls = 0;
  const backdrop = document.querySelector(".dsh-pg-backdrop");
  assert.ok(backdrop !== null, "card should still be open");
  const sendNow = backdrop.querySelector(".dsh-pg-btn-primary");
  assert.ok(sendNow !== null, "send-now button must exist");
  sendNow.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(submitCalls, 1, "the real inputActions.submit must run");
  assert.ok(document.querySelector(".dsh-pg-backdrop") === null, "card must close after sending");
  assert.equal(I.isSegmentMuted("2026-08-25|09:00-12:00"), false, "unchecked mute must not silence the segment");
});

await test("checking the mute box silences the segment when sending", async () => {
  // Open the gate again, tick the "don't ask again for this peak segment" box, send now.
  submitCalls = 0;
  const textarea = document.body.querySelector("[data-composer-seat] textarea");
  const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  textarea.dispatchEvent(event);
  await tick();
  const backdrop = document.querySelector(".dsh-pg-backdrop");
  assert.ok(backdrop !== null, "card must open again (segment not muted)");
  const checkbox = backdrop.querySelector(".dsh-pg-mute input");
  assert.ok(checkbox !== null, "mute checkbox must exist");
  checkbox.click();
  const sendNow = backdrop.querySelector(".dsh-pg-btn-primary");
  sendNow.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(submitCalls, 1);
  assert.equal(I.isSegmentMuted("2026-08-25|09:00-12:00"), true, "muted segment must be recorded");
  assert.ok(document.querySelector(".dsh-pg-backdrop") === null);
});

await test("the queue card renders with real React and lists held messages", async () => {
  I.writeHolds([{ id: "q1", sessionId: "s1", text: "明天发布公告", at: Date.now(), explicit: true }]);
  I.openQueue();
  await tick();
  const card = document.querySelector(".dsh-pg-qcard");
  assert.ok(card !== null, "queue card must be rendered");
  const rows = card.querySelectorAll(".dsh-pg-qrow");
  assert.equal(rows.length, 1, "one held message must be listed");
  assert.ok(rows[0].textContent.includes("明天发布公告"), "held text must be visible");
  I.closeQueue();
  await tick();
  assert.ok(document.querySelector(".dsh-pg-qcard") === null, "queue card must close");
  I.writeHolds([]);
});

await test("lifecycle disposer removes listeners and unmounts the portal", () => {
  const disposer = cleanups.at(-1);
  assert.equal(typeof disposer, "function");
  disposer();
  assert.ok(document.body.querySelector("[data-dsh-peak-gate-root]") === null, "portal container must be removed");
});

dom.window.close();
console.log(`\nAll ${testCount} smoke tests passed (jsdom + real React 18 render).`);
