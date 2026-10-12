// Animation preference (Settings → Appearance → Animations) in the REAL app, in a headless browser: full animations by
// default; a device's reduced-motion request is respected until the person knowingly chooses Full animations (offered
// once); Reduced motion and Follow system preference; choices persist per person; an earlier saved "Reduce motion"
// choice is kept. The device setting is emulated per test (independent of this computer's own setting).
// Skipped when no Chrome or Edge is installed (set JARC_TEST_BROWSER to use a specific one).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const { findBrowser, launch, sleep, freePort } = require("./support/headless-browser");

const BROWSER = findBrowser();

describe("Animation preference (real app, headless browser)", { skip: BROWSER ? false : "no Chrome or Edge installed" }, () => {
  let server, base, owner, ws;
  const people = [];
  const signIn = (b, n) => b.evaluate(`(async () => {
    const start = await (await fetch("/api/v1/auth/sign-in/start", { method: "POST" })).json();
    const { token } = await (await fetch("/__test/id-token?oid=0c0c0c0c-0000-4000-8000-0000000000${String(30 + n)}&name=Person%20${n}&email=p${n}@example.invalid&nonce=" + start.nonce)).json();
    await fetch("/api/v1/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  })()`);
  // A new person (fresh browser profile = no saved preferences), with the device's motion setting emulated.
  const person = async (device) => {
    const b = await launch(BROWSER); people.push(b);
    await b.open(`${base}/api/v1/health`, { width: 1280 }); await signIn(b, people.length);
    await b.motionPreference(device);
    return b;
  };
  const load = async (b) => {
    await b.open(`${base}/`, { width: 1280, height: 860 });
    assert.ok(await b.waitFor("!!document.querySelector('#sidebar .tree-item') || !!document.querySelector('.no-workspace') || !!document.querySelector('.app-shell .workspace')", 15000));
    await sleep(400);
  };
  const motion = (b) => b.evaluate("document.documentElement.dataset.motion");
  // Does a menu actually animate? (Opens the profile menu and reads its computed animation.)
  const animates = async (b) => {
    await b.evaluate("document.querySelector('[data-action=\"profile\"], .profile')?.click()");
    await b.waitFor("!!document.querySelector('.profile-popover')", 2000);
    const name = await b.evaluate("getComputedStyle(document.querySelector('.profile-popover')).animationName");
    await b.key("Escape"); await sleep(150);
    return name !== "none";
  };
  const prompt = (b) => b.evaluate("[...document.querySelectorAll('#toast-region .toast')].find(t => /reduced motion/.test(t.textContent))?.textContent || null");
  const openAppearance = async (b) => {
    await b.evaluate("document.querySelector('[data-action=\"settings\"]')?.click()");
    await b.waitFor("!!document.querySelector('[data-action=\"settings-section\"][data-section=\"appearance\"]')", 3000);
    await b.evaluate("document.querySelector('[data-action=\"settings-section\"][data-section=\"appearance\"]').click()");
    assert.ok(await b.waitFor("!!document.querySelector('select[data-action=\"motion-preference\"]')", 3000), "Animations setting shown");
    return b.evaluate("(() => { const s = document.querySelector('select[data-action=\"motion-preference\"]'); return { value: s.value, options: [...s.options].map(o => o.textContent), note: document.getElementById('motion-note').textContent }; })()");
  };
  const choose = async (b, value) => {
    await b.evaluate(`(() => { const s = document.querySelector('select[data-action="motion-preference"]'); s.value = "${value}"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(300);
  };
  const savedSettings = (b) => b.evaluate("(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); try { const v = JSON.parse(localStorage.getItem(k)); if (v && v.settings && typeof v.settings === 'object') return { key: k, settings: v.settings }; } catch {} } return null; })()");

  before(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(__dirname, "support", "entra-server.js"), String(port), "shared"], { stdio: "ignore" });
    for (let i = 0; i < 100; i += 1) { try { await fetch(`${base}/api/v1/health`); break; } catch { await sleep(100); } }
    owner = await person("no-preference");
    ws = await owner.evaluate(`(async () => { const { csrfToken } = await (await fetch("/api/v1/auth/session")).json(); const r = await fetch("/api/v1/workspaces", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ name: "Prefs" }) }); return (await r.json()).workspace; })()`);
  });
  after(async () => { for (const b of people) await b.close(); server?.kill(); });

  test("default (no saved choice, device has no preference): full animations, shown as the default; no prompt", async () => {
    const b = await person("no-preference");
    await load(b);
    assert.equal(await motion(b), "system");
    assert.equal(await animates(b), true, "menus animate");
    assert.equal(await prompt(b), null, "nothing to offer");
    const setting = await openAppearance(b);
    assert.deepEqual(setting.options, ["Full animations", "Reduced motion", "Follow system preference"]);
    assert.equal(setting.value, "full");
    assert.match(setting.note, /Full animations \(default\)/);
  });

  test("device asks for reduced motion: respected by default, offered once; choosing Full turns animations on and persists", async () => {
    const b = await person("reduce");
    await load(b);
    assert.equal(await animates(b), false, "no animation without a knowing choice");
    assert.match(await prompt(b) || "", /Your device asks for reduced motion/);
    const setting = await openAppearance(b);
    assert.equal(setting.value, "system");
    assert.match(setting.note, /Choose Full animations to turn them on/);
    await b.key("Escape");
    // The offer's button is the knowing opt-in.
    await b.evaluate("[...document.querySelectorAll('#toast-region .toast button')].find(x => /Use full animations/.test(x.textContent))?.click()");
    await sleep(300);
    assert.equal(await motion(b), "full");
    assert.equal(await animates(b), true, "animations on despite the device setting, because the person chose them");
    assert.equal((await savedSettings(b)).settings.motion, "full", "saved for this person");
    await load(b);
    assert.equal(await motion(b), "full", "kept after reloading");
    assert.equal(await prompt(b), null, "never offered again");
  });

  test("the offer appears only once even if ignored", async () => {
    const b = await person("reduce");
    await load(b);
    assert.ok(await prompt(b));
    await load(b);
    assert.equal(await prompt(b), null);
    assert.equal(await animates(b), false, "still reduced: ignoring the offer changes nothing");
  });

  test("Reduced motion turns animations off even when the device has no preference; persists", async () => {
    const b = await person("no-preference");
    await load(b);
    await openAppearance(b);
    await choose(b, "reduced");
    await b.key("Escape"); await sleep(200);
    assert.equal(await motion(b), "reduced");
    assert.equal(await animates(b), false);
    await load(b);
    assert.equal(await motion(b), "reduced");
    assert.equal((await openAppearance(b)).value, "reduced");
  });

  test("Follow system preference tracks the device setting as it changes", async () => {
    const b = await person("no-preference");
    await load(b);
    await openAppearance(b);
    await choose(b, "system");
    await b.key("Escape"); await sleep(200);
    assert.equal(await animates(b), true);
    await b.motionPreference("reduce");
    assert.equal(await animates(b), false, "device now asks for reduced motion");
    await b.motionPreference("no-preference");
    assert.equal(await animates(b), true);
  });

  test("an earlier saved \"Reduce motion\" choice is kept (not overwritten by the new default)", async () => {
    const b = await person("no-preference");
    await load(b);
    const saved = await savedSettings(b);
    assert.ok(saved, "per-person settings are stored");
    // As saved by the previous version: reduceMotion: true, no "motion" key.
    await b.evaluate(`(() => { const v = JSON.parse(localStorage.getItem(${JSON.stringify(saved.key)})); v.settings.reduceMotion = true; delete v.settings.motion; delete v.settings.motionPromptSeen; localStorage.setItem(${JSON.stringify(saved.key)}, JSON.stringify(v)); })()`);
    await load(b);
    assert.equal(await motion(b), "reduced");
    assert.equal(await animates(b), false);
    assert.equal(await prompt(b), null);
    assert.equal((await openAppearance(b)).value, "reduced");
    const after = (await savedSettings(b)).settings;
    assert.equal(after.reduceMotion, true, "the saved choice is untouched");
    assert.equal(after.motion, undefined, "no new value written on its behalf");
  });
});
