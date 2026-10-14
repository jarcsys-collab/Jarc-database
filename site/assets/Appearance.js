// Appearance & personalization (Phase 9C). Loaded after AppView.js and IconLibrary.js.
//
// Personal (per signed-in person, saved on the server at /api/v1/me/preferences and cached in this browser):
//   theme — JARC Default — Light (everyone's first-time appearance) or JARC Default — Dark, plus optional presets
//   (Midnight, Soft Slate, Warm Light) → settings.theme + settings.palette; accent colour (JARC Teal by default,
//   curated swatches or any HEX; buttons, text and focus are derived so they stay readable); table density.
// Shared (board and workspace data, saved like any other change and delivered live): workspace and board icons —
// stored as "icon:<id>" from IconLibrary.js or as one emoji, never as markup — and group colours (BoardGroups.js).
//
// The device's own light/dark setting never chooses the theme: a person sees JARC Light until they pick Dark.
const DEFAULT_ACCENT = "#00a5a8"; // JARC Teal
const ACCENT_PRESETS = [["JARC Teal", "#00a5a8"], ["Deep teal", "#007b84"], ["Blue", "#3b82f6"], ["Indigo", "#6366f1"], ["Purple", "#7c5cbf"], ["Pink", "#d6409f"], ["Red", "#e5484d"], ["Orange", "#ea6c1b"], ["Gold", "#d39e1a"], ["Green", "#08ab4b"], ["Blue-grey", "#64748b"], ["Graphite", "#3f4652"]];
const THEME_MODES = [{ id: "light", label: "Light", note: "JARC Default" }, { id: "dark", label: "Dark", note: "JARC Default" }];
// Optional presets: same teal sidebar and JARC colours, different surfaces (jarc-theme.css).
const THEME_PRESETS = [
  { id: "midnight", label: "Midnight", theme: "dark", palette: "midnight", swatch: ["#0c5865", "#171c26", "#232a38"] },
  { id: "slate", label: "Soft Slate", theme: "dark", palette: "slate", swatch: ["#246b72", "#232933", "#303744"] },
  { id: "warm", label: "Warm Light", theme: "light", palette: "warm", swatch: ["#068990", "#f6f2ea", "#fffdf9"] }
];
const THEMES = ["light", "dark", "system"], PALETTES = ["default", "midnight", "slate", "warm"];
const DENSITIES = [["compact", "Compact"], ["comfortable", "Comfortable"], ["spacious", "Spacious"]];
const DENSITY_IDS = DENSITIES.map(([v]) => v);
// Appearance before authentication (Phase 9 release candidate): every page load starts in neutral JARC Default — Light
// and stays neutral (loading, sign-in, expired, denied, signing out) until the SERVER has confirmed a session. Only then
// is "jarc-appearance" — a cache of the last appearance, stamped with the JARC user ID it belongs to — applied, and only
// for that same user, before anything else loads; a cache never counts as proof of sign-in.
const APPEARANCE_CACHE = "jarc-appearance";
const ACCENT_VARS = ["--accent", "--accent-fill", "--accent-fill-hover", "--on-accent", "--accent-text-on-light", "--accent-text-on-dark", "--focus-on-light", "--focus-on-dark", "--focus", "--accent-text"];
const writeAppearanceCache = (value) => { try { window.localStorage.setItem(APPEARANCE_CACHE, JSON.stringify(value)); } catch { /* storage blocked */ } };
try { window.sessionStorage?.removeItem("jarc-appearance-tab"); } catch { /* a marker from an earlier build; no longer used */ }
const readAppearanceCache = () => { try { const v = JSON.parse(window.localStorage.getItem(APPEARANCE_CACHE) || "null"); return v && typeof v === "object" ? v : null; } catch { return null; } };
// Least favourable backgrounds for accent-coloured text, per theme (covers the presets too).
const ACCENT_REF = Object.freeze({ light: "#eef0f0", dark: "#3a4250" });
const EMOJI_CHOICES = [
  ["📋", "clipboard tasks"], ["📌", "pin"], ["📎", "paperclip"], ["📁", "folder"], ["📂", "open folder"], ["🗂️", "dividers"], ["📊", "bar chart"], ["📈", "chart up growth"], ["📉", "chart down"], ["🧾", "receipt"],
  ["💼", "briefcase work"], ["🏢", "office building"], ["🏭", "factory"], ["🏠", "home house"], ["🏗️", "construction"], ["🚀", "rocket launch"], ["🎯", "target goal"], ["✅", "check done"], ["☑️", "checkbox"], ["⭐", "star"],
  ["🔥", "fire hot"], ["⚡", "lightning fast"], ["💡", "idea bulb"], ["🧠", "brain"], ["🛠️", "tools"], ["🔧", "wrench"], ["⚙️", "gear settings"], ["🔒", "lock security"], ["🔑", "key"], ["🛡️", "shield"],
  ["💰", "money bag"], ["💵", "dollar"], ["💳", "card payment"], ["🧮", "abacus accounting"], ["🏦", "bank"], ["🛒", "cart shopping"], ["📦", "package box"], ["🚚", "truck delivery"], ["✈️", "plane travel"], ["🚗", "car"],
  ["📣", "megaphone"], ["📢", "loudspeaker"], ["💬", "speech chat"], ["📧", "email"], ["📞", "phone"], ["📅", "calendar"], ["⏰", "alarm clock"], ["⏳", "hourglass"], ["🗓️", "calendar spiral"], ["📝", "memo note"],
  ["👥", "people team"], ["👤", "person"], ["🤝", "handshake deal"], ["🙌", "celebrate"], ["👍", "thumbs up"], ["🎉", "party"], ["🏆", "trophy"], ["🥇", "medal"], ["🎁", "gift"], ["❤️", "heart"],
  ["🌍", "globe world"], ["🌱", "seedling growth"], ["🌟", "glowing star"], ["☀️", "sun"], ["🌙", "moon"], ["☁️", "cloud"], ["🌈", "rainbow"], ["🍀", "clover luck"], ["☕", "coffee"], ["🍕", "pizza"],
  ["🎨", "palette design"], ["🎬", "film"], ["📷", "camera"], ["🎵", "music"], ["🎮", "game"], ["📚", "books"], ["🎓", "graduation training"], ["🔬", "microscope research"], ["🧪", "test tube"], ["💻", "laptop"],
  ["🖥️", "computer"], ["📱", "mobile"], ["🧩", "puzzle"], ["🔗", "link"], ["🏷️", "label tag"], ["🗃️", "card box"], ["🗄️", "cabinet"], ["🚩", "flag"], ["🟢", "green circle"], ["🟡", "yellow circle"],
  ["🔴", "red circle"], ["🔵", "blue circle"], ["🟣", "purple circle"], ["🟠", "orange circle"], ["⚪", "white circle"], ["⚫", "black circle"]
];
const entityGlyph = (id) => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ENTITY_ICONS[id]}</svg>`;
const capWord = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
// UI icons used by the board menu ("Change icon") and Settings.
if (!svgPaths.sparkles) svgPaths.sparkles = ENTITY_ICONS.sparkles;
if (!svgPaths.palette) svgPaths.palette = ENTITY_ICONS.palette;

// ---- Colour helpers (contrast-safe accents)
const Hex = {
  valid: (v) => /^#[0-9a-f]{6}$/i.test(String(v || "")),
  rgb: (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)),
  hex: (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`,
  lum(h) { return 0.2126 * this.ch(h, 0) + 0.7152 * this.ch(h, 1) + 0.0722 * this.ch(h, 2); },
  ch(h, i) { const v = this.rgb(h)[i] / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; },
  contrast(a, b) { const [x, y] = [this.lum(a), this.lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); },
  mix(a, b, t) { const p = this.rgb(a), q = this.rgb(b); return this.hex(p.map((v, i) => v + (q[i] - v) * t)); },
  // The colour moved towards white (dark backgrounds) or black (light) just far enough to reach the ratio.
  readableOn(color, bg, ratio = 4.5) { const toward = this.lum(bg) < 0.2 ? "#ffffff" : "#000000"; for (let t = 0; t <= 1.0001; t += 0.025) { const c = this.mix(color, toward, t); if (this.contrast(c, bg) >= ratio) return c; } return toward; },
  // A button fill for white text (≥ 4.5:1): the accent, deepened only as much as needed — JARC Teal becomes the
  // deeper teal of the original sidebar.
  fillForWhite(color) { return this.readableOn(color, "#ffffff", 4.5); }
};

