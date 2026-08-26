/**
 * dsh-peak-gate — integration tests (Node, no browser needed).
 *
 * Stubs the browser surface (window / document / localStorage / Element /
 * react-dom/client) and the client root context, then exercises the real
 * lib/client.js bundle: schedule math, submit interception, once-per-day
 * consent, defer-and-hold, and off-peak auto-send.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(__dirname, "..", "lib", "client.js");

// --- browser stubs ---------------------------------------------------------

const localStore = new Map();
const local = {
  getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => localStore.set(k, String(v)),
  removeItem: (k) => localStore.delete(k),
  clear: () => localStore.clear()
};

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.dataset = {};
    this.className = "";
    this._closestMap = {};
    this._query = null;
  }
  closest(sel) {
    if (Object.hasOwn(this._closestMap, sel)) return this._closestMap[sel];
    if (sel === "button" && this.tagName === "BUTTON") return this;
    return null;
  }
  setClosest(sel, el) {
    this._closestMap[sel] = el;
    return this;
  }
  setQuery(fn) {
    this._query = fn;
    return this;
  }
  querySelector() {
    return this._query !== null && this._query !== undefined ? this._query() : null;
  }
  querySelectorAll() {
    return [];
  }
  appendChild() {}
  remove() {}
  setAttribute() {}
  getAttribute() {
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}
globalThis.Element = FakeElement;

const docHandlers = [];
const documentStub = {
  addEventListener: (type, fn, capture) => docHandlers.push({ type, fn, capture: !!capture }),
  removeEventListener: (type, fn, capture) => {
    const i = docHandlers.findIndex((h) => h.type === type && h.fn === fn && h.capture === !!capture);
    if (i >= 0) docHandlers.splice(i, 1);
  },
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  head: { appendChild: () => {} },
  body: { appendChild: () => {} }
};
globalThis.document = documentStub;

let bundleDef = null;
globalThis.window = {
  __ModuleLoader__: { load: (def) => { bundleDef = def; } },
  localStorage: local,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id)
};

const checkoutRequire = createRequire("D:/download/dsh/DSH Desktop/resources/app.asar.unpacked/node_modules/react/package.json");
const requireShim = (spec) => {
  if (spec === "react") return checkoutRequire("react");
  if (spec === "react-dom/client") return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
  throw new Error("unexpected require: " + spec);
};

// Load the bundle exactly like the browser module loader would.
const code = readFileSync(CLIENT_PATH, "utf8");
const sandbox = { window, document: documentStub, require: requireShim, Element: FakeElement };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
assert.ok(bundleDef !== null, "bundle must register via __ModuleLoader__.load");
const plugin = bundleDef.factory(requireShim);
const I = plugin._internals;

// --- helpers ---------------------------------------------------------------

const TUE_PEAK = new Date("2026-08-25T02:00:00Z"); // Beijing 10:00 Tuesday
const TUE_EVENING = new Date("2026-08-25T11:00:00Z"); // Beijing 19:00 Tuesday
const WED_MORNING = new Date("2026-08-26T02:00:00Z"); // Beijing 10:00 Wednesday
const SAT_PEAK = new Date("2026-08-29T02:00:00Z"); // Beijing 10:00 Saturday

function makeCtx(sessionId, draft, phase = "plain", imageIds = []) {
  let input = { draft, phase, imageIds };
  const calls = { submit: 0, setDraft: [] };
  const sessions = {
    list: {
      getSnapshot: () => ({ current: sessionId }),
      subscribe: () => () => {}
    },
    provideInfo: (id) =>
      id === sessionId
        ? {
            sessionId: id,
            hooks: { input: { getSnapshot: () => input } },
            props: {
              inputActions: {
                submit: () => { calls.submit += 1; },
                setDraft: (t) => { input = { ...input, draft: t }; }
              }
            }
          }
        : undefined
  };
  const ctx = {
    sessions,
    slots: { inject: () => () => {} },
    locale: { register: () => {}, bind: () => (key) => key },
    effect: (fn) => fn()
  };
  return { ctx, calls, setInput: (next) => { input = { ...input, ...next }; } };
}

/** Shared live harness: one ctx wired through plugin.apply(), state reconfigurable per test. */
const shared = {
  current: null,
  inputs: new Map(),
  submitCalls: 0,
  cleanups: []
};
const sharedSessions = {
  list: {
    getSnapshot: () => ({ current: shared.current }),
    subscribe: () => () => {}
  },
  provideInfo: (id) => {
    const entry = shared.inputs.get(id);
    if (entry === undefined) return undefined;
    return {
      sessionId: id,
      hooks: { input: { getSnapshot: () => entry.state } },
      props: {
        inputActions: {
          submit: () => { shared.submitCalls += 1; },
          setDraft: (t) => { entry.state = { ...entry.state, draft: t }; }
        }
      }
    };
  }
};
const sharedCtx = {
  sessions: sharedSessions,
  slots: { inject: () => () => {} },
  locale: { register: () => {}, bind: () => (key) => key },
  effect: (fn) => {
    const result = fn();
    shared.cleanups.push(result);
    return result;
  }
};
function setSession(id, draft, phase = "plain", imageIds = []) {
  shared.current = id;
  shared.inputs.set(id, { state: { draft, phase, imageIds } });
}
function setInput(id, next) {
  const entry = shared.inputs.get(id);
  entry.state = { ...entry.state, ...next };
}

