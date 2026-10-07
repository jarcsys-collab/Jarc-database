// Import limits (Stage 5). Generous for real boards, but they keep a single import from filling this browser's storage.
const IMPORT_LIMITS = Object.freeze({ rows: 5000, fields: 200, cellLength: 10000 });

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
    // Supported column types. category/description drive the Add column chooser.
    this.columnTypes = [
      { type: "text", label: "Text", category: "Basic", description: "Names, notes and short values" },
      { type: "number", label: "Number", category: "Basic", description: "Quantities, amounts and scores" },
      { type: "status", label: "Status", category: "Selection", description: "Track progress with labelled stages" },
      { type: "dropdown", label: "Dropdown", category: "Selection", description: "Pick one value from your own list" },
      { type: "checkbox", label: "Checkbox", category: "Selection", description: "Yes or no, done or not done" },
      { type: "priority", label: "Priority", category: "Selection", description: "Low, medium, high or critical" },
      { type: "owner", label: "People", category: "People", description: "Who is responsible" },
      { type: "date", label: "Date", category: "Dates", description: "Deadlines, milestones and events" },
      { type: "email", label: "Email", category: "Contact", description: "Email addresses" },
      { type: "phone", label: "Phone", category: "Contact", description: "Phone numbers" },
      { type: "link", label: "Link", category: "Contact", description: "Web addresses" },
      { type: "group", label: "Group", category: "Organization", description: "Sort records into this board's groups" }
    ];
    this.normalizeBoards();
    this.currentWorkspaceId = saved.currentWorkspaceId || "engineering";
    this.currentBoardId = saved.currentBoardId || "medtek";
    this.screen = saved.screen || "home";
    this.currentView = saved.currentView || "table";
    this.query = "";
    this.status = "All";
    this.sortDirection = "desc"; this.sortKey = ""; this.quickFilter = "all"; this.columnFilter = null;
    this.grouped = false;
    this.selected = new Set();
    this.history = [];
    this.activeSavedViewId = null;
    this.showArchived = false;
    this.manualSort = Boolean(this.board?.manualOrder);
    this.settings = { theme: "dark", density: "comfortable", accentColor: "#0f9489", fontSize: "normal", highContrast: false, reduceMotion: false, stickyFirstColumn: true, showInvoiceDate: true, showOwner: true, showPriority: true, showBoardCounts: true, showIcons: true, dateFormat: "DD/MM/YYYY", language: "English", autosave: true, settingsSection: "appearance", ...(saved.settings || {}) };
    this.profile = { name: "medtek", email: "", role: "Workspace admin", initials: "M", avatar: "", color: "#0f9489", presence: "Available", startScreen: "Home", ...(saved.profile || {}) };
    this.notifications = saved.notifications || [];
    this.members = saved.members || [{id:"member-admin",name:this.profile.name,email:this.profile.email||"",role:"Owner",status:"Active"}];
    this.recentBoards = saved.recentBoards || []; this.recentRecords = saved.recentRecords || []; this.recentCommands = saved.recentCommands || [];
    if (this.profile.startScreen === "Home") this.screen = "home";
    if (this.profile.startScreen === "My work") this.screen = "mywork";
  }

  defaultWorkspaces() {
    return [
      { id: "engineering", name: "Engineering", color: "#2f81f7", boards: [
        { id: "new-project", name: "New project", icon: "D", records: [], activity: [] },
        { id: "resource", name: "Resource planning", icon: "D", records: [], activity: [] },
        { id: "it-luzon", name: "IT LUZON", icon: "D", records: [], activity: [] },
        { id: "medtek", name: "Jarc Database", icon: "D", records: [], activity: [] },
        { id: "service", name: "Service Ticket Command", icon: "D", records: [], activity: [] },
        { id: "installation", name: "Installation ticket", icon: "D", records: [], activity: [] }
      ]},
      { id: "operations", name: "Operations", color: "#18b8aa", boards: [
        { id: "ops-intake", name: "Operations intake", icon: "D", records: [], activity: [] },
        { id: "ops-tracker", name: "Delivery tracker", icon: "D", records: [], activity: [] }
      ]}
    ];
  }

  readStorage() {
    const current = localStorage.getItem("jarc-database-data");
    const legacyKey = ["medtek", "database", String.fromCharCode(118,57)].join("-");
    const raw = current || localStorage.getItem(legacyKey);
    if (!raw) return {};
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.workspaces) || !data.workspaces.length) throw Error("Invalid workspace data");
      if (!current) localStorage.setItem("jarc-database-data", raw);
      return data;
    } catch (error) {
      throw new Error("Your saved data could not be read. It has been left unchanged. Export the browser storage or restore a valid backup before continuing.");
    }
  }

  save() {
    this.saveState = "saving";
    window.dispatchEvent(new CustomEvent("jarc-save", {detail:"saving"}));
    try {
      localStorage.setItem("jarc-database-data", JSON.stringify({workspaces:this.workspaces,currentWorkspaceId:this.currentWorkspaceId,currentBoardId:this.currentBoardId,currentView:this.currentView,screen:this.screen,settings:this.settings,profile:this.profile,notifications:this.notifications,recentBoards:this.recentBoards,members:this.members,recentRecords:this.recentRecords,recentCommands:this.recentCommands}));
      this.saveState = "saved"; this.saveError = "";
    } catch (error) { this.saveState = "error"; this.saveError = error?.name === "QuotaExceededError" || /quota/i.test(String(error?.message)) ? "quota" : "blocked"; }
    window.dispatchEvent(new CustomEvent("jarc-save", {detail:this.saveState}));
    return this.saveState === "saved";
  }

  normalizeBoards() {
    this.workspaces.forEach((space) => space.boards.forEach((board) => {
      board.records ||= []; board.activity ||= [];
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
  get allRecords() { return this.workspaces.flatMap((space) => space.boards.flatMap((board) => { const byType=(type)=>board.columns?.find((column)=>column.type===type)?.key; return board.records.map((record) => ({ ...record, owner:record[byType("owner")]??record.owner, status:record[byType("status")]??record.status, priority:record[byType("priority")]??record.priority, dueDate:record[this.dueColumn(board)?.key]??record.dueDate, boardId: board.id, boardName: board.name, workspaceId: space.id, workspaceName:space.name, boardArchived:Boolean(board.archived), workspaceArchived:Boolean(space.archived) })); })); }
  get myWork() { return this.allRecords.filter((record) => !record.archived && !record.boardArchived && !record.workspaceArchived && [this.profile.initials,this.profile.name,this.profile.email].filter(Boolean).includes(record.owner)); }
  get visibleColumns() { return this.board.columns.filter((column) => column.visible !== false); }
  get statusColumn() { return this.board.columns.find((column)=>column.type==="status"); }
  get groupColumn() { return this.board.columns.find((column)=>column.type==="group"); }
  get ownerColumn() { return this.board.columns.find((column)=>column.type==="owner"); }
  get priorityColumn() { return this.board.columns.find((column)=>column.type==="priority"); }
  get sortColumn() { return this.board.columns.find((column)=>column.type==="date"); }
  get archivedCount() { return this.rows.filter((row)=>row.archived).length; }
  get canUndo() { return this.history.length > 0; }
  get unreadCount() { return this.notifications.filter((item) => !item.read).length; }
  get favoriteBoards() { return this.workspaces.flatMap((space) => space.boards.filter((board) => board.favorite && !board.archived && !space.archived).map((board) => ({ ...board, workspaceId: space.id, workspaceName: space.name }))); }
  get recentBoardItems() { return this.recentBoards.map((recent) => { const space = this.workspaces.find((item) => item.id === recent.workspaceId); const board = space?.boards.find((item) => item.id === recent.boardId); return board && !board.archived && !space.archived ? { ...board, workspaceId: space.id, workspaceName: space.name, openedAt: recent.openedAt } : null; }).filter(Boolean).slice(0,5); }

  get visibleRows() {
    const query = this.query.trim().toLowerCase();
    return [...this.rows]
      .filter((row) => this.showArchived ? row.archived : !row.archived)
      .filter((row) => this.status === "All" || !this.statusColumn || row[this.statusColumn.key] === this.status)
      .filter((row) => this.matchesQuickFilter(row))
      .filter((row) => this.matchesColumnFilter(row))
      .filter((row) => !query || Object.values(row).some((value) => String(value || "").toLowerCase().includes(query)))
      .sort((a, b) => { if(Boolean(a.pinned)!==Boolean(b.pinned))return a.pinned?-1:1; if(this.manualSort)return this.rows.indexOf(a)-this.rows.indexOf(b); const key=this.sortKey || this.sortColumn?.key; if(!key)return this.rows.indexOf(a)-this.rows.indexOf(b); return this.sortDirection === "desc" ? String(b[key]??"").localeCompare(String(a[key]??""),undefined,{numeric:true}) : String(a[key]??"").localeCompare(String(b[key]??""),undefined,{numeric:true}); });
  }

  openScreen(screen) { this.screen = screen; this.selected.clear(); this.save(); }
  openBoard(boardId, workspaceId = this.currentWorkspaceId) {
    const space = this.workspaces.find(w=>w.id===workspaceId);
    const board = space?.boards.find(b=>b.id===boardId);
    if (!board) throw Error("This board is no longer available.");
    this.currentWorkspaceId=workspaceId; this.currentBoardId=boardId; this.screen="board";
    this.currentView=board.lastView || "table"; this.resetMainView(); this.selected.clear();
    board.openCount=(board.openCount||0)+1;
    this.recentBoards=[{boardId,workspaceId,openedAt:new Date().toISOString()},...this.recentBoards.filter(r=>r.boardId!==boardId||r.workspaceId!==workspaceId)].slice(0,10);
    this.save();
  }

  switchWorkspace(id) { const space = this.workspaces.find((item) => item.id === id); if (!space) return; this.currentWorkspaceId = id; this.currentBoardId = space.boards[0]?.id || ""; this.screen = "home"; this.save(); }
  createWorkspace({name,color="#0f9489",icon="W",description=""}) {
    const clean=String(name||"").trim(); if(!clean)return null;
    const workspace={id:"workspace-"+crypto.randomUUID(),name:clean,color,icon:String(icon||clean[0]).slice(0,2),description,boards:[],createdAt:new Date().toISOString()};
    this.snapshot("Workspace creation undone"); this.workspaces.push(workspace); this.currentWorkspaceId=workspace.id; this.currentBoardId=""; this.screen="home"; this.save(); return workspace;
  }

  setView(view) { if(["table","list","kanban","calendar"].includes(view)){ this.currentView=view; if(this.board)this.board.lastView=view; this.save(); } }
  updateWorkspace(id, values) { const space=this.workspaces.find((item)=>item.id===id); if(!space)return false; this.snapshot("Workspace update undone"); if(values.name?.trim())space.name=values.name.trim(); if(values.icon!=null)space.icon=String(values.icon||space.name[0]).slice(0,2); if(values.color)space.color=values.color; if(values.description!=null)space.description=String(values.description); this.save(); return true; }
  moveWorkspace(id, direction) { const index=this.workspaces.findIndex((item)=>item.id===id), target=index+(direction==="up"?-1:1); if(index<0||target<0||target>=this.workspaces.length)return false; this.snapshot("Workspace reorder undone"); [this.workspaces[index],this.workspaces[target]]=[this.workspaces[target],this.workspaces[index]]; this.save(); return true; }
  deleteWorkspace(id) { if(!this.workspaces.find(w=>w.id===id)?.archived && this.workspaces.filter(w=>!w.archived).length<=1)throw new Error("Keep at least one active workspace."); if(this.workspaces.length<=1)throw new Error("Keep at least one workspace."); const index=this.workspaces.findIndex((item)=>item.id===id); if(index<0)return; this.snapshot("Workspace deletion undone"); this.workspaces.splice(index,1); if(this.currentWorkspaceId===id){ const next=this.workspaces.find(w=>!w.archived)||this.workspaces[0];this.currentWorkspaceId=next.id; this.currentBoardId=next.boards[0]?.id||""; this.screen="home"; } this.save(); }
  moveBoardToWorkspace(boardId,targetWorkspaceId) { const source=this.workspace; const idx=source.boards.findIndex((b)=>b.id===boardId); const target=this.workspaces.find((w)=>w.id===targetWorkspaceId); if(idx<0||!target||target.id===source.id)return false; this.snapshot("Board move undone"); const [board]=source.boards.splice(idx,1); target.boards.push(board); if(this.currentBoardId===boardId){this.currentWorkspaceId=target.id;} this.save(); return true; }
  archiveBoard(boardId, archived=true) { const board=this.workspace.boards.find((b)=>b.id===boardId); if(!board)return; this.snapshot("Board archive undone"); board.archived=archived; this.save(); }
  addMember({email,role="Editor"}) { const clean=String(email||"").trim(); if(!clean)return false; if(this.members.some((m)=>m.email.toLowerCase()===clean.toLowerCase()))return false; this.members.push({id:`member-${Date.now()}`,name:clean.split("@")[0],email:clean,role,status:"Local contact"}); this.save(); return true; }
  removeMember(id) { this.members=this.members.filter((m)=>m.id!==id); this.save(); }

  snapshot(label) { this.history.push({ label, workspaces: JSON.stringify(this.workspaces), currentWorkspaceId: this.currentWorkspaceId, currentBoardId: this.currentBoardId, manualSort:this.manualSort, sortKey:this.sortKey, sortDirection:this.sortDirection }); this.history = this.history.slice(-30); }
  undo() { const entry = this.history.pop(); if (!entry) return "Nothing to undo"; this.workspaces = JSON.parse(entry.workspaces); this.currentWorkspaceId = entry.currentWorkspaceId; this.currentBoardId = entry.currentBoardId; this.normalizeBoards(); this.manualSort=entry.manualSort??Boolean(this.board?.manualOrder); this.sortKey=entry.sortKey??this.sortKey;this.sortDirection=entry.sortDirection??this.sortDirection; this.save(); return entry.label; }

  createBoard(name="Untitled board", description="", template="blank") {
    this.snapshot("Board creation undone");
    const keys=template==="blank"?["serial"]:template==="inventory"?["serial","group","owner","received","invoice","dueDate","status","notes"]:["serial","group","owner","dueDate","status","priority","notes"];
    const board={id:"board-"+crypto.randomUUID(),name:name.trim()||"Untitled board",description,icon:"D",records:[],activity:[],createdAt:new Date().toISOString(),groups:["New","Working","Done"],savedViews:[],columns:this.defaultColumns.filter(c=>keys.includes(c.key)).map(c=>({...c,visible:true,required:c.key==="serial",defaultValue:"",options:[]}))};
    // A blank board starts with only its primary column, labelled "Item". The key stays "serial" for compatibility.
    if(template==="blank")board.columns[0].label="Item";
    this.workspace.boards.push(board); this.openBoard(board.id); this.log("Board created"); this.save(); return board;
  }

  renameBoard(id, name) { const board = this.workspace.boards.find((item) => item.id === id); if (board && name.trim()) { this.snapshot("Board rename undone"); board.name = name.trim(); this.log("Board renamed"); this.save(); } }
  duplicateBoard(id) { const source = this.workspace.boards.find((item) => item.id === id); if (!source) return; this.snapshot("Board duplication undone"); const copy = JSON.parse(JSON.stringify(source)); copy.id = `board-${Date.now()}`; copy.name = `${source.name} copy`; copy.activity = [{ id: Date.now(), text: `Duplicated from ${source.name}`, at: new Date().toISOString() }]; this.workspace.boards.push(copy); this.openBoard(copy.id); this.save(); }
  deleteBoard(id) {
    this.snapshot("Board deletion undone"); this.workspace.boards=this.workspace.boards.filter(b=>b.id!==id);
    if(this.currentBoardId===id){this.currentBoardId=this.workspace.boards.find(b=>!b.archived)?.id||"";this.screen="home";} this.save();
  }

  upsert(record) {
    this.snapshot(record.id ? "Record edit undone" : "Record creation undone");
    const id = Number(record.id) || this.nextRecordId();
    const prior=this.rows.find(r=>r.id===id);
    const at=new Date().toISOString();
    const clean = { ...prior, ...record, id, createdAt:prior?.createdAt || at, updatedAt:at, activity:[...(prior?.activity||[]),{at,text:prior?"Record updated":"Record created",by:this.profile.name}].slice(-50) };
    this.board.columns.forEach((column)=>{ if(clean[column.key] === undefined) clean[column.key]=column.type==="checkbox"?false:column.defaultValue; });
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows[index] = clean; else this.rows.unshift(clean);
    this.log(index >= 0 ? `Updated ${clean.serial}` : `Added ${clean.serial}`); this.save(); return clean;
  }
  updateCell(id, field, value) { const column = this.board.columns.find((item) => item.key === field); const row = this.rows.find((item) => item.id === Number(id)); if (!column || !row) return; if (column.required && !String(value).trim()) return; this.snapshot(`${column.label} change undone`); row[field] = column.type === "checkbox" ? Boolean(value) : String(value); this.recordActivity(row, `Changed ${column.label}`); this.log(`Updated ${column.label} on ${row.serial}`); this.save(); }
  moveRecord(id, updates) { const row = this.rows.find((item) => item.id === Number(id)); if (!row) return; this.snapshot("Record move undone"); Object.assign(row, updates); this.log(`Moved ${row.serial} to ${updates.status || updates.group}`); this.save(); }
  remove(ids) { this.snapshot("Record deletion undone"); const removeIds = new Set(ids.map(Number)); const names = this.rows.filter((row) => removeIds.has(row.id)).map((row) => row.serial); this.board.records = this.rows.filter((row) => !removeIds.has(row.id)); removeIds.forEach((id) => this.selected.delete(id)); this.log(`Deleted ${names.join(", ")}`); this.save(); }
  duplicateRecord(id) { const source = this.rows.find((row) => row.id === Number(id)); if (!source) return false; this.snapshot("Item duplication undone"); const copy = { ...source, id: Date.now()*1000+Math.floor(Math.random()*1000), serial: `${source.serial} copy`, archived:false }; this.rows.unshift(copy); this.manualSort=true; this.log(`Duplicated ${source.serial}`); this.save(); return copy.id; }
  quickAdd() { this.snapshot("Quick add undone"); const id = this.nextRecordId(); const row={id,archived:false,pinned:false}; this.board.columns.forEach((column)=>{ if(column.type==="checkbox")row[column.key]=false; else if(column.type==="group")row[column.key]=column.defaultValue||this.board.groups[0]; else if(column.type==="status")row[column.key]=column.defaultValue||column.options[0]||"Review"; else if(column.type==="owner")row[column.key]=column.defaultValue||"Unassigned"; else if(column.type==="priority")row[column.key]=column.defaultValue||"Medium"; else row[column.key]=column.defaultValue; }); const used=new Set(this.rows.map((item)=>String(item.serial||"").toLowerCase())); let number=this.board.nextItemNumber||1,name=number===1?"New item":`New item ${number}`; while(used.has(name.toLowerCase())){number+=1;name=`New item ${number}`;} this.board.nextItemNumber=number+1; row.serial=name; this.rows.unshift(row); this.showArchived=false; this.manualSort=true; this.log(`Added ${name}`); this.save(); return id; }
  togglePin(id) { const row=this.rows.find((item)=>item.id===Number(id)); if(!row)return; this.snapshot("Pin change undone"); row.pinned=!row.pinned; this.log(`${row.pinned?"Pinned":"Unpinned"} ${row.serial}`); this.save(); }
  archiveItem(id, archived=true) { const row=this.rows.find((item)=>item.id===Number(id)); if(!row)return; this.snapshot(archived?"Archive undone":"Restore undone"); row.archived=archived; this.recordActivity(row,archived?"Record archived":"Record restored"); this.selected.delete(row.id); this.log(`${archived?"Archived":"Restored"} ${row.serial}`); this.save(); }
  reorderRecord(id,targetId,position="before") {
    const visible=this.visibleRows, source=visible.find(r=>r.id===Number(id)), target=visible.find(r=>r.id===Number(targetId));
    if(!source||!target||source===target||!["before","after"].includes(position))return false;
    if(Boolean(source.pinned)!==Boolean(target.pinned))return false;
    if(this.grouped&&this.groupColumn&&(source[this.groupColumn.key]||"")!==(target[this.groupColumn.key]||""))return false;
    const reordered=visible.filter(r=>r!==source);reordered.splice(reordered.indexOf(target)+(position==="after"?1:0),0,source);
    if(reordered.every((r,i)=>r===visible[i]))return false;
    this.snapshot("Row order restored");
    // Replace only visible slots. Hidden and archived records retain their positions.
    const ids=new Set(visible.map(r=>r.id));let index=0;
    this.board.records=this.rows.map(r=>ids.has(r.id)?reordered[index++]:r);
    this.manualSort=true;this.board.manualOrder=true;this.activeSavedViewId=null;
    this.save();return true;
  }

  addGroup(name) { const clean = name.trim(); if (!clean || this.board.groups.includes(clean)) return false; this.snapshot("Group creation undone"); this.board.groups.push(clean); this.log(`Created group ${clean}`); this.save(); return true; }
  renameGroup(oldName, newName) { const clean = newName.trim(); if (!clean || this.board.groups.includes(clean)) return false; this.snapshot("Group rename undone"); this.board.groups = this.board.groups.map((name) => name === oldName ? clean : name); if(this.groupColumn)this.rows.forEach((row) => { if (row[this.groupColumn.key] === oldName) row[this.groupColumn.key] = clean; }); this.log(`Renamed group ${oldName} to ${clean}`); this.save(); return true; }
  deleteGroup(name, moveTo) { if (this.board.groups.length <= 1) return false; this.snapshot("Group deletion undone"); if(this.groupColumn)this.rows.forEach((row) => { if (row[this.groupColumn.key] === name) row[this.groupColumn.key] = moveTo; }); this.board.groups = this.board.groups.filter((group) => group !== name); this.log(`Deleted group ${name}`); this.save(); return true; }
  addColumn({ label, type, required = false, defaultValue = "", options = "" }) { const clean=String(label||"").trim(); if(!clean||!this.columnTypes.some((item)=>item.type===type))return false; this.snapshot("Column creation undone"); const key=`custom_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; let optionList=[...new Set((Array.isArray(options)?options:String(options).split(",")).map((item)=>String(item).trim()).filter(Boolean))]; if(!optionList.length)optionList=this.newColumnOptions(type); const column={ key, label:clean, type, visible:true, connection:"", required:Boolean(required), defaultValue:String(defaultValue||""), options:optionList }; this.board.columns.push(column); this.rows.forEach((row)=>{row[key]=column.type==="checkbox"?false:column.defaultValue;}); this.log(`Added ${clean} column`); this.save(); return column; }
  renameColumn(key, label) { const column=this.board.columns.find((item)=>item.key===key); const clean=String(label||"").trim(); if(!column||!clean)return false; this.snapshot("Column rename undone"); column.label=clean; this.log(`Renamed column to ${clean}`); this.save(); return true; }
  deleteColumn(key) { if(key==="serial")return false; const index=this.board.columns.findIndex((item)=>item.key===key); if(index<0)return false; this.snapshot("Column deletion undone"); const [column]=this.board.columns.splice(index,1); this.rows.forEach((row)=>{delete row[key];}); this.log(`Deleted ${column.label} column`); this.save(); return true; }
  moveColumn(key, direction) { const index=this.board.columns.findIndex((item)=>item.key===key); const target=index+(direction==="left"?-1:1); if(key==="serial"||index<0||target<1||target>=this.board.columns.length)return false; this.snapshot("Column reorder undone"); [this.board.columns[index],this.board.columns[target]]=[this.board.columns[target],this.board.columns[index]]; this.save(); return true; }
  duplicateColumn(key) { const source=this.board.columns.find((item)=>item.key===key); if(!source)return false; this.snapshot("Column duplication undone"); const copy={...source,key:`custom_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,label:`${source.label} copy`,required:false,options:[...source.options]}; this.board.columns.splice(this.board.columns.indexOf(source)+1,0,copy); this.rows.forEach((row)=>{row[copy.key]=row[source.key]??copy.defaultValue;}); this.log(`Duplicated ${source.label} column`); this.save(); return copy; }
  updateColumnConfig(config) { this.snapshot("Column settings undone"); Object.entries(config).forEach(([key, value]) => { const column=this.board.columns.find((item)=>item.key===key); if(column)Object.assign(column,value); }); this.save(); }
  saveView(name) { const clean = name.trim(); if (!clean) return false; const view={ id: Date.now(), name: clean, status: this.status, query: this.query, grouped: this.grouped, sortDirection: this.sortDirection, view:this.currentView, visibleColumns:this.board.columns.filter(c=>c.visible!==false).map(c=>c.key), density:this.settings.density, sortKey:this.sortKey,quickFilter:this.quickFilter,showArchived:this.showArchived,columnOrder:this.board.columns.map(c=>c.key),columnWidths:Object.fromEntries(this.board.columns.map(c=>[c.key,c.width])) }; this.board.savedViews.push(view); this.activeSavedViewId=view.id; this.save(); return true; }
  applyView(id) { const view = this.board.savedViews.find((item) => item.id === Number(id)); if (!view) return; Object.assign(this, { status: view.status, query: view.query, grouped: view.grouped, sortDirection: view.sortDirection }); if(view.view)this.currentView=view.view; if(view.visibleColumns){this.board.columns.forEach(c=>c.visible=view.visibleColumns.includes(c.key));} if(view.density)this.settings.density=view.density; this.sortKey=view.sortKey||"";this.quickFilter=view.quickFilter||"all";this.showArchived=Boolean(view.showArchived);if(view.columnOrder)this.board.columns.sort((a,b)=>{const ai=view.columnOrder.indexOf(a.key),bi=view.columnOrder.indexOf(b.key);return (ai<0?999:ai)-(bi<0?999:bi);});if(view.columnWidths)this.board.columns.forEach(c=>c.width=view.columnWidths[c.key]||c.width);this.manualSort=false; this.activeSavedViewId=view.id;this.save(); }
  resetMainView() { this.sortKey="";this.quickFilter="all";this.columnFilter=null;this.query=""; this.status="All"; this.grouped=false; this.sortDirection="desc"; this.activeSavedViewId=null; this.showArchived=false; this.manualSort=Boolean(this.board?.manualOrder); }
  deleteView(id) { this.board.savedViews = this.board.savedViews.filter((view) => view.id !== Number(id)); if(this.activeSavedViewId===Number(id))this.resetMainView(); this.save(); }
  toggleRow(id) { this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id); }
  log(text) { if (!this.board) return; const at = new Date().toISOString(); this.board.updatedAt=at; this.board.activity.unshift({ id: Date.now(), text, at }); this.board.activity = this.board.activity.slice(0, 80); if(!this.settings.muteActivity)this.notifications.unshift({ id: Date.now() + 1, text, boardId: this.board.id, workspaceId: this.workspace.id, at, read: false }); this.notifications = this.notifications.slice(0,50); }
  updateSetting(key, value) { this.settings[key] = value; this.save(); }
  updateProfile(values) { Object.assign(this.profile, values); const parts=this.profile.name.trim().split(/\s+/); this.profile.initials=(parts[0]?.[0] || "U") + (parts[1]?.[0] || ""); this.profile.initials=this.profile.initials.toUpperCase(); this.save(); }
  syncUsername(username) { const name=String(username || "medtek").trim().toLowerCase(); this.profile.name=name; this.profile.initials=(name[0] || "M").toUpperCase(); this.save(); }
  setAvatar(dataUrl) { this.profile.avatar = dataUrl; this.save(); }
  toggleFavorite(boardId, workspaceId = this.currentWorkspaceId) { const space=this.workspaces.find((item)=>item.id===workspaceId); const board=space?.boards.find((item)=>item.id===boardId); if (!board) return; board.favorite=!board.favorite; this.save(); }
  updateBoardDescription(value) { this.board.description=String(value).trim(); this.log("Updated the board description"); this.save(); }
  markAllNotificationsRead() { this.notifications.forEach((item)=>{item.read=true;}); this.save(); }
  clearNotifications() { this.notifications=[]; this.save(); }
  bulkUpdate(ids, field, value) { const targets=new Set(ids.map(Number)); this.snapshot(`Bulk ${field} change undone`); this.rows.forEach((row)=>{ if(targets.has(row.id)){row[field]=value;this.recordActivity(row,"Changed "+field);} }); this.log(`Updated ${field} on ${targets.size} records`); this.save(); }
  createBackup() { return JSON.parse(JSON.stringify({version:11,exportedAt:new Date().toISOString(),workspaces:this.workspaces,currentWorkspaceId:this.currentWorkspaceId,currentBoardId:this.currentBoardId,settings:this.settings,profile:this.profile,notifications:this.notifications,recentBoards:this.recentBoards,recentRecords:this.recentRecords,recentCommands:this.recentCommands,members:this.members})); }

  restoreBackup(data) {
    this.validateBackup(data); // throws a readable reason; nothing is applied unless the whole backup is valid
    this.snapshot("Backup restore undone");this.workspaces=JSON.parse(JSON.stringify(data.workspaces));this.currentWorkspaceId=data.currentWorkspaceId||this.workspaces[0].id;this.currentBoardId=data.currentBoardId||this.workspaces[0].boards[0]?.id||"";this.settings={...this.settings,...data.settings};this.profile={...this.profile,...data.profile};this.notifications=data.notifications||[];this.recentBoards=data.recentBoards||[];this.recentRecords=data.recentRecords||[];this.recentCommands=data.recentCommands||[];this.members=data.members||this.members;this.normalizeBoards();this.screen="home";this.save();
  }

  importRows(rows, mapping=null) {
    if(!Array.isArray(rows))throw Error("Import must contain a list of records.");
    const result=this.validateImport(rows,mapping); if(!result.valid.length)throw Error("No valid records to import. Map a non-empty record name.");
    this.snapshot("Import undone");
    const at=new Date().toISOString(); result.valid.forEach(row=>this.rows.push({...row,id:this.nextRecordId(),createdAt:at,updatedAt:at}));
    this.log("Imported "+result.valid.length+" records");this.save();return result;
  }
  validateImport(rows, mapping=null) {
    const valid=[],issues=[];
    rows.forEach((source,index)=>{
      const row={}; let reason="";
      this.board.columns.forEach(c=>{
        const key=mapping?mapping[c.key]:Object.keys(source).find(k=>k.toLowerCase()===c.key.toLowerCase()||k.toLowerCase()===c.label.toLowerCase());
        const value=key?source[key]:c.defaultValue;if(value!==null&&typeof value==="object"){reason=c.label+" has an unsupported nested value";return;}row[c.key]=c.type==="checkbox"?[true,"true","yes","1",1].includes(value):String(value??"");
        if(c.required&&!String(row[c.key]).trim())reason=c.label+" is required";
        if(row[c.key]&&c.type==="number"&&!Number.isFinite(Number(row[c.key])))reason=c.label+" must be a number";
        if(row[c.key]&&c.type==="date"&&(!/^\d{4}-\d{2}-\d{2}$/.test(row[c.key])||Number.isNaN(new Date(row[c.key]).getTime())||new Date(row[c.key]).toISOString().slice(0,10)!==row[c.key]))reason=c.label+" must use YYYY-MM-DD";
      });
      if(reason)issues.push({row:index+2,reason});else valid.push(row);
    });return {valid,issues};
  }
  nextRecordId(){let id=Date.now()*1000+Math.floor(Math.random()*1000);while(this.rows.some(r=>r.id===id))id++;return id;}
  recordActivity(row,text){const at=new Date().toISOString();row.updatedAt=at;row.activity=[...(row.activity||[]),{at,text,by:this.profile.name}].slice(-50);}
  matchesQuickFilter(row){
    if(this.quickFilter==="mine")return [this.profile.initials,this.profile.name,this.profile.email].filter(Boolean).includes(row[this.ownerColumn?.key]);
    if(this.quickFilter==="due")return this.isDueSoon(row,this.dueColumn()?.key);
    if(this.quickFilter==="recent")return row.updatedAt && Date.now()-new Date(row.updatedAt).getTime()<7*86400000;
    return true;
  }
  isDueSoon(row,key="dueDate"){const value=row[key];if(!value)return false;const days=(new Date(value+"T00:00:00")-new Date(new Date().toDateString()))/86400000;return days>=0&&days<=7&&!row.archived&&!row.boardArchived&&!row.workspaceArchived;}
  archiveWorkspace(id,archived=true){const w=this.workspaces.find(w=>w.id===id);if(!w)return; if(archived&&this.workspaces.filter(w=>!w.archived).length<2)throw Error("Keep at least one active workspace.");this.snapshot("Workspace archive undone");w.archived=archived;if(archived&&this.currentWorkspaceId===id)this.switchWorkspace(this.workspaces.find(w=>!w.archived).id);this.save();}
  moveRecordToBoard(id,boardId){const row=this.rows.find(r=>r.id===Number(id));const target=this.workspaces.flatMap(w=>w.boards).find(b=>b.id===boardId);if(!row||!target||target===this.board)return false;this.snapshot("Record move undone");this.board.columns.forEach(c=>{if(!target.columns.some(t=>t.key===c.key))target.columns.push(JSON.parse(JSON.stringify(c)));});if(target.records.some(r=>r.id===row.id))row.id=this.nextRecordId();target.records.push(row);this.board.records=this.rows.filter(r=>r!==row);this.recordActivity(row,"Moved to "+target.name);this.log("Moved record to "+target.name);this.save();return true;}
  rememberRecord(row){this.recentRecords=[{id:row.id,boardId:this.board.id,workspaceId:this.workspace.id},...this.recentRecords.filter(r=>r.id!==row.id||r.boardId!==this.board.id)].slice(0,8);this.save();}
  rememberCommand(command){this.recentCommands=[command,...this.recentCommands.filter(c=>c!==command)].slice(0,5);this.save();}
  resizeColumn(key,width){const column=this.board.columns.find(c=>c.key===key);if(column){column.width=Math.max(100,Math.min(600,width));this.save();}}

  // --- Backup validation (Stage 5). Checks the whole file before anything is applied and explains the first problem.
  // Accepts the current backup format (version 11) and older backups without a version or without board columns.
  validateBackup(data){
    const fail=(reason)=>{throw new Error(`This backup can't be restored: ${reason}`);};
    const isObject=(v)=>v!==null&&typeof v==="object"&&!Array.isArray(v);
    const isId=(v)=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
    const isRecordId=(v)=>(Number.isSafeInteger(v)&&v>0)||isId(v);
    const isText=(v,max=500)=>typeof v==="string"&&v.length<=max;
    const isColor=(v)=>v===undefined||v===""||(typeof v==="string"&&/^#[0-9a-f]{3,8}$/i.test(v));
    const isPrimitive=(v)=>v===null||["string","number","boolean"].includes(typeof v);
    const flatList=(v)=>Array.isArray(v)&&v.every((item)=>isObject(item)&&Object.values(item).every(isPrimitive));
    const types=new Set(this.columnTypes.map((t)=>t.type)), views=["table","list","kanban","calendar"];
    if(!isObject(data))fail("the file is not a JARC backup.");
    if(data.version!==undefined&&!(Number.isInteger(data.version)&&data.version>=1&&data.version<=11))fail("it was made by an unsupported version of JARC.");
    if(!Array.isArray(data.workspaces)||!data.workspaces.length)fail("it contains no workspaces.");
    const workspaceIds=new Set(); let boards=0, records=0;
    data.workspaces.forEach((w,wi)=>{
      const where=`workspace ${wi+1}`;
      if(!isObject(w))fail(`${where} is not a workspace.`);
      if(!isId(w.id)||workspaceIds.has(w.id))fail(`${where} has a missing, invalid or duplicate ID.`); workspaceIds.add(w.id);
      if(!isText(w.name,200)||!w.name.trim())fail(`${where} has no valid name.`);
      if(!isColor(w.color))fail(`workspace "${w.name}" has an invalid colour.`);
      if((w.icon!==undefined&&!isText(w.icon,4))||(w.description!==undefined&&!isText(w.description,5000)))fail(`workspace "${w.name}" has an invalid icon or description.`);
      if(!Array.isArray(w.boards))fail(`workspace "${w.name}" has no board list.`);
      const boardIds=new Set();
      w.boards.forEach((b,bi)=>{
        boards+=1; const bw=`board ${bi+1} in "${w.name}"`;
        if(!isObject(b))fail(`${bw} is not a board.`);
        if(!isId(b.id)||boardIds.has(b.id))fail(`${bw} has a missing, invalid or duplicate ID.`); boardIds.add(b.id);
        if(!isText(b.name,200)||!b.name.trim())fail(`${bw} has no valid name.`);
        if(b.description!==undefined&&!isText(b.description,5000))fail(`board "${b.name}" has an invalid description.`);
        if(b.lastView!==undefined&&!views.includes(b.lastView))fail(`board "${b.name}" has an unknown view.`);
        if(!Array.isArray(b.records))fail(`board "${b.name}" has no record list.`);
        if(b.columns!==undefined){
          if(!Array.isArray(b.columns)||!b.columns.length)fail(`board "${b.name}" has an empty or invalid column list.`);
          const keys=new Set();
          b.columns.forEach((c)=>{
            if(!isObject(c)||!isId(c.key)||keys.has(c.key))fail(`board "${b.name}" has a column with a missing, invalid or duplicate key.`); keys.add(c.key);
            if(!isText(c.label,200))fail(`board "${b.name}" has a column without a valid name.`);
            if(!types.has(c.type))fail(`board "${b.name}" uses an unsupported column type "${String(c.type).slice(0,30)}".`);
            if(c.options!==undefined&&(!Array.isArray(c.options)||c.options.some((o)=>!isText(o,200))))fail(`column "${c.label}" in "${b.name}" has invalid options.`);
            if((c.defaultValue!==undefined&&!isPrimitive(c.defaultValue))||(c.width!==undefined&&c.width!==null&&!Number.isFinite(c.width)))fail(`column "${c.label}" in "${b.name}" has invalid settings.`);
          });
          const primary=b.columns.find((c)=>c.key==="serial");
          if(!primary)fail(`board "${b.name}" has no primary Item column.`);
          if(primary.type!=="text")fail(`board "${b.name}" has a primary column that is not text.`);
        }
        if(b.groups!==undefined&&(!Array.isArray(b.groups)||b.groups.some((g)=>!isText(g,200))))fail(`board "${b.name}" has invalid groups.`);
        if(b.activity!==undefined&&!flatList(b.activity))fail(`board "${b.name}" has invalid activity history.`);
        if(b.savedViews!==undefined&&(!Array.isArray(b.savedViews)||b.savedViews.some((v)=>!isObject(v)||!isRecordId(v.id)||!isText(v.name,200)||["visibleColumns","columnOrder"].some((k)=>v[k]!==undefined&&(!Array.isArray(v[k])||!v[k].every(isId))))))fail(`board "${b.name}" has invalid saved views.`);
        const recordIds=new Set();
        b.records.forEach((r,ri)=>{
          records+=1; const rw=`record ${ri+1} in "${b.name}"`;
          if(!isObject(r))fail(`${rw} is not a record.`);
          if(!isRecordId(r.id)||recordIds.has(r.id))fail(`${rw} has a missing, invalid or duplicate ID.`); recordIds.add(r.id);
          for(const [key,value] of Object.entries(r)){
            if(key==="activity"){if(!flatList(value))fail(`${rw} has invalid history.`);continue;}
            if(!isPrimitive(value))fail(`${rw} has an unsupported value in "${key.slice(0,40)}".`);
            if(typeof value==="string"&&value.length>100000)fail(`${rw} has a value that is too long.`);
          }
        });
      });
    });
    if(data.currentWorkspaceId!=null&&data.currentWorkspaceId!==""&&!isId(data.currentWorkspaceId))fail("the selected workspace ID is invalid.");
    if(data.currentBoardId!=null&&data.currentBoardId!==""&&!isId(data.currentBoardId))fail("the selected board ID is invalid.");
    if(data.settings!==undefined&&(!isObject(data.settings)||!Object.values(data.settings).every(isPrimitive)||!isColor(data.settings.accentColor)))fail("its settings are invalid.");
    if(data.profile!==undefined){
      if(!isObject(data.profile)||!Object.values(data.profile).every(isPrimitive)||!isColor(data.profile.color))fail("its profile is invalid.");
      if(data.profile.avatar&&!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data.profile.avatar))fail("its profile photo is not a supported image.");
    }
    for(const key of ["notifications","recentBoards","recentRecords","members"])if(data[key]!==undefined&&!flatList(data[key]))fail(`its ${key} list is invalid.`);
    if(data.members?.some((m)=>!isId(m.id)))fail("a member has an invalid ID.");
    if([...(data.recentBoards||[]),...(data.recentRecords||[]),...(data.notifications||[])].some((x)=>(x.boardId!==undefined&&!isId(x.boardId))||(x.workspaceId!==undefined&&!isId(x.workspaceId))))fail("its recent items refer to invalid IDs.");
    if(data.recentCommands!==undefined&&(!Array.isArray(data.recentCommands)||!data.recentCommands.every((c)=>isText(c,100))))fail("its recent commands are invalid.");
    return {workspaces:data.workspaces.length,boards,records};
  }
  // Rejects imports that are too large or not flat records, before any preview or change.
  assertImportable(rows){
    if(!Array.isArray(rows)||!rows.length)throw new Error("The file must contain a non-empty list of records.");
    if(rows.length>IMPORT_LIMITS.rows)throw new Error(`This import has ${rows.length.toLocaleString()} records. Import at most ${IMPORT_LIMITS.rows.toLocaleString()} at a time.`);
    rows.forEach((row,i)=>{
      if(!row||typeof row!=="object"||Array.isArray(row))throw new Error(`Record ${i+1} is not a set of named fields.`);
      const entries=Object.entries(row);
      if(entries.length>IMPORT_LIMITS.fields)throw new Error(`Record ${i+1} has more than ${IMPORT_LIMITS.fields} fields.`);
      for(const [key,value] of entries){
        if(value!==null&&typeof value==="object")throw new Error(`Record ${i+1} has a nested value in "${String(key).slice(0,40)}". Use plain text, numbers or true/false.`);
        if(String(value??"").length>IMPORT_LIMITS.cellLength)throw new Error(`Record ${i+1} has a value longer than ${IMPORT_LIMITS.cellLength.toLocaleString()} characters in "${String(key).slice(0,40)}".`);
      }
    });
    return true;
  }

  // --- Column schema helpers. Records stay flat objects keyed by column key; nothing here migrates stored data.
  columnType(type){return this.columnTypes.find((item)=>item.type===type);}
  // Options a brand-new column starts with. Existing columns with no stored options keep their legacy defaults.
  newColumnOptions(type){return type==="status"?["New","In Progress","Waiting","Completed","Cancelled"]:type==="priority"?["Low","Medium","High","Critical"]:[];}
  effectiveOptions(column){if(!column)return [];if(column.type==="group")return [...this.board.groups];if(column.options?.length)return [...column.options];return column.type==="status"?["New","In Progress","Waiting","Completed","Cancelled","Review","Defective","Clear"]:column.type==="priority"?["Low","Medium","High","Critical"]:[];}
  hasValue(value){return value!==undefined&&value!==null&&value!==false&&String(value).trim()!=="";}
  columnUsage(key){return this.rows.filter((row)=>this.hasValue(row[key])).length;}
  uniqueColumnLabel(base){const used=new Set(this.board.columns.map((c)=>c.label.toLowerCase()));let label=base,n=2;while(used.has(label.toLowerCase()))label=`${base} ${n++}`;return label;}
  // Due-date column: legacy dueDate key, then a date column labelled "due", then the first date column.
  dueColumn(board=this.board){const dates=(board?.columns||[]).filter((c)=>c.type==="date");return dates.find((c)=>c.key==="dueDate")||dates.find((c)=>/due/i.test(c.label))||dates[0];}

  // Can an existing value be kept when a column becomes `type`? Empty values always fit.
  valueFits(value,type){
    if(!this.hasValue(value))return true;
    const text=String(value).trim();
    if(type==="number")return Number.isFinite(Number(text));
    if(type==="date")return /^\d{4}-\d{2}-\d{2}$/.test(text)&&!Number.isNaN(new Date(text+"T00:00:00").getTime());
    if(type==="checkbox")return value===true||["true","yes","1"].includes(text.toLowerCase());
    return typeof value!=="boolean"; // text-like types keep any string; a ticked checkbox has no text equivalent
  }
  typeChangeImpact(key,type){const column=this.board.columns.find((c)=>c.key===key);if(!column)return 0;return this.rows.filter((row)=>!this.valueFits(row[key],type)).length;}
  changeColumnType(key,type){
    const column=this.board.columns.find((c)=>c.key===key);
    if(!column||column.key==="serial"||column.type===type||!this.columnType(type))return false;
    this.snapshot(`${column.label} type change undone`);
    let cleared=0;
    this.rows.forEach((row)=>{
      const value=row[key],fits=this.valueFits(value,type);
      if(this.hasValue(value)&&!fits)cleared+=1;
      if(type==="checkbox")row[key]=fits&&this.hasValue(value);
      else if(!fits||typeof value==="boolean")row[key]="";
    });
    // A dropdown only offers its own options, so keep existing values selectable.
    if(type==="dropdown")column.options=[...new Set([...(column.options||[]),...this.rows.map((row)=>row[key]).filter((v)=>this.hasValue(v)).map(String)])];
    if(!this.valueFits(column.defaultValue,type))column.defaultValue="";
    const from=this.columnType(column.type)?.label||column.type;
    column.type=type;
    this.log(`Changed ${column.label} from ${from} to ${this.columnType(type).label}`);this.save();
    return {cleared};
  }

  // Option editing. items: [{from: original option or null for new, to: new text}]; options left out are removed.
  optionsEditPlan(key,items){
    const column=this.board.columns.find((c)=>c.key===key);if(!column)return null;
    const previous=this.effectiveOptions(column),kept=items.filter((i)=>String(i.to||"").trim());
    const removed=previous.filter((option)=>!kept.some((i)=>i.from===option));
    const renames=Object.fromEntries(kept.filter((i)=>i.from&&i.from!==i.to.trim()).map((i)=>[i.from,i.to.trim()]));
    const options=[...new Set(kept.map((i)=>i.to.trim()))];
    return {column,options,removed,renames,affected:this.rows.filter((row)=>removed.includes(row[key])).length};
  }
  editColumnOptions(key,items){
    const plan=this.optionsEditPlan(key,items);
    if(!plan||!["status","dropdown","priority"].includes(plan.column.type)||!plan.options.length)return false;
    this.snapshot(`${plan.column.label} options change undone`);
    this.rows.forEach((row)=>{const value=row[key];if(plan.renames[value]!==undefined)row[key]=plan.renames[value];else if(plan.removed.includes(value))row[key]="";});
    if(plan.renames[plan.column.defaultValue]!==undefined)plan.column.defaultValue=plan.renames[plan.column.defaultValue];else if(plan.removed.includes(plan.column.defaultValue))plan.column.defaultValue="";
    plan.column.options=plan.options;
    this.log(`Updated ${plan.column.label} options`);this.save();
    return {cleared:plan.affected};
  }
  // Basic per-column filter: {key, op, value}. Session state only, like the status filter and search.
  matchesColumnFilter(row){
    const filter=this.columnFilter, column=filter&&this.board?.columns.find((c)=>c.key===filter.key); if(!column)return true;
    const value=row[column.key], text=String(value??"").trim(), wanted=filter.value;
    switch(filter.op){
      case "in": return (Array.isArray(wanted)?wanted:[wanted]).includes(text);
      case "checked": return Boolean(value)===true;
      case "unchecked": return !value;
      case "contains": return text.toLowerCase().includes(String(wanted||"").toLowerCase());
      case "equals": return text.toLowerCase()===String(wanted||"").trim().toLowerCase();
      case "eq": return this.hasValue(value)&&Number(text)===Number(wanted);
      case "gt": return this.hasValue(value)&&Number(text)>Number(wanted);
      case "lt": return this.hasValue(value)&&Number(text)<Number(wanted);
      case "on": return text===wanted;
      case "before": return this.hasValue(value)&&text<wanted;
      case "after": return this.hasValue(value)&&text>wanted;
      case "empty": return !this.hasValue(value);
      case "not-empty": return this.hasValue(value);
      default: return true;
    }
  }
  // Drag-to-reorder: only columns[] order changes; the primary column always stays first.
  moveColumnTo(key,targetKey,position="before"){
    const cols=this.board.columns, from=cols.findIndex((c)=>c.key===key), target=cols.findIndex((c)=>c.key===targetKey);
    if(key==="serial"||from<0||target<0||key===targetKey)return false;
    let to=target+(position==="after"?1:0); if(from<to)to-=1; to=Math.max(1,to); if(to===from)return false;
    this.snapshot("Column reorder undone"); const [column]=cols.splice(from,1); cols.splice(to,0,column); this.save(); return true;
  }
  setColumnVisible(key,visible){if(key==="serial"&&!visible)return false;const column=this.board.columns.find((c)=>c.key===key);if(!column)return false;this.updateColumnConfig({[key]:{visible:Boolean(visible)}});return true;}


}
window.BoardModel = BoardModel;

