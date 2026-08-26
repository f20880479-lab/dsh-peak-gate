window.__ModuleLoader__.load({
	id: "dsh-peak-gate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region deps
		var react = require("react");
		var react_dom_client = require("react-dom/client");
		var createElement = react.createElement;
		//#endregion

		//#region constants
		/** Locale namespace this plugin owns. */
		var NS = "peak-gate";
		var SETTINGS_KEY = "dsh.peakGate.settings.v1";
		var MUTE_KEY = "dsh.peakGate.muted.v1";
		var HOLDS_KEY = "dsh.peakGate.holds.v1";
		var CSS_TAG = "dsh-peak-gate/client.css";
		var MINUTE = 60 * 1000;
		var HOLD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
		var HOLD_MAX_COUNT = 50;
		/** Slash-less? No — a real command prefix; handled before the composer's own command system. */
		var COMMAND_PREFIX = "/peakgate";
		/** Parse one composer command: /peakgate <hold|list|remove|cancel|help> [arg] */
		var COMMAND_RE = /^\/peakgate(?:\s+(hold|list|remove|cancel|help))?(?:\s+([\s\S]*))?$/i;
		/** DeepSeek official peak windows (weekday, Beijing time): 09:00-12:00 and 14:00-18:00. */
		var DEFAULT_SETTINGS = {
			enabled: true,
			timezone: "Asia/Shanghai",
			peakWindows: [
				{ start: "09:00", end: "12:00" },
				{ start: "14:00", end: "18:00" }
			],
			offPeakWeekends: true
		};
		//#endregion

		//#region tiny observable store
		function createStore(initial) {
			var value = initial;
			var listeners = new Set();
			return {
				getSnapshot: () => value,
				set: (next) => {
					if (Object.is(next, value)) return;
					value = next;
					for (var fn of [...listeners]) fn();
				},
				subscribe: (fn) => {
					listeners.add(fn);
					return () => {
						listeners.delete(fn);
					};
				}
			};
		}
		//#endregion

		//#region settings
		function parseTime(text) {
			var parts = String(text).split(":");
			return Number(parts[0]) * 60 + Number(parts[1] ?? 0);
		}
		function loadSettings() {
			var base = {
				...DEFAULT_SETTINGS,
				peakWindows: DEFAULT_SETTINGS.peakWindows.map((w) => ({ ...w }))
			};
			try {
				var raw = window.localStorage.getItem(SETTINGS_KEY);
				if (raw === null) return base;
				var parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return base;
				var merged = { ...base, ...parsed };
				if (!Array.isArray(merged.peakWindows) || merged.peakWindows.length === 0) merged.peakWindows = base.peakWindows;
				merged.peakWindows = merged.peakWindows
					.filter((w) => w !== null && typeof w === "object" && typeof w.start === "string" && typeof w.end === "string")
					.map((w) => ({ start: w.start, end: w.end }));
				if (merged.peakWindows.length === 0) merged.peakWindows = base.peakWindows;
				return merged;
			} catch {
				return base;
			}
		}
		var settingsStore = createStore(loadSettings());
		function saveSettings(next) {
			settingsStore.set(next);
			try {
				window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
			} catch {}
		}
		//#endregion

		//#region wall-clock helpers (Intl-based, no tz library)
		/** Test hook: override the clock used by interception/sweep decisions. */
		var _nowOverride = null;
		function now() {
			return _nowOverride !== null ? _nowOverride : new Date();
		}
		/** Current wall-clock parts in the configured timezone. */
		function wallParts(date, timezone) {
			var parts = new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				weekday: "short",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false
			}).formatToParts(date);
			var out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, weekday: 0 };
			for (var part of parts) {
				switch (part.type) {
					case "year": out.year = Number(part.value); break;
					case "month": out.month = Number(part.value); break;
					case "day": out.day = Number(part.value); break;
					case "hour": out.hour = Number(part.value) % 24; break;
					case "minute": out.minute = Number(part.value); break;
					case "weekday": out.weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part.value); break;
				}
			}
			out.minutes = out.hour * 60 + out.minute;
			out.dateKey = out.year + "-" + String(out.month).padStart(2, "0") + "-" + String(out.day).padStart(2, "0");
			out.timeLabel = String(out.hour).padStart(2, "0") + ":" + String(out.minute).padStart(2, "0");
			return out;
		}
		function minutesInWindow(settings, minutes) {
			for (var w of settings.peakWindows) {
				var start = parseTime(w.start);
				var end = parseTime(w.end);
				if (minutes >= start && minutes < end) return true;
			}
			return false;
		}
		/** True when the given instant is billed at peak price under the configured schedule. */
		function isPeakAt(settings, date) {
			if (!settings.enabled) return false;
			var parts = wallParts(date, settings.timezone);
			if (settings.offPeakWeekends && (parts.weekday === 0 || parts.weekday === 6)) return false;
			return minutesInWindow(settings, parts.minutes);
		}
		function labelForMinutes(minutes) {
			return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
		}
		/** The next pricing transition: { to, label, minutes, days } in wall-clock terms. */
		function nextTransition(settings, date) {
			var parts = wallParts(date, settings.timezone);
			if (settings.offPeakWeekends && (parts.weekday === 0 || parts.weekday === 6)) {
				var weekendDays = parts.weekday === 6 ? 2 : 1;
				return { to: "peak", label: "+" + weekendDays + "d 09:00", minutes: 540, days: weekendDays };
			}
			var boundaries = [];
			for (var w of settings.peakWindows) {
				boundaries.push(parseTime(w.start), parseTime(w.end));
			}
			boundaries.sort((a, b) => a - b);
			for (var b of boundaries) {
				if (b > parts.minutes) {
					return { to: minutesInWindow(settings, b) ? "peak" : "offpeak", label: labelForMinutes(b), minutes: b, days: 0 };
				}
			}
			return { to: "peak", label: "tomorrow 09:00", minutes: 540, days: 1 };
		}
		/** Human countdown text like "2h 35m" until the next pricing transition. */
		function countdownLabel(settings, date) {
			var parts = wallParts(date, settings.timezone);
			var transition = nextTransition(settings, date);
			var delta = transition.minutes - parts.minutes + transition.days * 24 * 60;
			var h = Math.floor(delta / 60);
			var m = delta % 60;
			return (h > 0 ? h + "h " : "") + m + "m";
		}
		//#endregion

		//#region muted peak segments + holds persistence
		function readJson(key, fallback) {
			try {
				var raw = window.localStorage.getItem(key);
				if (raw === null) return fallback;
				var parsed = JSON.parse(raw);
				return parsed === null || typeof parsed !== "object" ? fallback : parsed;
			} catch {
				return fallback;
			}
		}
		function writeJson(key, value) {
			try {
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch {}
		}
		/**
		* Identity of the current peak segment: "2026-08-25|09:00-12:00". Returns
		* null when the instant is not inside a peak window (off-peak / weekend).
		* Muting a segment silences the gate for the rest of that window only —
		* the next peak segment asks again.
		*/
		function segmentKey(settings, date) {
			var parts = wallParts(date, settings.timezone);
			if (settings.offPeakWeekends && (parts.weekday === 0 || parts.weekday === 6)) return null;
			for (var w of settings.peakWindows) {
				var start = parseTime(w.start);
				var end = parseTime(w.end);
				if (parts.minutes >= start && parts.minutes < end) return parts.dateKey + "|" + w.start + "-" + w.end;
			}
			return null;
		}
		function isSegmentMuted(segment) {
			if (segment === null) return false;
			var muted = readJson(MUTE_KEY, {});
			return muted[segment] === true;
		}
		function muteSegment(segment) {
			if (segment === null) return;
			var muted = readJson(MUTE_KEY, {});
			if (muted[segment] === true) return;
			muted[segment] = true;
			writeJson(MUTE_KEY, muted);
		}
		function readHolds() {
			var holds = readJson(HOLDS_KEY, []);
			if (!Array.isArray(holds)) return [];
			return holds.filter((h) => h !== null && typeof h === "object" && typeof h.sessionId === "string" && typeof h.text === "string");
		}
		function writeHolds(holds) {
			var now = Date.now();
			var kept = holds.filter((h) => now - (h.at ?? 0) < HOLD_MAX_AGE_MS).slice(0, HOLD_MAX_COUNT);
			writeJson(HOLDS_KEY, kept);
		}
		function dropHold(sessionId) {
			writeHolds(readHolds().filter((h) => h.sessionId !== sessionId));
		}
		/** Remove one queue entry by its generated id; returns true when found. */
		function removeHoldById(id) {
			var holds = readHolds();
			var next = holds.filter((h) => h.id !== id);
			if (next.length === holds.length) return false;
			writeHolds(next);
			return true;
		}
		/** Move one queue entry up (-1) or down (+1) in the send order; returns true when moved. */
		function moveHold(id, delta) {
			var holds = readHolds();
			var from = holds.findIndex((h) => h.id === id);
			var to = from + delta;
			if (from < 0 || to < 0 || to >= holds.length) return false;
			var next = holds.slice();
			var tmp = next[from];
			next[from] = next[to];
			next[to] = tmp;
			writeHolds(next);
			return true;
		}
		/** Replace one queue entry's text; returns true when edited. */
		function editHoldText(id, text) {
			var trimmed = String(text ?? "").trim();
			if (trimmed === "") return false;
			var holds = readHolds();
			var at = holds.findIndex((h) => h.id === id);
			if (at < 0) return false;
			holds[at] = { ...holds[at], text: trimmed };
			writeHolds(holds);
			return true;
		}
		var _idCounter = 0;
		function nextHoldId() {
			_idCounter = (_idCounter + 1) % 1000;
			return Date.now().toString(36) + "-" + _idCounter.toString(36);
		}
		//#endregion

		//#region gate + queue + toast state
		var gateStore = createStore({ pending: null, toast: null, queue: false });
		/** Open the confirmation card for a session. */
		function openGate(sessionId) {
			var current = gateStore.getSnapshot();
			if (current.pending !== null) return;
			gateStore.set({ ...current, pending: { sessionId, at: Date.now() }, queue: false });
		}
		/** Close the card without sending; the draft stays untouched and nothing is muted. */
		function closeGate(sessionId) {
			var current = gateStore.getSnapshot();
			if (current.pending === null || current.pending.sessionId !== sessionId) return;
			gateStore.set({ ...current, pending: null });
		}
		/** Open the queue management card. */
		function openQueue() {
			var current = gateStore.getSnapshot();
			if (current.queue) return;
			gateStore.set({ ...current, queue: true, pending: null });
		}
		function closeQueue() {
			var current = gateStore.getSnapshot();
			if (!current.queue) return;
			gateStore.set({ ...current, queue: false });
		}
		function showToast(text, kind) {
			var current = gateStore.getSnapshot();
			gateStore.set({ ...current, toast: { text, kind: kind ?? "info", at: Date.now() } });
		}
		//#endregion

		//#region interception
		/** The current active session id, or undefined when no session is open. */
		function currentSessionId(ctx) {
			try {
				return ctx.sessions.list.getSnapshot().current ?? void 0;
			} catch {
				return void 0;
			}
		}
		/** Per-session input facts: draft, phase, images — or null when unavailable. */
		function inputFacts(ctx, sessionId) {
			try {
				var info = ctx.sessions.provideInfo(sessionId);
				var state = info?.hooks?.input?.getSnapshot?.();
				if (state === void 0 || state === null) return null;
				return {
					draft: typeof state.draft === "string" ? state.draft : "",
					phase: typeof state.phase === "string" ? state.phase : "plain",
					imageIds: Array.isArray(state.imageIds) ? state.imageIds : []
				};
			} catch {
				return null;
			}
		}
		/** Mirror of the composer's own submit guards: would this gesture actually send? */
		function wouldActuallySend(facts) {
			if (facts === null) return false;
			if (facts.phase === "adjudicating" || facts.phase === "submitting" || facts.phase === "claimed") return false;
			return facts.draft.trim() !== "" || facts.imageIds.length > 0;
		}
		/** Decide whether a submit gesture must be intercepted by the peak gate.
		* @returns the session id to gate, or undefined when the gesture passes. */
		function shouldIntercept(ctx, nowDate) {
			var settings = settingsStore.getSnapshot();
			if (!settings.enabled) return void 0;
			var current = gateStore.getSnapshot();
			if (current.pending !== null) return void 0;
			if (!isPeakAt(settings, nowDate)) return void 0;
			if (isSegmentMuted(segmentKey(settings, nowDate))) return void 0;
			var sessionId = currentSessionId(ctx);
			if (sessionId === void 0) return void 0;
			if (!wouldActuallySend(inputFacts(ctx, sessionId))) return void 0;
			return sessionId;
		}
		/** Enter on the composer textarea (shape checks only — popup handling comes after command detection). */
		function isComposerEnter(event) {
			if (event.key !== "Enter" || event.shiftKey) return false;
			if (event.isComposing || event.keyCode === 229) return false;
			if (event.repeat) return false;
			var target = event.target;
			if (!(target instanceof Element)) return false;
			if (target.tagName !== "TEXTAREA") return false;
			var seat = target.closest("[data-composer-seat]");
			if (seat === null) return false;
			return { target, seat };
		}
		/** True when a popup (command menu / slash menu) is open in the composer seat and owns Enter. */
		function hasComposerPopup(seat) {
			if (seat === null) return false;
			return seat.querySelector('[role="listbox"], [role="menu"], [data-composer-popup]') !== null;
		}
		/** Click on the composer bar's primary (send) button — never on chain overlays like the approval panel,
		* and never on the stop button (running turns render a square <rect>; the send arrow is a <path>). */
		function isComposerSendClick(event) {
			var target = event.target;
			if (!(target instanceof Element)) return false;
			var button = target.closest("button");
			if (button === null) return false;
			var fallback = button.closest("[data-chain-overlay-fallback]");
			if (fallback === null) return false;
			if (typeof button.className !== "string" || !button.className.includes("primary")) return false;
			if (button.querySelector("svg rect") !== null) return false;
			return true;
		}
		//#endregion

		//#region auto-send (deferred holds)
		/** Send one held message immediately (user-initiated "send now", works even during peak).
		* Restores the text into the target session and submits it, then removes the hold.
		* Returns true when the send was handed to the composer. */
		function sendHoldNow(ctx, hold) {
			var sessionId = hold.sessionId;
			if (sessionId === "" || typeof sessionId !== "string") return false;
			var facts = inputFacts(ctx, sessionId);
			if (facts === null) {
				showToast("dock.sendNowMissing", "info");
				return false;
			}
			if (facts.phase === "adjudicating" || facts.phase === "submitting") {
				showToast("dock.sendNowBusy", "info");
				return false;
			}
			var info;
			try {
				info = ctx.sessions.provideInfo(sessionId);
			} catch {
				info = void 0;
			}
			if (info?.props?.inputActions?.submit === void 0) {
				showToast("dock.sendNowMissing", "info");
				return false;
			}
			// Never clobber a draft the user is actively writing in the target session.
			if (facts.draft !== "" && facts.draft !== hold.text) {
				showToast("dock.draftConflict", "info");
				return false;
			}
			try {
				info.props.inputActions.setDraft(hold.text);
				info.props.inputActions.submit();
				removeHoldById(hold.id);
				showToast("dock.sentNow", "success");
				return true;
			} catch {
				showToast("dock.sendNowFailed", "info");
				return false;
			}
		}
		/** Try to send one held message now that we are in off-peak. Returns true when sent or dropped. */
		function tryAutoSend(ctx, hold) {
			var sessionId = hold.sessionId;
			if (sessionId === "" || typeof sessionId !== "string") {
				dropHold(sessionId);
				return true;
			}
			var facts = inputFacts(ctx, sessionId);
			if (facts === null) return false;
			if (facts.phase === "adjudicating" || facts.phase === "submitting") return false;
			var info;
			try {
				info = ctx.sessions.provideInfo(sessionId);
			} catch {
				info = void 0;
			}
			if (info?.props?.inputActions?.submit === void 0) return false;
			if (hold.explicit === true) {
				// Command-created queue entry ("/peakgate hold …"): the draft was cleared
				// when the command ran, so restore the text and submit it. Never clobber a
				// draft the user is actively writing — skip (and keep waiting) instead.
				if (facts.draft !== "" && facts.draft !== hold.text) return false;
				info.props.inputActions.setDraft(hold.text);
				info.props.inputActions.submit();
				removeHoldById(hold.id);
				showToast("toast.autoSent", "success");
				return true;
			}
			// Card-created hold ("wait for off-peak"): reuse the untouched draft.
			if (facts.draft !== hold.text) {
				// The user edited the draft — their newer intent wins; drop the stale hold.
				dropHold(sessionId);
				return true;
			}
			if (facts.draft.trim() === "" && facts.imageIds.length === 0) {
				dropHold(sessionId);
				return true;
			}
			info.props.inputActions.submit();
			dropHold(sessionId);
			showToast("toast.autoSent", "success");
			return true;
		}
		/** Interval body: auto-send deferred holds once off-peak starts. */
		function sweepHolds(ctx) {
			var settings = settingsStore.getSnapshot();
			if (!settings.enabled) return;
			var holds = readHolds();
			if (holds.length === 0) return;
			if (isPeakAt(settings, now())) return;
			for (var hold of holds) tryAutoSend(ctx, hold);
		}
		//#endregion

		//#region styles
		var CSS = [
			".dsh-pg-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);backdrop-filter:blur(2px);padding:24px}",
			".dsh-pg-card{width:100%;max-width:440px;border:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv2);border-radius:20px;flex-direction:column;display:flex;overflow:hidden}",
			".dsh-pg-strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex;flex:none}",
			".dsh-pg-dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;width:8px;height:8px;flex:none}",
			".dsh-pg-header{justify-content:space-between;align-items:flex-start;gap:16px;padding:16px 16px 0 20px;display:flex}",
			".dsh-pg-title{margin:0;font-size:16px;font-weight:500;line-height:22px}",
			".dsh-pg-close{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;padding:0;display:grid;flex:none}",
			".dsh-pg-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-pg-body{padding:10px 20px 4px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}",
			".dsh-pg-note{padding:8px 20px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-pg-footer{flex:none;justify-content:flex-end;align-items:center;gap:10px;padding:14px 16px 16px;display:flex;flex-wrap:wrap}",
			".dsh-pg-btn{height:34px;font:inherit;font-size:14px;line-height:22px;cursor:pointer;border-radius:999px;align-items:center;gap:6px;padding:0 16px;display:inline-flex;border:1px solid transparent}",
			".dsh-pg-btn:disabled{opacity:.55;cursor:default}",
			".dsh-pg-btn-primary{background:var(--dsw-alias-state-warn-primary);color:#fff}",
			".dsh-pg-btn-outline{border-color:var(--dsw-alias-state-warn-secondary);color:var(--dsw-alias-state-warn-primary)}",
			".dsh-pg-btn-outline:hover{background:var(--dsw-alias-state-warn-tertiary)}",
			".dsh-pg-btn-primary:hover{filter:brightness(1.08)}",
			".dsh-pg-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483001;max-width:min(560px,calc(100vw - 48px));border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv2);border-radius:14px;padding:10px 16px;font-size:13px;line-height:19px}",
			".dsh-pg-toast-success{border-color:var(--dsw-alias-state-success-secondary);color:var(--dsw-alias-state-success-primary)}",
			".dsh-pg-mute{flex:none;align-items:center;gap:8px;padding:10px 20px 0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex}",
			".dsh-pg-mute input{width:15px;height:15px;accent-color:var(--dsw-alias-state-warn-primary);cursor:pointer;margin:0;flex:none}",
			".dsh-pg-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance));max-width:var(--dsh-chat-content-width);margin:0 auto;padding:0;flex:none}",
			".dsh-pg-hheader{box-sizing:border-box;width:100%;height:34px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:9px;align-items:center;gap:10px;padding:4px 12px;display:flex;transition:background .12s ease}",
			".dsh-pg-hheader:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-pg-hheader:active{background:var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover))}",
			".dsh-pg-hlead{color:var(--dsw-alias-state-warn-primary);flex:none;place-items:center;display:grid}",
			".dsh-pg-hcount{min-width:0;flex:auto;font-size:13px;font-weight:500;line-height:24px}",
			".dsh-pg-hchevron{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid;transition:transform .15s ease}",
			".dsh-pg-hpanel{background:var(--dsw-specific-tip);border-radius:12px 12px 0 0;width:100%;padding:6px 8px 8px;position:relative;overflow:hidden;display:flex;flex-direction:column;gap:6px;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}",
			".dsh-pg-hpanel::before{content:\"\";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--dsw-alias-state-warn-primary),transparent 65%);opacity:.85}",
			".dsh-pg-hlist{max-height:216px;overflow-y:auto;flex-direction:column;display:flex;gap:2px;padding-top:2px}",
			".dsh-pg-hrow{box-sizing:border-box;border-radius:9px;align-items:center;gap:8px;width:100%;min-height:38px;padding:4px 6px 4px 10px;display:flex;transition:background .1s ease}",
			".dsh-pg-hrow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-pg-hidx{width:20px;height:20px;flex:none;place-items:center;display:grid;border-radius:7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:20px;font-weight:600}",
			".dsh-pg-hmain{flex-direction:column;flex:1;min-width:0;gap:1px;display:flex}",
			".dsh-pg-htext{color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;word-break:break-all;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-pg-hmeta{color:var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));font-size:11px;line-height:15px}",
			".dsh-pg-hedit{min-width:0;flex:1;font:inherit;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:4px 9px;transition:border-color .12s ease}",
			".dsh-pg-hedit:focus{outline:none;border-color:var(--dsw-alias-state-warn-primary)}",
			".dsh-pg-hactions{flex:none;align-items:center;gap:2px;display:flex;opacity:.55;transition:opacity .12s ease}",
			".dsh-pg-hrow:hover .dsh-pg-hactions,.dsh-pg-hrow:focus-within .dsh-pg-hactions{opacity:1}",
			".dsh-pg-hact{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:7px;place-items:center;padding:0;display:grid;transition:background .1s ease,color .1s ease}",
			".dsh-pg-hact:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-pg-hact:disabled{opacity:.35;cursor:default}",
			".dsh-pg-hact-ok{color:var(--dsw-alias-state-success-primary)}",
			".dsh-pg-hact-send{color:var(--dsw-alias-state-success-primary)}",
			".dsh-pg-hact-send:hover:not(:disabled){background:var(--dsw-alias-state-success-tertiary, var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-success-primary)}",
			".dsh-pg-hempty{flex-direction:column;align-items:center;gap:8px;padding:16px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center;display:flex}",
			".dsh-pg-hempty-icon{color:var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));opacity:.8;place-items:center;display:grid}",
			".dsh-pg-hfooter{flex:none;display:flex;justify-content:flex-end}",
			".dsh-pg-hclear{height:26px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:7px;padding:0 9px;transition:background .1s ease,color .1s ease}",
			".dsh-pg-hclear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}",
			".dsh-pg-settings-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:6px}",
			".dsh-pg-switch{position:relative;width:40px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);cursor:pointer;flex:none;transition:background .15s ease}",
			".dsh-pg-switch[aria-checked=\"true\"]{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".dsh-pg-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s ease}",
			".dsh-pg-switch[aria-checked=\"true\"]::after{left:20px}"
		].join("\n");
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-peak-gate";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region locales
		var zh = {
			"settings.title": "高峰时段发送确认",
			"settings.description": "高峰时段（工作日 09:00–12:00、14:00–18:00，北京时间）每次发送消息前都会确认；可勾选“本次高峰段内不再提示”。空闲时段（其余时间及周末，半价计费）不询问。",
			"settings.status.peak": "当前：高峰计费（原价）· 下次切换 {label}",
			"settings.status.offpeak": "当前：空闲计费（半价）· 下次切换 {label}",
			"card.eyebrow": "峰谷计费 · dsh-peak-gate",
			"card.title": "现在处于高峰计费时段",
			"card.body": "当前北京时间 {time}。工作日高峰时段为 {windows}，价格为空闲时段的两倍；空闲时段（其余时间及周末）按半价计费。",
			"card.note": "本次高峰段持续至 {end}。",
			"card.mute": "本次高峰段内不再提示（至 {end}）",
			"card.sendNow": "立即发送（高峰价）",
			"card.waitOffPeak": "等到空闲时段（自动发送）",
			"card.closeAria": "关闭（取消本次发送，保留草稿）",
			"card.countdown": "距空闲时段还有 {countdown}",
			"toast.deferred": "消息已暂存，空闲时段开始时将自动发送（半价）",
			"toast.autoSent": "空闲时段已开始，暂存的消息已自动发送（半价）",
			"toast.imageHold": "图片消息无法自动暂存，请在空闲时段手动发送（草稿已保留）",
			"cmd.holdDone": "已加入队列：空闲时段开始时自动发送（半价）",
			"cmd.holdUsage": "用法：/peakgate hold 消息内容",
			"cmd.removeDone": "已从队列删除该条",
			"cmd.removeUsage": "用法：/peakgate remove 序号（先用 /peakgate list 查看）",
			"cmd.removeMissing": "序号无效：没有对应队列项",
			"cmd.cancelDone": "队列已清空",
			"cmd.help": "/peakgate hold 消息 — 排队等待空闲时段自动发送\n/peakgate list — 查看队列\n/peakgate remove 序号 — 删除一条\n/peakgate cancel — 清空队列",
			"queue.title": "待发送队列（空闲时段自动发送）",
			"queue.removeAria": "从队列删除",
			"queue.clear": "清空队列",
			"queue.done": "完成",
			"queue.closeAria": "关闭",
			"dock.title": "待发送队列 ({n})",
			"dock.empty": "队列为空。输入 /peakgate hold 消息 排队，空闲时段（半价）开始时自动发送；↑↓ 可调整发送顺序。",
			"dock.up": "上移（提前发送）",
			"dock.down": "下移（延后发送）",
			"dock.edit": "修改文本",
			"dock.save": "保存",
			"dock.cancelEdit": "取消",
			"dock.removeAria": "删除",
			"dock.clear": "清空队列",
			"dock.sendNow": "立即发送（不等待，高峰价也发）",
			"dock.sentNow": "已立即发送",
			"dock.sendNowMissing": "目标会话未打开，无法立即发送",
			"dock.sendNowBusy": "目标会话正在处理消息，请稍后再试",
			"dock.draftConflict": "目标会话有正在编辑的草稿，为避免覆盖已取消",
			"dock.sendNowFailed": "立即发送失败"
		};
		var en = {
			"settings.title": "Peak-hour send confirmation",
			"settings.description": "Before every send during peak hours (weekdays 09:00–12:00 / 14:00–18:00 Beijing time) you confirm once; optionally mute the reminder for the rest of the current peak segment. Off-peak hours (all other times and weekends, half price) never ask.",
			"settings.status.peak": "Now: peak billing (full price) · next switch {label}",
			"settings.status.offpeak": "Now: off-peak billing (half price) · next switch {label}",
			"card.eyebrow": "Peak/off-peak pricing · dsh-peak-gate",
			"card.title": "Peak billing period is active",
			"card.body": "Beijing time now: {time}. Weekday peak windows are {windows} at twice the off-peak price; off-peak (all other times and weekends) bills at half price.",
			"card.note": "This peak segment lasts until {end}.",
			"card.mute": "Don't ask again for this peak segment (until {end})",
			"card.sendNow": "Send now (peak price)",
			"card.waitOffPeak": "Wait for off-peak (auto-send)",
			"card.closeAria": "Close (cancel this send, keep draft)",
			"card.countdown": "Off-peak starts in {countdown}",
			"toast.deferred": "Message held — it will auto-send when off-peak starts (half price)",
			"toast.autoSent": "Off-peak started; the held message was sent automatically (half price)",
			"toast.imageHold": "Image-only messages cannot be auto-held — send them manually during off-peak (draft kept)",
			"cmd.holdDone": "Queued — it will auto-send when off-peak starts (half price)",
			"cmd.holdUsage": "Usage: /peakgate hold <message>",
			"cmd.removeDone": "Removed from the queue",
			"cmd.removeUsage": "Usage: /peakgate remove <index> (see /peakgate list)",
			"cmd.removeMissing": "Invalid index: no such queue item",
			"cmd.cancelDone": "Queue cleared",
			"cmd.help": "/peakgate hold <message> — queue for off-peak auto-send\n/peakgate list — show the queue\n/peakgate remove <index> — remove one item\n/peakgate cancel — clear the queue",
			"queue.title": "Send queue (auto-sends at off-peak)",
			"queue.removeAria": "Remove from queue",
			"queue.clear": "Clear queue",
			"queue.done": "Done",
			"queue.closeAria": "Close",
			"dock.title": "Send queue ({n})",
			"dock.empty": "Queue is empty. Type /peakgate hold <message> to queue it for off-peak (half price) auto-send; use ↑↓ to reorder.",
			"dock.up": "Move up (send sooner)",
			"dock.down": "Move down (send later)",
			"dock.edit": "Edit text",
			"dock.save": "Save",
			"dock.cancelEdit": "Cancel",
			"dock.removeAria": "Delete",
			"dock.clear": "Clear queue",
			"dock.sendNow": "Send now (no waiting, peak price too)",
			"dock.sentNow": "Sent now",
			"dock.sendNowMissing": "Target session is not open — cannot send now",
			"dock.sendNowBusy": "Target session is busy — try again in a moment",
			"dock.draftConflict": "Target session has an unsent draft — skipped to avoid overwriting it",
			"dock.sendNowFailed": "Send now failed"
		};
		//#endregion

		//#region settings row
		function SettingsRow({ t, settingsStore }) {
			var settings = react.useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
			var [now, setNow] = react.useState(() => new Date());
			react.useEffect(() => {
				var timer = window.setInterval(() => setNow(new Date()), 30 * 1000);
				return () => window.clearInterval(timer);
			}, []);
			var parts = wallParts(now, settings.timezone);
			var peak = isPeakAt(settings, now);
			var transition = nextTransition(settings, now);
			var statusKey = peak ? "settings.status.peak" : "settings.status.offpeak";
			var windows = settings.peakWindows.map((w) => w.start + "–" + w.end).join(" / ");
			return createElement(
				"div",
				{ className: "dsh-pg-settings-row" },
				createElement(
					"div",
					{ className: "dsh-pg-settings-text" },
					createElement("div", { className: "dsh-pg-settings-title" }, t("settings.title")),
					createElement("div", { className: "dsh-pg-settings-desc" }, t("settings.description")),
					createElement(
						"div",
						{ className: "dsh-pg-settings-status" },
						t(statusKey, { label: transition.label }) + " · " + parts.timeLabel + " (" + windows + ")"
					)
				),
				createElement(
					"button",
					{
						type: "button",
						role: "switch",
						"aria-checked": settings.enabled,
						"aria-label": t("settings.title"),
						className: "dsh-pg-switch",
						onClick: () => saveSettings({ ...settings, enabled: !settings.enabled })
					},
					null
				)
			);
		}
		var SETTINGS_ROW_CSS = [
			".dsh-pg-settings-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:16px;padding:16px 0;display:flex}",
			".dsh-pg-settings-text{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:16px;display:flex}",
			".dsh-pg-settings-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
			".dsh-pg-settings-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}"
		].join("\n");
		function injectSettingsCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG + ":row") + "]") !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-peak-gate";
			tag.dataset.pluginCss = CSS_TAG + ":row";
			tag.textContent = SETTINGS_ROW_CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region gate actions
		/** "Send now at peak price": optionally mute this peak segment, then submit the real draft. */
		function consentAndSubmit(ctx, sessionId, mute) {
			if (mute === true) muteSegment(segmentKey(settingsStore.getSnapshot(), now()));
			gateStore.set({ ...gateStore.getSnapshot(), pending: null });
			try {
				var info = ctx.sessions.provideInfo(sessionId);
				info?.props?.inputActions?.submit?.();
			} catch {}
		}
		/** "Wait for off-peak": optionally mute this peak segment, hold the draft for auto-send. */
		function deferAndHold(ctx, sessionId, mute) {
			if (mute === true) muteSegment(segmentKey(settingsStore.getSnapshot(), now()));
			var facts = inputFacts(ctx, sessionId);
			var text = facts === null ? "" : facts.draft;
			if (text.trim() === "") {
				gateStore.set({ ...gateStore.getSnapshot(), pending: null });
				showToast("toast.imageHold", "info");
				return;
			}
			var holds = readHolds().filter((h) => h.sessionId !== sessionId);
			holds.push({ sessionId, text, at: Date.now() });
			writeHolds(holds);
			gateStore.set({ ...gateStore.getSnapshot(), pending: null });
			showToast("toast.deferred", "info");
		}
		//#endregion

		//#region queue commands
		/** Parse a composer command draft into { name, arg }, or null when it is not a /peakgate command. */
		function commandFromDraft(draft) {
			if (typeof draft !== "string") return null;
			var m = draft.trim().match(COMMAND_RE);
			if (m === null) return null;
			return { name: (m[1] ?? "help").toLowerCase(), arg: (m[2] ?? "").trim() };
		}
		/**
		* Handle one /peakgate command. Commands never hit the peak gate and never
		* consume tokens: hold enqueues a message for off-peak auto-send, list opens
		* the queue card, remove/cancel edit the queue, help prints usage.
		* @returns true when the draft was a command (caller must swallow the submit).
		*/
		function handleCommand(ctx, sessionId, cmd) {
			switch (cmd.name) {
				case "hold": {
					if (cmd.arg === "") {
						showToast("cmd.holdUsage", "info");
						return true;
					}
					var holds = readHolds().filter((h) => h.sessionId !== sessionId || h.explicit !== true);
					holds.push({ id: nextHoldId(), sessionId, text: cmd.arg, at: Date.now(), explicit: true });
					writeHolds(holds);
					try {
						ctx.sessions.provideInfo(sessionId)?.props?.inputActions?.setDraft?.("");
					} catch {}
					showToast("cmd.holdDone", "success");
					return true;
				}
				case "list":
					openQueue();
					return true;
				case "remove": {
					if (cmd.arg === "") {
						showToast("cmd.removeUsage", "info");
						return true;
					}
					var index = Number.parseInt(cmd.arg, 10);
					var all = readHolds();
					if (!Number.isInteger(index) || index < 1 || index > all.length) {
						showToast("cmd.removeMissing", "info");
						return true;
					}
					removeHoldById(all[index - 1].id);
					showToast("cmd.removeDone", "success");
					return true;
				}
				case "cancel": {
					writeHolds([]);
					showToast("cmd.cancelDone", "success");
					return true;
				}
				default:
					showToast("cmd.help", "info");
					return true;
			}
		}
		//#endregion

		//#region gate card + toast (portal)
		/** The confirmation card shown when a peak-hour send is intercepted. */
		function PeakGateCard({ t, pending, onSendNow, onWaitOffPeak, onClose }) {
			var [now, setNow] = react.useState(() => new Date());
			var [mute, setMute] = react.useState(false);
			react.useEffect(() => {
				var timer = window.setInterval(() => setNow(new Date()), 1000);
				return () => window.clearInterval(timer);
			}, []);
			var settings = settingsStore.getSnapshot();
			var parts = wallParts(now, settings.timezone);
			var windows = settings.peakWindows.map((w) => w.start + "–" + w.end).join(" / ");
			var countdown = countdownLabel(settings, now);
			var body = t("card.body", { time: parts.timeLabel, windows: windows });
			var segmentEnd = "—";
			for (var w of settings.peakWindows) {
				if (parts.minutes >= parseTime(w.start) && parts.minutes < parseTime(w.end)) {
					segmentEnd = w.end;
					break;
				}
			}
			return createElement(
				"div",
				{ className: "dsh-pg-backdrop", "data-dsh-peak-gate": "" },
				createElement(
					"section",
					{ className: "dsh-pg-card", role: "dialog", "aria-modal": "true", "aria-label": t("card.title") },
					createElement(
						"div",
						{ className: "dsh-pg-strip" },
						createElement("span", { className: "dsh-pg-dot" }),
						createElement("span", null, t("card.eyebrow"))
					),
					createElement(
						"div",
						{ className: "dsh-pg-header" },
						createElement("h2", { className: "dsh-pg-title" }, t("card.title")),
						createElement(
							"button",
							{
								type: "button",
								className: "dsh-pg-close",
								"aria-label": t("card.closeAria"),
								title: t("card.closeAria"),
								onClick: onClose
							},
							createElement(
								"svg",
								{ viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", "aria-hidden": true },
								createElement("path", { d: "M4 4l8 8M12 4l-8 8" })
							)
						)
					),
					createElement("div", { className: "dsh-pg-body" }, body),
					createElement(
						"div",
						{ className: "dsh-pg-note" },
						t("card.note", { end: segmentEnd }) + " · " + t("card.countdown", { countdown: countdown })
					),
					createElement(
						"label",
						{ className: "dsh-pg-mute" },
						createElement("input", {
							type: "checkbox",
							checked: mute,
							onChange: (event) => setMute(event.target.checked)
						}),
						createElement("span", null, t("card.mute", { end: segmentEnd }))
					),
					createElement(
						"div",
						{ className: "dsh-pg-footer" },
						createElement(
							"button",
							{ type: "button", className: "dsh-pg-btn dsh-pg-btn-outline", onClick: () => onWaitOffPeak(mute) },
							t("card.waitOffPeak")
						),
						createElement(
							"button",
							{ type: "button", className: "dsh-pg-btn dsh-pg-btn-primary", onClick: () => onSendNow(mute) },
							t("card.sendNow")
						)
					)
				)
			);
		}
		/** Transient toast banner (auto-dismiss). */
		function ToastBanner({ toast, t }) {
			var [visible, setVisible] = react.useState(true);
			react.useEffect(() => {
				setVisible(true);
				var timer = window.setTimeout(() => setVisible(false), 6000);
				return () => window.clearTimeout(timer);
			}, [toast.at]);
			if (!visible) return null;
			return createElement("div", { className: "dsh-pg-toast" + (toast.kind === "success" ? " dsh-pg-toast-success" : "") }, t(toast.text));
		}
		/** Session dock window: the pending-send queue with reorder / edit / delete / send-now controls. */
		function HoldQueueDock({ t, gateStore: gate, ctx, useSessions }) {
			var state = react.useSyncExternalStore(gate.subscribe, gate.getSnapshot);
			var expanded = state.queue;
			var [, force] = react.useState(0);
			var [editing, setEditing] = react.useState(null);
			var holds = readHolds();
			var byId = {};
			try {
				byId = useSessions((s) => s.byId ?? {});
			} catch {}
			var refresh = () => force((n) => n + 1);
			var startEdit = (hold) => setEditing({ id: hold.id, text: hold.text });
			var saveEdit = () => {
				if (editing === null) return;
				if (editHoldText(editing.id, editing.text)) refresh();
				setEditing(null);
			};
			var listId = "dsh-pg-hold-list";
			var rows = holds.map((hold, i) => {
				var isEditing = editing !== null && editing.id === hold.id;
				return createElement(
					"div",
					{ className: "dsh-pg-hrow", key: hold.id },
					createElement("span", { className: "dsh-pg-hidx" }, String(i + 1)),
					isEditing
						? createElement("input", {
								autoFocus: true,
								className: "dsh-pg-hedit",
								"aria-label": t("dock.edit"),
								value: editing.text,
								onChange: (event) => setEditing({ id: hold.id, text: event.currentTarget.value }),
								onKeyDown: (event) => {
									if (event.key === "Escape") {
										setEditing(null);
										return;
									}
									if (event.key === "Enter" && !event.nativeEvent.isComposing) {
										event.preventDefault();
										saveEdit();
									}
								}
						  })
						: createElement(
								"div",
								{ className: "dsh-pg-hmain" },
								createElement("div", { className: "dsh-pg-htext" }, hold.text),
								createElement("div", { className: "dsh-pg-hmeta" }, (byId[hold.sessionId]?.displayTitle ?? byId[hold.sessionId]?.title ?? "") + (hold.explicit === true ? " /hold" : " 卡片延迟"))
						  ),
					createElement(
						"div",
						{ className: "dsh-pg-hactions" },
						isEditing
							? createElement(react.Fragment, null,
									createElement("button", { type: "button", className: "dsh-pg-hact dsh-pg-hact-ok", "aria-label": t("dock.save"), title: t("dock.save"), onClick: saveEdit },
										createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", "aria-hidden": true }, createElement("path", { d: "M3 8.5l3 3 7-7" }))),
									createElement("button", { type: "button", className: "dsh-pg-hact", "aria-label": t("dock.cancelEdit"), title: t("dock.cancelEdit"), onClick: () => setEditing(null) },
										createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", "aria-hidden": true }, createElement("path", { d: "M4 4l8 8M12 4l-8 8" }))))
							: createElement(react.Fragment, null,
									createElement("button", { type: "button", className: "dsh-pg-hact dsh-pg-hact-send", "aria-label": t("dock.sendNow"), title: t("dock.sendNow"), onClick: () => { if (sendHoldNow(ctx, hold)) refresh(); } },
										createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, createElement("path", { d: "M8.3125 0.9802c.3552.073.6665.224.9502.4521.2245.1807.4675.4257.7167.6749l4.7275 4.7275-1.414 1.414-4.293-4.293v11.0858h-2V4.9558l-4.293 4.293-1.414-1.414 4.7275-4.7275c.2492-.2492.4923-.4942.7168-.6749.2393-.1925.5471-.3883.9501-.4253.2098-.0332.4155-.025.625-.0001Z" }))),
									createElement("button", { type: "button", className: "dsh-pg-hact", "aria-label": t("dock.up"), title: t("dock.up"), disabled: i === 0, onClick: () => { moveHold(hold.id, -1); refresh(); } },
										createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, createElement("path", { d: "M8 12V4M4 8l4-4 4 4" }))),
									createElement("button", { type: "button", className: "dsh-pg-hact", "aria-label": t("dock.down"), title: t("dock.down"), disabled: i === holds.length - 1, onClick: () => { moveHold(hold.id, 1); refresh(); } },
										createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, createElement("path", { d: "M8 4v8M4 8l4 4 4-4" }))),
									createElement("button", { type: "button", className: "dsh-pg-hact", "aria-label": t("dock.edit"), title: t("dock.edit"), onClick: () => startEdit(hold) },
										createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, createElement("path", { d: "M11.5 2.5l2 2L6 12l-3 .5L3.5 9.5z" }))),
									createElement("button", { type: "button", className: "dsh-pg-hact", "aria-label": t("dock.removeAria"), title: t("dock.removeAria"), onClick: () => { removeHoldById(hold.id); if (editing?.id === hold.id) setEditing(null); refresh(); } },
										createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", "aria-hidden": true }, createElement("path", { d: "M4 4l8 8M12 4l-8 8" }))))
					)
				);
			});
			return createElement(
				"div",
				{ className: "dsh-pg-dock", "data-dsh-hold-dock": "" },
				createElement(
					"button",
					{
						type: "button",
						className: "dsh-pg-hheader",
						"aria-controls": listId,
						"aria-expanded": expanded,
						onClick: () => {
							if (state.queue) closeQueue();
							else openQueue();
						}
					},
					createElement("span", { className: "dsh-pg-hlead", "aria-hidden": true },
						createElement("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, createElement("path", { d: "M2 4h12M4 8h8M6 12h4" }))),
					createElement("span", { className: "dsh-pg-hcount" }, t("dock.title", { n: holds.length })),
					createElement("span", { className: "dsh-pg-hchevron", "aria-hidden": true },
						expanded
							? createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, createElement("path", { d: "M4 6l4 4 4-4" }))
							: createElement("svg", { viewBox: "0 0 16 16", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, createElement("path", { d: "M4 10l4-4 4 4" })))
				),
				expanded &&
					createElement(
						"div",
						{ className: "dsh-pg-hpanel", id: listId },
						holds.length === 0
							? createElement(
									"div",
									{ className: "dsh-pg-hempty" },
									createElement(
										"span",
										{ className: "dsh-pg-hempty-icon", "aria-hidden": true },
										createElement("svg", { viewBox: "0 0 16 16", width: "18", height: "18", fill: "none", stroke: "currentColor", strokeWidth: "1.1", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, createElement("path", { d: "M2 4h12M4 8h8M6 12h4" }))
									),
									createElement("span", null, t("dock.empty"))
							  )
							: createElement("div", { className: "dsh-pg-hlist" }, rows),
						holds.length > 0 &&
							createElement(
								"div",
								{ className: "dsh-pg-hfooter" },
								createElement(
									"button",
									{
										type: "button",
										className: "dsh-pg-hclear",
										onClick: () => {
											writeHolds([]);
											setEditing(null);
											refresh();
										}
									},
									t("dock.clear")
								)
							)
					)
			);
		}
		/** Portal root: renders the gate card and/or toast. (The queue lives in the session dock.) */
		function GatePortal({ ctx, t }) {
			var state = react.useSyncExternalStore(gateStore.subscribe, gateStore.getSnapshot);
			var pending = state.pending;
			var toast = state.toast;
			var sendNow = (mute) => {
				if (pending === null) return;
				consentAndSubmit(ctx, pending.sessionId, mute);
			};
			var waitOffPeak = (mute) => {
				if (pending === null) return;
				deferAndHold(ctx, pending.sessionId, mute);
			};
			var close = () => {
				if (pending === null) return;
				closeGate(pending.sessionId);
			};
			var nodes = [];
			if (pending !== null) {
				nodes.push(createElement(PeakGateCard, { key: "card", t: t, pending: pending, onSendNow: sendNow, onWaitOffPeak: waitOffPeak, onClose: close }));
			}
			if (toast !== null) {
				nodes.push(createElement(ToastBanner, { key: "toast" + toast.at, toast: toast, t: t }));
			}
			return createElement(react.Fragment, null, nodes);
		}
		//#endregion

		//#region apply
		/** Required services (fiber inject waiting — the runtime must be up first). */
		var inject = ["slots", "locale", "sessions", "workspaces"];
		/**
		* Mount the peak gate: submit interception, per-session/per-day consent,
		* deferred auto-send at off-peak, the confirmation card, and a settings row.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-peak-gate: dictionaries");
			injectCss();
			injectSettingsCss();
			var t = ctx.locale.bind(NS);

			// Settings row under General Settings.
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "peak-gate",
				order: 30,
				locale: NS,
				inject: () => ({ settingsStore })
			}, SettingsRow));

			// Pending-send queue window inside the conversation (composer dock).
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "peak-gate-queue",
				order: 20,
				locale: NS,
				inject: () => ({ gateStore, ctx })
			}, HoldQueueDock));

			// Portal container (card + toast).
			var container = document.createElement("div");
			container.dataset.dshPeakGateRoot = "";
			document.body.appendChild(container);
			var root = react_dom_client.createRoot(container);
			root.render(createElement(GatePortal, { ctx: ctx, t: t }));

			// Submit-gesture interception (capture phase on document: runs before React's root handlers).
			var onKeyDown = (event) => {
				var hit = isComposerEnter(event);
				if (hit === false) return;
				var sessionId = currentSessionId(ctx);
				if (sessionId === void 0) return;
				var facts = inputFacts(ctx, sessionId);
				var cmd = facts === null ? null : commandFromDraft(facts.draft);
				if (cmd !== null) {
					// A /peakgate command: run it directly, even with a popup open (the user typed the prefix on purpose).
					event.preventDefault();
					event.stopPropagation();
					var pendingCmd = gateStore.getSnapshot().pending;
					if (pendingCmd !== null) closeGate(pendingCmd.sessionId);
					handleCommand(ctx, sessionId, cmd);
					return;
				}
				if (hasComposerPopup(hit.seat)) return;
				// A confirmation card is already open: swallow every further submit
				// gesture so the composer underneath can never send while the card
				// is up (e.g. a quick double-Enter must not fire the message).
				if (gateStore.getSnapshot().pending !== null) {
					event.preventDefault();
					event.stopPropagation();
					return;
				}
				var gate = shouldIntercept(ctx, now());
				if (gate === void 0) return;
				event.preventDefault();
				event.stopPropagation();
				openGate(gate);
			};
			var onClick = (event) => {
				if (!isComposerSendClick(event)) return;
				var sessionId = currentSessionId(ctx);
				if (sessionId === void 0) return;
				var facts = inputFacts(ctx, sessionId);
				var cmd = facts === null ? null : commandFromDraft(facts.draft);
				if (cmd !== null) {
					event.preventDefault();
					event.stopPropagation();
					var pendingClick = gateStore.getSnapshot().pending;
					if (pendingClick !== null) closeGate(pendingClick.sessionId);
					handleCommand(ctx, sessionId, cmd);
					return;
				}
				if (gateStore.getSnapshot().pending !== null) {
					event.preventDefault();
					event.stopPropagation();
					return;
				}
				var gate = shouldIntercept(ctx, now());
				if (gate === void 0) return;
				event.preventDefault();
				event.stopPropagation();
				openGate(gate);
			};
			document.addEventListener("keydown", onKeyDown, true);
			document.addEventListener("click", onClick, true);

			// Drop a pending gate when the user switches sessions while the card is open.
			var onSessionChange = () => {
				var pending = gateStore.getSnapshot().pending;
				if (pending === null) return;
				var current = currentSessionId(ctx);
				if (current !== pending.sessionId) closeGate(pending.sessionId);
			};
			var unsubscribeSessions = ctx.sessions.list.subscribe(onSessionChange);

			// Deferred-hold sweep: auto-send once off-peak starts (every 15s).
			var sweepTimer = window.setInterval(() => sweepHolds(ctx), 15 * 1000);
			sweepHolds(ctx);

			ctx.effect(() => () => {
				document.removeEventListener("keydown", onKeyDown, true);
				document.removeEventListener("click", onClick, true);
				unsubscribeSessions();
				window.clearInterval(sweepTimer);
				root.unmount();
				container.remove();
			}, "dsh-peak-gate: lifecycle");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** Internal surface for automated tests (pricing clock + schedule math + gate verbs). */
		exports._internals = {
			DEFAULT_SETTINGS,
			parseTime,
			minutesInWindow,
			isPeakAt,
			wallParts,
			nextTransition,
			countdownLabel,
			labelForMinutes,
			now,
			setNow: (date) => {
				_nowOverride = date;
			},
			segmentKey,
			isSegmentMuted,
			muteSegment,
			commandFromDraft,
			handleCommand,
			openQueue,
			closeQueue,
			moveHold,
			editHoldText,
			removeHoldById,
			sendHoldNow,
			HoldQueueDock,
			gateStore,
			openGate,
			closeGate,
			shouldIntercept,
			isComposerEnter,
			hasComposerPopup,
			isComposerSendClick,
			consentAndSubmit,
			deferAndHold,
			readHolds,
			writeHolds,
			dropHold,
			tryAutoSend,
			sweepHolds
		};
		return module.exports;
	}
});