function dispatch(type, event) {
  const handler = docHandlers.find((h) => h.type === type && h.capture);
  assert.ok(handler, `capture handler for ${type} must be registered`);
  handler.fn(event);
}

function fakeEvent(target) {
  return {
    target,
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    repeat: false,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  };
}

function textareaIn(seat) {
  return new FakeElement("textarea").setClosest("[data-composer-seat]", seat);
}
function sendButtonIn(seat) {
  const fallback = new FakeElement("div").setClosest("[data-chain-overlay-fallback]", null);
  const button = new FakeElement("button");
  button.className = "XyZz_primary";
  button.setClosest("[data-chain-overlay-fallback]", fallback);
  button.setClosest("[data-composer-seat]", seat);
  return button;
}

let testCount = 0;
function test(name, fn) {
  testCount += 1;
  try {
    fn();
    console.log(`  ok ${testCount}: ${name}`);
  } catch (error) {
    console.error(`  FAIL ${testCount}: ${name}`);
    throw error;
  }
}

// --- schedule math ---------------------------------------------------------

test("weekday morning 10:00 Beijing is peak", () => {
  assert.equal(I.isPeakAt(I.DEFAULT_SETTINGS, TUE_PEAK), true);
});
test("weekday 08:30 / 12:00 / 13:00 / 18:00 Beijing are off-peak", () => {
  const s = I.DEFAULT_SETTINGS;
  assert.equal(I.isPeakAt(s, new Date("2026-08-25T00:30:00Z")), false); // 08:30
  assert.equal(I.isPeakAt(s, new Date("2026-08-25T04:00:00Z")), false); // 12:00 (end exclusive)
  assert.equal(I.isPeakAt(s, new Date("2026-08-25T05:00:00Z")), false); // 13:00
  assert.equal(I.isPeakAt(s, new Date("2026-08-25T10:00:00Z")), false); // 18:00
});
test("weekend is off-peak all day", () => {
  assert.equal(I.isPeakAt(I.DEFAULT_SETTINGS, SAT_PEAK), false);
});
test("wall parts resolve Beijing time and date key", () => {
  const parts = I.wallParts(TUE_PEAK, "Asia/Shanghai");
  assert.equal(parts.timeLabel, "10:00");
  assert.equal(parts.dateKey, "2026-08-25");
  assert.equal(parts.weekday, 2); // Tuesday
});
test("next transition labels", () => {
  const json = (v) => JSON.stringify(v);
  assert.equal(json(I.nextTransition(I.DEFAULT_SETTINGS, TUE_PEAK)), json({ to: "offpeak", label: "12:00", minutes: 720, days: 0 }));
  assert.equal(json(I.nextTransition(I.DEFAULT_SETTINGS, new Date("2026-08-25T05:00:00Z"))), json({ to: "peak", label: "14:00", minutes: 840, days: 0 }));
  assert.equal(I.nextTransition(I.DEFAULT_SETTINGS, TUE_EVENING).label, "tomorrow 09:00");
  assert.equal(I.nextTransition(I.DEFAULT_SETTINGS, SAT_PEAK).label, "+2d 09:00");
});
test("countdown to next transition", () => {
  assert.equal(I.countdownLabel(I.DEFAULT_SETTINGS, TUE_PEAK), "2h 0m");
  assert.equal(I.countdownLabel(I.DEFAULT_SETTINGS, TUE_EVENING), "14h 0m");
});

