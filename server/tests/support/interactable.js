// Shared "is this control really usable?" check for acceptance scripts and browser tests (TEST/ACCEPTANCE TOOLING ONLY,
// never loaded by the app). Existence in the DOM is not enough: a control can be rendered at 0 px, sit under a sticky
// column, be clipped by its scroll container, or be unfocusable. For one selector, the in-page function checks:
//   visible   computed display/visibility/opacity on the element and every ancestor (and Element.checkVisibility), not inert
//   size      a non-zero rendered box (optionally at least minWidth/minHeight)
//   viewport  inside the viewport; if not, its scroll containers are scrolled (scrollIntoView, centre) and it is checked again
//   clipped   not cut off by an ancestor with overflow other than visible (the box must fit that ancestor's client area)
//   obstructed document.elementFromPoint at the centre and four inset corners returns the element or a descendant
//              (detects sticky columns/headers, overlays and toasts drawn over it)
//   pointer   pointer-events is not none
//   focus     keyboard focusable (native control, or tabIndex >= 0; not disabled) and really receives focus
// verifyControl() can then do a REAL pointer click through the DevTools protocol (Input.dispatchMouseEvent at the computed
// centre, or a touch tap), wait for an expected effect (e.g. a popover opens), and close it again with a real Escape key.
// Only flags, sizes and class names are returned: no page text.
//
// The canonical copy is scratchpad/accept-lib/interactable.js; server/tests/support/interactable.js is the identical copy
// the committed browser tests use.

/* eslint-disable no-undef */
// Runs IN THE PAGE (serialised with toString): keep it self-contained.
async function interactableInPage(selector, options) {
  const o = Object.assign({ scroll: true, focus: true, block: "center", inline: "center", index: 0, pick: "first", minWidth: 1, minHeight: 1, tolerance: 1 }, options || {});
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const desc = (n) => (n && n.nodeType === 1 ? (n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/).slice(0, 3).join(".") : "") + (n.dataset && n.dataset.action ? "[" + n.dataset.action + "]" : "")) : String(n));
  const all = [...document.querySelectorAll(selector)];
  const el = o.pick === "last" ? all[all.length - 1] : all[o.index || 0];
  const out = { selector, found: !!el, count: all.length, ok: false, reasons: [] };
  if (!el) { out.reasons.push("missing"); return out; }
  out.element = desc(el);

  const visibility = () => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none") return "display:none on " + desc(n);
      if (parseFloat(cs.opacity) === 0) return "opacity:0 on " + desc(n);
      if (n.hasAttribute("inert")) return "inert " + desc(n);
      if (cs.contentVisibility === "hidden" && n !== el) return "content-visibility:hidden on " + desc(n);
    }
    const own = getComputedStyle(el);
    if (own.visibility !== "visible") return "visibility:" + own.visibility;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return "checkVisibility false";
    return null;
  };
  const overflowAncestors = () => {
    const list = [];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") list.push(n);
    }
    return list;
  };
  const geometry = () => {
    const r = el.getBoundingClientRect(), t = o.tolerance;
    const g = { rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } };
    g.sized = r.width >= o.minWidth && r.height >= o.minHeight;
    g.inViewport = r.left >= -t && r.top >= -t && r.right <= innerWidth + t && r.bottom <= innerHeight + t;
    g.clippedBy = null;
    for (const a of overflowAncestors()) {
      const ar = a.getBoundingClientRect(), left = ar.left + a.clientLeft, top = ar.top + a.clientTop;
      const cs = getComputedStyle(a), clipX = cs.overflowX !== "visible", clipY = cs.overflowY !== "visible";
      const inside = (!clipX || (r.left >= left - t && r.right <= left + a.clientWidth + t)) && (!clipY || (r.top >= top - t && r.bottom <= top + a.clientHeight + t));
      if (!inside) { g.clippedBy = desc(a); break; }
    }
    return { g, r };
  };
  const hitTest = (r) => {
    // Corners are inset past a rounded corner's curve (0.3 x radius covers a quarter circle), so a round button isn't
    // reported as covered by its own parent.
    const cs = getComputedStyle(el), side = Math.min(r.width, r.height);
    const radius = Math.max(...["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"].map((k) => { const v = cs[k] || "0"; return v.includes("%") ? (parseFloat(v) / 100) * side : parseFloat(v) || 0; }));
    const inset = Math.max(3, 0.3 * radius + 1), ix = Math.min(inset, r.width / 4), iy = Math.min(inset, r.height / 4);
    const points = { centre: [r.left + r.width / 2, r.top + r.height / 2], topLeft: [r.left + ix, r.top + iy], topRight: [r.right - ix, r.top + iy], bottomLeft: [r.left + ix, r.bottom - iy], bottomRight: [r.right - ix, r.bottom - iy] };
    const res = { clear: true, blocked: {} };
    for (const [name, [x, y]] of Object.entries(points)) {
      const hit = document.elementFromPoint(x, y);
      if (!(hit === el || (hit && el.contains(hit)))) {
        res.clear = false;
        res.blocked[name] = hit ? desc(hit) + (getComputedStyle(hit.closest("th,td") || hit).position === "sticky" ? " (sticky)" : "") : "nothing (outside the viewport)";
      }
    }
    return res;
  };

  out.hiddenBy = visibility();
  if (out.hiddenBy) out.reasons.push("not visible: " + out.hiddenBy);
  let { g, r } = geometry();
  let hits = g.sized ? hitTest(r) : { clear: false, blocked: {} };
  out.scrolled = false;
  if (o.scroll && !out.hiddenBy && g.sized && (!g.inViewport || g.clippedBy || !hits.clear)) {
    el.scrollIntoView({ block: o.block, inline: o.inline, behavior: "instant" });
    await frame();
    out.scrolled = true;
    ({ g, r } = geometry());
    hits = hitTest(r);
  }
  Object.assign(out, { rect: g.rect, sized: g.sized, inViewport: g.inViewport, clippedBy: g.clippedBy, obstructed: !hits.clear, blockedAt: hits.blocked });
  out.center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  out.pointerEvents = getComputedStyle(el).pointerEvents;
  if (!g.sized) out.reasons.push("zero or too small size " + g.rect.width + "x" + g.rect.height);
  if (!g.inViewport) out.reasons.push("outside the viewport");
  if (g.clippedBy) out.reasons.push("clipped by " + g.clippedBy);
  if (g.sized && !hits.clear) out.reasons.push("obstructed: " + JSON.stringify(hits.blocked));
  if (out.pointerEvents === "none") out.reasons.push("pointer-events:none");

  const native = /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || (el.tagName === "A" && el.hasAttribute("href"));
  out.disabled = !!(el.disabled || el.getAttribute("aria-disabled") === "true");
  out.focusable = !out.disabled && (native || el.tabIndex >= 0) && el.tabIndex >= 0;
  out.focused = false;
  if (o.focus) {
    if (!out.focusable) out.reasons.push(out.disabled ? "disabled" : "not keyboard focusable");
    else {
      const before = document.activeElement;
      el.focus({ preventScroll: true });
      out.focused = document.activeElement === el;
      if (!out.focused) out.reasons.push("does not receive focus");
      if (before && before !== el && typeof before.focus === "function" && before !== document.body) before.focus({ preventScroll: true }); else el.blur();
    }
  }
  out.ok = out.reasons.length === 0;
  return out;
}

