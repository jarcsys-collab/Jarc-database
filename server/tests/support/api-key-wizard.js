// Driving Developer → API Keys → Create API key in the headless browser (tests only). Every step goes through the real
// controls: buttons are clicked and checkboxes toggled, so the app's own click, change and submit handlers run.
const FORM = "#overlay-root form.apikey-wizard";

function wizard(b) {
  const q = JSON.stringify;
  const evaluate = (expr) => b.evaluate(expr);
  const wait = (expr, ms = 8000) => b.waitFor(expr, ms);
  const click = (sel) => evaluate(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return false; el.click(); return true; })()`);
  const step = () => evaluate(`document.querySelector(${q(FORM)})?.dataset.step || null`);
  const api = {
    FORM,
    step,
    async open() {
      if (!(await click('[data-action="apitok-new"]'))) throw new Error("Create API key isn't offered");
      if (!(await wait(`!!document.querySelector(${q(FORM)})`, 3000))) throw new Error("the Create API key window didn't open");
    },
    // Step 1. Only the fields given are changed; then Next.
    async details({ name, description, expires, next = true } = {}) {
      await evaluate(`(() => { const f = document.querySelector(${q(FORM)}); ${name === undefined ? "" : `f.elements.name.value = ${q(name)};`} ${description === undefined ? "" : `f.elements.description.value = ${q(description)};`} ${expires === undefined ? "" : expires === "max" ? "f.elements.expires.value = f.elements.expires.max;" : `f.elements.expires.value = ${q(expires)};`} })()`);
      if (next) await api.next();
    },
    next: () => click(`${FORM} [data-role="next"]`),
    back: () => click(`${FORM} [data-action="apitok-wiz-back"]`),
    cancel: () => click(`${FORM} [data-action="apitok-cancel"]`),
    // From step 1 to the board list, with a name if none was typed.
    async toBoards(name = "Test key") {
      if ((await step()) === "details") {
        const typed = await evaluate(`document.querySelector(${q(FORM)}).elements.name.value`);
        await api.details({ name: typed || name });
      }
      return wait(`document.querySelector(${q(FORM)})?.dataset.step === "boards"`, 3000);
    },
    // The workspace sections are drawn (the list has arrived).
    listed: (ms = 6000) => wait(`!!document.querySelector("#apikey-workspaces .apikey-ws")`, ms),
    workspaceNames: () => evaluate(`[...document.querySelectorAll("#apikey-workspaces .apikey-ws-toggle strong")].map((e) => e.textContent.trim())`),
    expanded: (ws) => evaluate(`document.querySelector('#apikey-workspaces [data-action="apitok-wiz-toggle"][data-ws=${q(ws)}]')?.getAttribute("aria-expanded") === "true"`),
    async expand(ws) { if (!(await api.expanded(ws))) await click(`#apikey-workspaces [data-action="apitok-wiz-toggle"][data-ws="${ws}"]`); },
    async collapse(ws) { if (await api.expanded(ws)) await click(`#apikey-workspaces [data-action="apitok-wiz-toggle"][data-ws="${ws}"]`); },
    boardNames: (ws) => evaluate(`[...document.querySelectorAll('#apikey-workspaces input[data-action="apitok-wiz-board"][data-ws=${q(ws)}]')].map((i) => i.closest("label").textContent.trim())`),
    boardValues: (ws) => evaluate(`[...document.querySelectorAll('#apikey-workspaces input[data-action="apitok-wiz-board"]${ws ? `[data-ws=${q(ws)}]` : ""}')].map((i) => i.value)`),
    checked: () => evaluate(`[...document.querySelectorAll('#apikey-workspaces input[data-action="apitok-wiz-board"]:checked')].map((i) => i.value)`),
    // Ticks (or unticks) a board, expanding its workspace first when it isn't drawn.
    async tick(boardId, ws) {
      if (ws) await api.expand(ws);
      const sel = `#apikey-workspaces input[data-action="apitok-wiz-board"][value="${boardId}"]`;
      if (!(await click(sel))) throw new Error(`board ${boardId} isn't listed`);
    },
    selectAll: (ws) => click(`#apikey-workspaces input[data-action="apitok-wiz-all"][value="${ws}"]`),
    search: (text) => evaluate(`(() => { const i = document.querySelector('${FORM} [data-action="apitok-wiz-search"]'); i.focus(); i.value = ${q(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`),
    // The search is applied after a short pause, as typing would be.
    settle: () => new Promise((resolve) => setTimeout(resolve, 260)),
    count: () => evaluate(`document.querySelector("#apikey-count")?.textContent || ""`),
    // Step 3: tick the confirmation, then Create. clicks: how many times Create is clicked at once.
    async create({ clicks = 1 } = {}) {
      if ((await step()) === "boards") await api.next();
      if (!(await wait(`document.querySelector(${q(FORM)})?.dataset.step === "review"`, 3000))) throw new Error("the review didn't open");
      await click(`${FORM} input[data-action="apitok-wiz-confirm"]`);
      await evaluate(`(() => { const b = document.querySelector('${FORM} [data-role="create"]'); for (let i = 0; i < ${clicks}; i++) b.click(); })()`);
      if (!(await wait("!!document.querySelector('#apitok-secret')", 8000))) throw new Error("the new key wasn't shown");
      return evaluate("document.querySelector('#apitok-secret').value");
    }
  };
  return api;
}

module.exports = { wizard, WIZARD_FORM: FORM };