// --- interception (listeners registered by plugin.apply on the shared ctx) --

test("apply() registers the capture listeners and the lifecycle disposer", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello world");
  shared.submitCalls = 0;
  plugin.apply(sharedCtx);
  const keydown = docHandlers.filter((h) => h.type === "keydown" && h.capture);
  const click = docHandlers.filter((h) => h.type === "click" && h.capture);
  assert.equal(keydown.length, 1);
  assert.equal(click.length, 1);
  assert.ok(shared.cleanups.length >= 2, "apply must run at least the locale + lifecycle effects");
});

test("peak Enter on composer textarea opens the gate", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello world");
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), "s1");
  const seat = new FakeElement("div");
  const event = fakeEvent(textareaIn(seat));
  dispatch("keydown", event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(I.gateStore.getSnapshot().pending.sessionId, "s1");
  I.closeGate("s1");
});

test("a second Enter while the card is open must not send and keeps the card", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello world");
  shared.submitCalls = 0;
  const seat = new FakeElement("div");
  // First Enter opens the card.
  const first = fakeEvent(textareaIn(seat));
  dispatch("keydown", first);
  assert.equal(first.prevented, true);
  assert.ok(I.gateStore.getSnapshot().pending !== null, "card must be open");
  // Second Enter (quick double-press) must be swallowed entirely.
  const second = fakeEvent(textareaIn(seat));
  dispatch("keydown", second);
  assert.equal(second.prevented, true, "second Enter must be swallowed");
  assert.equal(second.stopped, true, "second Enter must not reach the composer");
  assert.equal(shared.submitCalls, 0, "message must not be sent while the card is up");
  assert.ok(I.gateStore.getSnapshot().pending !== null, "card must stay open");
  // A send-button click while the card is open must also be swallowed.
  const click = fakeEvent(sendButtonIn(seat));
  dispatch("click", click);
  assert.equal(click.prevented, true, "send click must be swallowed while the card is up");
  assert.equal(shared.submitCalls, 0, "no send from click either");
  assert.ok(I.gateStore.getSnapshot().pending !== null, "card must stay open after click");
  I.closeGate("s1");
});

test("off-peak Enter never opens the gate", () => {
  local.clear();
  I.setNow(TUE_EVENING);
  setSession("s1", "hello world");
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), undefined);
  const seat = new FakeElement("div");
  const event = fakeEvent(textareaIn(seat));
  dispatch("keydown", event);
  assert.equal(event.prevented, false);
  assert.equal(I.gateStore.getSnapshot().pending, null);
});

test("click on the composer send button opens the gate; other buttons do not", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello world");
  const seat = new FakeElement("div");
  const event = fakeEvent(sendButtonIn(seat));
  dispatch("click", event);
  assert.equal(event.prevented, true);
  assert.equal(I.gateStore.getSnapshot().pending.sessionId, "s1");
  I.closeGate("s1");

  // A primary-looking button OUTSIDE the composer bar fallback (e.g. approval panel) must not gate.
  const outside = new FakeElement("button");
  outside.className = "XyZz_primary";
  outside.setClosest("[data-chain-overlay-fallback]", null);
  outside.setClosest("[data-composer-seat]", null);
  const event2 = fakeEvent(outside);
  dispatch("click", event2);
  assert.equal(event2.prevented, false);
  assert.equal(I.gateStore.getSnapshot().pending, null);
});

