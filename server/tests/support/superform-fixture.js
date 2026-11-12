// A fictional board and two forms for the guided-form ("SuperForm") tests: generic synthetic IDs, names, labels and values
// only. The board has the same SHAPE as a migrated terms board (statuses, multi-select dropdowns, numbers with "%",
// three Files columns, an empty Pending group first), and the guided form uses every guided-form feature: steps, a review
// step, required and conditional questions, number and length rules, a multi-select picker and a calculation preview.
// GUIDED is exactly what the migration planner produces from tests/support/terms-board-fixture.js (checked by the
// local planner tests), so the app is tested with the definition the migration would create.
const K = Object.freeze({
  name: "serial", itemId: "m_item_id", kind: "m_kind", codes: "m_codes", dueRule: "m_due_rule", pctDown: "m_pct_down", pctBalance: "m_pct_balance", pctMonthly: "m_pct_monthly",
  principal: "m_principal", downAmount: "m_down_amount", monthlyAmount: "m_monthly_amount", frequency: "m_frequency", monthsAhead: "m_months_ahead", daysDue: "m_days_due", daysInterval: "m_days_interval",
  payFrequency: "m_pay_freq", payStart: "m_pay_start", recordStatus: "m_record_status", codeState: "m_code_state", party: "m_party",
  docDeviation: "m_doc_deviation", docAccreditation: "m_doc_accreditation", docCredit: "m_doc_credit", payMode: "m_pay_mode"
});
const BUYER = "BUYER", SELLER = "SELLER";
const pct = (label) => ({ label, type: "number", description: "Unit in monday.com: % (shown after the number). JARC stores the number itself, unchanged." });
const COLUMNS = Object.freeze([
  { key: K.name, label: "Name", type: "text", required: true },
  { key: K.itemId, label: "Item ID", type: "text" },
  { key: K.kind, label: "Party Type", type: "status", options: [BUYER, SELLER], colors: ["#579bfc", "#74afcc"] },
  { key: K.codes, label: "Code", type: "dropdown", multiple: true, options: ["T-01", "T-02", "T-03", "T-30"] },
  { key: K.dueRule, label: "Due Rule", type: "text" },
  { key: K.pctDown, ...pct("% Down") }, { key: K.pctBalance, ...pct("% Balance") }, { key: K.pctMonthly, ...pct("% Monthly") },
  { key: K.principal, label: "Principal", type: "number" }, { key: K.downAmount, label: "Down Amount", type: "number" }, { key: K.monthlyAmount, label: "Monthly Amount", type: "number" },
  { key: K.frequency, label: "Frequency", type: "number" }, { key: K.monthsAhead, label: "Months Ahead", type: "number" }, { key: K.daysDue, label: "Days Due", type: "number" }, { key: K.daysInterval, label: "Days Interval", type: "number" },
  { key: K.payFrequency, label: "Payment Frequency", type: "status", options: ["monthly", "15 days", "10 days", "once"], colors: ["#fdab3d", "#df2f4a", "#007eb5", "#00c875"] },
  { key: K.payStart, label: "Payment Start", type: "number" },
  { key: K.recordStatus, label: "Record Status", type: "status", options: ["Pending", "Rejected", "Done"], colors: ["#fdab3d", "#df2f4a", "#9cd326"] },
  { key: K.codeState, label: "Code State", type: "status", options: ["New", "Revision", "Deviation"], colors: ["#9cd326", "#66ccff", "#fdab3d"] },
  { key: K.party, label: "Party Name", type: "text" },
  { key: K.docDeviation, label: "Deviation Form", type: "files" }, { key: K.docAccreditation, label: "Accreditation", type: "files" }, { key: K.docCredit, label: "Credit Form", type: "files" },
  { key: K.payMode, label: "Mode of Payment", type: "dropdown", multiple: true, options: ["Transfer", "Check", "Card"] },
  { key: "group", label: "Group", type: "group" }
]);
const GROUPS = Object.freeze([{ id: "grp_pending0001", name: "Pending", color: "#00c875" }, { id: "grp_buyer000001", name: "BUYER AGREEMENTS", color: "#fdab3d" }, { id: "grp_seller00001", name: "SELLER AGREEMENTS", color: "#66ccff" }, { id: "grp_revised0001", name: "Revised", color: "#ff642e" }]);
const PENDING = GROUPS[0].id;

