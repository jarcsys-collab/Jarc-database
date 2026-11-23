// personalViews collection: each person's personal saved views of a board, kept APART from the board document on purpose.
// Board documents hold only shared views, so any code that serves a board — including an older release after a rollback,
// which knows nothing of this collection — can never show someone's personal view to anyone else.
//   { _id: "<boardId>:<userId>", boardId, userId, views: [{ id, name, state, createdAt, legacyId? }], order: [view IDs], updatedAt }
//   order: the person's own order of all the views they see (shared and personal), so their tabs stay as they arranged them.
// Every read and write is by _id (the default index): no extra index is needed. Created on the first personal view.
const COLLECTION = "personalViews";
const keyOf = (boardId, userId) => `${String(boardId)}:${String(userId)}`;

class PersonalViewRepository {
  constructor(db) { this.collection = db.collection(COLLECTION); }
  async get(boardId, userId) { return userId ? this.collection.findOne({ _id: keyOf(boardId, userId) }) : null; }
  // One query for a list of boards (a workspace's board list). → Map(boardId hex → document)
  async forBoards(boardIds, userId) {
    if (!userId || !boardIds.length) return new Map();
    const docs = await this.collection.find({ _id: { $in: boardIds.map((b) => keyOf(b, userId)) } }).toArray();
    return new Map(docs.map((d) => [String(d.boardId), d]));
  }
  async put(boardId, userId, { views, order }, now = new Date()) {
    await this.collection.updateOne({ _id: keyOf(boardId, userId) }, { $set: { boardId, userId, views, order, updatedAt: now } }, { upsert: true });
  }
  // A deleted board takes everyone's personal views of it along (never touches records or shared views).
  async deleteByBoards(boardIds) { if (boardIds.length) await this.collection.deleteMany({ boardId: { $in: boardIds } }); }
}

module.exports = { PersonalViewRepository, PERSONAL_VIEWS_COLLECTION: COLLECTION, personalViewKey: keyOf };