test("click on the stop button (running turn) is never gated", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello world");
  const seat = new FakeElement("div");
  const fallback = new FakeElement("div").setClosest("[data-chain-overlay-fallback]", null);
  const stop = new FakeElement("button");
  stop.className = "XyZz_primary";
  stop.setClosest("[data-chain-overlay-fallback]", fallback);
  stop.setClosest("[data-composer-seat]", seat);
  // The running-turn stop button renders a square <rect> inside its SVG.
  stop.setQuery(() => new FakeElement("rect"));
  const event = fakeEvent(stop);
  dispatch("click", event);
  assert.equal(event.prevented, false, "stop must never be intercepted");
  assert.equal(I.gateStore.getSnapshot().pending, null);
});

test("empty draft is not gated (nothing would be sent)", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "   ");
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), undefined);
});

test("busy phases are not gated", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello", "submitting");
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), undefined);
});

test("shift+Enter / IME composition / repeat are not gated", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello");
  const seat = new FakeElement("div");
  const base = fakeEvent(textareaIn(seat));
  assert.equal(I.isComposerEnter({ ...base, shiftKey: true }), false);
  assert.equal(I.isComposerEnter({ ...base, isComposing: true }), false);
  assert.equal(I.isComposerEnter({ ...base, keyCode: 229 }), false);
  assert.equal(I.isComposerEnter({ ...base, repeat: true }), false);
  assert.equal(I.isComposerEnter({ ...base, target: new FakeElement("div") }), false);
});

test("Enter with an open popup listbox is not gated", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello");
  const seat = new FakeElement("div").setQuery(() => new FakeElement("div"));
  const event = fakeEvent(textareaIn(seat));
  dispatch("keydown", event);
  assert.equal(event.prevented, false);
  assert.equal(I.gateStore.getSnapshot().pending, null);
});

// --- peak-segment muting ----------------------------------------------------

const SEG_AM = "2026-08-25|09:00-12:00";
const SEG_PM = "2026-08-25|14:00-18:00";
const AFTERNOON_PEAK = new Date("2026-08-25T07:00:00Z"); // Beijing 15:00 Tuesday

test("segmentKey identifies the current peak window (and null off-peak/weekend)", () => {
  local.clear();
  assert.equal(I.segmentKey(I.DEFAULT_SETTINGS, TUE_PEAK), SEG_AM);
  assert.equal(I.segmentKey(I.DEFAULT_SETTINGS, AFTERNOON_PEAK), SEG_PM);
  assert.equal(I.segmentKey(I.DEFAULT_SETTINGS, TUE_EVENING), null);
  assert.equal(I.segmentKey(I.DEFAULT_SETTINGS, SAT_PEAK), null);
});

test("every send during peak asks again when the segment is not muted", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello world");
  shared.submitCalls = 0;
  I.openGate("s1");
  I.consentAndSubmit(sharedCtx, "s1", false); // send now, no mute
  assert.equal(shared.submitCalls, 1);
  assert.equal(I.gateStore.getSnapshot().pending, null);
  assert.equal(I.isSegmentMuted(SEG_AM), false);
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), "s1", "next send must ask again");
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), "s1", "and again — every peak send asks");
});

test("muting the current peak segment silences the gate until the segment ends", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello world");
  shared.submitCalls = 0;
  I.openGate("s1");
  I.consentAndSubmit(sharedCtx, "s1", true); // send now + mute this segment
  assert.equal(shared.submitCalls, 1);
  assert.equal(I.isSegmentMuted(SEG_AM), true);
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), undefined, "muted segment must not ask");
});

