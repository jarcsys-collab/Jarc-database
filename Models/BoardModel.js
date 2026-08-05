class BoardModel {
  constructor() {
    const saved = this.readStorage();
    this.workspaces = saved.workspaces || this.defaultWorkspaces();
    this.columnDefinitions = [
      { key: "serial", label: "Record / Serial", type: "text", required: true },
      { key: "group", label: "Group", type: "group" },
      { key: "owner", label: "Owner", type: "owner" },
      { key: "received", label: "Date received", type: "date" },
      { key: "invoice", label: "RR / Invoice", type: "text" },
      { key: "invoiceDate", label: "Invoice date", type: "date" },
      { key: "dueDate", label: "Due date", type: "date" },
      { key: "status", label: "Status", type: "status" },
      { key: "priority", label: "Priority", type: "priority" },
      { key: "notes", label: "Updates / Notes", type: "text" }
    ];
    this.normalizeBoards();
    this.currentWorkspaceId = saved.currentWorkspaceId || "engineering";
    this.currentBoardId = saved.currentBoardId || "medtek";
    this.screen = "board";
    this.currentView = "table";
    this.query = "";
    this.status = "All";
    this.sortDirection = "desc";
    this.grouped = false;
    this.selected = new Set();
    this.history = [];
    this.settings = { theme: "dark", density: "comfortable", accentColor: "#0f9489", fontSize: "normal", highContrast: false, reduceMotion: false, stickyFirstColumn: false, showInvoiceDate: true, showOwner: true, showPriority: true, ...(saved.settings || {}) };
    this.profile = { name: "medtek", email: "", role: "Workspace admin", initials: "M", avatar: "", color: "#0f9489", presence: "Available", startScreen: "Last opened board", ...(saved.profile || {}) };
    this.notifications = saved.notifications || [];
    this.recentBoards = saved.recentBoards || [];
    if (this.profile.startScreen === "Home") this.screen = "home";
    if (this.profile.startScreen === "My work") this.screen = "mywork";
  }

  defaultWorkspaces() {
    return [
      { id: "engineering", name: "Engineering", color: "#2f81f7", boards: [
        { id: "new-project", name: "New project", icon: "▤", records: [], activity: [] },
        { id: "resource", name: "Resource planning", icon: "♙", records: [], activity: [] },
        { id: "it-luzon", name: "IT LUZON", icon: "▣", records: [], activity: [] },
        { id: "medtek", name: "Medtek Database", icon: "▧", records: [], activity: [] },
        { id: "service", name: "Service Ticket Command", icon: "▥", records: [], activity: [] },
        { id: "installation", name: "Installation ticket", icon: "▣", records: [], activity: [] }
      ]},
      { id: "operations", name: "Operations", color: "#18b8aa", boards: [
        { id: "ops-intake", name: "Operations intake", icon: "▤", records: [], activity: [] },
        { id: "ops-tracker", name: "Delivery tracker", icon: "▥", records: [], activity: [] }
      ]}
    ];
  }

  readStorage() { try { return JSON.parse(localStorage.getItem("medtek-database-v7")) || {}; } catch { return {}; } }
  save() { localStorage.setItem("medtek-database-v7", JSON.stringify({ workspaces: this.workspaces, currentWorkspaceId: this.currentWorkspaceId, currentBoardId: this.currentBoardId, settings: this.settings, profile: this.profile, notifications: this.notifications, recentBoards: this.recentBoards })); }
  normalizeBoards() {
    this.workspaces.forEach((space) => space.boards.forEach((board) => {
      board.groups ||= ["New", "Working", "Done"];
      board.savedViews ||= [];
      board.favorite ||= false;
      board.description ||= "";
      board.columnConfig ||= Object.fromEntries(this.columnDefinitions.map((column) => [column.key, { visible: true, connection: "" }]));
      this.columnDefinitions.forEach((column) => { board.columnConfig[column.key] ||= { visible: true, connection: "" }; });
    }));
  }
  get workspace() { return this.workspaces.find((space) => space.id === this.currentWorkspaceId) || this.workspaces[0]; }
  get board() { return this.workspace.boards.find((board) => board.id === this.currentBoardId) || this.workspace.boards[0]; }
  get rows() { return this.board?.records || []; }
  get allRecords() { return this.workspaces.flatMap((space) => space.boards.flatMap((board) => board.records.map((record) => ({ ...record, boardId: board.id, boardName: board.name, workspaceId: space.id })))); }
  get myWork() { return this.allRecords.filter((record) => record.owner === this.profile.initials); }
  get visibleColumns() { return this.columnDefinitions.filter((column) => this.board.columnConfig[column.key]?.visible !== false); }
  get canUndo() { return this.history.length > 0; }
  get unreadCount() { return this.notifications.filter((item) => !item.read).length; }
  get favoriteBoards() { return this.workspaces.flatMap((space) => space.boards.filter((board) => board.favorite).map((board) => ({ ...board, workspaceId: space.id, workspaceName: space.name }))); }
  get recentBoardItems() { return this.recentBoards.map((recent) => { const space = this.workspaces.find((item) => item.id === recent.workspaceId); const board = space?.boards.find((item) => item.id === recent.boardId); return board ? { ...board, workspaceId: space.id, workspaceName: space.name, openedAt: recent.openedAt } : null; }).filter(Boolean).slice(0,5); }

  get visibleRows() {
    const query = this.query.trim().toLowerCase();
    return [...this.rows]
      .filter((row) => this.status === "All" || row.status === this.status)
      .filter((row) => !query || [row.serial, row.group, row.invoice, row.status, row.priority, row.owner, row.notes].some((value) => String(value || "").toLowerCase().includes(query)))
      .sort((a, b) => this.sortDirection === "desc" ? (b.received || "").localeCompare(a.received || "") : (a.received || "").localeCompare(b.received || ""));
  }

  openScreen(screen) { this.screen = screen; this.selected.clear(); }
  openBoard(boardId, workspaceId = this.currentWorkspaceId) { this.currentWorkspaceId = workspaceId; this.currentBoardId = boardId; this.screen = "board"; this.currentView = "table"; this.selected.clear(); this.recentBoards = [{ boardId, workspaceId, openedAt: new Date().toISOString() }, ...this.recentBoards.filter((item) => item.boardId !== boardId || item.workspaceId !== workspaceId)].slice(0,10); this.save(); }
  switchWorkspace(id) { const space = this.workspaces.find((item) => item.id === id); if (!space) return; this.currentWorkspaceId = id; this.currentBoardId = space.boards[0]?.id || ""; this.screen = "home"; this.save(); }

  snapshot(label) { this.history.push({ label, workspaces: JSON.stringify(this.workspaces), currentWorkspaceId: this.currentWorkspaceId, currentBoardId: this.currentBoardId }); this.history = this.history.slice(-30); }
  undo() { const entry = this.history.pop(); if (!entry) return "Nothing to undo"; this.workspaces = JSON.parse(entry.workspaces); this.currentWorkspaceId = entry.currentWorkspaceId; this.currentBoardId = entry.currentBoardId; this.normalizeBoards(); this.save(); return entry.label; }

  createBoard(name) {
    this.snapshot("Board creation undone");
    const id = `board-${Date.now()}`;
    this.workspace.boards.push({ id, name: name.trim() || "Untitled board", icon: "▤", records: [], activity: [{ id: Date.now(), text: "Board created", at: new Date().toISOString() }], groups: ["New", "Working", "Done"], savedViews: [], columnConfig: Object.fromEntries(this.columnDefinitions.map((column) => [column.key, { visible: true, connection: "" }])) });
    this.openBoard(id); this.save();
  }
  renameBoard(id, name) { const board = this.workspace.boards.find((item) => item.id === id); if (board && name.trim()) { this.snapshot("Board rename undone"); board.name = name.trim(); this.log("Board renamed"); this.save(); } }
  duplicateBoard(id) { const source = this.workspace.boards.find((item) => item.id === id); if (!source) return; this.snapshot("Board duplication undone"); const copy = JSON.parse(JSON.stringify(source)); copy.id = `board-${Date.now()}`; copy.name = `${source.name} copy`; copy.activity = [{ id: Date.now(), text: `Duplicated from ${source.name}`, at: new Date().toISOString() }]; this.workspace.boards.push(copy); this.openBoard(copy.id); this.save(); }
  deleteBoard(id) { if (this.workspace.boards.length <= 1) throw new Error("A workspace must keep at least one board."); this.snapshot("Board deletion undone"); this.workspace.boards = this.workspace.boards.filter((board) => board.id !== id); this.currentBoardId = this.workspace.boards[0].id; this.screen = "home"; this.save(); }

  upsert(record) {
    this.snapshot(record.id ? "Record edit undone" : "Record creation undone");
    const id = Number(record.id) || Date.now();
    const clean = { ...record, id, owner: record.owner || "Unassigned", group: record.group || "New", priority: record.priority || "Medium" };
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows[index] = clean; else this.rows.unshift(clean);
    this.log(index >= 0 ? `Updated ${clean.serial}` : `Added ${clean.serial}`); this.save(); return clean;
  }
  updateCell(id, field, value) { const column = this.columnDefinitions.find((item) => item.key === field); const row = this.rows.find((item) => item.id === Number(id)); if (!column || !row) return; if (column.required && !String(value).trim()) return; this.snapshot(`${column.label} change undone`); row[field] = String(value); this.log(`Updated ${column.label} on ${row.serial}`); this.save(); }
  moveRecord(id, updates) { const row = this.rows.find((item) => item.id === Number(id)); if (!row) return; this.snapshot("Record move undone"); Object.assign(row, updates); this.log(`Moved ${row.serial} to ${updates.status || updates.group}`); this.save(); }
  remove(ids) { this.snapshot("Record deletion undone"); const removeIds = new Set(ids.map(Number)); const names = this.rows.filter((row) => removeIds.has(row.id)).map((row) => row.serial); this.board.records = this.rows.filter((row) => !removeIds.has(row.id)); removeIds.forEach((id) => this.selected.delete(id)); this.log(`Deleted ${names.join(", ")}`); this.save(); }
  duplicateRecord(id) { const source = this.rows.find((row) => row.id === Number(id)); if (!source) return; this.snapshot("Record duplication undone"); const copy = { ...source, id: Date.now(), serial: `${source.serial} copy` }; this.rows.unshift(copy); this.log(`Duplicated ${source.serial}`); this.save(); }
  quickAdd() { this.snapshot("Quick add undone"); const id = Date.now(); this.rows.unshift({ id, serial: `New record ${this.rows.length + 1}`, group: this.board.groups[0], owner: "Unassigned", received: new Date().toISOString().slice(0,10), invoice: "", invoiceDate: "", dueDate: "", status: "Review", priority: "Medium", notes: "" }); this.log("Added a quick record"); this.save(); return id; }
  addGroup(name) { const clean = name.trim(); if (!clean || this.board.groups.includes(clean)) return false; this.snapshot("Group creation undone"); this.board.groups.push(clean); this.log(`Created group ${clean}`); this.save(); return true; }
  renameGroup(oldName, newName) { const clean = newName.trim(); if (!clean || this.board.groups.includes(clean)) return false; this.snapshot("Group rename undone"); this.board.groups = this.board.groups.map((name) => name === oldName ? clean : name); this.rows.forEach((row) => { if (row.group === oldName) row.group = clean; }); this.log(`Renamed group ${oldName} to ${clean}`); this.save(); return true; }
  deleteGroup(name, moveTo) { if (this.board.groups.length <= 1) return false; this.snapshot("Group deletion undone"); this.rows.forEach((row) => { if (row.group === name) row.group = moveTo; }); this.board.groups = this.board.groups.filter((group) => group !== name); this.log(`Deleted group ${name}`); this.save(); return true; }
  updateColumnConfig(config) { this.snapshot("Column settings undone"); Object.entries(config).forEach(([key, value]) => { if (this.board.columnConfig[key]) Object.assign(this.board.columnConfig[key], value); }); this.save(); }
  saveView(name) { const clean = name.trim(); if (!clean) return false; this.board.savedViews.push({ id: Date.now(), name: clean, status: this.status, query: this.query, grouped: this.grouped, sortDirection: this.sortDirection }); this.save(); return true; }
  applyView(id) { const view = this.board.savedViews.find((item) => item.id === Number(id)); if (!view) return; Object.assign(this, { status: view.status, query: view.query, grouped: view.grouped, sortDirection: view.sortDirection }); }
  deleteView(id) { this.board.savedViews = this.board.savedViews.filter((view) => view.id !== Number(id)); this.save(); }
  toggleRow(id) { this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id); }
  log(text) { if (!this.board) return; const at = new Date().toISOString(); this.board.activity.unshift({ id: Date.now(), text, at }); this.board.activity = this.board.activity.slice(0, 80); this.notifications.unshift({ id: Date.now() + 1, text, boardId: this.board.id, workspaceId: this.workspace.id, at, read: false }); this.notifications = this.notifications.slice(0,50); }
  updateSetting(key, value) { this.settings[key] = value; this.save(); }
  updateProfile(values) { Object.assign(this.profile, values); const parts=this.profile.name.trim().split(/\s+/); this.profile.initials=(parts[0]?.[0] || "U") + (parts[1]?.[0] || ""); this.profile.initials=this.profile.initials.toUpperCase(); this.save(); }
  syncUsername(username) { const name=String(username || "medtek").trim().toLowerCase(); this.profile.name=name; this.profile.initials=(name[0] || "M").toUpperCase(); this.save(); }
  setAvatar(dataUrl) { this.profile.avatar = dataUrl; this.save(); }
  toggleFavorite(boardId, workspaceId = this.currentWorkspaceId) { const space=this.workspaces.find((item)=>item.id===workspaceId); const board=space?.boards.find((item)=>item.id===boardId); if (!board) return; board.favorite=!board.favorite; this.save(); }
  updateBoardDescription(value) { this.board.description=String(value).trim(); this.log("Updated the board description"); this.save(); }
  markAllNotificationsRead() { this.notifications.forEach((item)=>{item.read=true;}); this.save(); }
  clearNotifications() { this.notifications=[]; this.save(); }
  bulkUpdate(ids, field, value) { const targets=new Set(ids.map(Number)); this.snapshot(`Bulk ${field} change undone`); this.rows.forEach((row)=>{ if(targets.has(row.id)) row[field]=value; }); this.log(`Updated ${field} on ${targets.size} records`); this.save(); }
  createBackup() { return JSON.parse(JSON.stringify({ version: 7, exportedAt: new Date().toISOString(), workspaces: this.workspaces, currentWorkspaceId: this.currentWorkspaceId, currentBoardId: this.currentBoardId, settings: this.settings, profile: this.profile, notifications: this.notifications, recentBoards: this.recentBoards })); }
  restoreBackup(data) { if(!data || !Array.isArray(data.workspaces)) throw new Error("This is not a Medtek backup file."); this.snapshot("Backup restore undone"); this.workspaces=data.workspaces; this.currentWorkspaceId=data.currentWorkspaceId || this.workspaces[0].id; this.currentBoardId=data.currentBoardId || this.workspaces[0].boards[0].id; this.settings={...this.settings,...(data.settings||{})}; this.profile={...this.profile,...(data.profile||{})}; this.notifications=data.notifications||[]; this.recentBoards=data.recentBoards||[]; this.normalizeBoards(); this.save(); }
  importRows(rows) { if (!Array.isArray(rows)) throw new Error("Backup must contain a records array."); this.board.records = rows.map((row, index) => ({ id: Number(row.id) || Date.now() + index, serial: String(row.serial || ""), group: String(row.group || "New"), received: String(row.received || ""), invoice: String(row.invoice || ""), invoiceDate: String(row.invoiceDate || ""), dueDate: String(row.dueDate || ""), status: ["Clear", "Review", "Defective"].includes(row.status) ? row.status : "Review", priority: ["Low", "Medium", "High", "Critical"].includes(row.priority) ? row.priority : "Medium", owner: String(row.owner || "Unassigned"), notes: String(row.notes || "") })).filter((row) => row.serial); this.log(`Imported ${this.rows.length} records`); this.save(); }
}
window.BoardModel = BoardModel;