// Runs a visual change as a short cross-fade where the browser supports it (and motion is allowed).
const withViewTransition = (fn) => {
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && typeof document.startViewTransition === "function") { try { document.startViewTransition(fn); return; } catch { /* fall through */ } }
  fn();
};

Object.assign(AppView.prototype, {
  // ---- Safe icon rendering: a known icon, an emoji or short text — always escaped, never stored markup.
  isCustomIcon(value) { const v = String(value || ""); return /^icon:[a-z][a-z0-9-]*$/.test(v) || /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u.test(v); },
  entityIcon(value, fallbackHtml) {
    const v = String(value || "");
    if (/^icon:/.test(v)) { const id = v.slice(5); return Object.prototype.hasOwnProperty.call(ENTITY_ICONS, id) ? `<span class="entity-icon is-glyph" aria-hidden="true">${entityGlyph(id)}</span>` : fallbackHtml; }
    if (this.isCustomIcon(v)) return `<span class="entity-icon is-emoji" aria-hidden="true">${this.escape(v)}</span>`;
    return fallbackHtml;
  },
  boardIcon(board) { return this.entityIcon(board?.icon, icon("board")); },
  workspaceIcon(space) { return this.entityIcon(space?.icon, this.escape((space?.name || "")[0] || "")); },
  iconLabel(value) { const v = String(value || ""); if (/^icon:/.test(v)) return capWord((ICON_CHOICES.find(([n]) => n === v.slice(5))?.[1] || v.slice(5)).split(" ")[0]); return capWord(EMOJI_CHOICES.find(([e]) => e === v)?.[1]?.split(" ")[0]) || v || "Default"; },

  // ---- Settings → Appearance
  appearanceSection(model, toggle) {
    const s = model.settings, mode = this.currentMode(model), palette = PALETTES.includes(s.palette) ? s.palette : "default";
    const accent = Hex.valid(s.accentColor) ? s.accentColor.toLowerCase() : DEFAULT_ACCENT, density = DENSITY_IDS.includes(s.density) ? s.density : "comfortable";
    const accentName = ACCENT_PRESETS.find(([, c]) => c === accent)?.[0] || "Custom colour";
    const modes = THEME_MODES.map((m) => `<button type="button" class="mode-option" data-action="appearance-mode" data-mode="${m.id}" aria-pressed="${mode === m.id && palette === "default"}"><span class="mode-preview is-${m.id}" aria-hidden="true"><span><i></i><i></i><i></i></span><div><b></b><em></em><em></em><em></em></div></span><strong>${m.label}</strong><small>${m.note}</small></button>`).join("");
    const presets = THEME_PRESETS.map((p) => `<button type="button" class="preset-chip" data-action="appearance-preset" data-preset="${p.id}" aria-pressed="${palette === p.id}"><span class="theme-swatch" aria-hidden="true">${p.swatch.map((c) => `<i style="background:${c}"></i>`).join("")}</span>${p.label}</button>`).join("");
    const swatches = ACCENT_PRESETS.map(([name, c]) => `<button type="button" class="accent-swatch" role="radio" aria-checked="${c === accent}" data-action="appearance-accent" data-color="${c}" style="--swatch:${c}" aria-label="${name}" title="${name}"></button>`).join("");
    return `<div class="appearance-settings">
      <section aria-labelledby="ap-theme"><h3 id="ap-theme">Theme</h3><p>Applies right away and follows you to every device you sign in on.</p>
        <div class="mode-switch" role="group" aria-label="Theme">${modes}</div>
        <details class="more-themes" ${palette !== "default" ? "open" : ""}><summary>More themes</summary><div class="preset-row" role="group" aria-label="More themes">${presets}</div></details></section>
      <section aria-labelledby="ap-accent"><h3 id="ap-accent">Accent colour</h3><p>Buttons, selection and focus. JARC deepens light colours where needed so text stays readable.</p>
        <div class="accent-row" role="radiogroup" aria-label="Accent colour">${swatches}</div><span class="accent-label" id="accent-current">${this.escape(accentName)} · ${accent}</span>
        <div class="accent-custom"><label class="accent-picker"><span class="sr-only">Pick a colour</span><input type="color" data-action="appearance-accent-picker" value="${accent}" aria-label="Pick an accent colour"></label>
          <label class="accent-hex">HEX<input type="text" data-action="appearance-accent-hex" value="${accent}" maxlength="7" spellcheck="false" autocomplete="off" aria-describedby="accent-hex-note" pattern="#[0-9a-fA-F]{6}"></label>
          <button type="button" class="button secondary small" data-action="appearance-accent-reset" ${accent === DEFAULT_ACCENT ? "disabled" : ""}>Reset to JARC Teal</button>
          <small id="accent-hex-note" class="accent-note" role="status" aria-live="polite"></small></div></section>
      <section aria-labelledby="ap-density"><h3 id="ap-density">Interface density</h3><p>Row height and spacing in boards. Your data doesn't change.</p>
        <div class="segmented" role="group" aria-label="Interface density">${DENSITIES.map(([v, l]) => `<button type="button" data-action="appearance-density" data-value="${v}" aria-pressed="${density === v}">${l}</button>`).join("")}</div></section>
      <section aria-labelledby="ap-preview"><h3 id="ap-preview">Preview</h3>
        <div class="appearance-preview" aria-hidden="true"><div class="ap-toolbar"><span class="ap-primary">${icon("plus")} New record</span><span class="ap-ghost">${icon("filter")} Filter</span><span class="ap-ghost">${icon("sort")} Sort</span></div>
          <div class="ap-group"><span class="ap-group-name">Planning</span><small>2 records</small></div>
          <div class="ap-row is-selected"><span>Selected record</span><span class="cell-label" style="--label-bg:#d39e1a;--label-fg:#17191d">Medium</span></div>
          <div class="ap-row"><span>Another record</span><span class="cell-label" style="--label-bg:#e5484d;--label-fg:#ffffff">Critical</span></div>
          <div class="ap-focus"><span class="ap-link">Accent text</span><span class="ap-ring">Focus ring</span></div></div></section>
      <section aria-labelledby="ap-personal"><h3 id="ap-personal">Personalization</h3>
        <p class="appearance-note"><strong>Workspace and board icons</strong> — choose an icon or emoji from the icon beside a board's name, or in Settings → Workspace. <strong>Group colours</strong> — from a group's ⋯ menu. These are shared: everyone on the board sees them. Theme, accent and density are yours alone.</p></section>
      <section aria-labelledby="ap-more"><h3 id="ap-more">Display</h3><div class="display-rows">
        <label class="setting-row"><span><strong>Text size</strong><small>Adjust text throughout the workspace</small></span><select data-action="setting-select" data-key="fontSize">${["small", "normal", "large"].map((v) => `<option ${s.fontSize === v ? "selected" : ""}>${this.cap(v)}</option>`).join("")}</select></label>
        ${toggle("showIcons", "Sidebar icons", "Recognizable shortcuts in your navigation")}${toggle("showBoardCounts", "Board counts", "Show record counts beside boards")}${toggle("stickyFirstColumn", "Sticky record name", "Keep record names in view as you scroll")}${toggle("highContrast", "High contrast", "Stronger text and separators")}</div></section>
      <div class="appearance-actions"><button type="button" class="button secondary" data-action="appearance-reset">Restore my appearance defaults</button></div>
    </div>`;
  },
  // "light" | "dark": what the person sees now (a saved "system" from an earlier version resolves on this device).
  currentMode(model) { const t = model.settings.theme; if (t === "dark" || t === "light") return t; return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; },

  // Called after applyDisplay: palette, density and contrast-safe accent states; cached for the next page load.
  applyAppearance(model) {
    const root = document.documentElement, s = model.settings || {};
    const palette = PALETTES.includes(s.palette) ? s.palette : "default";
    const theme = root.dataset.theme === "dark" ? "dark" : "light";
    root.dataset.palette = (palette === "warm" && theme !== "light") || (["midnight", "slate"].includes(palette) && theme !== "dark") ? "default" : palette;
    root.dataset.density = DENSITY_IDS.includes(s.density) ? s.density : "comfortable";
    const accent = Hex.valid(s.accentColor) ? s.accentColor.toLowerCase() : DEFAULT_ACCENT;
    // Accent text and focus are worked out for both themes against their least favourable surface (light: the grey
    // fills; dark: the lightest raised surface), and jarc-theme.css picks the pair for the current theme — so a theme
    // change is readable even before (or without) this code running again.
    const fill = Hex.fillForWhite(accent);
    const vars = { "--accent": accent, "--accent-fill": fill, "--accent-fill-hover": Hex.mix(fill, "#000000", 0.12), "--on-accent": "#ffffff",
      "--accent-text-on-light": Hex.readableOn(accent, ACCENT_REF.light, 4.5), "--accent-text-on-dark": Hex.readableOn(accent, ACCENT_REF.dark, 4.5),
      "--focus-on-light": Hex.readableOn(accent, ACCENT_REF.light, 3), "--focus-on-dark": Hex.readableOn(accent, ACCENT_REF.dark, 3) };
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.style.removeProperty?.("--focus"); root.style.removeProperty?.("--accent-text"); // set per theme in jarc-theme.css
    root.dataset.accentContrast = Hex.contrast("#ffffff", fill).toFixed(2);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0a5f63" : "#007b84");
    if (this.appearanceOwner) writeAppearanceCache({ owner: this.appearanceOwner, theme, palette: root.dataset.palette, density: root.dataset.density, fontSize: root.dataset.fontSize, contrast: root.dataset.contrast, vars });
  },
  // After the server confirmed the session of user `owner`: that user's last appearance from this browser, at once (no
  // light → dark switch once the app appears). Another user's cache, or none, keeps the neutral appearance.
  applyOwnerAppearance(owner) {
    const c = readAppearanceCache(), root = document.documentElement;
    if (!owner || !c || c.owner !== owner) return false;
    root.dataset.theme = c.theme === "dark" ? "dark" : "light";
    root.dataset.palette = PALETTES.includes(c.palette) ? c.palette : "default";
    root.dataset.density = DENSITY_IDS.includes(c.density) ? c.density : "comfortable";
    if (["small", "normal", "large"].includes(c.fontSize)) root.dataset.fontSize = c.fontSize;
    if (["high", "normal"].includes(c.contrast)) root.dataset.contrast = c.contrast;
    for (const name of ACCENT_VARS) { const v = c.vars?.[name]; if (Hex.valid(v)) root.style.setProperty(name, v); }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", root.dataset.theme === "dark" ? "#0a5f63" : "#007b84");
    return true;
  },
  // Before sign-in (Microsoft sign-in screen, session expired, signing out): JARC Default — Light with no personal
  // theme, accent, density, text size or contrast — and the cache stops applying until someone signs in again.
  // Nothing personal is deleted: it returns after sign-in from the person's own state and the server.
  applyNeutralAppearance() {
    const root = document.documentElement;
    Object.assign(root.dataset, { theme: "light", palette: "default", density: "comfortable", fontSize: "normal", contrast: "normal", icons: "on" });
    for (const name of ACCENT_VARS) root.style.removeProperty?.(name);
    delete root.dataset.accentContrast;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#007b84");
  },

  // ---- Icon picker (workspaces and boards): curated Lucide icons and emoji, searchable, recent icons, reset.
  iconPickerGrid(model, { tab = "icons", query = "" } = {}) {
    const q = query.trim().toLowerCase();
    const items = tab === "emoji" ? EMOJI_CHOICES.filter(([, k]) => !q || k.includes(q)).map(([e, k]) => ({ value: e, label: capWord(k.split(" ")[0]), html: this.escape(e) }))
      : ICON_CHOICES.filter(([n, k]) => !q || k.includes(q) || n.includes(q)).map(([n, k]) => ({ value: `icon:${n}`, label: capWord(k.split(" ")[0]), html: entityGlyph(n) }));
    return items.length ? items.map((i) => `<button type="button" class="icon-choice" data-action="icon-choose" data-value="${this.attr(i.value)}" aria-label="${this.attr(i.label)}" title="${this.attr(i.label)}">${i.html}</button>`).join("") : `<p class="menu-note">Nothing matches “${this.escape(query)}”.</p>`;
  },
  showIconPicker(model, { kind, id, name, current = "", tab = "icons" }) {
    const recent = (model.settings.recentIcons || []).filter((v) => this.isCustomIcon(v)).slice(0, 8);
    const recentHtml = recent.length ? `<div class="menu-section-label" role="presentation">Recently used</div><div class="icon-grid is-recent">${recent.map((v) => `<button type="button" class="icon-choice" data-action="icon-choose" data-value="${this.attr(v)}" aria-label="${this.attr(this.iconLabel(v))}" title="${this.attr(this.iconLabel(v))}">${this.entityIcon(v, "")}</button>`).join("")}</div>` : "";
    document.querySelector("#overlay-root").innerHTML = `<div class="popover icon-picker" role="dialog" aria-label="Choose an icon for ${this.attr(name)}" data-kind="${this.attr(kind)}" data-id="${this.attr(id)}" data-tab="${tab}">
      <div class="icon-picker-head"><span class="icon-picker-current" aria-label="Current icon: ${this.attr(this.iconLabel(current))}">${kind === "board" ? this.entityIcon(current, icon("board")) : this.entityIcon(current, this.escape((name || "")[0] || ""))}</span><input type="search" data-action="icon-search" placeholder="Search icons and emoji" aria-label="Search icons and emoji" autocomplete="off" autofocus></div>
      <div class="icon-picker-tabs" role="tablist"><button type="button" role="tab" data-action="icon-tab" data-tab="icons" aria-selected="${tab === "icons"}">Icons</button><button type="button" role="tab" data-action="icon-tab" data-tab="emoji" aria-selected="${tab === "emoji"}">Emoji</button></div>
      ${recentHtml}<div class="icon-grid" role="group" aria-label="${tab === "emoji" ? "Emoji" : "Icons"}">${this.iconPickerGrid(model, { tab })}</div>
      <div class="icon-picker-foot"><button type="button" class="link-button" data-action="icon-choose" data-value="">Reset to default</button></div></div>`;
  }
});