test("a new peak segment asks again after the muted one ends", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "hello");
  I.muteSegment(SEG_AM);
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), undefined, "muted morning segment");
  I.setNow(AFTERNOON_PEAK);
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), "s1", "afternoon segment asks again");
  assert.equal(I.isSegmentMuted(SEG_PM), false);
});

test("muting works across sessions (segment-wide, not per session)", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  I.muteSegment(SEG_AM);
  setSession("s1", "hello");
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), undefined);
  setSession("s2", "other");
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), undefined, "mute is segment-wide, all sessions");
});

// --- defer: hold + off-peak auto-send --------------------------------------

test("deferAndHold stores the draft; without mute the next send asks again", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "buy milk");
  shared.submitCalls = 0;
  I.openGate("s1");
  I.deferAndHold(sharedCtx, "s1", false);
  assert.equal(shared.submitCalls, 0, "defer must not send");
  const holds = I.readHolds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].sessionId, "s1");
  assert.equal(holds[0].text, "buy milk");
  assert.equal(I.gateStore.getSnapshot().pending, null);
  assert.equal(I.isSegmentMuted(SEG_AM), false);
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), "s1", "not muted: next send asks again");
});

test("deferAndHold with mute silences the segment and still holds the draft", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "buy milk");
  shared.submitCalls = 0;
  I.openGate("s1");
  I.deferAndHold(sharedCtx, "s1", true);
  assert.equal(shared.submitCalls, 0);
  assert.equal(I.isSegmentMuted(SEG_AM), true);
  assert.equal(I.readHolds().length, 1);
  assert.equal(I.shouldIntercept(sharedCtx, I.now()), undefined);
});

test("auto-send fires when off-peak starts and the draft is intact", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "buy milk");
  shared.submitCalls = 0;
  I.openGate("s1");
  I.deferAndHold(sharedCtx, "s1");
  // Off-peak arrives; the draft is untouched.
  I.setNow(TUE_EVENING);
  I.sweepHolds(sharedCtx);
  assert.equal(shared.submitCalls, 1, "held message must auto-send at off-peak");
  assert.equal(I.readHolds().length, 0, "hold must be consumed");
});

// --- /peakgate queue commands ----------------------------------------------

test("commandFromDraft parses the /peakgate command family", () => {
  assert.equal(I.commandFromDraft("/peakgate").name, "help");
  assert.equal(I.commandFromDraft("/peakgate hold 买牛奶").name, "hold");
  assert.equal(I.commandFromDraft("/peakgate hold 买牛奶").arg, "买牛奶");
  assert.equal(I.commandFromDraft("/peakgate list").name, "list");
  assert.equal(I.commandFromDraft("/peakgate remove 2").name, "remove");
  assert.equal(I.commandFromDraft("/peakgate remove 2").arg, "2");
  assert.equal(I.commandFromDraft("/peakgate cancel").name, "cancel");
  assert.equal(I.commandFromDraft("hello world"), null);
  assert.equal(I.commandFromDraft("/peakgatex hold x"), null);
});

test("typing /peakgate hold enqueues the text, clears the draft, and never opens the gate", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "/peakgate hold 买牛奶");
  shared.submitCalls = 0;
  const seat = new FakeElement("div");
  const event = fakeEvent(textareaIn(seat));
  dispatch("keydown", event);
  assert.equal(event.prevented, true, "command must swallow the submit");
  assert.equal(I.gateStore.getSnapshot().pending, null, "command must not open the peak gate");
  const holds = I.readHolds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].explicit, true);
  assert.equal(holds[0].text, "买牛奶");
  assert.equal(shared.inputs.get("s1").state.draft, "", "command must clear the draft");
});

test("/peakgate list opens the queue card; closeQueue closes it", () => {
  local.clear();
  const { ctx } = makeCtx("s1", "/peakgate list");
  I.handleCommand(ctx, "s1", { name: "list", arg: "" });
  assert.equal(I.gateStore.getSnapshot().queue, true);
  I.closeQueue();
  assert.equal(I.gateStore.getSnapshot().queue, false);
});

