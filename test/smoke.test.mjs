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

// Resolve react from the local devDependencies (npm install) — no machine paths.
const localRequire = createRequire(import.meta.url);
const checkoutRequire = createRequire(localRequire.resolve("react/package.json"));
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
  "cmd.help": "/peakgate hold 消息 — 排队\n/peakgate list — 查看队列",
  "dock.title": "待发送队列 ({n})",
  "dock.empty": "队列为空。",
  "dock.up": "上移（提前发送）",
  "dock.down": "下移（延后发送）",
  "dock.edit": "修改文本",
  "dock.save": "保存",
  "dock.cancelEdit": "取消",
  "dock.removeAria": "删除",
  "dock.clear": "清空队列",
  "dock.sendNow": "立即发送（不等待，高峰价也发）",
  "dock.dragHint": "拖动标题栏可移动窗口",
  "dock.open": "打开待发送队列",
  "dock.collapse": "收起",
  "dock.scopeAll": "全部会话",
  "dock.scopeCurrent": "仅当前会话",
  "sug.title": "待发送队列指令（空闲时段半价发送）：",
  "sug.hold": "排队发送",
  "sug.holdDesc": "把消息存到队列，空闲时段自动发出"
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
  assert.equal(slotRegistrations.length, 2, "settings row + queue dock must be registered");
  assert.deepEqual(slotRegistrations.map((r) => r.key), ["settings.general.item", "conversation.input.dock"]);
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

await test("Enter while the card is open force-sends via the card's primary action", async () => {
  // The card from the previous test is still open; press Enter again on the textarea.
  submitCalls = 0;
  const textarea = document.body.querySelector("[data-composer-seat] textarea");
  const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  const dispatched = textarea.dispatchEvent(event);
  assert.equal(dispatched, false, "second Enter must be consumed by the card (preventDefault)");
  await tick();
  assert.equal(submitCalls, 1, "Enter confirms and sends immediately");
  assert.ok(document.querySelector(".dsh-pg-backdrop") === null, "card closes after sending");
});

