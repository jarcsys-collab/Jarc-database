// Column System R0: the shared Popover (site/assets/Popover.js). Placement maths (pure, 320–1920 px viewports) and the real
// lifecycle in a headless browser: role="dialog" + aria-label, focus in and back to the anchor, Tab trapped, Escape and an
// outside pointer close it (the top one of a stack only), it follows the anchor on scroll, a bottom sheet with a backdrop
// under sheetBelow, light / dark colours from the theme variables, no animation with reduced motion. Synthetic page only.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const Popover = require("../../site/assets/Popover.js");
const { findBrowser, launch, sleep } = require("./support/headless-browser");

const inside = (p, size, vp) => p.left >= 8 && p.top >= 8 && p.left + Math.min(size.width, vp.width - 16) <= vp.width - 8 + 0.5 && p.top + Math.min(size.height, p.maxHeight) <= vp.height - 8 + 0.5;

describe("Popover.place (pure)", () => {
  const size = { width: 360, height: 420 };
  test("bottom-start: below the anchor, left-aligned; flips above when there is more room there", () => {
    const vp = { width: 1440, height: 900 };
    const p = Popover.place({ left: 100, right: 140, top: 50, bottom: 80 }, size, vp, "bottom-start");
    assert.deepEqual([p.left, p.top, p.sheet, p.side], [100, 84, false, "bottom"]);
    const up = Popover.place({ left: 100, right: 140, top: 820, bottom: 850 }, size, vp, "bottom-start");
    assert.equal(up.side, "top"); assert.equal(up.top, 820 - 4 - 420); assert.ok(inside(up, size, vp));
  });
  test("bottom-start near the right edge aligns to the anchor's right edge, then shifts inside", () => {
    const vp = { width: 1024, height: 768 };
    const p = Popover.place({ left: 900, right: 1000, top: 40, bottom: 70 }, size, vp, "bottom-start");
    assert.equal(p.left, 1000 - 360); assert.ok(inside(p, size, vp));
    const q = Popover.place({ left: 1010, right: 1020, top: 40, bottom: 70 }, size, vp, "bottom-start");
    assert.equal(q.left, 1024 - 8 - 360);
  });
  test("bottom-end aligns right edges; near the left edge it aligns left", () => {
    const vp = { width: 1440, height: 900 };
    assert.equal(Popover.place({ left: 600, right: 700, top: 10, bottom: 40 }, size, vp, "bottom-end").left, 340);
    assert.equal(Popover.place({ left: 20, right: 60, top: 10, bottom: 40 }, size, vp, "bottom-end").left, 20);
  });
  test("right-start: beside the anchor; flips to the left side when the right is too narrow; clamps vertically", () => {
    const vp = { width: 1440, height: 900 };
    const p = Popover.place({ left: 100, right: 300, top: 100, bottom: 130 }, size, vp, "right-start");
    assert.deepEqual([p.left, p.top, p.side], [304, 100, "right"]);
    const f = Popover.place({ left: 1200, right: 1300, top: 700, bottom: 730 }, size, vp, "right-start");
    assert.equal(f.side, "left"); assert.equal(f.left, 1200 - 4 - 360); assert.ok(f.top + 420 <= 900 - 8);
  });
  test("a point anchor ({x, y}) and an unknown placement work", () => {
    const vp = { width: 1440, height: 900 };
    const p = Popover.place({ x: 500, y: 300 }, size, vp, "nowhere");
    assert.deepEqual([p.left, p.top], [500, 304]);
  });
  test("every width from 320 to 1920 px: inside the viewport; a bottom sheet below sheetBelow (640 by default)", () => {
    for (const width of [320, 390, 480, 639, 640, 768, 1024, 1440, 1920]) for (const height of [568, 900]) {
      const vp = { width, height };
      for (const placement of Popover.PLACEMENTS) for (const a of [{ left: 0, right: 30, top: 0, bottom: 30 }, { left: width - 30, right: width, top: height - 30, bottom: height }, { left: width / 2, right: width / 2 + 30, top: height / 2, bottom: height / 2 + 30 }]) {
        const p = Popover.place(a, size, vp, placement);
        if (width < 640) { assert.equal(p.sheet, true, `${width}`); assert.equal(p.width, width); assert.ok(p.maxHeight <= height * 0.85 + 1); continue; }
        assert.equal(p.sheet, false);
        assert.ok(inside(p, size, vp), `${width}×${height} ${placement} ${JSON.stringify(a)} → ${JSON.stringify(p)}`);
      }
    }
    assert.equal(Popover.place({ left: 0, top: 0 }, size, { width: 700, height: 800 }, "bottom-start", { sheetBelow: 800 }).sheet, true);
    assert.equal(Popover.place({ left: 0, top: 0 }, size, { width: 400, height: 800 }, "bottom-start", { sheetBelow: 0 }).sheet, false);
  });
  test("content wider or taller than the viewport is capped", () => {
    const p = Popover.place({ left: 10, right: 20, top: 10, bottom: 20 }, { width: 5000, height: 5000 }, { width: 800, height: 600 }, "bottom-start");
    assert.equal(p.width, 784); assert.ok(p.maxHeight <= 584);
  });
});

