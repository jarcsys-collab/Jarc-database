// Public board numbers: the short number in a board's link (/boards/100001), shown and shared instead of the board's
// MongoDB _id. The _id stays the board's identity everywhere else (records, permissions, API tokens, the API, caches).
//
//   - allocated once, when the board is created (BoardRepository.insert/insertMany), from one atomic counter
//     (counters._id = "boardPublicId", $inc): two boards created at the same moment never get the same number
//   - never changed (move, rename, archive), never reused after a deletion (the counter only goes up), never chosen by a
//     client (the board validators accept no publicId)
//   - unique in the database (boards index uniq_public_id, partial: boards from before have none until the backfill,
//     scripts/board-public-ids.js)
//   - not a secret and never an authorization: the browser looks a number up only among the boards the server already
//     listed for that person
// Stored as a whole number (well within JavaScript's exact range); in links always plain decimal without leading zeros.
const { COLLECTIONS } = require("../db/bootstrap");

const COUNTER_ID = "boardPublicId";
const BASE = 100000;            // the first board gets 100001
const MAX = 999999999999;       // 12 digits: far beyond any real number of boards, and exact as a JavaScript number
const CANONICAL = /^[1-9][0-9]{0,11}$/;

const isPublicId = (value) => Number.isSafeInteger(value) && value > BASE && value <= MAX;
const isCanonicalText = (text) => typeof text === "string" && CANONICAL.test(text);

// The next number. The counter document is created by the first allocation (upsert); if two first allocations race,
// one of them meets the unique _id and simply tries again.
async function allocateBoardPublicId(db, { attempts = 3 } = {}) {
  const counters = db.collection(COLLECTIONS.counters);
  for (let i = 0; ; i += 1) {
    try {
      const doc = await counters.findOneAndUpdate({ _id: COUNTER_ID }, { $inc: { value: 1 } }, { upsert: true, returnDocument: "after" });
      const value = BASE + Number(doc?.value ?? NaN); // driver 7: the document itself
      if (!isPublicId(value)) throw new Error("The board number counter returned an unusable value.");
      return value;
    } catch (error) {
      if (error?.code === 11000 && i + 1 < attempts) continue;
      throw error;
    }
  }
}
// Makes sure the counter is past every number already in use (the backfill runs this first; harmless to repeat).
async function raiseCounterTo(db, publicId) {
  if (!isPublicId(publicId)) return;
  await db.collection(COLLECTIONS.counters).updateOne({ _id: COUNTER_ID }, { $max: { value: publicId - BASE } }, { upsert: true });
}

module.exports = { COUNTER_ID, BASE, MAX, isPublicId, isCanonicalText, allocateBoardPublicId, raiseCounterTo };