// The board header and settings show the picker; AppearanceActions applies choices and saves preferences.
class AppearanceActions {
  constructor(controller) { this.c = controller; this.saveTimer = null; }
  get model() { return this.c.model; }
  get view() { return this.c.view; }
  get adapter() { return this.c.model.storage?.adapter; }
  get server() { return this.adapter?.mode === "resource" && typeof this.adapter.request === "function"; }

  // After sign-in: the person's saved appearance (server) replaces this browser's copy. Nothing saved on the server
  // keeps this browser's copy (a new person: JARC Default — Light).
  async afterStart() {
    if (!this.server) return;
    try {
      const { appearance = {} } = await this.adapter.request("GET", "/me/preferences");
      const s = this.model.settings, before = JSON.stringify([s.theme, s.palette, s.accentColor, s.density]);
      if (THEMES.includes(appearance.theme)) s.theme = appearance.theme;
      if (PALETTES.includes(appearance.palette)) s.palette = appearance.palette;
      if (Hex.valid(appearance.accent)) s.accentColor = appearance.accent;
      if (DENSITY_IDS.includes(appearance.density)) s.density = appearance.density;
      if (Array.isArray(appearance.recentIcons)) s.recentIcons = appearance.recentIcons;
      if (before !== JSON.stringify([s.theme, s.palette, s.accentColor, s.density])) { this.model.updateSetting("theme", s.theme); this.view.applyDisplay(this.model); this.c.update(); }
    } catch { /* keep this browser's copy */ }
  }
  save() {
    if (!this.server) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      const s = this.model.settings;
      const appearance = { theme: THEMES.includes(s.theme) ? s.theme : "light", palette: PALETTES.includes(s.palette) ? s.palette : "default", accent: Hex.valid(s.accentColor) ? s.accentColor.toLowerCase() : DEFAULT_ACCENT, density: DENSITY_IDS.includes(s.density) ? s.density : "comfortable", recentIcons: (s.recentIcons || []).slice(0, 12) };
      try { await this.adapter.request("PUT", "/me/preferences", { appearance }); } catch { this.view.toast("Appearance saved on this device only — the server couldn't be reached"); }
    }, 350);
  }
  set(key, value) { this.model.updateSetting(key, value); }
  // Re-render first (the board behind updates), then reopen Settings on Appearance with focus kept on the choice.
  refresh(focusSelector = null, { fade = false } = {}) {
    const run = () => { this.view.applyDisplay(this.model); this.c.update(); this.view.showSettings(this.model, "appearance"); this.c.markPanel("settings"); };
    if (fade) withViewTransition(run); else run();
    if (focusSelector) requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(focusSelector)?.focus()));
    this.save();
  }
  // Light / Dark from anywhere (Settings, the command palette): always JARC Default for that mode.
  setMode(mode) { if (!["light", "dark"].includes(mode)) return; this.set("theme", mode); this.set("palette", "default"); }

  onAction(action, target) {
    const m = this.model;
    if (action === "appearance-mode") { this.setMode(target.dataset.mode); return this.refresh(`[data-action=appearance-mode][data-mode=${target.dataset.mode}]`, { fade: true }); }
    if (action === "appearance-preset") { const p = THEME_PRESETS.find((x) => x.id === target.dataset.preset); if (!p) return; this.set("theme", p.theme); this.set("palette", p.palette); return this.refresh(`[data-action=appearance-preset][data-preset=${p.id}]`, { fade: true }); }
    if (action === "appearance-accent") { if (Hex.valid(target.dataset.color)) { this.set("accentColor", target.dataset.color.toLowerCase()); this.refresh(`[data-action=appearance-accent][data-color="${target.dataset.color}"]`); } return; }
    if (action === "appearance-accent-reset") { this.set("accentColor", DEFAULT_ACCENT); return this.refresh(`[data-action=appearance-accent][data-color="${DEFAULT_ACCENT}"]`); }
    if (action === "appearance-density") { if (DENSITY_IDS.includes(target.dataset.value)) { this.set("density", target.dataset.value); this.refresh(`[data-action=appearance-density][data-value=${target.dataset.value}]`); } return; }
    if (action === "appearance-reset") { this.setMode("light"); this.set("accentColor", DEFAULT_ACCENT); this.set("density", "comfortable"); this.view.toast("Appearance restored to JARC Default — Light"); return this.refresh("[data-action=appearance-reset]", { fade: true }); }
    if (action === "icon-picker") {
      const kind = target.dataset.kind, id = target.dataset.id;
      const entity = kind === "workspace" ? m.workspaces.find((w) => String(w.id) === String(id)) : m.workspaces.flatMap((w) => w.boards).find((b) => String(b.id) === String(id));
      if (!entity) return;
      if (kind === "board" && entity.source?.readOnly) { this.view.toast("This board is synced from monday.com and is read-only"); return; }
      this.c.lastTrigger = target;
      return this.c.togglePanel(`icon-${kind}-${id}`, () => this.view.showIconPicker(m, { kind, id, name: entity.name, current: entity.icon }));
    }
    if (action === "icon-tab") { const picker = target.closest(".icon-picker"); picker.dataset.tab = target.dataset.tab; picker.querySelectorAll("[data-action=icon-tab]").forEach((b) => b.setAttribute("aria-selected", String(b === target))); this.renderGrid(picker); picker.querySelector("[data-action=icon-search]")?.focus(); return; }
    if (action === "icon-choose") {
      const picker = target.closest(".icon-picker"), value = target.dataset.value || "";
      const ok = picker.dataset.kind === "workspace" ? m.updateWorkspace(m.idOf(picker.dataset.id), { icon: value }) : m.setBoardIcon(picker.dataset.id, value);
      if (ok === false) { this.view.toast("The icon couldn't be changed"); return; }
      if (value) { m.settings.recentIcons = [value, ...(m.settings.recentIcons || []).filter((v) => v !== value)].slice(0, 12); m.updateSetting("recentIcons", m.settings.recentIcons); this.save(); }
      this.view.closeOverlay(); this.c.update(); this.view.toast(value ? "Icon updated" : "Icon reset", true);
    }
  }
  renderGrid(picker) { const grid = picker.querySelector(".icon-grid:not(.is-recent)"); if (grid) grid.innerHTML = this.view.iconPickerGrid(this.model, { tab: picker.dataset.tab, query: picker.querySelector("[data-action=icon-search]")?.value || "" }); }
  onInput(target) {
    const groupForm = target.closest?.("form.group-form");
    if (groupForm && ["color", "custom"].includes(target.name) || target.dataset?.action === "group-color-picker") {
      const hexInput = groupForm.querySelector("[name=custom]");
      if (target.dataset.action === "group-color-picker") hexInput.value = target.value.toLowerCase();
      const custom = hexInput.value.trim(), radio = groupForm.querySelector("input[name=color]:checked");
      if (target.name === "color") hexInput.value = "";
      if ((target.name === "custom" || target.dataset.action === "group-color-picker") && Hex.valid(hexInput.value.trim())) groupForm.querySelectorAll("input[name=color]").forEach((r) => { r.checked = false; });
      const color = Hex.valid(custom) ? custom : radio?.value || groupForm.querySelector(".color-choice.is-default span[aria-hidden]")?.style.getPropertyValue("--swatch") || "";
      hexInput.setAttribute("aria-invalid", String(Boolean(custom) && !Hex.valid(custom)));
      if (Hex.valid(color)) { groupForm.querySelector(".group-color-preview")?.style.setProperty("--group-color", color); const picker = groupForm.querySelector("[data-action=group-color-picker]"); if (picker) picker.value = color; const live = document.querySelector(`.board-group[data-group="${CSS.escape(groupForm.dataset.group || "")}"]`); if (live) { if (live.dataset.previewFrom === undefined) live.dataset.previewFrom = live.style.getPropertyValue("--group-color"); live.style.setProperty("--group-color", color); } }
      return target.dataset.action === "group-color-picker" || target.name === "custom";
    }
    if (target.dataset.action === "icon-search") return this.renderGrid(target.closest(".icon-picker")), true;
    if (target.dataset.action === "appearance-accent-picker") { this.set("accentColor", target.value.toLowerCase()); this.view.applyDisplay(this.model); const hex = document.querySelector("[data-action=appearance-accent-hex]"); if (hex) { hex.value = target.value.toLowerCase(); hex.removeAttribute("aria-invalid"); } this.syncAccentUi(target.value.toLowerCase()); this.save(); return true; }
    if (target.dataset.action === "appearance-accent-hex") {
      const v = target.value.trim(), value = /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : v;
      if (!Hex.valid(value)) { target.setAttribute("aria-invalid", "true"); this.note(v.length >= 6 ? "Use a 6-digit HEX colour like #00a5a8." : ""); return true; }
      target.removeAttribute("aria-invalid"); this.set("accentColor", value.toLowerCase()); this.view.applyDisplay(this.model);
      const pick = document.querySelector("[data-action=appearance-accent-picker]"); if (pick) pick.value = value.toLowerCase();
      this.syncAccentUi(value.toLowerCase());
      this.save(); return true;
    }
    return false;
  }
  // Live accent changes without re-rendering Settings (typing keeps focus): swatches, label, reset button, note.
  syncAccentUi(color) {
    document.querySelectorAll("[data-action=appearance-accent]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.color === color)));
    const name = ACCENT_PRESETS.find(([, c]) => c === color)?.[0] || "Custom colour", label = document.querySelector("#accent-current");
    if (label) label.textContent = `${name} · ${color}`;
    const reset = document.querySelector("[data-action=appearance-accent-reset]"); if (reset) reset.disabled = color === DEFAULT_ACCENT;
    this.note(Hex.fillForWhite(color) !== color ? "Buttons use a deeper shade of this colour so white text stays readable." : "");
  }
  note(text) { const n = document.querySelector("#accent-hex-note"); if (n) n.textContent = text; }
  // Arrow keys move through the icon grid; Enter in the search box picks the first match.
  onKeydown(event) {
    const t = event.target;
    if (t.dataset?.action === "icon-search" && event.key === "Enter") { event.preventDefault(); t.closest(".icon-picker")?.querySelector(".icon-grid:not(.is-recent) [data-action=icon-choose]")?.click(); return true; }
    if (t.dataset?.action === "icon-search" && event.key === "ArrowDown") { event.preventDefault(); t.closest(".icon-picker")?.querySelector(".icon-grid [data-action=icon-choose]")?.focus(); return true; }
    // Accent swatches are one radio group: arrows move and choose.
    if (t.dataset?.action === "appearance-accent" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const items = [...document.querySelectorAll("[data-action=appearance-accent]")], i = items.indexOf(t), next = items[(i + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + items.length) % items.length];
      event.preventDefault(); next?.click(); return true;
    }
    const grid = t.closest?.(".icon-grid");
    if (!grid || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return false;
    const items = [...grid.querySelectorAll("[data-action=icon-choose]")], i = items.indexOf(t), cols = Math.max(1, Math.round(grid.clientWidth / (items[0]?.offsetWidth || 36)));
    const next = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols, Home: 0, End: items.length - 1 }[event.key];
    event.preventDefault(); event.stopPropagation();
    if (next < 0 && event.key === "ArrowUp") { grid.closest(".icon-picker")?.querySelector("[data-action=icon-search]")?.focus(); return true; }
    items[Math.max(0, Math.min(items.length - 1, next))]?.focus();
    return true;
  }
}

// Closing a dialog without saving undoes a live group-colour preview (a save re-renders the board anyway).
{ const close = AppView.prototype.closeOverlay; AppView.prototype.closeOverlay = function (...args) { const out = close.apply(this, args); document.querySelectorAll("[data-preview-from]").forEach((el) => { el.style.setProperty("--group-color", el.dataset.previewFrom); delete el.dataset.previewFrom; }); return out; }; }
// Every render keeps the appearance applied (palette, density, readable accent).
// While the Microsoft sign-in screen is shown, nothing personal is applied (see applyNeutralAppearance).
{ const base = AppView.prototype.applyDisplay; AppView.prototype.applyDisplay = function (model) { base.call(this, model); if (this.preAuth) { if (!this.applyOwnerAppearance(this.appearanceOwner)) this.applyNeutralAppearance(); return; } this.applyAppearance?.(model); }; }
