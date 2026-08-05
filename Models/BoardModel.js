class BoardModel {
  constructor() {
    const saved = this.readStorage();
    this.workspaces = saved.workspaces || this.defaultWorkspaces();
    this.defaultColumns = [
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
    this.columnTypes = [
      { type: "text", label: "Text" }, { type: "number", label: "Number" },
      { type: "date", label: "Date" }, { type: "status", label: "Status" },
      { type: "priority", label: "Priority" }, { type: "owner", label: "People" },
      { type: "checkbox", label: "Checkbox" }, { type: "dropdown", label: "Dropdown" },
      { type: "email", label: "Email" }, { type: "phone", label: "Phone" },
      { type: "link", label: "Link" }, { type: "group", label: "Group" }
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
    this.activeSavedViewId = null;
    this.showArchived = false;
    this.manualSort = false;
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

  readStorage() { try { return JSON.parse(localStorage.getItem("medtek-database-v9")) || {}; } catch { return {}; } }
  save() { localStorage.setItem("medtek-database-v9", JSON.stringify({ workspaces: this.workspaces, currentWorkspaceId: this.currentWorkspaceId, currentBoardId: this.currentBoardId, settings: this.settings, profile: this.profile, notifications: this.notifications, recentBoards: this.recentBoards })); }
  normalizeBoards() {
    this.workspaces.forEach((space) => space.boards.forEach((board) => {
      board.groups ||= ["New", "Working", "Done"];
      board.savedViews ||= [];
      board.favorite ||= false;
      board.description ||= "";
      board.columns ||= this.defaultColumns.map((column) => ({ ...column, visible: board.columnConfig?.[column.key]?.visible !== false, connection: board.columnConfig?.[column.key]?.connection || "", required: column.key === "serial", defaultValue: "", options: [] }));
      board.columns.forEach((column) => { column.visible ??= true; column.connection ||= ""; column.defaultValue ||= ""; column.options ||= []; });
      if(!board.nextItemNumber){ const numbers=board.records.map((row)=>String(row.serial||"").match(/^New item(?: (\d+))?$/i)).filter(Boolean).map((match)=>Number(match[1]||1)); board.nextItemNumber=(numbers.length?Math.max(...numbers):0)+1; }
    }));
  }
  get workspace() { return this.workspaces.find((space) => space.id === this.currentWorkspaceId) || this.workspaces[0]; }
  get board() { return this.workspace.boards.find((board) => board.id === this.currentBoardId) || this.workspace.boards[0]; }
  get rows() { return this.board?.records || []; }
  get allRecords() { return this.workspaces.flatMap((space) => space.boards.flatMap((board) => { const byType=(type)=>board.columns?.find((column)=>column.type===type)?.key; return board.records.map((record) => ({ ...record, owner:record[byType("owner")]??record.owner, status:record[byType("status")]??record.status, priority:record[byType("priority")]??record.priority, dueDate:record[byType("date")]??record.dueDate, boardId: board.id, boardName: board.name, workspaceId: space.id })); })); }
  get myWork() { return this.allRecords.filter((record) => record.owner === this.profile.initials); }
  get visibleColumns() { return this.board.columns.filter((column) => column.visible !== false); }
  get statusColumn() { return this.board.columns.find((column)=>column.type==="status"); }
  get groupColumn() { return this.board.columns.find((column)=>column.type==="group"); }
  get ownerColumn() { return this.board.columns.find((column)=>column.type==="owner"); }
  get priorityColumn() { return this.board.columns.find((column)=>column.type==="priority"); }
  get sortColumn() { return this.board.columns.find((column)=>column.type==="date"); }
  get archivedCount() { return this.rows.filter((row)=>row.archived).length; }
  get canUndo() { return this.history.length > 0; }
  get unreadCount() { return this.notifications.filter((item) => !item.read).length; }
  get favoriteBoards() { return this.workspaces.flatMap((space) => space.boards.filter((board) => board.favorite).map((board) => ({ ...board, workspaceId: space.id, workspaceName: space.name }))); }
  get recentBoardItems() { return this.recentBoards.map((recent) => { const space = this.workspaces.find((item) => item.id === recent.workspaceId); const board = space?.boards.find((item) => item.id === recent.boardId); return board ? { ...board, workspaceId: space.id, workspaceName: space.name, openedAt: recent.openedAt } : null; }).filter(Boolean).slice(0,5); }

  get visibleRows() {
    const query = this.query.trim().toLowerCase();
    return [...this.rows]
      .filter((row) => this.showArchived ? row.archived : !row.archived)
      .filter((row) => this.status === "All" || !this.statusColumn || row[this.statusColumn.key] === this.status)
      .filter((row) => !query || Object.values(row).some((value) => String(value || "").toLowerCase().includes(query)))
      .sort((a, b) => { if(Boolean(a.pinned)!==Boolean(b.pinned))return a.pinned?-1:1; if(this.manualSort)return this.rows.indexOf(a)-this.rows.indexOf(b); const key=this.sortColumn?.key; if(!key)return this.rows.indexOf(a)-this.rows.indexOf(b); return this.sortDirection === "desc" ? String(b[key]||"").localeCompare(String(a[key]||"")) : String(a[key]||"").localeCompare(String(b[key]||"")); });
  }

  openScreen(screen) { this.screen = screen; this.selected.clear(); }
  openBoard(boardId, workspaceId = this.currentWorkspaceId) { this.currentWorkspaceId = workspaceId; this.currentBoardId = boardId; this.screen = "board"; this.currentView = "table"; this.activeSavedViewId = null; this.showArchived=false; this.manualSort=false; this.selected.clear(); this.recentBoards = [{ boardId, workspaceId, openedAt: new Date().toISOString() }, ...this.recentBoards.filter((item) => item.boardId !== boardId || item.workspaceId !== workspaceId)].slice(0,10); this.save(); }
  switchWorkspace(id) { const space = this.workspaces.find((item) => item.id === id); if (!space) return; this.currentWorkspaceId = id; this.currentBoardId = space.boards[0]?.id || ""; this.screen = "home"; this.save(); }

  snapshot(label) { this.history.push({ label, workspaces: JSON.stringify(this.workspaces), currentWorkspaceId: this.currentWorkspaceId, currentBoardId: this.currentBoardId }); this.history = this.history.slice(-30); }
  undo() { const entry = this.history.pop(); if (!entry) return "Nothing to undo"; this.workspaces = JSON.parse(entry.workspaces); this.currentWorkspaceId = entry.currentWorkspaceId; this.currentBoardId = entry.currentBoardId; this.normalizeBoards(); this.save(); return entry.label; }

  createBoard(name = "Untitled board") {
    this.snapshot("Board creation undone");
    const id = `board-${Date.now()}`;
    this.workspace.boards.push({ id, name: name.trim() || "Untitled board", icon: "▤", records: [], activity: [{ id: Date.now(), text: "Board created", at: new Date().toISOString() }], groups: ["New", "Working", "Done"], savedViews: [], columns: [{ key: "serial", label: "Record name", type: "text", visible: true, connection: "", required: true, defaultValue: "", options: [] }] });
    this.openBoard(id); this.save();
  }
  renameBoard(id, name) { const board = this.workspace.boards.find((item) => item.id === id); if (board && name.trim()) { this.snapshot("Board rename undone"); board.name = name.trim(); this.log("Board renamed"); this.save(); } }
  duplicateBoard(id) { const source = this.workspace.boards.find((item) => item.id === id); if (!source) return; this.snapshot("Board duplication undone"); const copy = JSON.parse(JSON.stringify(source)); copy.id = `board-${Date.now()}`; copy.name = `${source.name} copy`; copy.activity = [{ id: Date.now(), text: `Duplicated from ${source.name}`, at: new Date().toISOString() }]; this.workspace.boards.push(copy); this.openBoard(copy.id); this.save(); }
  deleteBoard(id) { if (this.workspace.boards.length <= 1) throw new Error("A workspace must keep at least one board."); this.snapshot("Board deletion undone"); this.workspace.boards = this.workspace.boards.filter((board) => board.id !== id); this.currentBoardId = this.workspace.boards[0].id; this.screen = "home"; this.save(); }

  upsert(record) {
    this.snapshot(record.id ? "Record edit undone" : "Record creation undone");
    const id = Number(record.id) || Date.now();
    const clean = { ...record, id };
    this.board.columns.forEach((column)=>{ if(clean[column.key] === undefined) clean[column.key]=column.type==="checkbox"?false:column.defaultValue; });
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows[index] = clean; else this.rows.unshift(clean);
    this.log(index >= 0 ? `Updated ${clean.serial}` : `Added ${clean.serial}`); this.save(); return clean;
  }
  updateCell(id, field, value) { const column = this.board.columns.find((item) => item.key === field); const row = this.rows.find((item) => item.id === Number(id)); if (!column || !row) return; if (column.required && !String(value).trim()) return; this.snapshot(`${column.label} change undone`); row[field] = column.type === "checkbox" ? Boolean(value) : String(value); this.log(`Updated ${column.label} on ${row.serial}`); this.save(); }
  moveRecord(id, updates) { const row = this.rows.find((item) => item.id === Number(id)); if (!row) return; this.snapshot("Record move undone"); Object.assign(row, updates); this.log(`Moved ${row.serial} to ${updates.status || updates.group}`); this.save(); }
  remove(ids) { this.snapshot("Record deletion undone"); const removeIds = new Set(ids.map(Number)); const names = this.rows.filter((row) => removeIds.has(row.id)).map((row) => row.serial); this.board.records = this.rows.filter((row) => !removeIds.has(row.id)); removeIds.forEach((id) => this.selected.delete(id)); this.log(`Deleted ${names.join(", ")}`); this.save(); }
  duplicateRecord(id) { const source = this.rows.find((row) => row.id === Number(id)); if (!source) return false; this.snapshot("Item duplication undone"); const copy = { ...source, id: Date.now()*1000+Math.floor(Math.random()*1000), serial: `${source.serial} copy`, archived:false }; this.rows.unshift(copy); this.manualSort=true; this.log(`Duplicated ${source.serial}`); this.save(); return copy.id; }
  quickAdd() { this.snapshot("Quick add undone"); const id = Date.now()*1000+Math.floor(Math.random()*1000); const row={id,archived:false,pinned:false}; this.board.columns.forEach((column)=>{ if(column.type==="checkbox")row[column.key]=false; else if(column.type==="group")row[column.key]=column.defaultValue||this.board.groups[0]; else if(column.type==="status")row[column.key]=column.defaultValue||column.options[0]||"Review"; else if(column.type==="owner")row[column.key]=column.defaultValue||"Unassigned"; else if(column.type==="priority")row[column.key]=column.defaultValue||"Medium"; else row[column.key]=column.defaultValue; }); const used=new Set(this.rows.map((item)=>String(item.serial||"").toLowerCase())); let number=this.board.nextItemNumber||1,name=number===1?"New item":`New item ${number}`; while(used.has(name.toLowerCase())){number+=1;name=`New item ${number}`;} this.board.nextItemNumber=number+1; row.serial=name; this.rows.unshift(row); this.showArchived=false; this.manualSort=true; this.log(`Added ${name}`); this.save(); return id; }
  togglePin(id) { const row=this.rows.find((item)=>item.id===Number(id)); if(!row)return; this.snapshot("Pin change undone"); row.pinned=!row.pinned; this.log(`${row.pinned?"Pinned":"Unpinned"} ${row.serial}`); this.save(); }
  archiveItem(id, archived=true) { const row=this.rows.find((item)=>item.id===Number(id)); if(!row)return; this.snapshot(archived?"Archive undone":"Restore undone"); row.archived=archived; this.selected.delete(row.id); this.log(`${archived?"Archived":"Restored"} ${row.serial}`); this.save(); }
  moveItem(id, direction) { const visible=this.visibleRows; const visibleIndex=visible.findIndex((item)=>item.id===Number(id)); const targetVisible=visibleIndex+(direction==="up"?-1:1); if(visibleIndex<0||targetVisible<0||targetVisible>=visible.length)return false; const index=this.rows.indexOf(visible[visibleIndex]),target=this.rows.indexOf(visible[targetVisible]); this.snapshot("Item move undone"); [this.rows[index],this.rows[target]]=[this.rows[target],this.rows[index]]; this.manualSort=true; this.save(); return true; }
  addGroup(name) { const clean = name.trim(); if (!clean || this.board.groups.includes(clean)) return false; this.snapshot("Group creation undone"); this.board.groups.push(clean); this.log(`Created group ${clean}`); this.save(); return true; }
  renameGroup(oldName, newName) { const clean = newName.trim(); if (!clean || this.board.groups.includes(clean)) return false; this.snapshot("Group rename undone"); this.board.groups = this.board.groups.map((name) => name === oldName ? clean : name); if(this.groupColumn)this.rows.forEach((row) => { if (row[this.groupColumn.key] === oldName) row[this.groupColumn.key] = clean; }); this.log(`Renamed group ${oldName} to ${clean}`); this.save(); return true; }
  deleteGroup(name, moveTo) { if (this.board.groups.length <= 1) return false; this.snapshot("Group deletion undone"); if(this.groupColumn)this.rows.forEach((row) => { if (row[this.groupColumn.key] === name) row[this.groupColumn.key] = moveTo; }); this.board.groups = this.board.groups.filter((group) => group !== name); this.log(`Deleted group ${name}`); this.save(); return true; }
  addColumn({ label, type, required = false, defaultValue = "", options = "" }) { const clean=String(label||"").trim(); if(!clean)return false; this.snapshot("Column creation undone"); const key=`custom_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; const optionList=String(options).split(",").map((item)=>item.trim()).filter(Boolean); const column={ key, label:clean, type, visible:true, connection:"", required:Boolean(required), defaultValue:String(defaultValue||""), options:optionList }; this.board.columns.push(column); this.rows.forEach((row)=>{row[key]=column.type==="checkbox"?false:column.defaultValue;}); this.log(`Added ${clean} column`); this.save(); return column; }
  renameColumn(key, label) { const column=this.board.columns.find((item)=>item.key===key); const clean=String(label||"").trim(); if(!column||!clean)return false; this.snapshot("Column rename undone"); column.label=clean; this.log(`Renamed column to ${clean}`); this.save(); return true; }
  deleteColumn(key) { if(key==="serial")return false; const index=this.board.columns.findIndex((item)=>item.key===key); if(index<0)return false; this.snapshot("Column deletion undone"); const [column]=this.board.columns.splice(index,1); this.rows.forEach((row)=>{delete row[key];}); this.log(`Deleted ${column.label} column`); this.save(); return true; }
  moveColumn(key, direction) { const index=this.board.columns.findIndex((item)=>item.key===key); const target=index+(direction==="left"?-1:1); if(key==="serial"||index<0||target<1||target>=this.board.columns.length)return false; this.snapshot("Column reorder undone"); [this.board.columns[index],this.board.columns[target]]=[this.board.columns[target],this.board.columns[index]]; this.save(); return true; }
  duplicateColumn(key) { const source=this.board.columns.find((item)=>item.key===key); if(!source)return false; this.snapshot("Column duplication undone"); const copy={...source,key:`custom_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,label:`${source.label} copy`,required:false,options:[...source.options]}; this.board.columns.splice(this.board.columns.indexOf(source)+1,0,copy); this.rows.forEach((row)=>{row[copy.key]=row[source.key]??copy.defaultValue;}); this.log(`Duplicated ${source.label} column`); this.save(); return copy; }
  updateColumnConfig(config) { this.snapshot("Column settings undone"); Object.entries(config).forEach(([key, value]) => { const column=this.board.columns.find((item)=>item.key===key); if(column)Object.assign(column,value); }); this.save(); }
  saveView(name) { const clean = name.trim(); if (!clean) return false; const view={ id: Date.now(), name: clean, status: this.status, query: this.query, grouped: this.grouped, sortDirection: this.sortDirection }; this.board.savedViews.push(view); this.activeSavedViewId=view.id; this.save(); return true; }
  applyView(id) { const view = this.board.savedViews.find((item) => item.id === Number(id)); if (!view) return; Object.assign(this, { status: view.status, query: view.query, grouped: view.grouped, sortDirection: view.sortDirection }); this.showArchived=false; this.activeSavedViewId=view.id; }
  resetMainView() { this.query=""; this.status="All"; this.grouped=false; this.sortDirection="desc"; this.activeSavedViewId=null; this.showArchived=false; this.manualSort=false; }
  deleteView(id) { this.board.savedViews = this.board.savedViews.filter((view) => view.id !== Number(id)); if(this.activeSavedViewId===Number(id))this.resetMainView(); this.save(); }
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
  createBackup() { return JSON.parse(JSON.stringify({ version: 9, exportedAt: new Date().toISOString(), workspaces: this.workspaces, currentWorkspaceId: this.currentWorkspaceId, currentBoardId: this.currentBoardId, settings: this.settings, profile: this.profile, notifications: this.notifications, recentBoards: this.recentBoards })); }
  restoreBackup(data) { if(!data || !Array.isArray(data.workspaces)) throw new Error("This is not a Medtek backup file."); this.snapshot("Backup restore undone"); this.workspaces=data.workspaces; this.currentWorkspaceId=data.currentWorkspaceId || this.workspaces[0].id; this.currentBoardId=data.currentBoardId || this.workspaces[0].boards[0].id; this.settings={...this.settings,...(data.settings||{})}; this.profile={...this.profile,...(data.profile||{})}; this.notifications=data.notifications||[]; this.recentBoards=data.recentBoards||[]; this.normalizeBoards(); this.save(); }
  importRows(rows) { if (!Array.isArray(rows)) throw new Error("Backup must contain a records array."); this.snapshot("Import undone"); this.board.records = rows.map((source,index)=>{ const row={id:Number(source.id)||Date.now()+index}; this.board.columns.forEach((column)=>{ const value=source[column.key] ?? source[column.label] ?? column.defaultValue; row[column.key]=column.type==="checkbox" ? [true,"true","yes","1"].includes(value) : String(value??""); }); return row; }).filter((row)=>String(row.serial||"").trim()); this.log(`Imported ${this.rows.length} records`); this.save(); }
}
window.BoardModel = BoardModel;
