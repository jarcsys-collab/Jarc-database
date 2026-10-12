// The server's activity stream in isolation (fake log, fake clock): ordering, duplicates, a slow commit that becomes
// visible long after it was written (delivered by the sweep, not lost), replay, and stopping when nobody listens.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { ActivityStream } = require("../src/realtime/activity-stream");

function fakeLog() {
  const docs = [];
  return {
    docs,
    add(at, { loggedAt = at, action = "record.updated" } = {}) { const d = { _id: new ObjectId(), action, workspaceId: null, boardId: null, recordId: null, actorUserId: null, createdAt: new Date(at), loggedAt: new Date(loggedAt) }; docs.push(d); return d; },
    async listSince(since, { limit }) { return docs.filter((d) => d.loggedAt >= since).sort((a, b) => a.loggedAt - b.loggedAt).slice(0, limit); },
    async findById(id) { return docs.find((d) => d._id.equals(id)) || null; },
    async listRecent({ limit }) { return [...docs].sort((a, b) => b.loggedAt - a.loggedAt).slice(0, limit); }
  };
}
function harness() {
  let now = 1_000_000;
  const log = fakeLog();
  const stream = new ActivityStream({ activities: log, now: () => new Date(now), pollMs: 3_600_000, overlapMs: 5000, sweepEveryMs: 15000, sweepWindowMs: 120000, logger: { error() {} } });
  const got = [];
  const unsubscribe = stream.subscribe({ deliver: async (events) => { got.push(...events.map((e) => e.id)); }, close() {} });
  return { log, stream, got, unsubscribe, advance: (ms) => { now += ms; }, get now() { return now; } };
}

describe("Activity stream (server)", () => {
  test("new entries are delivered once, in order, across overlapping reads", async () => {
    const h = harness();
    const a = h.log.add(h.now + 10), b = h.log.add(h.now + 20);
    h.advance(1000); await h.stream.poll(); await h.stream.poll();
    assert.deepEqual(h.got, [a._id.toHexString(), b._id.toHexString()]);
    h.unsubscribe();
  });

  test("SLOW COMMIT: an entry visible only after the read position moved past it is still delivered (by the sweep)", async () => {
    const h = harness();
    const started = h.now + 100;
    h.advance(8000);
    const quick = h.log.add(h.now); // a later change, seen first: moves the read position forward
    await h.stream.poll();
    assert.deepEqual(h.got, [quick._id.toHexString()]);
    h.advance(1000);
    const slow = h.log.add(started, { loggedAt: started }); // written 9 s ago, visible only now
    await h.stream.poll();
    assert.ok(!h.got.includes(slow._id.toHexString()), "outside the normal overlap window");
    h.advance(15000);
    await h.stream.poll(); // the sweep
    assert.ok(h.got.includes(slow._id.toHexString()), "delivered late rather than lost");
    h.advance(15000); await h.stream.poll();
    assert.equal(h.got.filter((id) => id === slow._id.toHexString()).length, 1, "and only once");
    h.unsubscribe();
  });

  test("replay after a reconnect returns what came after the last event; unknown or too-old IDs → null (resync)", async () => {
    const h = harness();
    const first = h.log.add(h.now), second = h.log.add(h.now + 50), third = h.log.add(h.now + 90);
    const replay = await h.stream.replaySince(first._id);
    assert.deepEqual(replay.map((e) => e.id), [second._id.toHexString(), third._id.toHexString()]);
    assert.equal(await h.stream.replaySince(new ObjectId()), null);
    h.advance(25 * 60 * 60 * 1000);
    assert.equal(await h.stream.replaySince(first._id), null, "older than a day");
    assert.equal(await h.stream.latestId(), third._id.toHexString());
    h.unsubscribe();
  });

  test("polling stops when the last listener leaves, and starts afresh for the next", async () => {
    const h = harness();
    assert.ok(h.stream.timer);
    h.unsubscribe();
    assert.equal(h.stream.timer, null);
    assert.equal(h.stream.seen.size, 0);
  });
});