test("/peakgate remove deletes by 1-based index; bad index keeps the queue", () => {
  local.clear();
  const { ctx } = makeCtx("s1", "x");
  I.writeHolds([
    { id: "a", sessionId: "s1", text: "one", at: Date.now(), explicit: true },
    { id: "b", sessionId: "s1", text: "two", at: Date.now(), explicit: true }
  ]);
  I.handleCommand(ctx, "s1", { name: "remove", arg: "1" });
  let holds = I.readHolds();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].text, "two");
  I.handleCommand(ctx, "s1", { name: "remove", arg: "9" });
  assert.equal(I.readHolds().length, 1, "invalid index must not remove anything");
});

test("/peakgate cancel clears the whole queue", () => {
  local.clear();
  const { ctx } = makeCtx("s1", "x");
  I.writeHolds([
    { id: "a", sessionId: "s1", text: "one", at: Date.now(), explicit: true },
    { id: "b", sessionId: "s1", text: "two", at: Date.now(), explicit: true }
  ]);
  I.handleCommand(ctx, "s1", { name: "cancel", arg: "" });
  assert.equal(I.readHolds().length, 0);
});

test("command-created queue entries auto-send at off-peak by restoring the text", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "/peakgate hold 明天发布");
  shared.submitCalls = 0;
  const seat = new FakeElement("div");
  const event = fakeEvent(textareaIn(seat));
  dispatch("keydown", event);
  assert.equal(I.readHolds().length, 1);
  // Off-peak arrives; the draft is empty (command consumed it).
  I.setNow(TUE_EVENING);
  I.sweepHolds(sharedCtx);
  assert.equal(shared.submitCalls, 1, "queued text must be submitted at off-peak");
  assert.equal(shared.inputs.get("s1").state.draft, "明天发布", "text must be restored before sending");
  assert.equal(I.readHolds().length, 0);
});

test("queued text never clobbers a draft the user is actively writing", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "/peakgate hold 明天发布");
  shared.submitCalls = 0;
  const seat = new FakeElement("div");
  const event = fakeEvent(textareaIn(seat));
  dispatch("keydown", event);
  // User starts writing something else before off-peak.
  setInput("s1", { draft: "别的草稿" });
  I.setNow(TUE_EVENING);
  I.sweepHolds(sharedCtx);
  assert.equal(shared.submitCalls, 0, "must not overwrite the user's active draft");
  assert.equal(shared.inputs.get("s1").state.draft, "别的草稿");
  assert.equal(I.readHolds().length, 1, "hold must stay queued");
});

test("edited draft cancels the stale hold instead of sending", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "buy milk");
  shared.submitCalls = 0;
  I.openGate("s1");
  I.deferAndHold(sharedCtx, "s1");
  setInput("s1", { draft: "buy milk NOW" });
  I.setNow(TUE_EVENING);
  I.sweepHolds(sharedCtx);
  assert.equal(shared.submitCalls, 0);
  assert.equal(I.readHolds().length, 0, "stale hold must be dropped");
});

test("holds never auto-send while still in peak", () => {
  local.clear();
  I.setNow(TUE_PEAK);
  setSession("s1", "buy milk");
  shared.submitCalls = 0;
  I.openGate("s1");
  I.deferAndHold(sharedCtx, "s1");
  I.sweepHolds(sharedCtx);
  assert.equal(shared.submitCalls, 0);
  assert.equal(I.readHolds().length, 1);
});

// --- lifecycle cleanup ------------------------------------------------------

test("lifecycle disposer removes listeners and unmounts the portal", () => {
  const before = docHandlers.length;
  const disposer = shared.cleanups.at(-1);
  assert.equal(typeof disposer, "function");
  disposer();
  const keydown = docHandlers.filter((h) => h.type === "keydown" && h.capture);
  const click = docHandlers.filter((h) => h.type === "click" && h.capture);
  assert.equal(keydown.length, 0);
  assert.equal(click.length, 0);
  assert.ok(docHandlers.length < before);
});

console.log(`\nAll ${testCount} tests passed.`);