const INTERACTABLE_FN = interactableInPage.toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// expression for Runtime.evaluate (awaitPromise: true, returnByValue: true)
const interactableExpression = (selector, options = {}) => `(${INTERACTABLE_FN})(${JSON.stringify(selector)}, ${JSON.stringify(options)})`;

// page: { evaluate(expr) -> value, send(method, params) -> CDP answer }. Works with tests/support/headless-browser.js (b) and
// with the acceptance scripts' { ev, send } (pass { evaluate: ev, send }).
async function checkInteractable(page, selector, options = {}) { return page.evaluate(interactableExpression(selector, options)); }

// A real pointer click: the browser hit-tests the point itself, so a covered control gets no click.
async function realClick(page, x, y) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}
async function realTap(page, x, y) {
  await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function realKey(page, key = "Escape") {
  const codes = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: codes[key] || 0 });
}
async function waitTrue(page, expression, ms) {
  const end = Date.now() + ms;
  for (;;) { let v = false; try { v = await page.evaluate(expression); } catch { v = false; } if (v === true) return true; if (Date.now() > end) return false; await sleep(60); }
}

// The full check, then (optionally) a real click/tap at the centre, the expected effect, and a real Escape that must undo it.
//   options: everything checkInteractable takes, plus
//     click: true | "touch"     expect: JS expression true once the click worked (e.g. "!!document.querySelector('.column-picker')")
//     closeWith: "Escape" | null   closed: expression true once closed (default: !(expect))   timeout: ms (default 4000)
//     hover: true | "<ancestor selector>"   a real pointer move over it first (for controls shown on hover)
async function verifyControl(page, selector, options = {}) {
  const { click = false, expect = null, closeWith = "Escape", closed = null, timeout = 4000, hover = null, ...checkOptions } = options;
  // hover: true (or a selector of the element to hover, e.g. its header cell): controls that only show on hover get a real
  // pointer move over them first, as a user's mouse would.
  if (hover) {
    const at = await page.evaluate(`(async () => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${Number(checkOptions.index || 0)}]; if (!el) return null;
      const target = ${hover === true ? "el" : `el.closest(${JSON.stringify(hover)}) || el`}; el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const r = target.getBoundingClientRect(), e = el.getBoundingClientRect();
      return { x: ${hover === true ? "e.left + e.width / 2" : "Math.min(Math.max(e.left + e.width / 2, r.left + 1), r.right - 1)"}, y: ${hover === true ? "e.top + e.height / 2" : "Math.min(Math.max(e.top + e.height / 2, r.top + 1), r.bottom - 1)"} }; })()`);
    if (at) { await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" }); await sleep(200); }
  }
  const r = await checkInteractable(page, selector, checkOptions);
  if (!click) return r;
  r.clicked = false; r.effect = null; r.closed = null;
  if (!r.found || !r.sized) { r.ok = false; return r; }
  if (click === "touch") await realTap(page, r.center.x, r.center.y); else await realClick(page, r.center.x, r.center.y);
  r.clicked = true;
  if (expect) { r.effect = await waitTrue(page, expect, timeout); if (!r.effect) r.reasons.push("the click had no effect"); }
  if (expect && closeWith) {
    await realKey(page, closeWith);
    r.closed = await waitTrue(page, closed || `!(${expect})`, timeout);
    if (!r.closed) r.reasons.push(`${closeWith} did not close it`);
  }
  r.ok = r.reasons.length === 0;
  return r;
}
// One line for logs: flags only.
const summary = (r) => ({ ok: r.ok, found: r.found, count: r.count, sized: r.sized, inViewport: r.inViewport, clippedBy: r.clippedBy || null, obstructed: r.obstructed, focusable: r.focusable, focused: r.focused, scrolled: r.scrolled, ...(r.clicked !== undefined ? { clicked: r.clicked, effect: r.effect, closed: r.closed } : {}), ...(r.reasons.length ? { reasons: r.reasons } : {}) });

module.exports = { INTERACTABLE_FN, interactableExpression, checkInteractable, verifyControl, realClick, realTap, realKey, waitTrue, summary };
