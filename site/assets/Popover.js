// Shared anchored popover (Column System R0), promoted from FabricColumnMenu.place() and its layer lifecycle. One module for
// the Add column picker, header menus, column settings and, later, cell pickers. Browser script (window.Popover); the pure
// placement maths is also exported for Node tests (module.exports).
//
//   Popover.open({ anchor, content, placement, label, onClose, sheetBelow }) → { el, close(), reposition() }
//     anchor      an Element, or a point { x, y } (a right-click)
//     content     an Element, moved into the popover
//     placement   "bottom-start" (default) | "bottom-end" | "right-start"; flips to the other side when there is more room
//                 there, and shifts to stay inside the viewport (8 px margin)
//     label       the dialog's accessible name (role="dialog", aria-label)
//     onClose     called once with the reason: "escape" | "outside" | "close" | "anchor-removed"
//     sheetBelow  viewport width (px) under which it is a bottom sheet with a backdrop (default 640)
//   Escape and a pointer outside close it (the top one only when popovers are stacked: one opened from inside another stays
//   with its parent); Tab stays inside; focus returns to the anchor when it was inside the popover. It follows the anchor on
//   scroll and resize, and closes when the anchor leaves the page. Colours come from the app's CSS variables (light and
//   dark); no animation under prefers-reduced-motion.
//   Popover.place(anchorRect, size, viewport, placement, { sheetBelow }) → { left, top, width, maxHeight, sheet, side } (pure)
//   Popover.position(el, anchor, { placement }) places an existing fixed element once (no lifecycle).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Popover = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MARGIN = 8, GAP = 4, SHEET_BELOW = 640, MIN_HEIGHT = 120;
  const PLACEMENTS = Object.freeze(["bottom-start", "bottom-end", "right-start"]);
  const stack = [];

  // ---- Placement (pure) ----------------------------------------------------------------------------------------------
  function rectOf(anchor) {
    if (!anchor) return { left: 0, right: 0, top: 0, bottom: 0 };
    if (typeof anchor.getBoundingClientRect === "function") { const r = anchor.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }
    if (Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const left = anchor.left ?? 0, top = anchor.top ?? 0;
    return { left, right: anchor.right ?? left, top, bottom: anchor.bottom ?? top };
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  function place(anchor, size, viewport, placement = "bottom-start", { sheetBelow = SHEET_BELOW } = {}) {
    const a = rectOf(anchor), vw = Math.max(0, viewport?.width || 0), vh = Math.max(0, viewport?.height || 0);
    const w = Math.max(0, size?.width || 0), h = Math.max(0, size?.height || 0), m = MARGIN;
    const fullHeight = Math.max(0, vh - 2 * m);
    if (vw < sheetBelow) {
      const maxHeight = Math.max(0, Math.floor(vh * 0.85));
      return { left: 0, top: Math.round(Math.max(0, vh - Math.min(h, maxHeight))), width: Math.round(vw), maxHeight, sheet: true, side: "sheet" };
    }
    const width = Math.min(w, Math.max(0, vw - 2 * m));
    const p = PLACEMENTS.includes(placement) ? placement : "bottom-start";
    if (p === "right-start") {
      const right = vw - m - (a.right + GAP), leftRoom = a.left - GAP - m;
      const flip = width > right && leftRoom > right;
      let left = flip ? a.left - GAP - width : a.right + GAP;
      left = clamp(left, m, vw - m - width);
      const maxHeight = Math.max(Math.min(MIN_HEIGHT, fullHeight), fullHeight);
      const top = clamp(a.top, m, vh - m - Math.min(h, maxHeight));
      return { left: Math.round(left), top: Math.round(top), width: Math.round(width), maxHeight, sheet: false, side: flip ? "left" : "right" };
    }
    let left = p === "bottom-end" ? a.right - width : a.left;
    // Near an edge, align to the anchor's other edge first (as FabricColumnMenu.place), then shift inside the viewport.
    if (p === "bottom-start" && left + width > vw - m && a.right - width >= m) left = a.right - width;
    if (p === "bottom-end" && left < m && a.left + width <= vw - m) left = a.left;
    left = clamp(left, m, vw - m - width);
    const below = vh - m - (a.bottom + GAP), above = a.top - GAP - m;
    const up = h > below && above > below;
    const maxHeight = Math.min(fullHeight, Math.max(Math.min(MIN_HEIGHT, fullHeight), Math.floor(up ? above : below)));
    let top = up ? a.top - GAP - Math.min(h, maxHeight) : a.bottom + GAP;
    top = clamp(top, m, vh - m - Math.min(h, maxHeight));
    return { left: Math.round(left), top: Math.round(top), width: Math.round(width), maxHeight, sheet: false, side: up ? "top" : "bottom" };
  }
  function viewport() {
    const w = typeof window !== "undefined" ? window : {}, d = typeof document !== "undefined" ? document.documentElement : null;
    return { width: w.visualViewport?.width || w.innerWidth || d?.clientWidth || 1024, height: w.visualViewport?.height || w.innerHeight || d?.clientHeight || 768 };
  }

  // ---- Styles (injected once; colours from the app's theme variables) --------------------------------------------------
  const CSS_TEXT = `
.jarc-popover-layer{position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:75}
.jarc-popover{position:fixed;box-sizing:border-box;display:flex;flex-direction:column;overflow:auto;overscroll-behavior:contain;min-width:200px;max-width:calc(100vw - 16px);background:var(--surface,#fff);color:var(--text,#172033);border:1px solid var(--line,#d9dee7);border-radius:10px;box-shadow:var(--shadow-popover,var(--shadow,0 12px 32px rgba(16,24,40,.18)));outline:none}
.jarc-popover:focus-visible{box-shadow:0 0 0 2px var(--ring,#2563eb),var(--shadow-popover,var(--shadow,0 12px 32px rgba(16,24,40,.18)))}
.jarc-popover.is-sheet{left:0;right:0;bottom:0;top:auto;width:100%;max-width:100%;min-width:0;border-radius:14px 14px 0 0;border-bottom:0;padding-bottom:env(safe-area-inset-bottom,0)}
.jarc-popover.is-sheet::before{content:"";display:block;flex:none;width:36px;height:4px;margin:8px auto 4px;border-radius:2px;background:var(--line-strong,var(--line,#c3cad6))}
.jarc-popover-backdrop{position:fixed;inset:0;background:rgba(8,13,22,.44)}
@media (prefers-reduced-motion:no-preference){.jarc-popover{animation:jarc-popover-in .12s ease-out}.jarc-popover.is-sheet{animation:jarc-popover-sheet .18s ease-out}.jarc-popover-backdrop{animation:jarc-popover-fade .15s ease-out}}
@keyframes jarc-popover-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
@keyframes jarc-popover-sheet{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}}
@keyframes jarc-popover-fade{from{opacity:0}to{opacity:1}}`;
  function injectStyles() {
    if (typeof document === "undefined" || document.getElementById?.("jarc-popover-styles")) return;
    const style = document.createElement("style");
    style.id = "jarc-popover-styles";
    style.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- Focus helpers -------------------------------------------------------------------------------------------------
  const FOCUSABLE = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  const focusables = (el) => [...el.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden && !n.closest("[hidden],[inert]") && (n.offsetParent !== null || n.getClientRects?.().length));
  const focus = (el) => { try { el?.focus?.({ preventScroll: true }); } catch { /* not focusable */ } };
  const isElement = (x) => Boolean(x) && typeof x === "object" && x.nodeType === 1;

  // ---- Document listeners (one set, shared by the stack) ---------------------------------------------------------------
  let listening = false;
  const top = () => stack[stack.length - 1] || null;
  function onPointerDown(e) {
    const t = e.target;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const p = stack[i];
      if (p.el.contains(t) || (isElement(p.anchor) && p.anchor.contains(t))) break; // inside it (or its own button: the button toggles)
      p.close({ reason: "outside", restoreFocus: false });
    }
  }
  function onKeyDown(e) {
    const p = top();
    if (!p) return;
    if (e.key === "Escape") {
      // The top popover only; the app's own Escape handling (dialogs, cell editing) doesn't also see this key.
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.();
      p.close({ reason: "escape", restoreFocus: true });
      return;
    }
    if (e.key === "Tab" && p.el.contains(e.target)) {
      const list = focusables(p.el);
      if (!list.length) { e.preventDefault(); focus(p.el); return; }
      const first = list[0], last = list[list.length - 1], active = document.activeElement;
      if (e.shiftKey && (active === first || active === p.el)) { e.preventDefault(); focus(last); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); focus(first); }
    }
  }
  let frame = 0;
  function onReflow() {
    if (frame) return;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    frame = raf(() => { frame = 0; for (const p of [...stack]) p.reposition(); });
  }
  function listen(on) {
    if (on === listening || typeof document === "undefined") return;
    listening = on;
    const m = on ? "addEventListener" : "removeEventListener";
    document[m]("pointerdown", onPointerDown, true);
    document[m]("keydown", onKeyDown, true);
    window[m]("resize", onReflow);
    window[m]("scroll", onReflow, true);
    window.visualViewport?.[m]?.("resize", onReflow);
  }

  // ---- Open ------------------------------------------------------------------------------------------------------------
  let seq = 0;
  function open({ anchor = null, content = null, placement = "bottom-start", label = "", onClose = null, sheetBelow = SHEET_BELOW } = {}) {
    if (typeof document === "undefined") return null;
    injectStyles();
    const layer = document.createElement("div");
    layer.className = "jarc-popover-layer";
    const el = document.createElement("div");
    el.className = "jarc-popover";
    el.id = `jarc-popover-${(seq += 1)}`;
    el.setAttribute("role", "dialog");
    if (label) el.setAttribute("aria-label", String(label));
    el.tabIndex = -1;
    if (content) el.appendChild(content);
    let backdrop = null;
    layer.appendChild(el);
    (document.body || document.documentElement).appendChild(layer);
    const opener = isElement(anchor) ? anchor : null;
    const expands = opener && (opener.tagName === "BUTTON" || opener.hasAttribute("aria-haspopup"));
    if (expands) { opener.setAttribute("aria-expanded", "true"); opener.setAttribute("aria-controls", el.id); }
    let closed = false;
    const handle = {
      el, anchor,
      reposition() {
        if (closed) return null;
        if (opener && !opener.isConnected) { handle.close({ reason: "anchor-removed", restoreFocus: false }); return null; }
        const vp = viewport();
        el.style.width = ""; el.style.maxHeight = ""; // measure the content's own size
        const r = el.getBoundingClientRect();
        const p = place(anchor, { width: r.width || 280, height: r.height || 200 }, vp, placement, { sheetBelow });
        el.classList.toggle("is-sheet", p.sheet);
        el.dataset.side = p.side;
        if (p.sheet) {
          if (!backdrop) { backdrop = document.createElement("div"); backdrop.className = "jarc-popover-backdrop"; backdrop.setAttribute("aria-hidden", "true"); layer.insertBefore(backdrop, el); }
          el.setAttribute("aria-modal", "true");
          Object.assign(el.style, { left: "", top: "", width: "", maxHeight: `${p.maxHeight}px` });
        } else {
          if (backdrop) { backdrop.remove(); backdrop = null; }
          el.removeAttribute("aria-modal");
          Object.assign(el.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, maxHeight: `${p.maxHeight}px` });
        }
        return p;
      },
      close({ reason = "close", restoreFocus = true } = {}) {
        if (closed) return;
        closed = true;
        const i = stack.indexOf(handle);
        // Popovers opened from this one close with it (innermost first).
        for (const child of stack.slice(i + 1).reverse()) child.close({ reason, restoreFocus: false });
        if (i >= 0) stack.splice(stack.indexOf(handle), 1);
        if (!stack.length) listen(false);
        const hadFocus = el.contains(document.activeElement) || document.activeElement === document.body || !document.activeElement;
        layer.remove();
        if (expands) { opener.setAttribute("aria-expanded", "false"); opener.removeAttribute("aria-controls"); }
        if (restoreFocus && hadFocus && opener?.isConnected) focus(opener);
        if (typeof onClose === "function") { try { onClose(reason); } catch (error) { setTimeout(() => { throw error; }); } }
      }
    };
    stack.push(handle);
    listen(true);
    handle.reposition();
    const first = el.querySelector("[autofocus]") || focusables(el)[0];
    focus(first || el);
    return handle;
  }

  // One-off placement of an existing position:fixed element (no listeners, no focus handling).
  function position(el, anchor, { placement = "bottom-start", sheetBelow = 0 } = {}) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const p = place(anchor, { width: r.width, height: r.height }, viewport(), placement, { sheetBelow });
    if (!p.sheet) Object.assign(el.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: `${p.maxHeight}px` });
    return p;
  }
  const closeAll = () => { for (const p of [...stack].reverse()) p.close({ reason: "close", restoreFocus: false }); };

  return Object.freeze({ open, place, position, viewport, closeAll, get openCount() { return stack.length; }, MARGIN, GAP, SHEET_BELOW, PLACEMENTS, CSS_TEXT });
});