const NATIVE = Object.freeze({ name: "New Fictional Agreement", description: "", status: "published", mode: "create", confirmation: "", groupId: PENDING, uniqueKey: null, fields: [{ key: K.name, required: true }, { key: K.kind }, { key: K.dueRule }] });

const COUNT = { min: "0", maxDecimals: 0 }, PCT = { min: "0", max: "100" }, AMOUNT = { min: "0" }, TEXT = { maxLength: 200 };
const note = (n, of, on) => `${n} of ${of} migrated terms follow this${on ? "" : "; off until the business confirms the formula"}. A suggestion only: it never fills in an answer.`;
const GUIDED = Object.freeze({
  name: "Guided Agreement Form", description: "A guided form for new buyer and seller agreements. New agreements are added to the Pending group for review.",
  status: "draft", mode: "create", confirmation: "Thank you. The new agreement was added to Pending.", groupId: PENDING, uniqueKey: null,
  fields: [
    { key: K.name, label: "Agreement name", help: "The agreement's name or code, as it appears on the board.", required: true, section: "classification", validation: TEXT },
    { key: K.kind, help: "Buyer and seller agreements ask for different documents.", required: true, section: "classification" },
    { key: K.party, section: "classification", validation: TEXT },
    { key: K.codes, help: "Choose one or more codes. Search to narrow the list.", section: "classification" },
    { key: K.payMode, help: "Choose one or more.", section: "classification" },
    { key: K.dueRule, section: "payment", placeholder: "e.g. 30D", validation: TEXT },
    { key: K.payFrequency, section: "payment" },
    { key: K.payStart, section: "payment", validation: COUNT }, { key: K.frequency, section: "payment", validation: COUNT }, { key: K.monthsAhead, section: "payment", validation: COUNT },
    { key: K.daysDue, section: "payment", validation: COUNT }, { key: K.daysInterval, section: "payment", validation: COUNT },
    { key: K.principal, section: "financial", validation: AMOUNT }, { key: K.pctDown, section: "financial", suffix: "%", validation: PCT }, { key: K.downAmount, section: "financial", validation: AMOUNT },
    { key: K.pctBalance, section: "financial", suffix: "%", validation: PCT }, { key: K.pctMonthly, section: "financial", suffix: "%", validation: PCT }, { key: K.monthlyAmount, section: "financial", validation: AMOUNT },
    { key: K.docDeviation, section: "documents" },
    { key: K.docAccreditation, showWhen: { key: K.kind, cmp: "equals", values: [SELLER] }, section: "documents" },
    { key: K.docCredit, showWhen: { key: K.kind, cmp: "equals", values: [BUYER] }, section: "documents" }
  ],
  schemaVersion: 2, layout: "wizard",
  sections: [
    { id: "classification", title: "Classification", description: "What kind of agreement this is, and for whom." },
    { id: "payment", title: "Payment terms", description: "When and how often payment is due." },
    { id: "financial", title: "Financial details", description: "Percentages are whole percentages: 4.17 means 4.17 %. Values are kept exactly as typed." },
    { id: "documents", title: "Supporting documents", description: "PDF, JPEG, PNG or WebP, up to 10 MB each. Files are uploaded after the agreement is saved." }
  ],
  review: true,
  calculations: [
    { id: "suggested-balance", label: "Suggested % Balance (100 − % Down)", op: "subtract", args: [{ value: "100" }, { key: K.pctDown }], target: K.pctBalance, enabled: true, note: note(4, 5, true) },
    { id: "down-from-principal", label: "Down Amount (Principal × % Down)", op: "percentOf", args: [{ key: K.principal }, { key: K.pctDown }], target: K.downAmount, enabled: false, note: note(1, 1, false) },
    { id: "monthly-share", label: "% Monthly (% Balance ÷ Frequency)", op: "divide", args: [{ key: K.pctBalance }, { key: K.frequency }], target: K.pctMonthly, enabled: false, note: note(5, 5, false) }
  ]
});
// The definition as sent to the Forms API (no schemaVersion: the server sets it).
const definition = (f, over = {}) => { const out = {}; for (const k of ["name", "description", "status", "mode", "confirmation", "groupId", "uniqueKey", "fields", "layout", "sections", "review", "calculations"]) if (f[k] !== undefined) out[k] = f[k]; return { ...out, ...over }; };

module.exports = { K, BUYER, SELLER, COLUMNS, GROUPS, PENDING, NATIVE, GUIDED, definition, BOARD_NAME: "Fictional Agreements" };
