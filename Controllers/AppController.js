class AppController {
  constructor(root) {
    this.root = root; this.auth = new AuthModel(); this.model = new BoardModel(); this.view = new AppView(root);
    root.addEventListener("click", (event) => this.onClick(event));
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener("change", (event) => this.onChange(event));
    root.addEventListener("submit", (event) => this.onSubmit(event));
    root.addEventListener("pointerdown", () => this.auth.touch());
    root.addEventListener("keyup", (event) => { if (event.target.dataset?.action === "password-input") { const warning=document.querySelector("#caps-warning"); if(warning) warning.hidden=!event.getModifierState("CapsLock"); } });
    document.addEventListener("keydown", (event) => this.onKeydown(event));
    setInterval(() => { if (this.auth.checkTimeout()) this.update(); }, 30000);
    this.update();
  }
  update() { this.auth.authenticated ? this.view.render(this.model) : this.view.renderLogin(this.auth,this.model); }

  onClick(event) {
    const target = event.target.closest("[data-action]"); if (!target) return;
    const action = target.dataset.action;
    if (action === "toggle-password") { const input=document.querySelector('[name="password"]'); const showing=input.type === "text"; input.type=showing?"password":"text"; target.textContent=showing?"Show":"Hide"; target.setAttribute("aria-label",showing?"Show password":"Hide password"); }
    if (action === "nav") { this.model.openScreen(target.dataset.screen); this.update(); }
    if (action === "open-board") { this.model.openBoard(target.dataset.id); this.update(); }
    if (action === "open-record-board") { this.model.openBoard(target.dataset.board,target.dataset.workspace); this.update(); }
    if (action === "toggle-nav") document.querySelector("#sidebar").classList.toggle("open");
    if (action === "collapse-nav") document.body.classList.toggle("nav-collapsed");
    if (action === "workspace-menu") this.view.showWorkspaceMenu(this.model);
    if (action === "switch-workspace") { this.model.switchWorkspace(target.dataset.id); this.view.closeOverlay(); this.update(); }
    if (action === "more-menu") this.view.showMore();
    if (action === "board-menu") this.view.showBoardMenu(this.model.workspace.boards.find((board) => board.id === target.dataset.id));
    if (action === "new-board") this.view.showBoardForm();
    if (action === "rename-board") this.view.showBoardForm(this.model.workspace.boards.find((board) => board.id === target.dataset.id));
    if (action === "duplicate-board") { this.model.duplicateBoard(target.dataset.id); this.view.closeOverlay(); this.update(); this.view.toast("Board duplicated"); }
    if (action === "delete-board") this.view.showConfirm("Delete board?","The board and its records will be removed. You can still use Undo afterward.","confirm-delete-board",target.dataset.id);
    if (action === "confirm-delete-board") this.deleteBoard(target.dataset.payload);
    if (action === "view") { this.model.currentView = target.dataset.view; this.model.selected.clear(); this.update(); }
    if (action === "new-view") this.view.showQuickChoice("Choose a board view",["Table","Kanban","Activity"],"select-view-choice","");
    if (action === "select-view-choice") { this.model.currentView = target.dataset.value.toLowerCase(); this.view.closeOverlay(); this.update(); }
    if (action === "open-form") this.view.showForm({},target.dataset.status || "Review",this.model);
    if (action === "edit") this.view.showForm(this.model.rows.find((row)=>row.id===Number(target.dataset.id)),"Review",this.model);
    if (action === "duplicate-record") { this.model.duplicateRecord(target.dataset.id); this.update(); this.view.toast("Record duplicated"); }
    if (action === "delete") this.requestDeleteRecords([Number(target.dataset.id)]);
    if (action === "delete-selected") this.requestDeleteRecords([...this.model.selected]);
    if (action === "confirm-delete-records") this.deleteRecords(target.dataset.payload.split(",").map(Number));
    if (action === "clear-selection") { this.model.selected.clear(); this.update(); }
    if (action === "sort") { this.model.sortDirection = this.model.sortDirection === "desc" ? "asc" : "desc"; this.update(); }
    if (action === "group") { this.model.grouped = !this.model.grouped; this.update(); }
    if (action === "clear-filters") { this.model.query=""; this.model.status="All"; this.update(); }
    if (action === "toggle-favorite") { this.model.toggleFavorite(this.model.currentBoardId); this.update(); this.view.toast(this.model.board.favorite?"Board added to favorites":"Board removed from favorites"); }
    if (action === "edit-description") this.view.showDescription(this.model);
    if (action === "quick-add") { this.model.quickAdd(); this.update(); this.view.toast("Quick record added. Edit any cell directly."); }
    if (action === "undo") { const label=this.model.undo(); this.update(); this.view.toast(label); }
    if (action === "manage-groups") this.view.showGroupManager(this.model);
    if (action === "save-group") { const input=target.closest(".manager-row").querySelector('[data-role="group-name"]'); if (input.value !== target.dataset.old) { this.model.renameGroup(target.dataset.old,input.value); this.view.showGroupManager(this.model); } }
    if (action === "request-delete-group") { const fallback=this.model.board.groups.find((group)=>group!==target.dataset.group); this.view.showConfirm("Delete group?",`Items in ${target.dataset.group} will move to ${fallback}.`,"confirm-delete-group",target.dataset.group); }
    if (action === "confirm-delete-group") { const fallback=this.model.board.groups.find((group)=>group!==target.dataset.payload); this.model.deleteGroup(target.dataset.payload,fallback); this.view.closeOverlay(); this.update(); this.view.toast("Group deleted"); }
    if (action === "manage-columns") this.view.showColumnManager(this.model);
    if (action === "saved-views") this.view.showSavedViews(this.model);
    if (action === "apply-saved-view") { this.model.applyView(target.dataset.id); this.view.closeOverlay(); this.update(); }
    if (action === "delete-saved-view") { this.model.deleteView(target.dataset.id); this.view.showSavedViews(this.model); }
    if (action === "quick-status") this.view.showQuickChoice("Change status",["Review","Defective","Clear"],"apply-status",target.dataset.id);
    if (action === "apply-status") this.applyMove(target.dataset.id,{status:target.dataset.value});
    if (action === "quick-group") this.view.showQuickChoice("Move to group",["New","Working","Done"],"apply-group",target.dataset.id);
    if (action === "apply-group") this.applyMove(target.dataset.id,{group:target.dataset.value});
    if (action === "move-status") this.applyMove(target.dataset.id,{status:target.dataset.status});
    if (action === "bulk-status") this.view.showQuickChoice("Set selected status",["Review","Defective","Clear"],"apply-bulk-status","");
    if (action === "apply-bulk-status") { [...this.model.selected].forEach((id)=>this.model.moveRecord(id,{status:target.dataset.value})); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Selected records updated"); }
    if (action === "bulk-owner") this.view.showQuickChoice("Assign selected records",[this.model.profile.initials,"Engineering","QA Team","Unassigned"],"apply-bulk-owner","");
    if (action === "apply-bulk-owner") { this.model.bulkUpdate([...this.model.selected],"owner",target.dataset.value); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Owners updated"); }
    if (action === "bulk-priority") this.view.showQuickChoice("Set selected priority",["Low","Medium","High","Critical"],"apply-bulk-priority","");
    if (action === "apply-bulk-priority") { this.model.bulkUpdate([...this.model.selected],"priority",target.dataset.value); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Priorities updated"); }
    if (action === "settings") this.view.showSettings(this.model);
    if (action === "theme") { this.model.updateSetting("theme",target.dataset.theme); this.view.applyDisplay(this.model); this.view.showSettings(this.model); }
    if (action === "invite") this.view.showInvite();
    if (action === "profile-menu") this.view.showProfileMenu(this.model,this.auth);
    if (action === "lock-session") { this.auth.lock(); this.update(); }
    if (action === "request-logout") this.view.showConfirm("Sign out of Medtek?","Your local board data will remain on this browser.","confirm-logout");
    if (action === "confirm-logout") { this.auth.logout(); this.update(); }
    if (action === "profile-settings") this.view.showProfileSettings(this.model);
    if (action === "choose-avatar") document.querySelector("#avatar-file").click();
    if (action === "remove-avatar") { this.model.setAvatar(""); this.view.showProfileSettings(this.model); }
    if (action === "set-presence") { this.model.updateProfile({presence:target.dataset.value}); this.view.showProfileMenu(this.model); this.view.toast(`Status set to ${target.dataset.value}`); }
    if (action === "notifications") this.view.showNotifications(this.model);
    if (action === "mark-notifications") { this.model.markAllNotificationsRead(); this.view.showNotifications(this.model); }
    if (action === "clear-notifications") this.view.showConfirm("Clear notifications?","This removes every notification from your local inbox.","confirm-clear-notifications");
    if (action === "confirm-clear-notifications") { this.model.clearNotifications(); this.view.closeOverlay(); this.update(); }
    if (action === "open-notification") { const item=this.model.notifications.find((note)=>note.boardId===target.dataset.board && note.workspaceId===target.dataset.workspace && !note.read); if(item)item.read=true; this.model.save(); this.model.openBoard(target.dataset.board,target.dataset.workspace); this.view.closeOverlay(); this.update(); }
    if (action === "command-palette") this.view.showCommandPalette(this.model);
    if (action === "run-command") this.runCommand(target.dataset.command);
    if (action === "global-search") this.view.showGlobalSearch();
    if (action === "shortcuts") this.view.showMessage("Keyboard shortcuts","/  Focus board search\nEnter  Save an inline field\nEscape  Close dialogs or leave a field");
    if (action === "import") document.querySelector("#import-file").click();
    if (action === "export") this.exportCsv();
    if (action === "export-backup") this.exportBackup();
    if (action === "close-overlay" && (event.target === target || target.closest("button"))) this.view.closeOverlay();
  }

  onInput(event) {
    if (event.target.dataset.action === "command-search") { const term=event.target.value.toLowerCase(); document.querySelectorAll(".command-list button").forEach((button)=>{ button.hidden=!button.dataset.label.includes(term); }); return; }
    if (event.target.dataset.action !== "search") return;
    const cursor=event.target.selectionStart; this.model.query=event.target.value; this.update();
    const input=document.querySelector('[data-action="search"]'); input?.focus(); input?.setSelectionRange(cursor,cursor);
  }
  onChange(event) {
    const action=event.target.dataset.action;
    if (action === "filter") { this.model.status=event.target.value; this.update(); }
    if (action === "select") { this.model.toggleRow(Number(event.target.dataset.id)); this.update(); }
    if (action === "select-all") { this.model.visibleRows.forEach((row)=>event.target.checked?this.model.selected.add(row.id):this.model.selected.delete(row.id)); this.update(); }
    if (action === "density") { this.model.updateSetting("density",event.target.checked?"compact":"comfortable"); document.documentElement.dataset.density=this.model.settings.density; }
    if (action === "setting") { this.model.updateSetting(event.target.dataset.key,event.target.checked); this.update(); this.view.showSettings(this.model); }
    if (action === "setting-select") { this.model.updateSetting(event.target.dataset.key,event.target.value.toLowerCase()); this.update(); this.view.showSettings(this.model); }
    if (action === "accent-color") { this.model.updateSetting("accentColor",event.target.value); this.view.applyDisplay(this.model); }
    if (action === "cell-edit") { this.model.updateCell(event.target.dataset.id,event.target.dataset.field,event.target.value); this.update(); this.view.toast(`${event.target.dataset.field} saved`); }
    if (action === "import-file") this.importData(event.target.files[0]);
    if (action === "avatar-file") this.loadAvatar(event.target.files[0]);
  }
  onSubmit(event) {
    event.preventDefault(); const action=event.target.dataset.action; const data=Object.fromEntries(new FormData(event.target));
    if (action === "login-form") { const signedIn=this.auth.login(data.username,data.password,Boolean(data.rememberSession),Boolean(data.rememberUsername)); if(signedIn)this.model.syncUsername(data.username); this.update(); return; }
    if (action === "record-form") { const edit=Boolean(data.id); this.model.upsert(data); this.view.closeOverlay(); this.update(); this.view.toast(edit?"Record updated":"Record added"); }
    if (action === "board-form") { if (data.id) this.model.renameBoard(data.id,data.name); else this.model.createBoard(data.name); this.view.closeOverlay(); this.update(); this.view.toast(data.id?"Board renamed":"Board created"); }
    if (action === "invite-form") { this.view.closeOverlay(); this.view.toast("Local invitation created"); }
    if (action === "global-search-form") this.globalSearch(data.term);
    if (action === "add-group-form") { if (this.model.addGroup(data.name)) { this.view.showGroupManager(this.model); this.view.toast("Group added"); } else this.view.showMessage("Group not added","Use a unique, non-empty group name."); }
    if (action === "column-form") { const config={}; this.model.columnDefinitions.forEach((column)=>{ config[column.key]={ visible:Boolean(data[`visible-${column.key}`]), connection:data[`connection-${column.key}`] || "" }; }); this.model.updateColumnConfig(config); this.view.closeOverlay(); this.update(); this.view.toast("Column settings saved"); }
    if (action === "save-view-form") { if (this.model.saveView(data.name)) { this.view.closeOverlay(); this.update(); this.view.toast("View saved"); } }
    if (action === "profile-form") { data.name=this.auth.username; this.model.updateProfile(data); this.view.closeOverlay(); this.update(); this.view.toast("Profile updated"); }
    if (action === "description-form") { this.model.updateBoardDescription(data.description); this.view.closeOverlay(); this.update(); this.view.toast("Description saved"); }
  }
  onKeydown(event) {
    if (event.key === "Escape") this.view.closeOverlay();
    if (this.auth.authenticated && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); this.view.showCommandPalette(this.model); }
    if (event.target.dataset?.action === "cell-edit" && event.key === "Enter") { event.preventDefault(); event.target.blur(); }
    if (event.target.dataset?.action === "cell-edit" && event.key === "Escape") { event.preventDefault(); this.update(); }
    if (event.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)) { event.preventDefault(); document.querySelector("#board-search")?.focus(); }
  }
  applyMove(id,updates) { this.model.moveRecord(id,updates); this.view.closeOverlay(); this.update(); this.view.toast("Record moved"); }
  requestDeleteRecords(ids) { if (ids.length) this.view.showConfirm(`Delete ${ids.length} record${ids.length===1?"":"s"}?`,"The selected data will be removed from this board. Undo remains available afterward.","confirm-delete-records",ids.join(",")); }
  deleteRecords(ids) { if (!ids.length) return; this.model.remove(ids); this.view.closeOverlay(); this.update(); this.view.toast("Record deleted"); }
  deleteBoard(id) { try { this.model.deleteBoard(id); this.view.closeOverlay(); this.update(); this.view.toast("Board deleted"); } catch(error) { this.view.showMessage("Board not deleted",error.message); } }
  globalSearch(term) { if (!term) return; const match=this.model.allRecords.find((row)=>[row.serial,row.invoice,row.notes].some((value)=>String(value||"").toLowerCase().includes(term.toLowerCase()))); if (!match) { this.view.showMessage("No matching records",`No record matched “${term}”.`); return; } this.model.openBoard(match.boardId,match.workspaceId); this.model.query=term; this.view.closeOverlay(); this.update(); }
  runCommand(command) { this.view.closeOverlay(); if(command==="home"){this.model.openScreen("home");this.update();} if(command==="mywork"){this.model.openScreen("mywork");this.update();} if(command==="new-record")this.view.showForm({},"Review",this.model); if(command==="new-board")this.view.showBoardForm(); if(command==="notifications")this.view.showNotifications(this.model); if(command==="profile")this.view.showProfileSettings(this.model); if(command==="settings")this.view.showSettings(this.model); }
  loadAvatar(file) { if(!file)return; if(file.size>1024*1024){this.view.showMessage("Photo is too large","Choose an image smaller than 1 MB.");return;} const reader=new FileReader(); reader.onload=()=>{this.model.setAvatar(reader.result);this.view.showProfileSettings(this.model);this.view.toast("Profile photo updated");}; reader.onerror=()=>this.view.showMessage("Photo not loaded","The selected image could not be read."); reader.readAsDataURL(file); }
  exportCsv() { const fields=["serial","group","owner","received","invoice","invoiceDate","dueDate","status","priority","notes"]; const quote=(value)=>`"${String(value||"").replaceAll('"','""')}"`; const csv=[fields.join(","),...this.model.visibleRows.map((row)=>fields.map((field)=>quote(row[field])).join(","))].join("\n"); this.download(new Blob([csv],{type:"text/csv"}),`${this.model.board.name.toLowerCase().replace(/[^a-z0-9]+/g,"-")}.csv`); this.view.toast("Board exported"); }
  exportBackup() { const backup=JSON.stringify(this.model.createBackup(),null,2); this.download(new Blob([backup],{type:"application/json"}),"medtek-database-v7-backup.json"); this.view.toast("Full backup exported"); }
  async importData(file) { if (!file) return; try { const text=await file.text(); if(file.name.toLowerCase().endsWith(".csv")){this.model.importRows(this.parseCsv(text));this.update();this.view.toast(`${this.model.rows.length} CSV records imported`);return;} const data=JSON.parse(text); if(data.workspaces)this.model.restoreBackup(data); else this.model.importRows(data.rows||data); this.update(); this.view.toast(data.workspaces?"Medtek backup restored":`${this.model.rows.length} records imported`); } catch(error) { this.view.showMessage("Import failed",error.message); } }
  parseCsv(text) { const parseLine=(line)=>{const cells=[];let value="",quoted=false;for(let i=0;i<line.length;i++){const char=line[i];if(char==='"'&&quoted&&line[i+1]==='"'){value+='"';i++;}else if(char==='"'){quoted=!quoted;}else if(char===","&&!quoted){cells.push(value);value="";}else value+=char;}cells.push(value);return cells;}; const lines=text.replace(/\r/g,"").split("\n").filter((line)=>line.trim()); if(lines.length<2)throw new Error("CSV must include a header and at least one record."); const headers=parseLine(lines.shift()).map((header)=>header.trim()); return lines.map((line)=>Object.fromEntries(headers.map((header,index)=>[header,parseLine(line)[index]||""]))); }
  download(blob,filename) { const url=URL.createObjectURL(blob),link=document.createElement("a"); link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),500); }
}
new AppController(document.querySelector("#app"));
