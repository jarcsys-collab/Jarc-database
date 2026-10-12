// The browser's live-update connection manager (site/assets/LiveUpdates.js) in isolation, with a fake EventSource
// and fake timers: batching, duplicate events, reconnect backoff with resume, session end, offline, and the polling
// fallback when Server-Sent Events are unavailable.
const { test, describe } = require("node:test");
const plain = (v) => JSON.parse(JSON.stringify(v)); // values from the sandbox have its own Array prototype
const tick = () => new Promise((r) => setTimeout(r, 0)); // lets async handlers (e.g. the session check) finish
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");

function load() {
  const listeners = {};
  const window = { addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); } };
  const navigator = { onLine: true };
  const ctx = vm.createContext({ window, navigator, console, Math, JSON, Set, Promise, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", "..", "site", "assets", "LiveUpdates.js"), "utf8"), ctx);
  return { LiveUpdates: window.LiveUpdates, window, navigator, fire: (t) => (listeners[t] || []).forEach((f) => f()) };
}
// Fake timers: run() advances time and fires due callbacks in order.
function fakeTimers() {
  let now = 0, id = 0; const due = new Map();
  const add = (fn, ms, every) => { id += 1; due.set(id, { at: now + ms, fn, every }); return id; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, 0), setInterval: (fn, ms) => add(fn, ms, ms), clearTimeout: (i) => due.delete(i), clearInterval: (i) => due.delete(i),
    async run(ms) { const end = now + ms; for (;;) { const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [i, t] = next; now = t.at; if (t.every) t.at += t.every; else due.delete(i); await t.fn(); await Promise.resolve(); } now = end; },
    pending: () => due.size
  };
}
// Fake EventSource: records URLs; tests emit messages or errors on the latest instance.
function fakeEventSource() {
  const opened = [];
  class FakeES {
    constructor(url) { this.url = url; this.handlers = {}; this.closed = false; opened.push(this); }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    close() { this.closed = true; }
    emit(type, data, lastEventId = "") { (this.handlers[type] || []).forEach((fn) => fn({ data: JSON.stringify(data), lastEventId })); }
    fail() { this.onerror?.(); }
  }
  return { FakeES, opened, latest: () => opened.at(-1) };
}

describe("LiveUpdates (browser connection manager)", () => {
  test("bursts are batched; duplicates are dropped; the state goes live on ready", async () => {
    const { LiveUpdates } = load(); const timers = fakeTimers(); const es = fakeEventSource();
    const batches = [], states = [];
    const live = new LiveUpdates({ EventSourceImpl: es.FakeES, timers, onChanges: (b) => batches.push(b), onState: (s) => states.push(s) }).start();
    es.latest().emit("ready", { lastEventId: null });
    for (const id of ["a1", "a2", "a2", "a3"]) es.latest().emit("change", { id, action: "record.updated" }, id);
    await timers.run(300);
    assert.equal(batches.length, 1, "one batch for the burst");
    assert.deepEqual(plain(batches[0].map((e) => e.id)), ["a1", "a2", "a3"], "a2 once");
    es.latest().emit("change", { id: "a3" }, "a3");
    await timers.run(300);
    assert.equal(batches.length, 1, "a replayed event isn't handled twice");
    assert.equal(states.at(-1), "live");
    live.stop();
  });

  test("reconnects with growing delays and resumes from the last event (or the load start / ready's ID)", async () => {
    const { LiveUpdates } = load(); const timers = fakeTimers(); const es = fakeEventSource();
    const live = new LiveUpdates({ EventSourceImpl: es.FakeES, timers, since: "2026-10-12T00:00:00.000Z", request: async () => ({}) }).start();
    assert.match(es.latest().url, /\/events\?since=2026-10-12/, "first connection replays from when loading began");
    es.latest().emit("ready", { lastEventId: "f0" });
    es.latest().emit("change", { id: "f1" }, "f1");
    es.latest().fail();
    await tick();
    const opened = es.opened.length;
    await timers.run(700); assert.equal(es.opened.length, opened, "not immediately");
    await timers.run(700); assert.equal(es.opened.length, opened + 1, "after about a second");
    assert.match(es.latest().url, /lastEventId=f1/, "resumes after the last event");
    es.latest().fail(); await tick();
    await timers.run(1500); assert.equal(es.opened.length, opened + 1, "second wait is longer");
    await timers.run(1500); assert.equal(es.opened.length, opened + 2);
    live.stop();
    assert.equal(es.latest().closed, true, "stop closes the stream");
    assert.equal(timers.pending(), 0, "no timers left behind");
  });

  test("a session that ended stops everything and tells the app (from the stream, or found after an error)", async () => {
    for (const how of ["stream", "error"]) {
      const { LiveUpdates } = load(); const timers = fakeTimers(); const es = fakeEventSource();
      let ended = 0;
      const request = async () => { const e = new Error("expired"); e.code = "UNAUTHENTICATED"; throw e; };
      const live = new LiveUpdates({ EventSourceImpl: es.FakeES, timers, request, onSessionEnded: () => { ended += 1; } }).start();
      if (how === "stream") es.latest().emit("session-ended", {}); else { es.latest().fail(); await new Promise((r) => setTimeout(r, 0)); }
      assert.equal(ended, 1, how);
      await timers.run(60000);
      assert.equal(es.opened.length, 1, `${how}: no reconnect attempts after the session ended`);
      live.stop();
    }
  });

  test("offline pauses; online reconnects at once", async () => {
    const { LiveUpdates, navigator, fire } = load(); const timers = fakeTimers(); const es = fakeEventSource();
    const states = [];
    const live = new LiveUpdates({ EventSourceImpl: es.FakeES, timers, onState: (s) => states.push(s), request: async () => ({}) }).start();
    es.latest().emit("ready", {});
    navigator.onLine = false; fire("offline");
    assert.equal(states.at(-1), "offline"); assert.equal(es.latest().closed, true);
    navigator.onLine = true; fire("online");
    assert.equal(es.opened.length, 2, "reconnected straight away");
    live.stop();
  });

  test("FALLBACK: without EventSource, or when the stream never opens, the activity log is polled every 20 s", async () => {
    const calls = [];
    const request = async (method, p) => { calls.push(p); return { items: calls.length === 1 ? [{ id: "x1" }] : [{ id: "x2", action: "record.created", createdAt: "t" }, { id: "x1" }] }; };
    const { LiveUpdates } = load(); const timers = fakeTimers();
    const batches = [], states = [];
    const live = new LiveUpdates({ EventSourceImpl: null, timers, request, onChanges: (b) => batches.push(b), onState: (s) => states.push(s) }).start();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(states.at(-1), "polling");
    assert.equal(batches.length, 0, "the first page is what the app already has");
    await timers.run(20300);
    assert.deepEqual(plain(batches.flat().map((e) => e.id)), ["x2"], "only the new entry");
    live.stop();
    // Stream that never opens: after a few failures, polling starts (and the stream keeps being retried).
    const es = fakeEventSource(); const t2 = fakeTimers(); const s2 = [];
    const live2 = new LiveUpdates({ EventSourceImpl: es.FakeES, timers: t2, request: async () => ({ items: [] }), onState: (s) => s2.push(s) }).start();
    for (let i = 0; i < 4; i += 1) { es.latest().fail(); await new Promise((r) => setTimeout(r, 0)); await t2.run(31000); }
    assert.ok(s2.includes("polling"), "fell back to polling");
    live2.stop();
  });
});
