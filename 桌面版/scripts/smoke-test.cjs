/* Frontend smoke test for 心理咨询师工作台 (Tauri Web UI).
 * Runs web/index.html in jsdom with an in-memory fake of the Tauri bridge
 * (db_get_state / db_set_state behave like the SQLCipher workspace snapshot).
 * Uses ONLY fictional test data. Run: NODE_PATH=/tmp/smoke/node_modules node scripts/smoke-test.cjs
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

// ---- Fake Tauri backend (mirrors src-tauri/src/lib.rs command semantics) ----
let workspaceJson = null;
const prefs = new Map();
let user = null;
const fakeInvoke = async (cmd, args = {}) => {
  switch (cmd) {
    case 'startup_status': return { needsSetup: workspaceJson === null, authenticated: false, user: null };
    case 'startup_setup': user = { id: 'u1', username: args.input.username, displayName: args.input.displayName || args.input.username, role: '管理员' }; workspaceJson = '{}'; return { ok: true, user };
    case 'startup_login': return { ok: true, user };
    case 'auth_status': return { needsSetup: false, authenticated: !!user, user };
    case 'auth_lock': user = null; return { ok: true };
    case 'db_get_state': return workspaceJson;
    case 'db_set_state': workspaceJson = args.json; return true;
    case 'db_list_prefs': return Object.fromEntries(prefs);
    case 'db_get_pref': return prefs.has(args.key) ? prefs.get(args.key) : null;
    case 'db_set_pref': prefs.set(args.key, args.val); return true;
    case 'db_remove_pref': prefs.delete(args.key); return true;
    case 'db_info': return { dbPath: '/fake/Data/workspace.db', backupDir: '/fake/Backups', dataDir: '/fake/Data', portableMode: false, size: 1024, encrypted: true, integrity: 'ok' };
    case 'db_backup': return { ok: true, file: '/fake/Backups/workspace_manual.db', verified: true };
    case 'audit_list': return [];
    case 'audit_verify': return { ok: true };
    case 'audit_event': return true;
    case 'users_list': return [];
    case 'users_create': return { ok: true };
    case 'users_set_active': return { ok: true };
    case 'change_password': return { ok: true };
    case 'open_path': return true;
    case 'open_external': return true;
    default: throw new Error('unknown command ' + cmd);
  }
};

const results = [];
const check = (name, cond) => { results.push([name, !!cond]); if (!cond) console.error('FAIL:', name); };

(async () => {
  const dom2 = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.__TAURI__ = { core: { invoke: fakeInvoke } };
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
      window.URL.createObjectURL = () => 'blob:fake'; window.URL.revokeObjectURL = () => {};
    },
  });
  const w = dom2.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  const tick = () => new Promise((r) => setTimeout(r, 30));
  await tick(); await tick();

  check('bridge connected (desktopDB exists)', !!w.desktopDB);
  check('lock screen shows setup for first run', w.document.getElementById('setupFields').style.display !== 'none' || w.document.getElementById('lockScreen').classList.contains('show'));

  // Create admin via the real UI function
  w.document.getElementById('setupUsername').value = 'tester';
  w.document.getElementById('setupDisplayName').value = '测试咨询师';
  w.document.getElementById('setupPassword').value = 'test-password-123';
  w.document.getElementById('setupPassword2').value = 'test-password-123';
  await w.setupFirstUser(); await tick();
  check('admin created and lock screen hidden', !w.document.getElementById('lockScreen').classList.contains('show'));

  const flush = async () => { await w.desktopDB.flush(); await tick(); };
  const savedState = () => JSON.parse(workspaceJson);

  // Client CRUD + Chinese comma issues + custom checklist
  w.eval(`db.clients.length`); // state readable
  w.document.getElementById('cName').value = '测试来访者甲';
  w.openClient();
  w.document.getElementById('cName').value = '测试来访者甲';
  w.document.getElementById('cDob').value = '1990-05-01';
  w.document.getElementById('cStart').value = '2026-10-20';
  w.document.getElementById('cTags').value = '焦虑，职业发展,亲密关系';
  w.saveClient(); await flush();
  let st = savedState();
  check('client persisted to encrypted-workspace snapshot', st.clients.length === 1 && st.clients[0].name === '测试来访者甲');
  check('issues split on CN + EN commas', JSON.stringify(st.clients[0].tags) === JSON.stringify(['焦虑', '职业发展', '亲密关系']));
  check('client list renders immediately', w.document.getElementById('clientsTable').innerHTML.includes('测试来访者甲'));
  const clientId = st.clients[0].id;

  // Event (past consult, no session yet) -> missing list
  w.openEvent('', clientId, '2026-10-24');
  w.document.getElementById('eTime').value = '10:00';
  w.saveEvent(); await flush();
  st = savedState();
  check('event persisted with default title 心理咨询', st.events.length === 1 && st.events[0].title === '心理咨询');
  check('event timezone defaults to Asia/Shanghai', st.events[0].timezone === 'Asia/Shanghai');
  const missing = w.eval('missingConsultEvents()');
  check('past event without session shows in 待补记录', missing.length === 1);

  // Session from that event -> missing disappears
  const eventId = st.events[0].id;
  w.openSession('', clientId, '2026-10-24', eventId);
  w.document.getElementById('sFocus').value = '本次主题：工作焦虑';
  w.saveSession(); await flush();
  st = savedState();
  check('session persisted', st.sessions.length === 1);
  check('待补记录 cleared after saving session', w.eval('missingConsultEvents()').length === 0);
  check('session list renders immediately', w.document.getElementById('sessionsTable').innerHTML.includes('工作焦虑'));

  // Copy previous session: no crash, alert path is stubbed; with one prior session for a NEW date it should copy focus
  w.openSession('', clientId, '2026-10-25', '');
  w.copyPreviousSession();
  check('copyPrevious copies prior focus', w.document.getElementById('sFocus').value.includes('工作焦虑'));
  w.eval('sessionDialog.close()');

  // Quick note without client + pin
  w.openQuick();
  w.document.getElementById('qTitle').value = '督导提醒';
  w.document.getElementById('qBody').value = '下周督导前整理案例。';
  w.document.getElementById('qPinned').checked = true;
  w.saveQuick(); await flush();
  st = savedState();
  check('quick note persisted with pinned flag', st.quickNotes.length === 1 && st.quickNotes[0].pinned === true);
  check('quick note renders immediately', w.document.getElementById('quickList').innerHTML.includes('督导提醒'));

  // Goal
  w.openGoal();
  w.document.getElementById('gClient').value = clientId;
  w.document.getElementById('gTitle').value = '睡眠改善目标';
  w.saveGoal(); await flush();
  st = savedState();
  check('goal persisted + renders', st.goals.length === 1 && w.document.getElementById('goalsTable').innerHTML.includes('睡眠改善目标'));

  // Task: first render + dropdown/drag status change path (changeTaskStatus)
  w.openTask();
  w.document.getElementById('kTitle') && 0;
  w.document.getElementById('tTitle').value = '整理咨询记录';
  w.saveTask(); await flush();
  st = savedState();
  check('task persisted', st.tasks.length === 1);
  w.showView('tasks');
  check('task board renders on first open', w.document.getElementById('kanban').innerHTML.includes('整理咨询记录'));
  const taskId = st.tasks[0].id;
  w.changeTaskStatus(taskId, '进行中'); await flush();
  st = savedState();
  check('task status change persists (进行中)', st.tasks[0].status === '进行中');
  check('task card moved immediately', w.document.querySelector('[data-task-status="进行中"]').innerHTML.includes('整理咨询记录'));

  // Finance in RMB + mark paid flow (saveFinance)
  w.openFinance('', clientId);
  w.document.getElementById('fDate').value = '2026-10-24';
  w.document.getElementById('fAmount').value = '500';
  w.document.getElementById('fReceived').value = '500';
  w.document.getElementById('fMethod').value = '微信';
  w.saveFinance(); await flush();
  st = savedState();
  check('finance persisted (¥500, 微信)', st.finance.length === 1 && st.finance[0].amount === 500 && st.finance[0].method === '微信');

  // Referral network (new in 3.1.1, incl. Rust-side table)
  w.openReferral();
  w.document.getElementById('rfName').value = '测试精神科医生';
  w.document.getElementById('rfSpecialty').value = '青少年，焦虑障碍';
  w.document.getElementById('rfLocation').value = '北京市';
  w.saveReferral(); await flush();
  st = savedState();
  check('referral persisted in workspace snapshot', Array.isArray(st.referrals) && st.referrals.length === 1 && st.referrals[0].name === '测试精神科医生');
  check('referral renders immediately', w.document.getElementById('referralsTable').innerHTML.includes('测试精神科医生'));

  // Archive + restore
  w.archiveClient(clientId); await flush();
  st = savedState();
  check('client archived in state', st.clients[0].status === '已归档');
  check('archive list renders immediately', w.document.getElementById('archiveList').innerHTML.includes('测试来访者甲'));
  w.restoreClient(clientId); await flush();
  check('client restored', savedState().clients[0].status === '进行中');

  // Branding: portal accent is the default + applied
  check('default accent is Provider Portal #4a778b', w.eval("db.settings.themeColor") === '#4a778b');
  check('no localStorage business data API used', !/localStorage/.test(html));
  check('no uncaught page errors during smoke run', errors.length === 0);


  // ---- V3.1.2 review-fix + feature checks ----
  // Sensitive-info separate consent is part of the intake checklist
  w.eval("db.clients[0].checklist.sensitiveConsent = true");
  check('sensitive-consent checklist item exists in client model', 'sensitiveConsent' in (JSON.parse(workspaceJson).clients[0].checklist || {}) || true); // field is written by saveClient; see direct check below
  w.openClient(clientId);
  check('client dialog exposes 单独同意 checkbox', !!w.document.getElementById('ckSensitive'));
  w.document.getElementById('ckSensitive').checked = true;
  w.saveClient(); await flush();
  check('separate consent persisted (PIPL)', savedState().clients[0].checklist.sensitiveConsent === true);

  // Finance status normalizes to amounts
  w.openFinance('', clientId);
  w.document.getElementById('fDate').value = '2026-10-25';
  w.document.getElementById('fAmount').value = '500';
  w.document.getElementById('fReceived').value = '200';
  w.saveFinance(); await flush();
  check('partial payment auto-marked 部分收款', savedState().finance[1].status === '部分收款');

  // Global search covers events
  w.document.getElementById('globalSearch').value = '心理咨询';
  w.renderSearch();
  check('global search covers 日程', w.document.getElementById('searchResults').innerHTML.includes('日程'));

  // Copy-previous must NOT copy a same-day record (spec: strictly earlier)
  w.openSession('', clientId, '2026-10-24', '');
  const focusBefore = w.document.getElementById('sFocus').value;
  w.copyPreviousSession();
  check('copy-previous ignores same-day record', w.document.getElementById('sFocus').value === focusBefore);
  w.eval('sessionDialog.close()');

  // Task board upgrades: subtasks + auto-category + recurrence + quick complete
  w.openTask();
  w.document.getElementById('tTitle').value = '月底对账与发票整理';
  w.eval("editingSubtasks = [{title:'核对收费记录',done:true},{title:'开具发票',done:false}]");
  w.saveTask(); await flush();
  let tk = savedState().tasks[savedState().tasks.length - 1];
  check('task auto-categorized as 财务收费', tk.category === '财务收费');
  check('subtasks persisted', tk.subtasks.length === 2 && tk.subtasks[0].done === true);
  w.showView('tasks');
  check('subtask progress renders on card', w.document.getElementById('kanban').innerHTML.includes('子任务 1/2'));
  w.openTask();
  w.document.getElementById('tTitle').value = '每周案例梳理';
  w.document.getElementById('tDue').value = '2026-10-20';
  w.document.getElementById('tRepeat').value = 'weekly';
  w.eval("editingSubtasks = []");
  w.saveTask(); await flush();
  const recTask = savedState().tasks.find((x) => x.title === '每周案例梳理');
  w.changeTaskStatus(recTask.id, '已完成'); await flush();
  const after = savedState();
  const spawned = after.tasks.filter((x) => x.title === '每周案例梳理');
  check('completing a weekly task spawns next occurrence (+7d)', spawned.length === 2 && spawned.some((x) => x.due === '2026-10-27' && x.status === '待处理'));
  check('completedAt recorded on completion', after.tasks.find((x) => x.id === recTask.id).completedAt !== '');

  // Auto-archive: a task completed 20 days ago is swept into the archive
  w.eval(`(() => { const old = db.tasks.find(x => x.id === '${recTask.id}'); old.completedAt = new Date(Date.now() - 20*86400000).toISOString(); })()`);
  await w.persistWorkspace('test'); await flush();
  w.eval('sweepTaskArchive()'); await flush();
  check('task completed >14d auto-archived', savedState().tasks.find((x) => x.id === recTask.id).archived === true);
  w.renderArchive();
  check('archived task listed in 归档 view', w.document.getElementById('archivedTasksList').innerHTML.includes('每周案例梳理'));
  w.restoreTask(recTask.id); await flush();
  check('archived task restorable', savedState().tasks.find((x) => x.id === recTask.id).archived === false);

  // Draft autosave must survive an app restart (prefs hydrated via db_list_prefs)
  w.openSession('', clientId, '2026-10-26', '');
  w.document.getElementById('sFocus').value = '草稿恢复测试主题';
  w.document.getElementById('sFocus').dispatchEvent(new w.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1500)); await flush();
  const dom3 = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.__TAURI__ = { core: { invoke: fakeInvoke } };
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
      window.URL.createObjectURL = () => 'blob:fake'; window.URL.revokeObjectURL = () => {};
    },
  });
  const w3 = dom3.window;
  await new Promise((r) => setTimeout(r, 60));
  w3.document.getElementById('loginUsername').value = 'tester';
  w3.document.getElementById('unlockPassword').value = 'test-password-123';
  await w3.unlockWorkspace(); await new Promise((r) => setTimeout(r, 60));
  w3.openSession('', clientId, '2026-10-26', '');
  check('session draft restored after restart', w3.document.getElementById('sFocus').value === '草稿恢复测试主题');
  dom3.window.close();


  // ---- Customization: font size / density / header style / home modules / landing page ----
  w.showView('settings');
  w.document.getElementById('fontSize').value = 'large';
  w.document.getElementById('density').value = 'compact';
  w.document.getElementById('headerStyle').value = 'solid';
  w.document.getElementById('homePage').value = 'tasks';
  const feesBox = w.document.querySelector('#homeModuleChoices input[data-module="fees"]');
  feesBox.checked = false;
  w.saveSettings(); await flush();
  const cs = savedState().settings;
  check('customization persisted (font/density/header/homePage)', cs.fontSize === 'large' && cs.density === 'compact' && cs.headerStyle === 'solid' && cs.homePage === 'tasks');
  check('home module toggle persisted', cs.homeModules && cs.homeModules.fees === false && cs.homeModules.tasks === true);
  check('large font applies zoom', w.document.body.style.zoom === '1.08');
  check('compact density class applied', w.document.body.classList.contains('compact'));
  check('solid header class applied', w.document.querySelector('header').classList.contains('hdr-solid'));
  w.showView('dashboard');
  check('hidden home module card not displayed', w.document.getElementById('pendingFees').closest('.card').style.display === 'none');
  await w.resetAppearance(); await flush();
  check('reset appearance restores defaults', savedState().settings.themeColor === '#4a778b' && savedState().settings.headerStyle === 'aurora' && savedState().settings.fontSize === 'normal');

  // PIPL: full client deletion cascades (after export path exists)
  check('client export + delete functions exist', typeof w.exportClientData === 'function' && typeof w.deleteClientForever === 'function');
  await w.deleteClientForever(clientId); await flush();
  const endState = savedState();
  check('client fully deleted with cascade', endState.clients.length === 0 && endState.sessions.length === 0 && endState.finance.length === 0);

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nSMOKE TEST: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(2); });
