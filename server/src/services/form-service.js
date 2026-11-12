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
const rules = require("../domain/form-rules");

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
    allowOnly(body, ["submissionKey", "values", "recordId", "expectedVersion", "files"], "the submission");
    if (typeof body.submissionKey !== "string" || !KEY.test(body.submissionKey)) fail("submissionKey must be a UUID.");
    const { values, missing } = submittedValues(form, board, body.values ?? {}, { files: body.files });
    if (missing.length) throw new ApiError(400, "VALIDATION_ERROR", `Please answer: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}.`, { missing });
    if (form.mode === "update") { if (typeof body.recordId !== "string" || !/^[0-9a-f]{24}$/.test(body.recordId)) fail("recordId must be a record ID."); }
    else if (body.recordId !== undefined) fail("This form creates records; it can't take a recordId.");
    // One attempt, once. The reservation is unique per form and key.
    const now = new Date(), submissionKey = body.submissionKey.toLowerCase();
    // expectedFiles: how many files the person said they would upload per question (audit; the uploads follow).
    const expectedFiles = body.files && Object.keys(body.files).length ? { ...body.files } : undefined;
    try { await this.submissions.insertOne({ _id: new ObjectId(), formId: form._id, formVersion: form.version, boardId: board._id, workspaceId: board.workspaceId, submissionKey, userId: actor.userId, recordId: null, status: "pending", ...(expectedFiles ? { expectedFiles } : {}), createdAt: now }); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      const earlier = await this.submissions.findOne({ formId: form._id, submissionKey });
      if (!earlier || !earlier.userId.equals(actor.userId)) throw new ApiError(409, "DUPLICATE_SUBMISSION", "This submission was already used.");
      // The record exists once recordId is set (status done, awaiting-files or incomplete): the same attempt returns it.
      if (!earlier.recordId) throw new ApiError(409, "SUBMISSION_IN_PROGRESS", "This submission is still being saved. Try again in a moment.");
      const record = await this.repos.records.findById(earlier.recordId);
      if (!record) throw notFound("record");
      return { record, confirmation: form.confirmation, repeated: true, submission: { key: submissionKey, status: earlier.status } };
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
    // With documents announced, the submission isn't done until the server has seen them (completeFiles).
    const status = expectedFiles ? "awaiting-files" : "done";
    await this.submissions.updateOne({ formId: form._id, submissionKey }, { $set: { status, recordId: record._id, finishedAt: new Date() } });
    const docs = expectedFiles ? Object.values(expectedFiles).reduce((s, n) => s + n, 0) : 0;
    await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId: board._id, recordId: record._id, actorUserId: actor.userId, actorName: actor.displayName, action: "form.submitted", entityType: "form", entityId: form._id, summary: `Submitted form ${form.name}${docs ? ` (${docs} document${docs === 1 ? "" : "s"} to attach)` : ""}`, now: new Date() }));
    return { record, confirmation: form.confirmation, repeated: false, submission: { key: submissionKey, status } };
  }

  // Documents of a submission, as the SERVER sees them: the ready attachments on the submission's record, in the form's
  // Files questions, uploaded by the submitter after the submission started (through the usual upload route, which
  // validated each file). Nothing the browser reports is taken as proof. The submission becomes "done" only when every
  // announced document is there and every required document question that applies has one; otherwise "incomplete".
  // Repeatable: after a retried upload it is simply checked again. → { status, files: [{ key, label, expected, uploaded }], missing }
  async completeFiles(form, board, rawKey, actor) {
    if (typeof rawKey !== "string" || !KEY.test(rawKey)) fail("The submission key must be a UUID.");
    const submissionKey = rawKey.toLowerCase();
    const sub = await this.submissions.findOne({ formId: form._id, submissionKey });
    // Someone else's submission is answered like a missing one: nothing about it is revealed.
    if (!sub || !sub.userId.equals(actor.userId)) throw new ApiError(404, "NOT_FOUND", "This submission doesn't exist.");
    if (!sub.recordId) throw new ApiError(409, "SUBMISSION_IN_PROGRESS", "This submission is still being saved. Try again in a moment.");
    const record = await this.repos.records.findById(sub.recordId);
    if (!record || !record.boardId.equals(board._id)) throw notFound("record");
    const byKey = new Map(board.columns.map((c) => [c.key, c]));
    const fileFields = form.fields.filter((f) => byKey.get(f.key)?.type === "files");
    const counts = {};
    if (fileFields.length) {
      const found = await this.repos.attachments.find({ recordId: record._id, columnKey: { $in: fileFields.map((f) => f.key) }, status: "ready", uploadedBy: actor.userId, createdAt: { $gte: sub.createdAt } }, { limit: 1000 });
      for (const a of found) counts[a.columnKey] = (counts[a.columnKey] || 0) + 1;
    }
    const expected = sub.expectedFiles || {}, values = record.values || {};
    const files = fileFields.map((f) => ({ key: f.key, label: f.label || byKey.get(f.key).label, expected: expected[f.key] || 0, uploaded: counts[f.key] || 0 }));
    const missing = files.filter((x) => x.uploaded < x.expected || (x.uploaded === 0 && rules.isRequired(form.fields.find((f) => f.key === x.key), form, values))).map((x) => x.label);
    const status = missing.length ? "incomplete" : "done";
    const changed = sub.status !== status || JSON.stringify(sub.verifiedFiles || {}) !== JSON.stringify(counts);
    if (changed) {
      await this.submissions.updateOne({ _id: sub._id }, { $set: { status, verifiedFiles: counts, verifiedAt: new Date() } });
      const got = files.reduce((s, x) => s + Math.min(x.uploaded, x.expected || x.uploaded), 0), want = files.reduce((s, x) => s + x.expected, 0);
      await appendActivity(this.repos.activities, this.logger, activityEntry({ workspaceId: board.workspaceId, boardId: board._id, recordId: record._id, actorUserId: actor.userId, actorName: actor.displayName, action: status === "done" ? "form.documents.complete" : "form.documents.incomplete", entityType: "form", entityId: form._id, summary: status === "done" ? `Documents for form ${form.name}: all ${want} attached` : `Documents for form ${form.name}: ${got} of ${want} attached; missing ${missing.join(", ")}`, now: new Date() }));
    }
    return { status, files, missing, recordId: record._id };
  }
}

module.exports = { FormService, MAX_FORMS_PER_BOARD };