await test("clicking 'send now' performs the real submit and closes the card", async () => {
  // Reopen the card first (the previous test sent and closed it).
  I.openGate("s1");
  await tick();
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

await test("the session dock window renders the queue with reorder / edit / delete / send-now", async () => {
  const React = checkoutRequire("react");
  const { createRoot } = checkoutRequire("react-dom/client");
  // q2 belongs to another session — must be hidden in the default "current session" view.
  I.writeHolds([
    { id: "q1", sessionId: "s1", text: "第一条消息", at: Date.now(), explicit: true },
    { id: "q2", sessionId: "s2", text: "另一会话消息", at: Date.now(), explicit: true },
    { id: "q3", sessionId: "s1", text: "第二条消息", at: Date.now(), explicit: true }
  ]);
  const holder = document.createElement("div");
  document.body.appendChild(holder);
  const dockRoot = createRoot(holder);
  dockRoot.render(
    React.createElement(I.HoldQueueDock, {
      t,
      gateStore: I.gateStore,
      ctx,
      sessionId: "s1",
      useSessions: (sel) => sel({ byId: { s1: { displayTitle: "会话A" }, s2: { displayTitle: "会话B" } } })
    })
  );
  await tick();

  // Collapsed: a tiny floating button with the CURRENT session's queue count badge.
  const fab = document.querySelector(".dsh-pg-fab");
  assert.ok(fab !== null, "collapsed floating button must render");
  assert.ok(fab.textContent.includes("2"), "badge shows the current session's queue count");
  assert.ok(!fab.textContent.includes("3"), "other sessions are not counted in the default view");
  assert.equal(document.querySelector(".dsh-pg-window"), null, "panel hidden while collapsed");

  // Drag the floating button → position updates and persists.
  assert.equal(fab.style.left, "", "no left before dragging (CSS default position)");
  fab.dispatchEvent(new window.PointerEvent("pointerdown", { button: 0, pointerId: 7, clientX: 100, clientY: 100, bubbles: true }));
  fab.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 7, clientX: 150, clientY: 130, bubbles: true }));
  fab.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 7, clientX: 150, clientY: 130, bubbles: true }));
  await tick();
  assert.equal(fab.style.left, "50px", "button moved by dx=50");
  assert.equal(fab.style.top, "30px", "button moved by dy=30");
  const saved = JSON.parse(window.localStorage.getItem("dsh.peakGate.dockPos.v1"));
  assert.equal(saved.x, 50, "dragged position persisted");
  assert.equal(saved.y, 30);

  // A drag ends with a trailing click that must be swallowed (never a toggle).
  fab.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(document.querySelector(".dsh-pg-window"), null, "trailing click after drag must not expand");

  // Click the floating button → panel expands with rows in send order.
  fab.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  const win = document.querySelector(".dsh-pg-wrap");
  assert.ok(win !== null, "panel wrap must expand on fab click");
  assert.equal(document.querySelector(".dsh-pg-fab"), null, "fab hidden while expanded");
  let rows = document.querySelectorAll(".dsh-pg-hrow");
  assert.equal(rows.length, 2, "current-session view shows only s1 entries");
  assert.ok(rows[0].textContent.includes("第一条消息"));
  assert.ok(rows[1].textContent.includes("第二条消息"));
  assert.ok(![...rows].some((r) => r.textContent.includes("另一会话消息")), "other session's entry is hidden by default");

  // Toggle to "all sessions" → the other session's entry appears.
  const scopeBtn = document.querySelector('button[aria-label="全部会话"]');
  assert.ok(scopeBtn !== null, "scope toggle must exist");
  scopeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  rows = document.querySelectorAll(".dsh-pg-hrow");
  assert.equal(rows.length, 3, "all-sessions view shows every entry");
  assert.ok([...rows].some((r) => r.textContent.includes("另一会话消息")), "other session's entry visible in all view");
  // Back to current-session only.
  const backBtn = document.querySelector('button[aria-label="仅当前会话"]');
  backBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  rows = document.querySelectorAll(".dsh-pg-hrow");
  assert.equal(rows.length, 2, "back to current-session view");

  // Default panel size is compact.
  assert.equal(win.style.width, "300px", "default width is compact");
  assert.equal(win.style.height, "260px", "default height is compact");

  // Resize from the bottom-right corner (se) → size grows, top-left corner anchored.
  const panel = document.querySelector(".dsh-pg-window");
  panel.getBoundingClientRect = () => ({ x: 100, y: 80, width: 300, height: 260, top: 80, left: 100, right: 400, bottom: 340 });
  const se = document.querySelector(".dsh-pg-rz-se");
  assert.ok(se !== null, "se resize handle must exist");
  assert.equal(document.querySelectorAll(".dsh-pg-rz").length, 8, "all 8 edges/corners have resize handles");
  se.dispatchEvent(new window.PointerEvent("pointerdown", { button: 0, pointerId: 9, clientX: 300, clientY: 260, bubbles: true }));
  se.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 9, clientX: 400, clientY: 330, bubbles: true }));
  se.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 9, clientX: 400, clientY: 330, bubbles: true }));
  await tick();
  assert.equal(win.style.width, "400px", "resized width persisted");
  assert.equal(win.style.height, "330px", "resized height persisted");
  assert.equal(win.style.left, "100px", "top-left corner stays anchored when resizing from se");
  const savedSize = JSON.parse(window.localStorage.getItem("dsh.peakGate.dockSize.v1"));
  assert.equal(savedSize.width, 400);
  assert.equal(savedSize.height, 330);

  // Resize from the west edge → left edge moves, width shrinks (right edge anchored).
  panel.getBoundingClientRect = () => ({ x: 100, y: 80, width: 400, height: 330, top: 80, left: 100, right: 500, bottom: 410 });
  const w = document.querySelector(".dsh-pg-rz-w");
  w.dispatchEvent(new window.PointerEvent("pointerdown", { button: 0, pointerId: 10, clientX: 100, clientY: 200, bubbles: true }));
  w.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 10, clientX: 150, clientY: 200, bubbles: true }));
  w.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 10, clientX: 150, clientY: 200, bubbles: true }));
  await tick();
  assert.equal(win.style.width, "350px", "west resize shrinks width by dx");
  assert.equal(win.style.left, "150px", "west resize moves the left edge");
  assert.equal(JSON.parse(window.localStorage.getItem("dsh.peakGate.dockSize.v1")).width, 350);

  // West-edge resize is persisted.
  assert.equal(JSON.parse(window.localStorage.getItem("dsh.peakGate.dockSize.v1")).width, 350);

  // The explicit collapse button still works.
  const collapseBtn = document.querySelector('button[aria-label="收起"]');
  assert.ok(collapseBtn !== null, "collapse button must exist");
  collapseBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.ok(document.querySelector(".dsh-pg-fab") !== null, "collapsed again after collapse button");
  document.querySelector(".dsh-pg-fab").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.ok(document.querySelector(".dsh-pg-window") !== null, "panel reopened");

  // Clicking inside the panel must NOT collapse it.
  win.dispatchEvent(new window.PointerEvent("pointerdown", { button: 0, bubbles: true }));
  await tick();
  assert.ok(document.querySelector(".dsh-pg-window") !== null, "clicking inside the panel keeps it open");

  // Clicking outside the panel collapses it back to the floating button.
  document.body.dispatchEvent(new window.PointerEvent("pointerdown", { button: 0, bubbles: true }));
  await tick();
  assert.ok(document.querySelector(".dsh-pg-fab") !== null, "clicking outside collapses to the floating button");
  assert.ok(document.querySelector(".dsh-pg-window") === null, "panel hidden after outside click");

  // Re-open for the remaining row interactions.
  document.querySelector(".dsh-pg-fab").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  rows = document.querySelectorAll(".dsh-pg-hrow");
  assert.equal(rows.length, 2, "panel reopened");

  // Reorder: move the first item down → second item becomes first.
  const firstDown = rows[0].querySelector('button[aria-label="下移（延后发送）"]');
  firstDown.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.deepEqual([...I.readHolds().map((h) => h.id)], ["q3", "q2", "q1"], "q1 swapped with its same-session peer q3 (skipping q2)");
  rows = document.querySelectorAll(".dsh-pg-hrow");
  assert.ok(rows[0].textContent.includes("第二条消息"), "UI reflects the new order");

  // Edit: open the editor, change the text, save.
  const editBtn = rows[0].querySelector('button[aria-label="修改文本"]');
  editBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  const editor = document.querySelector(".dsh-pg-hedit");
  assert.ok(editor !== null, "editor input must appear");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(editor, "改后的第二条消息");
  editor.dispatchEvent(new window.Event("input", { bubbles: true }));
  const saveBtn = document.querySelector('button[aria-label="保存"]');
  saveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(I.readHolds()[0].text, "改后的第二条消息", "edited text persisted");

  // Delete the second row (q1 — the reordered last item).
  rows = document.querySelectorAll(".dsh-pg-hrow");
  const delBtn = rows[1].querySelector('button[aria-label="删除"]');
  delBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.deepEqual([...I.readHolds().map((h) => h.id)], ["q3", "q2"], "deleted item removed (other session's q2 stays)");
  assert.equal(document.querySelectorAll(".dsh-pg-hrow").length, 1);

  // Send-now: click the green send button → submitted immediately even in peak, hold consumed.
  rows = document.querySelectorAll(".dsh-pg-hrow");
  inputState = { ...inputState, draft: "" }; // target session draft must be empty for send-now
  const sendBtn = rows[0].querySelector('button[aria-label="立即发送（不等待，高峰价也发）"]');
  assert.ok(sendBtn !== null, "send-now button must exist on each row");
  submitCalls = 0;
  sendBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(submitCalls, 1, "send-now must submit immediately");
  assert.deepEqual([...I.readHolds().map((h) => h.id)], ["q2"], "sent hold leaves the queue (other session's q2 stays)");
  assert.equal(document.querySelectorAll(".dsh-pg-hrow").length, 0, "row removed from the UI");

  dockRoot.unmount();
  holder.remove();
  I.writeHolds([]);
  I.closeQueue();
});