const BROWSER = findBrowser();
describe("Popover.open in a real browser", { skip: BROWSER ? false : "no Chrome or Edge installed", concurrency: false }, () => {
  let b, dir, page;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarc-popover-"));
    page = path.join(dir, "popover.html");
    const src = path.resolve(__dirname, "..", "..", "site", "assets", "Popover.js").split(path.sep).join("/");
    fs.writeFileSync(page, `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      :root{--surface:#ffffff;--text:#111111;--line:#cccccc}
      html[data-theme=dark]{--surface:#101820;--text:#eeeeee;--line:#334455}
      body{margin:0;height:3000px;font:14px sans-serif} #a{position:absolute;left:40px;top:60px} #far{position:absolute;left:200px;top:400px}
    </style></head><body><button id="a" aria-haspopup="dialog">Open</button><button id="far">Elsewhere</button>
    <script src="file:///${src}"></script></body></html>`);
    b = await launch(BROWSER);
  });
  after(async () => { await b?.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

  const openOne = (extra = "") => b.evaluate(`(() => {
    const c = document.createElement('div'); c.innerHTML = '<input id="q" placeholder="Search"><button id="x1">One</button><button id="x2">Two</button>';
    window.closes = []; document.getElementById('a').focus();
    window.pop = Popover.open({ anchor: document.getElementById('a'), content: c, label: 'Add column', onClose: (r) => window.closes.push(r) ${extra} });
    const el = window.pop.el, r = el.getBoundingClientRect();
    return { role: el.getAttribute('role'), label: el.getAttribute('aria-label'), focused: document.activeElement.id, expanded: document.getElementById('a').getAttribute('aria-expanded'), sheet: el.classList.contains('is-sheet'), left: r.left, top: r.top, width: r.width, bg: getComputedStyle(el).backgroundColor, styles: document.querySelectorAll('#jarc-popover-styles').length, count: Popover.openCount };
  })()`);

  test("desktop: a labelled dialog under its anchor, focus inside, Tab trapped, Escape closes and focus returns", async () => {
    await b.open(page, { width: 1280 });
    const s = await openOne();
    assert.deepEqual([s.role, s.label, s.focused, s.expanded, s.sheet, s.styles, s.count], ["dialog", "Add column", "q", "true", false, 1, 1]);
    assert.ok(s.left >= 8 && Math.abs(s.top - (60 + (await b.evaluate("document.getElementById('a').getBoundingClientRect().height")) + 4)) <= 1, JSON.stringify(s));
    assert.equal(s.bg, "rgb(255, 255, 255)", "light surface from the theme variable");
    await b.evaluate("document.getElementById('x2').focus()");
    await b.key("Tab");
    assert.equal(await b.evaluate("document.activeElement.id"), "q", "Tab wraps to the first control");
    await b.key("Escape");
    assert.deepEqual(await b.evaluate("({ count: Popover.openCount, closed: window.closes, focused: document.activeElement.id, expanded: document.getElementById('a').getAttribute('aria-expanded'), left: document.querySelectorAll('.jarc-popover').length })"), { count: 0, closed: ["escape"], focused: "a", expanded: "false", left: 0 });
  });

  test("an outside pointer closes it (focus not stolen); a click inside doesn't; it follows the anchor on scroll", async () => {
    await b.open(page, { width: 1280 });
    await openOne();
    const press = async (x, y) => { await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); await sleep(80); };
    const box = await b.evaluate("(() => { const r = document.getElementById('x1').getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5 }; })()");
    await press(box.x, box.y);
    assert.equal(await b.evaluate("Popover.openCount"), 1, "inside click keeps it open");
    const before = await b.evaluate("window.pop.el.getBoundingClientRect().top");
    await b.evaluate("window.scrollTo(0, 40)"); await sleep(120);
    const afterTop = await b.evaluate("window.pop.el.getBoundingClientRect().top");
    assert.ok(Math.abs((before - afterTop) - 40) <= 1 || afterTop === 8, `moved with the anchor (${before} → ${afterTop})`);
    await press(700, 700);
    assert.deepEqual(await b.evaluate("({ count: Popover.openCount, closed: window.closes })"), { count: 0, closed: ["outside"] });
  });

  test("stacked: Escape and outside clicks close the top one first; closing a parent closes its child", async () => {
    await b.open(page, { width: 1280 });
    await openOne();
    await b.evaluate(`(() => { const c = document.createElement('div'); c.innerHTML = '<button id="inner">Inner</button>'; window.child = Popover.open({ anchor: document.getElementById('x1'), content: c, placement: 'right-start', label: 'Settings', onClose: (r) => window.closes.push('child:' + r) }); })()`);
    assert.equal(await b.evaluate("Popover.openCount"), 2);
    assert.equal(await b.evaluate("document.activeElement.id"), "inner");
    await b.key("Escape");
    assert.deepEqual(await b.evaluate("({ count: Popover.openCount, closed: window.closes, focused: document.activeElement.id })"), { count: 1, closed: ["child:escape"], focused: "x1" });
    await b.evaluate(`(() => { const c = document.createElement('div'); c.innerHTML = '<button id="inner2">Inner</button>'; Popover.open({ anchor: document.getElementById('x1'), content: c, label: 'Settings', onClose: (r) => window.closes.push('child2:' + r) }); })()`);
    await b.evaluate("window.pop.close()");
    assert.deepEqual(await b.evaluate("({ count: Popover.openCount, closed: window.closes })"), { count: 0, closed: ["child:escape", "child2:close", "close"] });
  });

  test("an anchor removed from the page closes the popover", async () => {
    await b.open(page, { width: 1280 });
    await openOne();
    await b.evaluate("document.getElementById('a').remove(); window.dispatchEvent(new Event('resize'))"); await sleep(120);
    assert.deepEqual(await b.evaluate("({ count: Popover.openCount, closed: window.closes })"), { count: 0, closed: ["anchor-removed"] });
  });

  test("phone (390 px): a bottom sheet with a backdrop, aria-modal; the backdrop closes it; dark theme colours", async () => {
    await b.open(page, { width: 390, height: 800 });
    await b.evaluate("document.documentElement.dataset.theme = 'dark'");
    const s = await openOne();
    assert.equal(s.sheet, true); assert.equal(Math.round(s.width), 390);
    assert.equal(s.bg, "rgb(16, 24, 32)", "dark surface from the theme variable");
    const sheet = await b.evaluate("(() => { const el = window.pop.el, r = el.getBoundingClientRect(); return { bottom: Math.round(r.bottom), modal: el.getAttribute('aria-modal'), backdrop: !!document.querySelector('.jarc-popover-backdrop') }; })()");
    assert.deepEqual(sheet, { bottom: 800, modal: "true", backdrop: true });
    await b.tap(195, 30);
    assert.deepEqual(await b.evaluate("({ count: Popover.openCount, closed: window.closes, backdrop: !!document.querySelector('.jarc-popover-backdrop') })"), { count: 0, closed: ["outside"], backdrop: false });
  });

  test("reduced motion: no animation", async () => {
    await b.open(page, { width: 1280 });
    await b.motionPreference("reduce");
    await openOne();
    assert.equal(await b.evaluate("getComputedStyle(window.pop.el).animationName"), "none");
    await b.evaluate("window.pop.close()");
    await b.motionPreference("no-preference");
    await openOne();
    assert.equal(await b.evaluate("getComputedStyle(window.pop.el).animationName"), "jarc-popover-in");
    await b.evaluate("window.pop.close()");
  });
});
