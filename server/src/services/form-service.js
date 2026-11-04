// Native forms (domain/form.js). A submission is an ordinary record change made by the signed-in person: it goes through the
// record service, so column validation, version checks, People rules, activity and search all apply as usual.
//
//   duplicates  each submission carries a key made by the browser for one attempt: the same attempt sent twice creates one
//               record. uniqueKey additionally refuses a value another active record already has.
//   audit       formSubmissions records who submitted which form, when, and the resulting record (never the values);
//               an activity entry is written too.
const { ObjectId } = require("mongodb");
const { ApiError } = require("../middleware/errors");
const { fail, requireBody, allowOnly, version } = require("../validation/common");
const { COLLECTIONS } = require("../db/bootstrap");
const { cleanForm, submittedValues } = require("../domain/form");
const { notFound, conflict, activityEntry, appendActivity } = require("./shared");

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FORMS_PER_BOARD = 50;

class FormService {
  constructor({ repos, connection, logger, records }) {
    Object.assign(this, { repos, connection, logger, records });
    this.forms = connection.db.collection(COLLECTIONS.forms);
    this.submissions = connection.db.collection(COLLECTIONS.formSubmissions);
  }

  list(boardId) { return this.forms.find({ boardId }, { sort: { name: 1, _id: 1 }, limit: MAX_FORMS_PER_BOARD }).toArray(); }
  find(id) { return this.forms.findOne({ _id: id }); }

  async create(board, raw, actor) {
    if (board.source?.readOnly) throw new ApiError(403, "READ_ONLY_BOARD", "This board is synchronized from monday.com and is read-only in JARC.");
    const definition = cleanForm(raw, board);
    if (await this.forms.countDocuments({ boardId: board._id }) >= MAX_FORMS_PER_BOARD) throw new ApiError(409, "TOO_MANY_FORMS", `A board can have at most ${MAX_FORMS_PER_BOARD} forms.`);
    const now = new Date(), doc = { _id: new ObjectId(), workspaceId: board.workspaceId, boardId: board._id, ...definition, createdBy: actor.userId, updatedBy: actor.userId, createdAt: now, updatedAt: now, version: 1 };
    await this.forms.insertOne(doc);
    await this.log(board, actor, "form.created", doc, `Created form ${doc.name}`);
    return doc;
  }

  async update(form, board, raw, actor) {
    const body = requireBody(raw), expectedVersion = version(body.expectedVersion), definition = cleanForm(raw, board), now = new Date();
    const updated = await this.forms.findOneAndUpdate({ _id: form._id, version: expectedVersion }, { $set: { ...definition, updatedBy: actor.userId, updatedAt: now }, $inc: { version: 1 } }, { returnDocument: "after" });
    if (!updated) throw conflict("form", form);
    await this.log(board, actor, "form.updated", updated, `Updated form ${updated.name}`);
    return updated;
  }

  async remove(form, board, expectedVersion, actor) {
    const { deletedCount } = await this.forms.deleteOne({ _id: form._id, version: expectedVersion });
    if (!deletedCount) throw conflict("form", form);
    await this.log(board, actor, "form.deleted", form, `Deleted form ${form.name}`);
  }

  log(board, actor, action, form, summary) {
    return appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId: board._id, actorUserId: actor.userId, actorName: actor.displayName, action, entityType: "form", entityId: form._id, summary, now: new Date() }));
  }

  // → { record, confirmation, repeated }. Repeating an attempt returns its first result and changes nothing.
  async submit(form, board, raw, actor, people) {
    if (form.status !== "published") throw new ApiError(409, "FORM_NOT_PUBLISHED", "This form isn't published.");
    if (board.source?.readOnly) throw new ApiError(403, "READ_ONLY_BOARD", "This board is synchronized from monday.com and is read-only in JARC.");
    const body = requireBody(raw);
    allowOnly(body, ["submissionKey", "values", "recordId", "expectedVersion"], "the submission");
    if (typeof body.submissionKey !== "string" || !KEY.test(body.submissionKey)) fail("submissionKey must be a UUID.");
    const { values, missing } = submittedValues(form, board, body.values ?? {});
    if (missing.length) throw new ApiError(400, "VALIDATION_ERROR", `Please answer: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}.`, { missing });
    if (form.mode === "update") { if (typeof body.recordId !== "string" || !/^[0-9a-f]{24}$/.test(body.recordId)) fail("recordId must be a record ID."); }
    else if (body.recordId !== undefined) fail("This form creates records; it can't take a recordId.");
    // One attempt, once. The reservation is unique per form and key.
    const now = new Date(), submissionKey = body.submissionKey.toLowerCase();
    try { await this.submissions.insertOne({ _id: new ObjectId(), formId: form._id, boardId: board._id, workspaceId: board.workspaceId, submissionKey, userId: actor.userId, recordId: null, status: "pending", createdAt: now }); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      const earlier = await this.submissions.findOne({ formId: form._id, submissionKey });
      if (!earlier || !earlier.userId.equals(actor.userId)) throw new ApiError(409, "DUPLICATE_SUBMISSION", "This submission was already used.");
      if (earlier.status !== "done" || !earlier.recordId) throw new ApiError(409, "SUBMISSION_IN_PROGRESS", "This submission is still being saved. Try again in a moment.");
      const record = await this.repos.records.findById(earlier.recordId);
      if (!record) throw notFound("record");
      return { record, confirmation: form.confirmation, repeated: true };
    }
    let record;
    try {
      if (form.uniqueKey && values[form.uniqueKey] !== undefined) {
        const same = await this.repos.records.collection.findOne({ boardId: board._id, archived: false, [`values.${form.uniqueKey}`]: values[form.uniqueKey], ...(form.mode === "update" ? { _id: { $ne: new ObjectId(body.recordId) } } : {}) }, { projection: { _id: 1 } });
        if (same) throw new ApiError(409, "DUPLICATE_RECORD", "A record with this value already exists.", { field: form.uniqueKey });
      }
      if (form.mode === "update") {
        const existing = await this.repos.records.findById(new ObjectId(body.recordId));
        if (!existing || !existing.boardId.equals(board._id)) throw notFound("record");
        record = await this.records.update(existing._id, { expectedVersion: body.expectedVersion, values }, actor, people);
      } else {
        record = await this.records.create(board._id, { values, ...(form.groupId ? { groupId: form.groupId } : {}) }, actor, people);
      }
    } catch (error) {
      await this.submissions.deleteOne({ formId: form._id, submissionKey }).catch(() => {}); // a refused attempt can be corrected and sent again
      throw error;
    }
    // The record exists from here on, so the reservation stays even if this bookkeeping fails: a retry must not make a second record.
    await this.submissions.updateOne({ formId: form._id, submissionKey }, { $set: { status: "done", recordId: record._id, finishedAt: new Date() } });
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId: board._id, recordId: record._id, actorUserId: actor.userId, actorName: actor.displayName, action: "form.submitted", entityType: "form", entityId: form._id, summary: `Submitted form ${form.name}`, now: new Date() }));
    return { record, confirmation: form.confirmation, repeated: false };
  }
}

module.exports = { FormService, MAX_FORMS_PER_BOARD };