await test("typing /peakgate shows the inline hint; picking an option fills the draft", async () => {
  const textarea = document.body.querySelector("[data-composer-seat] textarea");
  textarea.getBoundingClientRect = () => ({ x: 20, y: 460, top: 460, bottom: 500, left: 20, right: 500, width: 480, height: 40 });
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;

  // Bare prefix → hint bar appears with human-readable options.
  setter.call(textarea, "/peakgate");
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick();
  const sug = document.querySelector(".dsh-pg-sug");
  assert.ok(sug !== null, "hint bar must appear while typing /peakgate");
  assert.ok(sug.textContent.includes("排队发送"), "hint explains the queue command in plain words");
  assert.ok(sug.textContent.includes("把消息存到队列"), "hint carries a description");

  // Picking "排队发送" fills "/peakgate hold " so the user only types the message.
  const holdBtn = sug.querySelector("button");
  holdBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(inputState.draft, "/peakgate hold ", "picking the option fills the command prefix");
  assert.ok(document.querySelector(".dsh-pg-sug") === null, "hint hides after picking");

  // A complete command hides the hint.
  setter.call(textarea, "/peakgate hold 明天发布");
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick();
  assert.ok(document.querySelector(".dsh-pg-sug") === null, "no hint for a complete command");

  // Clearing back to the prefix shows it again.
  setter.call(textarea, "/peakgate");
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick();
  assert.ok(document.querySelector(".dsh-pg-sug") !== null, "hint returns when the command is incomplete again");
  I.gateStore.set({ ...I.gateStore.getSnapshot(), suggestion: null });
});

await test("lifecycle disposer removes listeners and unmounts the portal", () => {
  const disposer = cleanups.at(-1);
  assert.equal(typeof disposer, "function");
  disposer();
  assert.ok(document.body.querySelector("[data-dsh-peak-gate-root]") === null, "portal container must be removed");
});

dom.window.close();
console.log(`\nAll ${testCount} smoke tests passed (jsdom + real React 18 render).`);
