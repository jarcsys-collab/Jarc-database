class AppController {
  constructor(root) {
    this.root = root; this.auth = new AuthModel(); this.model = new BoardModel(); this.view = new AppView(root);this.view.onUndo=()=>{const label=this.model.undo();this.update();this.view.toast(label);};
    root.addEventListener("click", (event) => this.guard(()=>this.onClick(event)));
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener("change", (event) => this.guard(()=>this.onChange(event)));
    root.addEventListener("submit", (event) => this.guard(()=>this.onSubmit(event)));
    root.addEventListener("pointerdown", () => this.auth.touch());
    root.addEventListener("keyup", (event) => { if (event.target.dataset?.action === "password-input") { const warning=document.querySelector("#caps-warning"); if(warning) warning.hidden=!event.getModifierState("CapsLock"); } });
    document.addEventListener("keydown", (event) => this.onKeydown(event));
    root.addEventListener("keydown",()=>this.auth.touch());
    setInterval(() => { if (this.auth.checkTimeout()) this.update(); }, 30000);
    setInterval(()=>{if(this.auth.authenticated)return;const button=this.root.querySelector('.login-submit');if(!button)return;const seconds=this.auth.lockSeconds;button.disabled=seconds>0;const label=button.querySelector('span');if(label)label.textContent=seconds?'Try again in '+seconds+'s':this.auth.lockedScreen?'Unlock workspace':'Sign in';},1000);
    this.update();
    root.addEventListener("focusin",e=>{if(e.target.matches('input,textarea,select'))e.target.dataset.beforeEdit=e.target.value;});
    root.addEventListener("contextmenu",e=>this.onContextMenu(e));
    root.addEventListener("pointerdown",e=>this.startResize(e));
    root.addEventListener("pointerdown",e=>this.startRowDrag(e));
    root.addEventListener("pointerdown",e=>this.startColumnDrag(e));
    // Leaving a cell editor saves it (Esc cancels first); leaving an empty draft row discards it.
    root.addEventListener("focusout",e=>{const a=e.target.dataset?.action;if(a==="cell-input")this.commitCell(e.target,"none");else if(a==="draft-input")this.commitDraft(e.target);});
    document.addEventListener("pointerdown",e=>{const overlay=this.root.querySelector('#overlay-root');if(overlay?.querySelector('.popover,.profile-popover')&&!overlay.contains(e.target)&&!e.target.closest('[data-action]'))this.view.closeOverlay();});
    window.addEventListener("jarc-save",()=>this.saveFeedback());window.addEventListener("online",()=>this.saveFeedback());window.addEventListener("offline",()=>this.saveFeedback());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>this.view.applyDisplay(this.model));
    root.addEventListener("pointerover",e=>{
      const target=e.target.closest('button');if(!target)return;
      const label=target.getAttribute("aria-label")||target.dataset.tooltip||target.title;
      if(!label)return;clearTimeout(this.tooltipTimer);document.querySelector('.ui-tooltip')?.remove();
      this.tooltipTimer=setTimeout(()=>{if(!target.isConnected)return;const r=target.getBoundingClientRect();const tip=document.createElement('div');tip.className='ui-tooltip';tip.textContent=label;tip.setAttribute('role','tooltip');document.body.append(tip);tip.style.left=Math.max(8,Math.min(r.left,innerWidth-tip.offsetWidth-8))+'px';tip.style.top=Math.min(innerHeight-tip.offsetHeight-8,r.bottom+7)+'px';},450);
    });
    root.addEventListener("pointerout",()=>{clearTimeout(this.tooltipTimer);document.querySelector('.ui-tooltip')?.remove();});
    this.overlayObserver=new MutationObserver(()=>this.enhanceOverlay());this.overlayObserver.observe(root,{childList:true,subtree:true});
    const originalClose=this.view.closeOverlay.bind(this.view);this.view.closeOverlay=()=>{originalClose();this.boardMenuWorkspace=null;this.root.querySelector(".app-shell")?.removeAttribute("inert");this.overlayReturnFocus?.focus?.();this.overlayReturnFocus=null;};
    if (window.jarcStorage.getPreference("navCollapsed")==="1") document.body.classList.add("nav-collapsed");
    if (window.jarcStorage.getPreference("workspaceSectionCollapsed")==="1") document.body.classList.add("workspace-section-collapsed");
  }
  update() { this.auth.authenticated ? this.view.render(this.model) : this.view.renderLogin(this.auth,this.model); this.saveFeedback(); }
  togglePanel(name, opener) { const root=document.querySelector("#overlay-root"); if(root?.dataset.open===name){this.view.closeOverlay();return false;} opener(); const next=document.querySelector("#overlay-root"); if(next)next.dataset.open=name; return true; }
  markPanel(name) { const root=document.querySelector("#overlay-root"); if(root)root.dataset.open=name; }

  onClick(event) {
    const target = event.target.closest("[data-action]"); if (!target) return;
    const action = target.dataset.action;
    if(action==="login-theme-choice"){this.model.updateSetting("theme",target.dataset.theme);this.view.applyDisplay(this.model);this.root.querySelectorAll('[data-action="login-theme-choice"]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.theme===target.dataset.theme)));return;}
    this.lastTrigger=target;
    if(action==="retry-save"){this.model.save({op:"saveState",reason:"retry"});this.saveFeedback();return;}
    if(action==="dismiss-hint"){this.model.updateSetting("dismissedHint",true);this.update();return;}
    if(action==="toggle-home-archived"){this.model.updateSetting("homeArchived",!this.model.settings.homeArchived);this.update();return;}
    if(action==="home-create-record"||action==="home-import"){this.chooseBoardAction(action==="home-import"?"import":"record");return;}
    if(action==="choose-board-action"){this.model.openBoard(target.dataset.id,target.dataset.workspace);this.update();target.dataset.mode==="import"?this.view.showImport(this.model):this.view.showRecordForm(this.model);return;}
    if(action==="favorite-board"){this.view.closeOverlay();this.model.toggleFavorite(target.dataset.id);this.update();return;}
    if(action==="remove-filter"){this.model[target.dataset.key]=target.dataset.key==="status"?"All":target.dataset.key==="quickFilter"?"all":"";this.model.activeSavedViewId=null;this.update();return;}
    if(action==="archive-workspace"){this.model.archiveWorkspace(target.dataset.id,target.dataset.archived==="1");this.update();this.view.showSettings(this.model,"workspace");return;}
    if(action==="restore-backup"){const backup=this.pendingBackup;this.pendingBackup=null;try{this.model.restoreBackup(backup);}catch(error){this.view.showMessage("Backup not restored",`${error.message}

Your current data was not changed.`);return;}this.update();this.view.toast(this.model.saveState==="error"?"Backup restored for this session only — it could not be saved in this browser":"Backup restored",true);return;}
    if(action==="move-record-board"){this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>Move record to…</h2>${this.view.closeButton()}</div><p>Existing field values and missing columns will be preserved.</p><div class="choice-list">${this.model.workspaces.filter(w=>!w.archived).flatMap(w=>w.boards.filter(b=>!b.archived&&b.id!==this.model.board.id).map(b=>`<button data-action="confirm-move-record" data-id="${this.view.attr(target.dataset.id)}" data-board="${this.view.attr(b.id)}">${this.view.escape(w.name)} / ${this.view.escape(b.name)}</button>`)).join("")||"<p>Create another board first.</p>"}</div></div>`);return;}
    if(action==="confirm-move-record"){this.model.moveRecordToBoard(target.dataset.id,target.dataset.board);this.update();this.view.toast("Record moved");return;}
    if(action==="adjacent-record"){const list=this.model.visibleRows;const index=list.findIndex(r=>r.id===Number(target.dataset.id));const row=list[(index+Number(target.dataset.direction)+list.length)%list.length];if(row)this.view.showRecordForm(this.model,row);return;}
    if(["rename-board","duplicate-board","delete-board","archive-board","move-board","favorite-board","open-board"].includes(action)&&this.boardMenuWorkspace){this.model.currentWorkspaceId=this.boardMenuWorkspace;this.boardMenuWorkspace=null;}
    if (action === "toggle-password") { const input=document.querySelector('[name="password"]'); const showing=input.type === "text"; input.type=showing?"password":"text"; target.textContent=showing?"Show":"Hide"; target.setAttribute("aria-label",showing?"Show password":"Hide password"); target.setAttribute("aria-pressed",String(!showing));input.focus(); }
    if (action === "nav") { this.model.openScreen(target.dataset.screen); this.update(); }
    if (action === "open-board") { this.view.closeOverlay();this.model.openBoard(target.dataset.id); this.update(); }
    if (action === "open-record-board") { this.model.openBoard(target.dataset.board,target.dataset.workspace); this.update(); }
    if (action === "toggle-nav") document.querySelector("#sidebar").classList.toggle("open");
    if (action === "collapse-nav") { document.body.classList.toggle("nav-collapsed"); window.jarcStorage.setPreference("navCollapsed",document.body.classList.contains("nav-collapsed")?"1":"0"); }
    if (action === "toggle-workspace-section") { document.body.classList.toggle("workspace-section-collapsed"); window.jarcStorage.setPreference("workspaceSectionCollapsed",document.body.classList.contains("workspace-section-collapsed")?"1":"0"); }
    if (action === "workspace-menu") this.togglePanel("workspace",()=>this.view.showWorkspaceMenu(this.model));
    if (action === "create-workspace") this.view.showWorkspaceForm();
    if (action === "record-menu") this.togglePanel(`record-${target.dataset.id}`,()=>this.view.showRecordMenu(this.model.rows.find((row)=>row.id===Number(target.dataset.id))));
    if (action === "switch-workspace") { this.model.switchWorkspace(target.dataset.id); this.view.closeOverlay(); this.update(); }
    if(action==="board-menu"){this.boardMenuWorkspace=target.dataset.workspace||this.model.currentWorkspaceId;const ws=this.model.workspaces.find(w=>w.id===this.boardMenuWorkspace);this.togglePanel(`board-${target.dataset.id}`,()=>this.view.showBoardMenu(ws.boards.find(b=>b.id===target.dataset.id)));}
    if (action === "new-board") this.view.showBoardForm(null);
    if (action === "rename-board") this.view.showBoardForm(this.model.workspace.boards.find((board) => board.id === target.dataset.id));
    if (action === "duplicate-board") { this.model.duplicateBoard(target.dataset.id); this.view.closeOverlay(); this.update(); this.view.toast("Board duplicated"); }
    if (action === "delete-board") this.view.showConfirm("Delete board?","The board and its records will be removed. You can still use Undo afterward.","confirm-delete-board",target.dataset.id);
    if (action === "confirm-delete-board") this.deleteBoard(target.dataset.payload);
    if (action === "archived-view") { this.model.showArchived=true; this.model.activeSavedViewId=null; this.model.selected.clear(); this.update(); }
    if (["open-form","new-item"].includes(action)) this.view.showRecordForm(this.model);
    if (action === "edit") this.view.showRecordForm(this.model,this.model.rows.find((row)=>row.id===Number(target.dataset.id)));
    if (action === "duplicate-record") { const id=this.model.duplicateRecord(target.dataset.id); this.update(); if(id)this.focusItem(id); this.view.toast("Item duplicated"); }
    if (action === "pin-item") { this.model.togglePin(target.dataset.id); this.update(); this.view.toast("Pin updated"); }
    if (action === "archive-item") { const row=this.model.rows.find((item)=>item.id===Number(target.dataset.id)); const archive=!row.archived; this.model.archiveItem(target.dataset.id,archive); this.update(); this.view.toast(archive?"Record archived":"Record restored",true); }
    if (action === "delete") this.requestDeleteRecords([Number(target.dataset.id)]);
    if (action === "delete-selected") this.requestDeleteRecords([...this.model.selected]);
    if (action === "confirm-delete-records") this.deleteRecords(target.dataset.payload.split(",").map(Number));
    if (action === "clear-selection") { this.model.selected.clear(); this.update(); }
    if(action==="sort")this.view.showSort(this.model);
    if (action === "group") { if(!this.model.groupColumn){this.togglePanel("group-help",()=>this.view.showGroupHelp());return;} this.model.grouped = !this.model.grouped; this.model.activeSavedViewId=null; this.update(); }
    if (action === "clear-filters") { this.model.resetMainView(); this.update(); }
    if (action === "toggle-favorite") { this.model.toggleFavorite(this.model.currentBoardId); this.update(); this.view.toast(this.model.board.favorite?"Board added to favorites":"Board removed from favorites"); }
    if (action === "edit-description") this.view.showDescription(this.model);
    if (action === "undo") { const label=this.model.undo(); this.update(); this.view.toast(label); }
    if (action === "manage-groups") this.view.showGroupManager(this.model);
    if (action === "save-group") { const input=target.closest(".manager-row").querySelector('[data-role="group-name"]'); if (input.value !== target.dataset.old) { this.model.renameGroup(target.dataset.old,input.value); this.view.showGroupManager(this.model); } }
    if (action === "request-delete-group") { const fallback=this.model.board.groups.find((group)=>group!==target.dataset.group); this.view.showConfirm("Delete group?",`Items in ${target.dataset.group} will move to ${fallback}.`,"confirm-delete-group",target.dataset.group); }
    if (action === "confirm-delete-group") { const fallback=this.model.board.groups.find((group)=>group!==target.dataset.payload); this.model.deleteGroup(target.dataset.payload,fallback); this.view.closeOverlay(); this.update(); this.view.toast("Group deleted"); }
    if (action === "manage-columns") this.togglePanel("columns",()=>this.view.showColumnManager(this.model));
    if (action === "add-column") this.view.showAddColumn(this.model);
    if (action === "column-editor") this.togglePanel(`column-${target.dataset.key}`,()=>this.view.showColumnEditor(this.model,target.dataset.key));
    if (action === "move-column") { const moved=this.model.moveColumn(target.dataset.key,target.dataset.direction); this.view.showColumnEditor(this.model,target.dataset.key); this.markPanel(`column-${target.dataset.key}`); this.view.toast(moved?"Column moved":"The primary record column stays first"); }
    if (action === "duplicate-column") { const copy=this.model.duplicateColumn(target.dataset.key); this.view.closeOverlay(); this.update(); if(copy)this.view.toast("Column duplicated"); }
    if (action === "request-delete-column") {
      // Empty columns delete straight away (with Undo); columns holding data ask first and say how much.
      const column=this.model.board.columns.find((item)=>item.key===target.dataset.key); if(!column||column.key==="serial")return;
      const used=this.model.columnUsage(column.key);
      if(!used){this.model.deleteColumn(column.key);this.view.closeOverlay();this.update();this.view.toast(`${column.label} column deleted`,true);}
      else this.view.showConfirm(`Delete "${column.label}"?`,`This column contains data in ${used} record${used===1?"":"s"}. Deleting it will remove those values.`,"confirm-delete-column",column.key,"Delete column");
    }
    if (action === "confirm-delete-column") { this.model.deleteColumn(target.dataset.payload); this.view.closeOverlay(); this.update(); this.view.toast("Column deleted",true); }
    // ---- Table interaction (Stage 4)
    if (action === "cell-open") { this.openCell(target); return; }
    if (action === "set-cell-option") { const id=Number(target.dataset.id), field=target.dataset.field, column=this.model.board.columns.find((c)=>c.key===field); this.model.updateCell(id,field,target.dataset.value); this.view.closeOverlay(); if(column?.type==="group"&&this.model.grouped)this.refreshBoard(); else this.patchCell(id,field,true); return; }
    if (action === "inline-add") { this.startInlineAdd(target); return; }
    if (action === "sort-column") { this.applySort(target.dataset.key,target.dataset.direction); return; }
    if (action === "clear-sort") { this.applySort("","desc"); return; }
    if (action === "filter-column") { this.view.showColumnFilter(this.model,target.dataset.key); return; }
    if (action === "clear-column-filter") { this.model.columnFilter=null; this.model.activeSavedViewId=null; this.view.closeOverlay(); this.update(); return; }
    if (action === "move-column-menu") { const moved=this.model.moveColumn(target.dataset.key,target.dataset.direction); this.view.closeOverlay(); this.update(); if(moved){this.view.toast("Column moved",true);this.root.querySelector(`[data-action="column-menu"][data-key="${CSS.escape(target.dataset.key)}"]`)?.focus();} return; }
    if (action === "show-column" || action === "show-all-columns") { const keys=action==="show-column"?[target.dataset.key]:this.model.board.columns.filter((c)=>c.visible===false).map((c)=>c.key); this.model.updateColumnConfig(Object.fromEntries(keys.map((key)=>[key,{visible:true}]))); this.update(); this.view.showColumnManager(this.model); this.markPanel("columns"); this.view.toast(keys.length===1?"Column shown":`${keys.length} columns shown`,true); return; }
    if (action === "column-menu") this.togglePanel(`column-menu-${target.dataset.key}`,()=>this.view.showColumnMenu(this.model,target.dataset.key));
    if (action === "choose-column-type") { this.view.showColumnNameStep(this.model,target.dataset.type); this.selectOverlayInput('[name="label"]'); }
    if (action === "rename-column") { this.view.showRenameColumn(this.model,target.dataset.key); this.selectOverlayInput('[name="label"]'); }
    if (action === "change-column-type") this.view.showColumnChooser(this.model,{mode:"change",key:target.dataset.key});
    if (action === "choose-new-type") this.changeColumnType(target.dataset.key,target.dataset.type);
    if (action === "confirm-change-type") { const [key,type]=target.dataset.payload.split("|"); this.changeColumnType(key,type,true); }
    if (action === "edit-column-options") this.view.showOptionEditor(this.model,target.dataset.key);
    if (action === "add-option-row") { const list=target.closest("form").querySelector(".option-list"); list.insertAdjacentHTML("beforeend",this.view.optionRow()); list.lastElementChild.querySelector("input").focus(); }
    if (action === "remove-option-row") { const row=target.closest(".option-row"), next=row.nextElementSibling||row.previousElementSibling; row.remove(); (next?.querySelector("input")||this.root.querySelector('[data-action="add-option-row"]'))?.focus(); }
    if (action === "confirm-column-options") this.applyColumnOptions(true);
    if (action === "hide-column") { const column=this.model.board.columns.find((item)=>item.key===target.dataset.key); if(column&&this.model.setColumnVisible(column.key,false)){this.view.closeOverlay();this.update();this.view.toast(`${column.label} hidden · show it again from Columns`,true);} }
    if (action === "add-group-column") { const column=this.model.addColumn({label:this.model.uniqueColumnLabel("Group"),type:"group"}); if(column){this.model.grouped=true;this.view.closeOverlay();this.update();this.view.toast("Group column added",true);} }
    if (action === "saved-views") this.togglePanel("views",()=>this.view.showSavedViews(this.model));
    if (action === "set-view") { this.model.setView(target.dataset.view); this.model.showArchived=false; this.update(); }
    if (action === "density-menu") this.togglePanel("density",()=>this.view.showDensityMenu(this.model));
    if (action === "set-density") { this.model.updateSetting("density",target.dataset.value); this.view.closeOverlay(); this.update(); }
    if (action === "view-overflow") this.togglePanel("view-overflow",()=>this.view.showViewOverflow(this.model));
    if (action === "apply-saved-view") { this.model.applyView(target.dataset.id); this.view.closeOverlay(); this.update(); }
    if (action === "delete-saved-view") { this.model.deleteView(target.dataset.id); this.view.showSavedViews(this.model); }
    if (action === "bulk-status") this.view.showQuickChoice("Set selected status",this.model.statusColumn.options.length?this.model.statusColumn.options:["Review","Defective","Clear"],"apply-bulk-status","");
    if (action === "apply-bulk-status") { this.model.bulkUpdate([...this.model.selected],this.model.statusColumn.key,target.dataset.value); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Selected records updated"); }
    if (action === "bulk-owner") this.view.showQuickChoice("Assign selected records",[...new Set([this.model.profile.initials,...this.model.members.map(m=>m.name),"Unassigned"])],"apply-bulk-owner","");
    if (action === "apply-bulk-owner") { this.model.bulkUpdate([...this.model.selected],this.model.ownerColumn.key,target.dataset.value); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Owners updated"); }
    if (action === "bulk-priority") this.view.showQuickChoice("Set selected priority",["Low","Medium","High","Critical"],"apply-bulk-priority","");
    if (action === "apply-bulk-priority") { this.model.bulkUpdate([...this.model.selected],this.model.priorityColumn.key,target.dataset.value); this.model.selected.clear(); this.view.closeOverlay(); this.update(); this.view.toast("Priorities updated"); }
    if (action === "settings") this.togglePanel("settings",()=>this.view.showSettings(this.model));
    if (action === "settings-section") { this.model.updateSetting("settingsSection",target.dataset.section); this.view.showSettings(this.model,target.dataset.section); this.markPanel("settings"); }
    if (action === "workspace-manage") this.view.showSettings(this.model,"workspace");
    if (action === "request-delete-workspace") this.view.showConfirm("Delete workspace?","All boards and records in this workspace will be deleted from this browser.","confirm-delete-workspace",target.dataset.id);
    if (action === "confirm-delete-workspace") { try{this.model.deleteWorkspace(target.dataset.payload);this.view.closeOverlay();this.update();this.view.toast("Workspace deleted",true);}catch(error){this.view.showMessage("Workspace not deleted",error.message);} }
    if (action === "remove-member") { this.model.removeMember(target.dataset.id); this.view.showSettings(this.model,"members"); }
    if (action === "theme") { this.model.updateSetting("theme",target.dataset.theme); this.view.applyDisplay(this.model); this.view.showSettings(this.model); this.markPanel("settings"); }
    if (action === "invite") this.view.showInvite();
    if (action === "profile-menu") this.togglePanel("profile",()=>this.view.showProfileMenu(this.model,this.auth));
    if (action === "lock-session") { this.auth.lock(); this.update(); }
    if (action === "request-logout") this.view.showConfirm("Sign out of Jarc?","Your local board data will remain on this browser.","confirm-logout");
    if (action === "confirm-logout") { this.auth.logout(); this.update(); }
    if (action === "profile-settings") this.view.showProfileSettings(this.model);
    if (action === "choose-avatar") document.querySelector("#avatar-file").click();
    if (action === "remove-avatar") { this.model.setAvatar(""); this.view.showProfileSettings(this.model); }
    if (action === "set-presence") { this.model.updateProfile({presence:target.dataset.value}); this.view.showProfileMenu(this.model,this.auth); this.markPanel("profile"); this.view.toast(`Status set to ${target.dataset.value}`); }
    if (action === "notifications") this.togglePanel("notifications",()=>this.view.showNotifications(this.model));
    if (action === "notification-filter") { this.view.showNotifications(this.model,target.dataset.filter); this.markPanel("notifications"); }
    if (action === "mark-notifications") { this.model.markAllNotificationsRead(); this.view.showNotifications(this.model); this.markPanel("notifications"); }
    if (action === "clear-notifications") this.view.showConfirm("Clear notifications?","This removes every notification from your local inbox.","confirm-clear-notifications");
    if (action === "confirm-clear-notifications") { this.model.clearNotifications(); this.view.closeOverlay(); this.update(); }
    if (action === "open-notification") { const item=this.model.notifications.find((note)=>note.boardId===target.dataset.board && note.workspaceId===target.dataset.workspace && !note.read); if(item)item.read=true; this.model.save({op:"updateUserState"}); this.model.openBoard(target.dataset.board,target.dataset.workspace); this.view.closeOverlay(); this.update(); }
    if (action === "command-palette") this.view.showCommandPalette(this.model);
    if (action === "palette-workspace") { this.model.switchWorkspace(target.dataset.id); this.view.closeOverlay(); this.update(); }
    if (action === "palette-board") { this.model.openBoard(target.dataset.id,target.dataset.workspace); this.view.closeOverlay(); this.update(); }
    if (action === "palette-record") { this.model.openBoard(target.dataset.board,target.dataset.workspace); const row=this.model.rows.find(r=>r.id===Number(target.dataset.id)); this.update(); this.view.showRecordForm(this.model,row); }
    if (action === "run-command") this.runCommand(target.dataset.command);
    if (action === "global-search") this.view.showGlobalSearch();
    if(action==="move-board"){const choices=this.model.workspaces.filter(w=>w.id!==this.model.currentWorkspaceId&&!w.archived);this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>Move board to workspace</h2>${this.view.closeButton()}</div><div class="choice-list">${choices.map(w=>`<button data-action="apply-move-board" data-id="${this.view.attr(target.dataset.id)}" data-workspace="${this.view.attr(w.id)}">${this.view.escape(w.name)}</button>`).join("")||"<p>Create another workspace to move this board.</p>"}</div></div>`);}
    if (action === "apply-move-board") { const ws=this.model.workspaces.find(w=>w.id===target.dataset.workspace); if(ws){this.model.moveBoardToWorkspace(target.dataset.id,ws.id);this.view.closeOverlay();this.update();this.view.toast("Board moved");} }
    if (action === "archive-board") { this.model.archiveBoard(target.dataset.id,!this.model.workspace.boards.find(b=>b.id===target.dataset.id)?.archived); this.view.closeOverlay();this.update();this.view.toast("Board archive updated"); }
    if(action==="shortcuts")this.view.showShortcuts();
    if (action === "import") this.view.showImport(this.model);
    if (action === "choose-import-file") document.querySelector("#import-file").click();
    if (action === "export") this.exportCsv();
    if (action === "export-backup") this.exportBackup();
    if (action === "close-overlay" && (event.target === target || target.closest("button"))) this.view.closeOverlay();
  }

  onInput(event) {
    if (event.target.dataset.action === "workspace-search") { const term=event.target.value.toLowerCase(); document.querySelectorAll(".workspace-list > button").forEach((button)=>{button.hidden=!button.textContent.toLowerCase().includes(term);}); return; }
    if (event.target.dataset.action === "command-search") { this.view.showCommandPalette(this.model,event.target.value); return; }
    if (event.target.dataset.action === "column-type-search") {
      const term=event.target.value.trim().toLowerCase(), modal=event.target.closest(".column-chooser"), options=[...modal.querySelectorAll(".chooser-option")];
      options.forEach((b)=>{b.hidden=Boolean(term)&&!b.dataset.search.includes(term);});
      modal.querySelectorAll(".chooser-group").forEach((g)=>{g.hidden=![...g.querySelectorAll(".chooser-option")].some((b)=>!b.hidden);});
      modal.querySelector(".chooser-empty").hidden=options.some((b)=>!b.hidden); return;
    }
    if (event.target.dataset.action !== "search") return;
    const cursor=event.target.selectionStart; this.model.query=event.target.value; this.model.activeSavedViewId=null; this.update();
    const input=document.querySelector('[data-action="search"]'); input?.focus(); input?.setSelectionRange(cursor,cursor);
  }
  onChange(event) {
    const action=event.target.dataset.action;
    if(action==="login-theme"){this.model.updateSetting("theme",event.target.value);this.view.applyDisplay(this.model);return;}
    if(action==="home-sort"){this.model.updateSetting("homeSort",event.target.value);this.update();return;}
    if(action==="quick-view"){this.model.quickFilter=event.target.value;this.model.showArchived=false;this.model.activeSavedViewId=null;this.update();return;}
    if(action==="import-mapping"){const data=Object.fromEntries(new FormData(event.target.form));this.view.showImportPreview(this.model,this.pendingImport,data);return;}
    if (action === "filter") { this.model.status=event.target.value; this.model.activeSavedViewId=null; this.update(); }
    if (action === "select") { this.model.toggleRow(Number(event.target.dataset.id)); this.update(); }
    if (action === "select-all") { this.model.visibleRows.forEach((row)=>event.target.checked?this.model.selected.add(row.id):this.model.selected.delete(row.id)); this.update(); }
    if (action === "density") { this.model.updateSetting("density",event.target.checked?"compact":"comfortable"); document.documentElement.dataset.density=this.model.settings.density; }
    if (action === "setting") { this.model.updateSetting(event.target.dataset.key,event.target.checked); this.update(); this.view.showSettings(this.model); }
    if (action === "setting-select") { const key=event.target.dataset.key; const value=["density","fontSize"].includes(key)?event.target.value.toLowerCase():event.target.value; this.model.updateSetting(key,value); this.update(); this.view.showSettings(this.model,this.model.settings.settingsSection); }
    if (action === "board-title-inline") { this.model.renameBoard(this.model.currentBoardId,event.target.value); this.update(); this.view.toast("Board name saved"); }
    if (action === "import-file") this.importData(event.target.files[0]);
    if (action === "avatar-file") this.loadAvatar(event.target.files[0]);
  }
  onSubmit(event) {
    event.preventDefault(); const action=event.target.dataset.action; const data=Object.fromEntries(new FormData(event.target));
    if (action === "workspace-form") { const workspace=this.model.createWorkspace(data); if(workspace){this.view.closeOverlay();this.update();this.view.toast("Workspace created");} return; }
    if(action==="login-form"){
      data.username=String(data.username||"").trim();
      if(!data.username){const field=event.target.querySelector('[name="username"]');field.value="";field.reportValidity();return;}
      if(!event.target.reportValidity())return;
      this.auth.draftUsername=data.username;this.auth.draftRememberUsername=Boolean(data.rememberUsername);this.auth.draftRememberSession=Boolean(data.rememberSession);
      const signedIn=this.auth.login(data.username,data.password,Boolean(data.rememberSession),Boolean(data.rememberUsername));
      if(signedIn)this.model.syncUsername(data.username);this.update();return;
    }
    if(action==="sort-form"){this.model.sortKey=data.key;this.model.sortDirection=data.direction;this.model.manualSort=false;this.model.board.manualOrder=false;this.model.save({op:"updateBoard",boardId:this.model.board.id});this.model.activeSavedViewId=null;this.update();return;}
    if(action==="confirm-import-form"){const result=this.model.importRows(this.pendingImport,data);this.pendingImport=null;this.update();this.view.toast(result.valid.length+" records imported"+(result.issues.length?" · "+result.issues.length+" skipped":""),true);return;}
    if (action === "record-form") { const edit=Boolean(data.id); this.model.board.columns.filter((column)=>column.type==="checkbox").forEach((column)=>{data[column.key]=Boolean(data[column.key]);}); this.model.upsert(data); this.view.closeOverlay(); this.update(); this.view.toast(edit?"Record updated":"Record added"); }
    if (action === "board-form") { if(data.id){this.model.renameBoard(data.id,data.name);const b=this.model.workspace.boards.find(b=>b.id===data.id);b.description=data.description;this.model.save({op:"updateBoard",boardId:data.id});}else{this.model.currentWorkspaceId=data.workspace;this.model.createBoard(data.name,data.description,data.template);} this.view.closeOverlay(); this.update(); this.view.toast(data.id?"Board renamed":"Board created"); }
    if (action === "invite-form") { if(this.model.addMember(data)){this.view.closeOverlay();this.update();this.view.toast("Member added");}else this.view.showMessage("Member not added","Use a unique email address."); }
    if (action === "global-search-form") this.globalSearch(data.term);
    if (action === "add-group-form") { if (this.model.addGroup(data.name)) { this.view.showGroupManager(this.model); this.view.toast("Group added"); } else this.view.showMessage("Group not added","Use a unique, non-empty group name."); }
    if (action === "column-filter-form") {
      const form=event.target, key=data.key, op=data.op, noValue=["empty","not-empty","checked","unchecked"].includes(op);
      const value=op==="in"?new FormData(form).getAll("value"):String(data.value??"").trim();
      if(op==="in"&&!value.length)this.model.columnFilter=null;
      else if(!noValue&&value===""){form.querySelector('[name="value"]')?.focus();this.view.toast("Enter a value to filter by");return;}
      else this.model.columnFilter={key,op,value:noValue?"":value};
      this.model.activeSavedViewId=null; this.view.closeOverlay(); this.update(); return;
    }
    if (action === "create-column-form") { const column=this.model.addColumn({label:data.label,type:data.type,options:data.options||""}); if(column){this.view.closeOverlay();this.update();this.root.querySelector(`th[data-column-key="${CSS.escape(column.key)}"]`)?.scrollIntoView({block:"nearest",inline:"nearest"});this.view.toast(`${column.label} column added`,true);} }
    if (action === "rename-column-form") { if(this.model.renameColumn(data.key,data.label)){this.view.closeOverlay();this.update();this.view.toast("Column renamed",true);} }
    if (action === "column-options-form") { this.pendingOptions={key:data.key,items:[...event.target.querySelectorAll(".option-row input")].map((input)=>({from:input.dataset.from||null,to:input.value}))}; this.applyColumnOptions(); }
    if (action === "edit-column-form") { this.model.renameColumn(data.key,data.label); this.model.updateColumnConfig({[data.key]:{visible:data.key==="serial"?true:Boolean(data.visible),required:data.key==="serial"?true:Boolean(data.required),connection:data.connection||"",defaultValue:data.defaultValue||"",options:String(data.options||"").split(",").map((item)=>item.trim()).filter(Boolean)}}); this.view.closeOverlay(); this.update(); this.view.toast("Column updated"); }
    if (action === "save-view-form") { if (this.model.saveView(data.name)) { this.view.closeOverlay(); this.update(); this.view.toast("View saved"); } }
    if (action === "profile-form") { data.name=this.auth.username; this.model.updateProfile(data); this.view.closeOverlay(); this.update(); this.view.toast("Profile updated"); }
    if (action === "description-form") { this.model.updateBoardDescription(data.description); this.view.closeOverlay(); this.update(); this.view.toast("Description saved"); }
    if(action==="paste-import-form"){if(String(data.text||"").length>10*1024*1024){this.view.showMessage("Import not ready","Pasted text is larger than 10 MB. Split it into smaller imports.");return;}try{const rows=this.parseCsv(data.text);this.model.assertImportable(rows);this.pendingImport=rows;this.view.showImportPreview(this.model,rows);}catch(error){this.view.showMessage("Import not ready",error.message);}return;}
    if (action === "workspace-settings-form") { this.model.updateWorkspace(this.model.currentWorkspaceId,data); this.update();this.view.showSettings(this.model,"workspace"); this.view.toast("Workspace updated"); }
  }
  onKeydown(event) {
    if(event.target.dataset?.action==="row-drag"&&event.altKey&&["ArrowUp","ArrowDown"].includes(event.key)){
      event.preventDefault();const id=Number(event.target.dataset.id),rows=this.model.visibleRows,index=rows.findIndex(r=>r.id===id),up=event.key==="ArrowUp",target=rows[index+(up?-1:1)];
      if(target&&this.model.reorderRecord(id,target.id,up?"before":"after")){this.update();this.root.querySelector('[data-action="row-drag"][data-id="'+id+'"]')?.focus();this.view.toast("Row moved",true);}return;
    }
    const editing=event.target.matches?.('input,textarea,select,[contenteditable="true"]');
    if(!this.auth.authenticated)return;
    if(event.target.dataset?.action==="cell-input"){this.cellInputKey(event);return;}
    if(event.target.dataset?.action==="draft-input"){this.draftKey(event);return;}
    if(event.target.classList?.contains("cell-display")&&!document.querySelector("#overlay-root")?.children.length&&this.cellKey(event))return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();this.view.showCommandPalette(this.model);return;}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="b"&&!editing){event.preventDefault();this.toggleSidebar();return;}
    if(event.target.dataset?.action==="column-type-search"&&event.key==="Enter"){event.preventDefault();event.target.closest(".column-chooser")?.querySelector(".chooser-option:not([hidden]):not(:disabled)")?.click();return;}
    if(event.key==="Escape"){
      event.preventDefault();
      if(event.target.dataset.action==="board-title-inline"){event.target.value=event.target.dataset.beforeEdit??event.target.defaultValue;event.target.blur();return;}
      this.view.closeOverlay();document.querySelector("#sidebar")?.classList.remove("open");return;
    }
    const root=document.querySelector("#overlay-root");
    if(root?.children.length){
      const palette=root.querySelector(".command-results"), menu=root.querySelector(".popover,.profile-popover");
      const list=palette||menu;
      if(list&&["ArrowDown","ArrowUp","Enter"].includes(event.key)&&!event.target.matches('select,textarea')){
        const buttons=[...list.querySelectorAll('button:not(:disabled)')].filter(b=>!b.hidden&&b.offsetParent!==null);if(!buttons.length)return;
        const index=buttons.findIndex(b=>b===document.activeElement||b.classList.contains("keyboard-selected"));
        event.preventDefault();if(event.key==="Enter"){buttons[Math.max(0,index)].click();return;}
        const next=(index+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;
        buttons.forEach(b=>b.classList.remove("keyboard-selected"));buttons[next].classList.add("keyboard-selected");
        if(!palette)buttons[next].focus();buttons[next].scrollIntoView({block:"nearest"});return;
      }
      if(event.key==="Tab"){
        const focusable=[...root.querySelectorAll('button:not(:disabled),input:not([type="hidden"]):not(:disabled),textarea,select,[tabindex="0"]')].filter(e=>!e.hidden&&e.offsetParent!==null);
        const first=focusable[0],last=focusable.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }return;
    }
    if(event.target.dataset.action==="resize-column"&&["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();const c=this.model.board.columns.find(c=>c.key===event.target.dataset.key);this.model.resizeColumn(c.key,(c.width||180)+(event.key==="ArrowRight"?20:-20));this.update();return;}
    if(event.target.dataset.action==="board-title-inline"&&event.key==="Enter"){event.preventDefault();event.target.blur();return;}
    if(!editing&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      if(event.key==="/"){event.preventDefault();if(this.model.screen==="board")document.querySelector("#board-search")?.focus();else this.view.showCommandPalette(this.model);}
      if(event.key==="?"){event.preventDefault();this.view.showShortcuts();}
      if(event.key.toLowerCase()==="n"){event.preventDefault();this.chooseBoardAction("record");}
    }
  }

  requestDeleteRecords(ids) { if (ids.length) this.view.showConfirm(`Delete ${ids.length} record${ids.length===1?"":"s"}?`,"The selected data will be removed from this board. Undo remains available afterward.","confirm-delete-records",ids.join(",")); }
  deleteRecords(ids) { if (!ids.length) return; this.model.remove(ids); this.view.closeOverlay(); this.update(); this.view.toast("Record deleted",true); }
  deleteBoard(id) { try { this.model.deleteBoard(id); this.view.closeOverlay(); this.update(); this.view.toast("Board deleted",true); } catch(error) { this.view.showMessage("Board not deleted",error.message); } }
  globalSearch(term) { if (!term) return; const match=this.model.allRecords.find((row)=>Object.values(row).some((value)=>String(value||"").toLowerCase().includes(term.toLowerCase()))); if (!match) { this.view.showMessage("No matching items",`No item matched “${term}”.`); return; } this.model.openBoard(match.boardId,match.workspaceId); this.model.query=term; this.view.closeOverlay(); this.update(); }
  runCommand(command) {
    this.model.rememberCommand(command);this.view.closeOverlay();
    if(command==="home"||command==="mywork"){this.model.openScreen(command);this.update();}
    if(command==="new-record")this.chooseBoardAction("record");
    if(command==="new-board")this.view.showBoardForm(null);
    if(command==="import")this.chooseBoardAction("import");
    if(command==="theme"){this.model.updateSetting("theme",document.documentElement.dataset.theme==="dark"?"light":"dark");this.update();}
    if(command==="shortcuts")this.view.showShortcuts();
    if(command==="notifications")this.view.showNotifications(this.model);
    if(command==="profile")this.view.showProfileSettings(this.model);
    if(command==="settings")this.view.showSettings(this.model);
  }

  focusItem(id) { requestAnimationFrame(()=>{ const cell=this.cellButton(id,"serial"); cell?.scrollIntoView({block:"nearest",inline:"nearest"}); cell?.focus(); }); }
  loadAvatar(file) { if(!file)return; if(file.size>1024*1024){this.view.showMessage("Photo is too large","Choose an image smaller than 1 MB.");return;} const reader=new FileReader(); reader.onload=()=>{this.model.setAvatar(reader.result);this.view.showProfileSettings(this.model);this.view.toast("Profile photo updated");}; reader.onerror=()=>this.view.showMessage("Photo not loaded","The selected image could not be read."); reader.readAsDataURL(file); }
  // A cell starting with = + - @ (or tab/carriage return) can run as a formula in Excel, Sheets or LibreOffice, so it is
  // exported with a leading apostrophe. Plain numbers in Number columns (e.g. -5) are left as numbers.
  csvCell(value,column=null){ let text=String(value??""); const plainNumber=column?.type==="number"&&/^-?\d+(\.\d+)?$/.test(text.trim()); if(!plainNumber&&/^[=+\-@\t\r]/.test(text))text="'"+text; return `"${text.replaceAll('"','""')}"`; }
  exportCsv() { const fields=this.model.board.columns; const csv=[fields.map((field)=>this.csvCell(field.label)).join(","),...this.model.visibleRows.map((row)=>fields.map((field)=>this.csvCell(row[field.key],field)).join(","))].join("\n"); if(this.download(new Blob([csv],{type:"text/csv"}),`${this.model.board.name.toLowerCase().replace(/[^a-z0-9]+/g,"-")||"board"}.csv`))this.view.toast("Board exported"); }
  exportBackup() { const backup=JSON.stringify(this.model.createBackup(),null,2); if(this.download(new Blob([backup],{type:"application/json"}),"jarc-database-backup.json"))this.view.toast("Full backup exported"); }
  async importData(file) {
    if(!file)return;
    try{
      if(file.size>10*1024*1024)throw Error("Choose a file smaller than 10 MB.");
      const text=await file.text(), isCsv=file.name.toLowerCase().endsWith(".csv");
      let data; if(isCsv)data=this.parseCsv(text); else { try{data=JSON.parse(text);}catch{throw Error("This file isn't valid JSON. Choose a JARC backup (.json), a JSON list of records, or a CSV file.");} }
      if(!isCsv&&data&&typeof data==="object"&&!Array.isArray(data)&&"workspaces" in data){
        const summary=this.model.validateBackup(data); // throws a readable reason before anything changes
        this.pendingBackup=data;this.view.showConfirm("Restore workspace backup?",`This replaces your current data with ${summary.workspaces} workspace${summary.workspaces===1?"":"s"}, ${summary.boards} board${summary.boards===1?"":"s"} and ${summary.records} record${summary.records===1?"":"s"}. Download a full backup from Settings → Data first. You can undo a restore during this session.`,"restore-backup","","Restore backup");return;
      }
      const rows=Array.isArray(data)?data:data?.rows;this.model.assertImportable(rows);
      this.pendingImport=rows;this.view.showImportPreview(this.model,rows);
    }catch(error){this.view.showMessage("Import not ready",error.message);}
  }

  parseCsv(text) {
    const rows=[];let row=[],cell="",quoted=false;const source=text.replace(/^\uFEFF/,"");
    for(let i=0;i<source.length;i++){
      const c=source[i];if(c==='"'&&quoted&&source[i+1]==='"'){cell+='"';i++;}
      else if(c==='"')quoted=!quoted;
      else if(c===','&&!quoted){row.push(cell);cell="";}
      else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&source[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell="";}
      else cell+=c;
    }
    if(quoted)throw Error("CSV has an unclosed quoted field.");row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
    if(rows.length<2)throw Error("Include a header row and at least one record.");
    const headers=rows.shift().map(v=>v.trim());if(headers.some(h=>!h)||new Set(headers).size!==headers.length)throw Error("Each column needs a unique, non-empty header.");
    return rows.map((r,i)=>{if(r.length!==headers.length)throw Error("Row "+(i+2)+" has "+r.length+" values; expected "+headers.length+".");return Object.fromEntries(headers.map((h,j)=>[h,r[j]]));});
  }

  download(blob,filename) { try { const url=URL.createObjectURL(blob),link=document.createElement("a"); link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),500); return true; } catch(error) { this.view.showMessage("Export failed",`The file could not be created in this browser (${error.message}). Try again, or use a different browser.`); return false; } }
  chooseBoardAction(action) {
    if(this.model.screen==="board"&&this.model.board&&!this.model.board.archived){action==="import"?this.view.showImport(this.model):this.view.showRecordForm(this.model);return;}
    const boards=this.model.workspaces.filter(w=>!w.archived).flatMap(w=>w.boards.filter(b=>!b.archived).map(b=>({...b,workspaceId:w.id,workspaceName:w.name})));
    this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>${action==="import"?"Import into a board":"Create a record in…"}</h2>${this.view.closeButton()}</div><div class="choice-list">${boards.map(b=>`<button data-action="choose-board-action" data-mode="${this.view.attr(action)}" data-id="${this.view.attr(b.id)}" data-workspace="${this.view.attr(b.workspaceId)}">${icon("board")}<span><strong>${this.view.escape(b.name)}</strong><small>${this.view.escape(b.workspaceName)}</small></span></button>`).join("")||'<p>Create a board first to add records.</p><button data-action="new-board" class="button primary">Create board</button>'}</div></div>`);
  }
  toggleSidebar(){document.body.classList.toggle("nav-collapsed");window.jarcStorage.setPreference("navCollapsed",document.body.classList.contains("nav-collapsed")?"1":"0");}
  saveFeedback(){
    const button=this.root.querySelector(".save-state");if(!button)return;
    const state=this.model.saveState||"saved";button.classList.toggle("save-error",state==="error");
    button.innerHTML=state==="error"?"Couldn't save · Retry":state==="saving"?"Saving…":`<i></i> ${navigator.onLine?"Saved locally":"Offline · saved locally"}`;
    if(state==="error"&&!this.saveErrorNotified){this.saveErrorNotified=true;this.view.toast(this.model.saveError===StorageError.CODES.QUOTA?"Browser storage is full — your latest changes are not saved. Export a backup from Settings → Data.":"Changes couldn't be saved in this browser. Export a backup from Settings → Data, then use Retry.");}
    if(state==="saved")this.saveErrorNotified=false;
  }
  onContextMenu(event){
    const row=event.target.closest('[data-record-context]'),board=event.target.closest('[data-board-context]'),workspace=event.target.closest('[data-action="workspace-menu"]');
    if(!row&&!board&&!workspace)return;event.preventDefault();
    if(row)this.view.showRecordMenu(this.model.rows.find(r=>r.id===Number(row.dataset.recordContext)));
    else if(board){this.boardMenuWorkspace=board.dataset.workspace||this.model.currentWorkspaceId;this.view.showBoardMenu(this.model.workspaces.find(w=>w.id===this.boardMenuWorkspace).boards.find(b=>b.id===board.dataset.boardContext));}
    else this.view.overlay(`<div class="modal small-modal"><div class="modal-head"><h2>${this.view.escape(this.model.workspace.name)}</h2>${this.view.closeButton()}</div><div class="choice-list"><button data-action="workspace-manage">Rename and customize</button><button data-action="settings-section" data-section="members">Manage local members</button><button data-action="archive-workspace" data-id="${this.view.attr(this.model.workspace.id)}" data-archived="1">Archive workspace</button><button class="danger" data-action="request-delete-workspace" data-id="${this.view.attr(this.model.workspace.id)}">Delete workspace</button></div></div>`);
    const pop=this.root.querySelector('.popover');if(pop){pop.style.left=Math.min(event.clientX,innerWidth-260)+"px";pop.style.top=Math.min(event.clientY,innerHeight-340)+"px";pop.style.right="auto";}
  }
  startRowDrag(event){
    const row=event.target.closest('.editable-table tr[data-record-context]');
    const handle=event.target.closest('[data-action="row-drag"]');
    if(!row||event.button!==0||(!handle&&event.target.closest('input,textarea,select,button,a,[contenteditable]')))return;
    if(!handle&&event.pointerType==='touch')return;
    event.preventDefault();
    const id=Number(row.dataset.recordContext),board=this.model.board,startX=event.clientX,startY=event.clientY,wrap=row.closest('.table-wrap');
    let active=false,ghost=null,target=null,position='before',x=startX,y=startY,frame;
    const clearMarks=()=>this.root.querySelectorAll('.row-drop-before,.row-drop-after').forEach(r=>r.classList.remove('row-drop-before','row-drop-after'));
    const locate=()=>{
      clearMarks();target=null;
      const element=document.elementFromPoint(x,y)?.closest('tr[data-record-context]');
      if(!element||element===row||element.closest('.table-wrap')!==wrap)return;
      const source=this.model.rows.find(r=>r.id===id),other=this.model.rows.find(r=>r.id===Number(element.dataset.recordContext));
      if(!source||!other||Boolean(source.pinned)!==Boolean(other.pinned))return;
      if(this.model.grouped&&this.model.groupColumn&&(source[this.model.groupColumn.key]||'')!==(other[this.model.groupColumn.key]||''))return;
      const bounds=element.getBoundingClientRect();position=y<bounds.top+bounds.height/2?'before':'after';target=other.id;element.classList.add('row-drop-'+position);
    };
    const tick=()=>{
      if(!active)return;
      const bounds=wrap.getBoundingClientRect();
      if(x>=bounds.left&&x<=bounds.right){
        if(y<bounds.top+45&&y>bounds.top-20)wrap.scrollTop-=9;
        else if(y>bounds.bottom-45&&y<bounds.bottom+20)wrap.scrollTop+=9;
        if(y<60)window.scrollBy(0,-9);else if(y>innerHeight-60)window.scrollBy(0,9);
      }
      locate();frame=requestAnimationFrame(tick);
    };
    const move=e=>{
      if(e.pointerId!==event.pointerId)return;x=e.clientX;y=e.clientY;
      if(!active&&Math.hypot(x-startX,y-startY)<6)return;
      e.preventDefault();
      if(!active){active=true;row.classList.add('row-dragging');document.body.classList.add('is-row-dragging');ghost=document.createElement('div');ghost.className='row-drag-preview';ghost.textContent=this.model.rows.find(r=>r.id===id)?.serial||'Move record';document.body.append(ghost);tick();}
      ghost.style.left=Math.max(8,Math.min(x+18,innerWidth-250))+'px';ghost.style.top=Math.max(8,Math.min(y+12,innerHeight-50))+'px';locate();
    };
    const cleanup=()=>{cancelAnimationFrame(frame);clearMarks();row.classList.remove('row-dragging');document.body.classList.remove('is-row-dragging');ghost?.remove();document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',key);window.removeEventListener('blur',cancel);};
    const cancel=()=>{cleanup();handle?.focus();};
    const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancel();}};
    const up=e=>{if(e.pointerId!==event.pointerId)return;const moved=active&&target!==null&&board===this.model.board;cleanup();if(moved&&this.model.reorderRecord(id,target,position)){this.update();this.root.querySelector('[data-action="row-drag"][data-id="'+id+'"]')?.focus();this.view.toast('Row order saved',true);}};
    document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',up);document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',key);window.addEventListener('blur',cancel);
  }

  startResize(event){
    const handle=event.target.closest('[data-action="resize-column"]');if(!handle)return;event.preventDefault();
    const key=handle.dataset.key,th=handle.closest('th'),start=event.clientX,width=th.getBoundingClientRect().width;
    const move=e=>{const next=Math.max(100,Math.min(600,width+e.clientX-start));th.style.width=th.style.minWidth=next+"px";};
    const up=e=>{document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);this.model.resizeColumn(key,width+e.clientX-start);};
    document.addEventListener("pointermove",move);document.addEventListener("pointerup",up,{once:true});
  }
  enhanceOverlay(){
    const root=this.root.querySelector('#overlay-root');if(!root?.children.length){this.root.querySelector(".app-shell")?.removeAttribute("inert");return;}
    const panel=root.querySelector('.modal,.record-drawer,.settings-window,.settings-drawer,.popover,.profile-popover');if(!panel)return;
    if(panel.dataset.enhanced)return;panel.dataset.enhanced="1";
    panel.setAttribute("role","dialog");panel.setAttribute("aria-modal","true");panel.setAttribute("aria-label",panel.querySelector('h2')?.textContent||"Actions");
    if(!this.overlayReturnFocus?.isConnected)this.overlayReturnFocus=document.activeElement;
    panel.querySelectorAll('button.icon-button:not([aria-label])').forEach(b=>b.setAttribute('aria-label',b.title||'Close'));
    const pop=panel.matches('.popover,.profile-popover');
    if(!pop)this.root.querySelector(".app-shell")?.setAttribute("inert","");else this.root.querySelector(".app-shell")?.removeAttribute("inert");
    if(pop&&this.lastTrigger?.isConnected){const r=this.lastTrigger.getBoundingClientRect();panel.style.left=Math.max(8,Math.min(r.left,innerWidth-panel.offsetWidth-12))+"px";panel.style.top=Math.max(8,Math.min(r.bottom+6,innerHeight-panel.offsetHeight-12))+"px";panel.style.right="auto";}
    requestAnimationFrame(()=>{const focus=panel.querySelector('[autofocus]')||panel.querySelector('input:not([type="hidden"]),select,textarea')||panel.querySelector('button');focus?.focus();});
  }
  guard(action){try{action();}catch(error){this.view.showMessage("Action could not be completed",error.message);}}

  // ---- Table interaction (Stage 4). Cell edits patch one cell; row inserts refresh only the board view.
  cellButton(id,field){return this.root.querySelector(`tr[data-record-context="${CSS.escape(String(id))}"] [data-action="cell-open"][data-field="${CSS.escape(field)}"]`);}
  patchCell(id,field,focus=false){
    const row=this.model.rows.find((r)=>r.id===Number(id)), column=this.model.board.columns.find((c)=>c.key===field);
    const td=this.root.querySelector(`tr[data-record-context="${CSS.escape(String(id))}"] td[data-column-key="${CSS.escape(field)}"]`);
    if(!row||!column||!td)return;
    td.outerHTML=this.view.cell(row,column,this.model); this.saveFeedback();
    if(focus)this.cellButton(id,field)?.focus();
  }
  refreshBoard(){
    const region=this.root.querySelector(".board-view-region"); if(!region||this.model.screen!=="board"){this.update();return;}
    region.innerHTML=this.view.boardView(this.model);
    const active=this.model.rows.filter((r)=>!r.archived).length, count=this.root.querySelector(".board-nav.selected .nav-count");
    if(count)count.textContent=active;
    this.root.querySelector('.board-actions [data-action="export"]')?.toggleAttribute("disabled",!this.model.rows.length);
    this.saveFeedback();
  }
  openCell(button){
    const id=Number(button.dataset.id), field=button.dataset.field, row=this.model.rows.find((r)=>r.id===id), column=this.model.board.columns.find((c)=>c.key===field);
    if(!row||!column)return;
    if(column.type==="checkbox"){this.model.updateCell(id,field,!row[field]);this.patchCell(id,field,true);return;}
    if(this.view.isChoiceColumn(column)){button.scrollIntoView({block:"nearest",inline:"nearest"});this.togglePanel(`cell-${id}-${field}`,()=>this.view.showCellOptions(this.model,row,column));return;}
    this.openCellEditor(button.closest("td"),row,column);
  }
  openCellEditor(td,row,column,seed=null){
    if(!td)return;
    td.classList.add("is-editing"); td.innerHTML=this.view.cellInput(row,column);
    const input=td.querySelector(".cell-input"); input.focus();
    if(seed!==null)input.value=seed; else try{input.select();}catch{}
  }
  commitCell(input,move="stay"){
    if(input.dataset.done)return; input.dataset.done="1";
    const id=Number(input.dataset.id), field=input.dataset.field, column=this.model.board.columns.find((c)=>c.key===field), value=input.value;
    let note="";
    if(column&&value!==input.dataset.original){
      if(column.required&&!value.trim())note=`${column.label} can't be empty`;
      else if(!input.checkValidity())note=`${column.label} not saved: ${input.validationMessage}`;
      else this.model.updateCell(id,field,value);
    }
    this.patchCell(id,field,move!=="none");
    if(!note&&column?.type==="link"&&value.trim()&&value!==input.dataset.original&&!this.view.safeHref(value,"link"))note="Saved as text — only http, https, mailto and tel links can be opened.";
    if(note)this.view.toast(note);
    if(move==="next"||move==="prev"){const cell=this.cellButton(id,field);(this.adjacentCell(cell,move==="next"?1:-1)||cell)?.focus();}
  }
  cancelCell(input){input.dataset.done="1";this.patchCell(Number(input.dataset.id),input.dataset.field,true);}
  cellInputKey(event){
    const input=event.target;
    if(event.key==="Escape"){event.preventDefault();this.cancelCell(input);}
    else if(event.key==="Enter"&&!(input.tagName==="TEXTAREA"&&event.shiftKey)){event.preventDefault();this.commitCell(input,"stay");}
    else if(event.key==="Tab"){event.preventDefault();this.commitCell(input,event.shiftKey?"prev":"next");}
  }
  // Spreadsheet-style movement between cell buttons within one table. dir: 1 / -1 (reading order) or an arrow key.
  adjacentCell(cell,dir){
    if(!cell)return null;
    const tr=cell.closest("tr"), rows=[...cell.closest("tbody").querySelectorAll("tr[data-record-context]")], inRow=(r)=>[...r.querySelectorAll(".cell-display")];
    if(dir===1||dir===-1){const all=rows.flatMap(inRow);return all[all.indexOf(cell)+dir]||null;}
    const ci=inRow(tr).indexOf(cell), ri=rows.indexOf(tr);
    if(dir==="ArrowLeft")return inRow(tr)[ci-1]||null;
    if(dir==="ArrowRight")return inRow(tr)[ci+1]||null;
    const other=rows[ri+(dir==="ArrowUp"?-1:1)]; return other?inRow(other)[ci]||null:null;
  }
  cellKey(event){
    const cell=event.target, key=event.key; if(event.ctrlKey||event.metaKey||event.altKey)return false;
    if(key==="Tab"){const next=this.adjacentCell(cell,event.shiftKey?-1:1);if(next){event.preventDefault();next.focus();}return true;}
    if(key.startsWith("Arrow")){const next=this.adjacentCell(cell,key);if(next){event.preventDefault();next.focus();}return true;}
    if(key==="F2"){event.preventDefault();cell.click();return true;}
    if(key.length===1&&key!==" "){
      // Typing on a focused text-like cell starts editing with that character; letter shortcuts stay quiet here.
      event.preventDefault();
      const row=this.model.rows.find((r)=>r.id===Number(cell.dataset.id)), column=this.model.board.columns.find((c)=>c.key===cell.dataset.field);
      if(row&&column&&column.type!=="checkbox"&&!this.view.isChoiceColumn(column))this.openCellEditor(cell.closest("td"),row,column,key);
      return true;
    }
    return false;
  }
  // Inline add: a temporary draft row. Nothing is stored until a non-empty name is entered.
  startInlineAdd(trigger){
    const blocking=this.model.board.columns.some((c)=>c.key!=="serial"&&c.required&&c.type!=="checkbox"&&!this.model.hasValue(c.defaultValue));
    if(blocking){this.view.showRecordForm(this.model);return;} // other required fields need the full form
    const quick=trigger.closest("tr"); quick.parentElement.querySelector(".draft-row")?.remove();
    quick.insertAdjacentHTML("beforebegin",this.view.draftRow(this.model,trigger.dataset.group||""));
    quick.previousElementSibling.querySelector("input").focus();
  }
  commitDraft(input,{again=false,next=false}={}){
    if(input.dataset.done)return; input.dataset.done="1";
    const tr=input.closest("tr"), name=input.value.trim(), group=tr?.dataset.group||"";
    if(!name){tr?.remove();return;}
    const record={serial:name}; if(group&&this.model.groupColumn)record[this.model.groupColumn.key]=group;
    const saved=this.model.upsert(record); this.refreshBoard();
    if(again){const trigger=this.root.querySelector(`.quick-add-row [data-action="inline-add"][data-group="${CSS.escape(group)}"]`);if(trigger)this.startInlineAdd(trigger);}
    else if(next){const first=this.cellButton(saved.id,"serial"),following=this.adjacentCell(first,"ArrowRight");(following||first)?.focus();}
  }
  draftKey(event){
    const input=event.target;
    if(event.key==="Escape"){event.preventDefault();input.dataset.done="1";const tr=input.closest("tr"),trigger=tr.nextElementSibling?.querySelector('[data-action="inline-add"]');tr.remove();trigger?.focus();}
    else if(event.key==="Enter"){event.preventDefault();this.commitDraft(input,{again:true});}
    else if(event.key==="Tab"&&!event.shiftKey){event.preventDefault();this.commitDraft(input,{next:true});}
  }
  // Sorting from the column menu reuses model.sortKey/sortDirection. It leaves the board's saved manual order intact.
  applySort(key,direction){
    this.model.sortKey=key; this.model.sortDirection=direction||"desc";
    this.model.manualSort=key?false:Boolean(this.model.board.manualOrder);
    this.model.activeSavedViewId=null; this.view.closeOverlay(); this.update();
  }
  // Drag a column header to reorder (mouse/pen). Touch and keyboard use Move left / Move right in the column menu.
  startColumnDrag(event){
    const th=event.target.closest('.editable-table th.is-movable[data-column-key]');
    if(!th||event.button!==0||event.pointerType==="touch"||event.target.closest("button,input,a"))return;
    const key=th.dataset.columnKey, table=th.closest("table"), wrap=table.closest(".table-wrap"), startX=event.clientX, startY=event.clientY;
    let active=false,ghost=null,target=null,position="before";
    const clear=()=>table.querySelectorAll(".col-drop-before,.col-drop-after").forEach((h)=>h.classList.remove("col-drop-before","col-drop-after"));
    const move=(e)=>{
      if(e.pointerId!==event.pointerId)return;
      if(!active&&Math.hypot(e.clientX-startX,e.clientY-startY)<6)return;
      e.preventDefault();
      if(!active){active=true;th.classList.add("col-dragging");document.body.classList.add("is-col-dragging");ghost=document.createElement("div");ghost.className="row-drag-preview";ghost.textContent=th.querySelector(".column-label")?.textContent||"Column";document.body.append(ghost);}
      ghost.style.left=Math.max(8,Math.min(e.clientX+14,innerWidth-250))+"px";ghost.style.top=Math.max(8,Math.min(e.clientY+12,innerHeight-50))+"px";
      clear();target=null;
      const bounds=wrap.getBoundingClientRect(); if(e.clientX>bounds.right-40)wrap.scrollLeft+=14; else if(e.clientX<bounds.left+40)wrap.scrollLeft-=14;
      const over=document.elementFromPoint(e.clientX,e.clientY)?.closest("th[data-column-key]");
      if(!over||over.closest("table")!==table||over===th)return;
      const r=over.getBoundingClientRect(); position=over.dataset.columnKey==="serial"||e.clientX>=r.left+r.width/2?"after":"before";
      target=over.dataset.columnKey; over.classList.add("col-drop-"+position);
    };
    const cleanup=()=>{clear();th.classList.remove("col-dragging");document.body.classList.remove("is-col-dragging");ghost?.remove();document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);document.removeEventListener("pointercancel",cleanup);document.removeEventListener("keydown",onKey,true);};
    const onKey=(e)=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();cleanup();}};
    const up=(e)=>{if(e.pointerId!==event.pointerId)return;const go=active&&target;cleanup();if(go&&this.model.moveColumnTo(key,target,position)){this.update();this.view.toast("Column moved",true);}};
    document.addEventListener("pointermove",move,{passive:false});document.addEventListener("pointerup",up);document.addEventListener("pointercancel",cleanup);document.addEventListener("keydown",onKey,true);
  }
  selectOverlayInput(selector){requestAnimationFrame(()=>{const input=this.root.querySelector(`#overlay-root ${selector}`);input?.focus();input?.select();});}
  // Change a column's type. Values that can't be kept are only cleared after an explicit confirmation.
  changeColumnType(key,type,confirmed=false){
    const column=this.model.board.columns.find((c)=>c.key===key), meta=this.model.columnType(type); if(!column||!meta)return;
    if(column.key==="serial"){this.view.showMessage("Type not changed","The primary column always stays text.");return;}
    const impact=this.model.typeChangeImpact(key,type);
    if(impact&&!confirmed){this.view.showConfirm(`Change "${column.label}" to ${meta.label}?`,`${impact} record${impact===1?" has a value":"s have values"} that can't be stored as ${meta.label}. ${impact===1?"It":"They"} will be cleared. You can undo this right afterwards.`,"confirm-change-type",`${key}|${type}`,"Change type");return;}
    const label=column.label, result=this.model.changeColumnType(key,type); this.view.closeOverlay(); this.update();
    if(result)this.view.toast(`${label} is now ${meta.label}${result.cleared?` · ${result.cleared} value${result.cleared===1?"":"s"} cleared`:""}`,true);
  }
  // Save edited options. Removing options that records still use needs confirmation; renames carry values along.
  applyColumnOptions(confirmed=false){
    const pending=this.pendingOptions; if(!pending)return;
    const plan=this.model.optionsEditPlan(pending.key,pending.items);
    if(!plan||!plan.options.length){this.view.showMessage("Options not saved","Keep at least one option.");return;}
    if(plan.affected&&!confirmed){const used=plan.removed.filter((o)=>this.model.rows.some((r)=>r[pending.key]===o));this.view.showConfirm("Remove options in use?",`${plan.affected} record${plan.affected===1?" uses":"s use"} ${used.length===1?`"${used[0]}"`:"the removed options"}. Those values will be cleared. You can undo this right afterwards.`,"confirm-column-options","","Remove options");return;}
    const result=this.model.editColumnOptions(pending.key,pending.items); this.pendingOptions=null; this.view.closeOverlay(); this.update();
    if(result)this.view.toast(`Options updated${result.cleared?` · ${result.cleared} value${result.cleared===1?"":"s"} cleared`:""}`,true);
  }
}
try { new AppController(document.querySelector("#app")); } catch(error) {
  const root=document.querySelector("#app"); let raw=null; try { raw=window.jarcStorage.readRawState(); } catch {}
  root.innerHTML='<main class="startup-error" role="alert"><h1>JARC couldn\'t open your saved data</h1><p class="startup-error-message"></p><p>Nothing has been deleted. Download a copy of the stored data before trying anything else.</p><div class="startup-error-actions"><button type="button" class="button primary" data-recover="download">Download stored data</button><button type="button" class="button secondary" data-recover="reload">Try again</button><button type="button" class="button danger" data-recover="reset">Clear stored data…</button></div></main>';
  root.querySelector(".startup-error-message").textContent=error.message;
  if(!raw)root.querySelector('[data-recover="download"]').disabled=true;
  root.addEventListener("click",(event)=>{
    const action=event.target.closest("[data-recover]")?.dataset.recover;
    if(action==="download"&&raw){const url=URL.createObjectURL(new Blob([raw],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download="jarc-stored-data-"+new Date().toISOString().slice(0,10)+".json";link.click();setTimeout(()=>URL.revokeObjectURL(url),500);}
    if(action==="reload")location.reload();
    if(action==="reset"&&confirm("Permanently delete the stored JARC data in this browser? Download it first if you might need it."))try{window.jarcStorage.clearState();location.reload();}catch{}
  });
}
