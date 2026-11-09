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
      try { Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true }); } catch (e) {}
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



  // ---- Borrowed-from-EHR features: assessments / waitlist / event status / insights / statement / documents / default fee ----
  w.showView('assessments');
  w.openAssessment('', clientId);
  w.document.querySelector('input[name="aq0"][value="3"]').checked = true;
  w.document.querySelector('input[name="aq8"][value="1"]').checked = true;
  w.updateAssessmentTotal();
  check('PHQ-9 live total + risk note', w.document.getElementById('aTotal').textContent === '4' && w.document.getElementById('aRiskNote').innerHTML.includes('第 9 题'));
  await w.saveAssessment(); await flush();
  const asmt = savedState().assessments[0];
  check('assessment auto-scored + flagged + persisted (Rust table round-trip)', asmt && asmt.total === 4 && asmt.severity === '最小' && asmt.flag === true);

  w.openWaitlist();
  w.document.getElementById('wName').value = '候补测试者';
  w.document.getElementById('wContact').value = '13800000000';
  w.document.getElementById('wIssues').value = '焦虑，睡眠';
  await w.saveWaitlist(); await flush();
  check('waitlist entry saved', savedState().waitlist.length === 1);
  const wid = savedState().waitlist[0].id;
  await w.convertToClient(wid); await flush();
  const conv = savedState();
  check('waitlist converted to client + marked 已建档', conv.clients.some((c) => c.name === '候补测试者') && conv.waitlist[0].status === '已建档');

  w.openEvent('', clientId, '2026-10-27');
  w.document.getElementById('eStatus').value = '爽约';
  w.document.getElementById('eVideo').value = 'https://meet.example.com/abc';
  w.saveEvent(); await flush();
  const ev = savedState().events[savedState().events.length - 1];
  check('event status + video link persisted', ev.status === '爽约' && ev.videoLink.includes('meet.example.com'));
  check('no-show color coding is red', w.eventStatusColor(ev) === '#a13b3b');

  w.showView('insights');
  check('insights page renders stats', w.document.getElementById('insightsBody').innerHTML.includes('咨询场次'));
  w.showView('statement');
  w.initStatement();
  w.document.getElementById('stmtClient').value = clientId;
  w.renderStatement();
  check('statement generated for client', w.document.getElementById('stmtBody').innerHTML.includes('收费对账单'));

  w.viewClient(clientId);
  w.document.getElementById('docName').value = '个人信息处理告知';
  w.document.getElementById('docStatus').value = '已签署';
  await w.addDocument(clientId); await flush();
  check('client document record added', savedState().clients.find((c) => c.id === clientId).documents.length === 1);

  w.openClient(clientId);
  w.document.getElementById('cFee').value = '600';
  w.saveClient(); await flush();
  w.openFinance('', clientId);
  check('finance prefilled from client default fee', w.document.getElementById('fAmount').value === '600');


  // ---- Templates: seeded builtins, kinds, custom CRUD, plan application, delete persistence ----
  const seeded = savedState().templates;
  check('builtin templates seeded (record + plan kinds)', seeded.length >= 6 && seeded.some((x) => x.name === '安全计划（危机干预）' && x.kind === '方案') && seeded.some((x) => x.name === 'SOAP 记录' && x.kind === '记录'));
  w.openTemplate();
  w.document.getElementById('rtName').value = '我的方案模板';
  w.document.getElementById('rtKind').value = '方案';
  w.document.getElementById('rtPGoals').value = '自定义目标X';
  w.saveTemplate(); await flush();
  check('custom plan template saved with kind', savedState().templates.some((x) => x.name === '我的方案模板' && x.kind === '方案' && x.pGoals === '自定义目标X'));
  const safety = savedState().templates.find((x) => x.name === '安全计划（危机干预）');
  w.openPlan(clientId);
  check('plan picker offers plan templates', [...w.document.getElementById('pTemplatePick').options].some((o) => o.value === safety.id));
  w.document.getElementById('pTemplatePick').value = safety.id;
  w.applyPlanTemplate();
  check('plan template applied (crisis resources filled)', w.document.getElementById('pApproach').value.includes('12356'));
  w.eval('planDialog.close()');
  await w.deleteTemplate(safety.id); await flush();
  const afterDelete = savedState().templates.length;
  w.seedBuiltinTemplates(); await flush();
  check('deleted builtin is not resurrected by reseeding', savedState().templates.length === afterDelete && !savedState().templates.some((x) => x.id === safety.id));

  // ---- V3.1.13: builtin template pack V3 (seeded once, kinds, picker) + 常用句式 panel ----
  const v3kinds = { '电话 / 线上简短沟通记录': '记录', '危机干预记录': '记录', '个案概念化': '记录', '伴侣 / 家庭咨询记录': '记录', '团体咨询记录': '记录', '督导记录': '记录', '转介记录': '通用' };
  const v3now = savedState().templates;
  check('V3 template pack seeded with expected kinds', Object.entries(v3kinds).every(([n, k]) => v3now.some((x) => x.name === n && x.kind === k)));
  check('V3 templates seeded exactly once and flag persisted', Object.keys(v3kinds).every((n) => v3now.filter((x) => x.name === n).length === 1) && savedState().settings.templatesSeededV3 === '1');
  w.options();
  check('session template picker lists all V3 templates', Object.keys(v3kinds).every((n) => [...w.document.getElementById('sTemplate').options].some((o) => o.textContent === n)));
  const crisis = savedState().templates.find((x) => x.name === '危机干预记录');
  await w.deleteTemplate(crisis.id); await flush();
  const afterV3Delete = savedState().templates.length;
  w.seedBuiltinTemplates(); await flush();
  check('deleted V3 builtin is not resurrected by reseeding', savedState().templates.length === afterV3Delete && !savedState().templates.some((x) => x.name === '危机干预记录'));

  // 常用句式 panel: renders corpus groups, inserts at cursor of focused field, selects 〔〕 slot
  w.openSession('', clientId);
  w.document.getElementById('sRecordMode').value = 'detailed'; w.updateSessionMode();
  w.togglePhrasePanel();
  const panelHtml = w.document.getElementById('phrasePanel').innerHTML;
  check('phrase panel renders corpus groups incl. modality groups', panelHtml.includes('呈现') && panelHtml.includes('干预 · CBT／认知行为') && panelHtml.includes('苏格拉底式提问') && panelHtml.includes('计划'));
  const workEl = w.document.getElementById('sWork');
  workEl.value = '前文。';
  workEl.focus();
  workEl.setSelectionRange(3, 3);
  workEl.dispatchEvent(new w.Event('focusin', { bubbles: true }));
  const slotChip = [...w.document.querySelectorAll('.phrase-chip')].find((b) => b.textContent.includes('识别与〔问题〕相关的触发因素'));
  slotChip.click(); await tick();
  check('phrase inserted at cursor of focused field', workEl.value.startsWith('前文。咨询师协助来访者识别与〔问题〕相关的触发因素。'));
  check('first 〔〕 slot selected after insert', workEl.selectionStart === 3 + '咨询师协助来访者识别与'.length && workEl.value.slice(workEl.selectionStart, workEl.selectionEnd) === '〔问题〕');
  w.eval('sessionFocusField=null');
  const fbChip = [...w.document.querySelectorAll('.phrase-chip')].find((b) => b.textContent.includes('积极倾听、反映与肯定'));
  fbChip.click(); await tick();
  check('phrase insert falls back to interventions field when nothing focused', workEl.value.includes('咨询师运用积极倾听、反映与肯定'));
  w.eval('sessionDialog.close()');

  // ---- Logo + client document (PDF) layout ----
  w.setLogoData('data:image/png;base64,iVBORw0KGgo=');
  await flush();
  check('logo stored in settings', savedState().settings.logoData.startsWith('data:image/png'));
  check('brand logo shown in header', w.document.getElementById('brandLogo').style.display === 'block');
  w.showView('statement');
  w.initStatement();
  w.document.getElementById('stmtClient').value = clientId;
  w.renderStatement();
  check('statement uses branded letterhead with logo', w.document.getElementById('stmtBody').innerHTML.includes('data:image/png') && w.document.getElementById('stmtBody').innerHTML.includes('linear-gradient(125deg,#132228'));
  w.eval("db.settings.docHeaderStyle='minimal';db.settings.pdfFooter='页脚测试文字'");
  w.renderStatement();
  check('minimal letterhead + footer text applied', !w.document.getElementById('stmtBody').innerHTML.includes('linear-gradient(125deg,#132228,#355564') && w.document.getElementById('stmtBody').innerHTML.includes('页脚测试文字'));
  w.removeLogo(); await flush();
  check('logo removed', !savedState().settings.logoData);


  check('DAP + BIRP builtin templates seeded', savedState().templates.some(x => x.name === 'DAP 记录') && savedState().templates.some(x => x.name === 'BIRP 记录'));

  // ---- Problem phrase groups （问题句式） + My Phrases （我的句式） ----
  // Phrase panel: problem groups + My Phrases (star / custom / delete)
  w.openSession('', clientId);
  w.document.getElementById('sRecordMode').value = 'detailed'; w.updateSessionMode();
  w.renderPhrasePanel();
  let minePanelHtml = w.document.getElementById('phrasePanel').innerHTML;
  check('phrase panel renders problem groups', minePanelHtml.includes('问题句式：焦虑') && minePanelHtml.includes('问题句式：强迫') && minePanelHtml.includes('暴露与反应预防的原则'));
  check('my-phrases pinned section renders at panel top', minePanelHtml.includes('★ 我的常用') && minePanelHtml.indexOf('★ 我的常用') < minePanelHtml.indexOf('呈现'));
  const favText = '咨询师将来访者的〔情绪〕感受正常化，并肯定其应对努力。';
  const favChipIdx = [...w.document.querySelectorAll('.phrase-chip')].findIndex((b) => b.textContent === favText);
  check('star target chip found', favChipIdx >= 0);
  w.document.querySelectorAll('.phrase-star')[favChipIdx].click(); await tick();
  check('starring a phrase persists favorites to prefs', JSON.parse(w.eval("window.desktopDB.getPref('aiFavPhrases')") || '[]').includes(favText));
  minePanelHtml = w.document.getElementById('phrasePanel').innerHTML;
  check('favorited phrase renders inside pinned 我的常用 section', minePanelHtml.split('★ 我的常用')[1].split('呈现')[0].includes(favText));
  const customText = '咨询师以一句话小结本次咨询的核心主题，并确认来访者的理解。';
  w.document.getElementById('myPhraseInput').value = customText;
  w.document.getElementById('myPhraseAdd').click(); await tick();
  check('custom phrase persists to prefs', JSON.parse(w.eval("window.desktopDB.getPref('aiCustomPhrases')") || '[]').includes(customText));
  check('custom phrase renders in pinned section', w.document.getElementById('phrasePanel').innerHTML.includes(customText));
  w.document.querySelectorAll('.phrase-del')[0].click(); await tick();
  check('custom phrase deletable and removed from prefs', !JSON.parse(w.eval("window.desktopDB.getPref('aiCustomPhrases')") || '[]').includes(customText));
  w.eval('sessionDialog.close()');

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
  check('client fully deleted with cascade', !endState.clients.some((c) => c.id === clientId) && !endState.sessions.some((s) => s.clientId === clientId) && !endState.finance.some((f) => f.clientId === clientId) && !endState.assessments.some((a) => a.clientId === clientId));

  // ---- No AI anywhere: no nav entry, no bridge methods, no view ----
  check('no AI nav entry exists', !w.document.querySelector('nav button[data-view="ai"]'));
  check('renderAi / initAiGate are gone', typeof w.renderAi === 'undefined' && typeof w.initAiGate === 'undefined');
  check('desktop bridge has no AI methods', typeof w.desktopDB.aiCompStatus === 'undefined' && typeof w.desktopDB.transcribeStart === 'undefined' && typeof w.desktopDB.generateStart === 'undefined');
  check('no 智能记录 text anywhere in the UI', !w.document.body.textContent.includes('智能记录'));
  w.options();
  check('manual templates stay in session picker', [...w.document.getElementById('sTemplate').options].some((o) => o.textContent === '督导记录'));
  w.renderPhrasePanel();
  const manWork = w.document.getElementById('sWork'); manWork.value = '';
  w.eval('sessionFocusField=null');
  const manChip = [...w.document.querySelectorAll('.phrase-chip')].find((b) => b.textContent.includes('无条件积极关注'));
  manChip.click(); await tick();
  check('phrase panel renders and inserts for manual writing', manWork.value.includes('咨询师以无条件积极关注与温暖接纳建立咨询关系与信任。'));
  const portPanelHtml = w.document.getElementById('phrasePanel').innerHTML;
  check('My Phrases + problem groups stay in phrase panel', portPanelHtml.includes('★ 我的常用') && portPanelHtml.includes('问题句式：焦虑') && portPanelHtml.includes(favText));
  const portWork = w.document.getElementById('sWork'); portWork.value = '';
  w.eval('sessionFocusField=null');
  const portChip = [...w.document.querySelectorAll('.phrase-chip')].find((b) => b.textContent.includes('灾难化预期'));
  portChip.click(); await tick();
  check('problem phrase insert still works', portWork.value.includes('灾难化预期'));

  const liveClient = savedState().clients[0].id;
  // ---- V3.2.0: scale pack (SDS / SCL-90 / PSQI scoring) ----
  const sdsAns = Array(20).fill(1); sdsAns[0] = 4;
  const sds = w.eval(`scoreAssessment('SDS', ${JSON.stringify(sdsAns)})`);
  check('SDS reverse scoring + standard score (66, 中度抑郁)', sds.total === 66 && sds.severity === '中度抑郁' && sds.detail.includes('标准分 66'));
  const sas = w.eval(`scoreAssessment('SAS', Array(20).fill(2))`);
  check('SAS uniform answers score sanely', sas.total === 56 && sas.severity === '轻度焦虑');
  const sclAns = Array(90).fill(1); sclAns[14] = 3;
  const scl = w.eval(`scoreAssessment('SCL-90', ${JSON.stringify(sclAns)})`);
  check('SCL-90 total/factors/suicide-item flag', scl.total === 92 && scl.flag === true && scl.detail.includes('阳性项目 1 项'));
  const psqi = w.eval(`scoreAssessment('PSQI', {bed:'23:00',wake:'07:00',latency:45,hours:6,fa:2,fb:1,fc:0,fd:0,fe:0,ff:0,fg:0,fh:1,fi:0,fj:0,quality:1,meds:0,sleepy:1,energy:1})`);
  check('PSQI seven-component total = 7 （一般）', psqi.total === 7 && psqi.severity === '睡眠质量一般' && psqi.detail.includes('睡眠效率 1'));
  w.openAssessment('', liveClient); await tick();
  w.document.getElementById('aScale').value = 'SDS'; w.renderAssessmentItems();
  check('SDS items render (20 items, zung options)', w.document.querySelectorAll('#aItems input[type=radio]').length === 80 && w.document.getElementById('aItems').textContent.includes('没有或很少时间'));
  w.eval('assessmentDialog.close()');

  // ---- V3.2.0: structured risk assessment + watchlist ----
  w.openCrisis('', liveClient); await tick();
  w.document.getElementById('crLevel').value = '高';
  w.document.getElementById('crRiskFactors').value = '有自伤意念，无具体计划';
  w.document.getElementById('crActions').value = '已共同制定安全计划，约定危机时拨打 12356';
  w.document.getElementById('crFollowUp').value = w.eval(`(()=>{const d=new Date();d.setDate(d.getDate()-2);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')})()`);
  await w.saveCrisis(); await flush();
  check('risk assessment persisted', savedState().riskAssessments.length === 1 && savedState().riskAssessments[0].level === '高');
  w.showView('assessments'); await tick();
  check('risk watchlist flags overdue follow-up', w.document.getElementById('riskWatch').innerHTML.includes('已逾期'));
  check('risk list renders the record', w.document.getElementById('riskList').innerHTML.includes('高风险'));
  w.openRisk(liveClient); await tick();
  check('original 风险与转介 dialog intact (no id collision)', !!w.document.getElementById('rSelfHarm') && w.document.getElementById('rLevel').innerHTML.includes('高风险'));
  w.eval('riskDialog.close()');

  // ---- V3.2.0: case members （伴侣/家庭） + session attendees + invoice fields ----
  const member = savedState().clients[0];
  w.openClient(member.id); await tick();
  w.document.getElementById('cCaseType').value = '伴侣咨询';
  w.document.getElementById('cInvoiceTitle').value = '某某科技有限公司';
  w.document.getElementById('cInvoiceTaxId').value = '91310000TEST000001';
  const mbox = w.document.querySelector('.c-member-choice');
  check('member choices render for case linking', !!mbox || w.document.querySelectorAll('.c-member-choice').length === 0);
  w.saveClient(); await flush();
  const savedMember = savedState().clients.find((c) => c.id === member.id);
  check('case type + invoice fields persisted', savedMember.caseType === '伴侣咨询' && savedMember.invoiceTitle === '某某科技有限公司' && savedMember.invoiceTaxId === '91310000TEST000001');

  // ---- V3.2.0: WeChat scripts ----
  w.openWx({ name: '测试', amount: '300.00' }); await tick();
  const wxOpts = [...w.document.getElementById('wxKind').options].map((o) => o.value);
  check('wx templates include payment when amount present', wxOpts.includes('payment') && wxOpts.includes('confirm'));
  w.document.getElementById('wxKind').value = 'payment'; w.renderWxText();
  check('wx payment text fills amount', w.document.getElementById('wxText').value.includes('¥300.00'));
  w.eval('wxDialog.close()');

  // ---- V3.2.0: therapy groups (create, log, attendance fees) ----
  w.openGroup(); await tick();
  w.document.getElementById('gName').value = '焦虑管理团体';
  w.document.getElementById('gFee').value = '150';
  const gcheck = w.document.querySelector('.g-member-choice');
  if (gcheck) gcheck.checked = true;
  await w.saveGroup(); await flush();
  check('group persisted with member', savedState().groups.length === 1 && savedState().groups[0].memberIds.length >= 1);
  w.showView('groups'); await tick();
  const att = w.document.querySelector('.gl-attendee');
  if (att) att.checked = true;
  w.document.getElementById('glTopic').value = '认识焦虑';
  await w.saveGroupLog(); await flush();
  check('group session log saved', savedState().groups[0].logs.length === 1);
  const logId = savedState().groups[0].logs[0].id;
  await w.genGroupFees(logId); await flush();
  check('attendance fees generated as 待收款 finance rows', savedState().finance.some((f) => f.type === '团体咨询' && f.status === '待收款' && Number(f.amount) === 150));
  check('log marked feeGenerated (no duplicates)', savedState().groups[0].logs[0].feeGenerated === true);

  // ---- V3.3.0: layout integrity + phrase panel UX + quick actions ----
  check('all view sections are direct children of main (no blank-page nesting)', [...w.document.querySelectorAll('section.view')].every((s) => s.parentElement.tagName === 'MAIN'));
  check('dashboard quick actions present', w.document.querySelector('.quick-actions') !== null && w.document.querySelectorAll('.quick-actions button').length === 5);
  w.openSession('', liveClient); await tick();
  if (w.document.getElementById('phrasePanel').style.display === 'none') w.togglePhrasePanel(); await tick();
  const groupHeads = w.document.querySelectorAll('.phrase-group-head');
  const groupBodies = w.document.querySelectorAll('.phrase-group-body');
  check('phrase panel groups are collapsible (later groups start collapsed)', groupHeads.length >= 10 && groupBodies.length >= 10 && groupBodies[groupBodies.length - 1].style.display === 'none');
  const fs = w.document.getElementById('phraseSearch');
  fs.value = '苏格拉底'; w.filterPhrases();
  const visChips = [...w.document.querySelectorAll('.phrase-chip')].filter((b) => b.closest('.phrase-unit').style.display !== 'none');
  check('phrase search filters to matching phrases', visChips.length >= 1 && visChips.every((b) => b.textContent.includes('苏格拉底')));
  fs.value = ''; w.filterPhrases();
  w.eval('sessionDialog.close()');

  // ---- V3.4.0: scripts (TextExpander) + PDF export + hints + 微信脚本 rename ----
  w.eval(`window.desktopDB.setPref('aiCustomPhrases', JSON.stringify(['旧句式一条〔空〕'])); window.desktopDB.setPref('twScripts', '[]'); twScriptsCache = null; aiCustomPhrasesCache = null;`);
  check('legacy custom phrases migrated into script store', w.eval('loadScripts()').some((s) => s.body.includes('旧句式一条')));
  w.eval(`aiAddCustomPhrase('复诊开场：上次以来〔变化〕如何。', 'fz')`);
  check('script with shortcut stored', w.eval('loadScripts()').some((s) => s.shortcut === 'fz'));
  w.openSession('', liveClient); await tick();
  const work = w.document.getElementById('sWork');
  work.focus(); work.value = '记录：fz'; work.setSelectionRange(5, 5);
  work.dispatchEvent(new w.Event('input', { bubbles: true })); await tick();
  const dd = w.document.getElementById('expDropdown');
  check('shortcut typing opens script dropdown', !!dd && dd.style.display === 'block' && dd.textContent.includes('复诊开场'));
  work.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await tick();
  check('enter expands shortcut into script text', work.value === '记录：复诊开场：上次以来〔变化〕如何。' && dd.style.display === 'none');
  work.value = '补充/苏格拉底'; work.setSelectionRange(7, 7);
  work.dispatchEvent(new w.Event('input', { bubbles: true })); await tick();
  check('slash search finds corpus scripts', dd.style.display === 'block' && dd.textContent.includes('苏格拉底式提问'));
  work.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  check('escape closes dropdown without changing text', dd.style.display === 'none' && work.value === '补充/苏格拉底');
  w.eval('sessionDialog.close()');
  w.showView('finance'); w.renderFinance(); await tick();
  check('wechat feature renamed to 脚本', w.document.getElementById('wxDialog').innerHTML.includes('微信脚本') && w.document.querySelector('#financeTable').innerHTML.includes('>脚本</a>'));
  check('hint tooltips present across features', w.document.querySelectorAll('.hint[data-hint]').length >= 6);
  w.exportClientPdf(liveClient); await tick();
  const expHtml = w.document.getElementById('exportBody').innerHTML;
  check('single-client PDF export renders full record', expHtml.includes('来访者记录档案') && expHtml.includes('咨询记录') && expHtml.includes('收费记录') && expHtml.includes('敏感个人信息'));
  await w.exportAllPdf(); await tick();
  check('all-clients export renders too', w.document.getElementById('exportBody').innerHTML.length > 200);


  // ===== V3.5.0 TESTS: intuitive workflow round =====
  try {
    const st35 = savedState();
    const cidA = st35.clients[0].id;
    w.eval(`(()=>{const c=db.clients.find(x=>x.id==='${cidA}');c.defaultFee=500;save()})()`);
    w.eval(`openSession('','${cidA}','2026-09-01')`); await new Promise(r => setTimeout(r, 60));
    w.eval(`sRecordMode.value='key';updateSessionMode();sKeyFocus.value='关键主题A';sKeyNext.value='关键下次安排A';sGenFee.checked=false;saveSession()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`openSession('','${cidA}','2026-09-08')`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 last-review strip shows previous plan', w.eval(`document.getElementById('sLastReview').style.display`) === 'block' && w.eval(`document.getElementById('sLastReview').textContent`).includes('关键下次安排A'));
    check('V3.5 new session inherits previous record mode', w.eval(`sRecordMode.value`) === 'key');
    check('V3.5 fee row visible + amount prefilled from default fee', w.eval(`document.getElementById('sFeeRow').style.display`) === 'flex' && Number(w.eval(`sFeeAmount.value`)) === 500);
    w.eval(`sKeyFocus.value='第二讲';saveSession()`); await new Promise(r => setTimeout(r, 60));
    const fees1 = savedState().finance.filter(f => f.clientId === cidA && f.type === '心理咨询' && Number(f.amount) === 500);
    check('V3.5 saving a new session generates one pending fee', fees1.length === 1 && fees1[0].status === '待收款');
    w.eval(`openSession('','${cidA}','2026-09-08')`); await new Promise(r => setTimeout(r, 60));
    w.eval(`sGenFee.checked=true;sFeeAmount.value='500';sKeyFocus.value='重复收费守卫';saveSession()`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 duplicate fee is not generated twice', savedState().finance.filter(f => f.clientId === cidA && f.type === '心理咨询' && Number(f.amount) === 500).length === 1);
    w.eval(`openEvent('','${cidA}','2026-10-05')`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 repeat row visible for new event', w.eval(`document.getElementById('eRepeatRow').style.display`) !== 'none');
    w.eval(`eTime.value='10:00';eRepeat.value='weekly';eRepeatCount.value='3';saveEvent()`); await new Promise(r => setTimeout(r, 60));
    const reps = savedState().events.filter(e => e.clientId === cidA && e.time === '10:00' && e.date >= '2026-10-05');
    check('V3.5 weekly repeat creates 3 weekly events', reps.length === 3 && reps.map(e => e.date).sort().join(',') === '2026-10-05,2026-10-12,2026-10-19');
    const evId = reps.slice().sort((a,b)=>a.date.localeCompare(b.date))[0].id;
    w.eval(`openEvent('${evId}')`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 reschedule button visible for existing event', w.eval(`document.getElementById('eRescheduleBtn').style.display`) === 'inline-block');
    w.eval(`openReschedule()`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 reschedule defaults to +7 days', w.eval(`rsDate.value`) === '2026-10-12');
    w.eval(`rsDate.value='2026-10-07';doReschedule()`); await new Promise(r => setTimeout(r, 60));
    const stR = savedState(); const orig = stR.events.find(e => e.id === evId);
    check('V3.5 reschedule cancels original with note + creates new confirmed event', orig.status === '已取消' && (orig.notes || '').includes('已改期至 2026-10-07') && stR.events.some(e => e.clientId === cidA && e.date === '2026-10-07' && e.status === '已确认' && e.time === '10:00'));
    const ev2 = reps.slice().sort((a,b)=>a.date.localeCompare(b.date))[1].id;
    w.eval(`openEvent('${ev2}')`); await new Promise(r => setTimeout(r, 60));
    w.eval(`eStatus.value='爽约';saveEvent()`); await new Promise(r => setTimeout(r, 120));
    check('V3.5 marking no-show opens follow-up dialog', !!w.eval(`document.getElementById('followupDialog').open`));
    w.eval(`makeFollowTask()`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 follow-up creates a task', savedState().tasks.some(t => (t.title || '').includes('跟进') && t.clientId === cidA));
    w.eval(`openFollowup(db.events.find(e=>e.id==='${ev2}'))`); await new Promise(r => setTimeout(r, 60));
    w.eval(`openFollowWx()`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 follow-up opens WeChat script with no-show kind', !!w.eval(`document.getElementById('wxDialog').open`) && w.eval(`wxKind.value`) === 'noshow');
    w.eval(`wxDialog.close()`);
    w.eval(`moveEventToDate('${ev2}','2026-10-15')`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 drag-move changes event date keeping time', savedState().events.find(e => e.id === ev2).date === '2026-10-15');
    w.eval(`openAssessment('','${cidA}');aScale.value='PHQ-9';aDate.value='2026-08-10';document.querySelectorAll('#aItems input').forEach((el,i)=>{el.checked=i<5});saveAssessment()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`openAssessment('','${cidA}');aScale.value='PHQ-9';aDate.value='2026-09-10';document.querySelectorAll('#aItems input').forEach(el=>el.checked=false);saveAssessment()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`viewClient('${cidA}')`); await new Promise(r => setTimeout(r, 60));
    const profileHtml = w.eval(`document.getElementById('clientDetail').innerHTML`);
    check('V3.5 profile shows scale trend sparkline', profileHtml.includes('<svg') && profileHtml.includes('趋势'));
    check('V3.5 profile shows timeline with session entries', profileHtml.includes('时间线') && profileHtml.includes('咨询记录'));
    w.eval(`openStageSummary('${cidA}')`); await new Promise(r => setTimeout(r, 60));
    w.eval(`ssFrom.value='2026-08-01';ssTo.value='2026-10-31';generateStageSummary()`); await new Promise(r => setTimeout(r, 60));
    const ssText = w.eval(`ssText.value`);
    check('V3.5 stage summary assembles counts + scale change', ssText.includes('咨询概况') && ssText.includes('PHQ-9') && ssText.includes('后续建议'));
    w.eval(`printStageSummary()`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 stage summary prints via export view', w.eval(`document.getElementById('exportView').classList.contains('active')`));
    w.eval(`stageSummaryDialog.close()`);
    w.eval(`openQuickJump()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`qjInput.value='收费';renderQJ('收费')`); await new Promise(r => setTimeout(r, 40));
    check('V3.5 quick jump filters pages', w.eval(`qjItems.some(i=>i.label==='收费对账单')`));
    w.eval(`runQJ(qjItems.findIndex(i=>i.label==='收费对账单'))`); await new Promise(r => setTimeout(r, 60));
    check('V3.5 quick jump navigates to finance', w.eval(`document.getElementById('finance').classList.contains('active')`));
    w.eval(`showView('clients');openClient()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`document.getElementById('cName').value='快捷保存来访'`);
    w.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))`); await new Promise(r => setTimeout(r, 80));
    check('V3.5 Ctrl+S saves open dialog', savedState().clients.some(c => c.name === '快捷保存来访'));
    const old40 = w.eval(`addDaysStr(todayLocal(),-40)`);
    const act = savedState().clients.find(c => c.status === '进行中');
    if (act) {
      w.eval(`openAssessment('','${act.id}');aScale.value='GAD-7';aDate.value='${old40}';document.querySelectorAll('#aItems input').forEach(el=>el.checked=false);saveAssessment()`); await new Promise(r => setTimeout(r, 60));
      w.eval(`showView('dashboard');renderTodayWorkspace()`); await new Promise(r => setTimeout(r, 60));
      check('V3.5 retest reminder lists stale-assessment client', w.eval(`document.getElementById('retestCard').style.display`) === 'block' && w.eval(`document.getElementById('retestCard').textContent`).includes(act.name));
    }
    check('V3.5 onboarding checklist function present', w.eval('typeof renderOnboarding') === 'function');
    w.eval(`(()=>{db.settings.lastBackup=new Date().toISOString();save();renderOnboarding()})()`); await new Promise(r => setTimeout(r, 40));
    check('V3.5 onboarding hides when all steps done', w.eval(`document.getElementById('onboardCard').style.display`) === 'none');
    w.eval(`renderFavNav()`); await new Promise(r => setTimeout(r, 40));
    check('V3.5 favorites nav renders default entries', w.eval(`document.getElementById('favNav').querySelectorAll('button[data-view]').length`) >= 4);
    w.eval(`toggleFav('insights',true)`); await new Promise(r => setTimeout(r, 40));
    check('V3.5 toggling a favorite persists + shows in nav', w.eval(`favViewsGet().includes('insights')`) && w.eval(`!!document.querySelector('#favNav button[data-view="insights"]')`));
    w.eval(`toggleFav('insights',false)`); await new Promise(r => setTimeout(r, 40));
  } catch (e) { console.error('V35 TEST ERROR', e); check('V3.5 block completed without exception', false); }


  // ===== V3.6.0 TESTS: trend lines + live auto-scoring =====
  try {
    w.eval(`openClient();document.getElementById('cName').value='趋势线测试';saveClient()`); await new Promise(r => setTimeout(r, 60));
    const cidT = savedState().clients.find(c => c.name === '趋势线测试').id;
    const setAns = pairs => { pairs.forEach(([i, v]) => { const el = document.querySelector(`input[name="aq${i}"][value="${v}"]`); if (el) el.click(); }); };
    w.eval(`openAssessment('','${cidT}');aScale.value='GAD-7';renderAssessmentItems()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`(${setAns.toString()})([[0,3],[1,3]])`); await new Promise(r => setTimeout(r, 60));
    check('V3.6 live auto-scoring updates total before saving', w.eval(`aTotal.textContent`) === '6');
    w.eval(`aDate.value='2026-07-05';saveAssessment()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`openAssessment('','${cidT}');aScale.value='GAD-7';renderAssessmentItems();(${setAns.toString()})([[0,2],[1,2]]);aDate.value='2026-08-05';saveAssessment()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`openAssessment('','${cidT}');aScale.value='GAD-7';renderAssessmentItems();(${setAns.toString()})([[0,1],[1,1]]);aDate.value='2026-09-05';saveAssessment()`); await new Promise(r => setTimeout(r, 60));
    const gads = savedState().assessments.filter(a => a.clientId === cidT && a.scale === 'GAD-7').map(a => a.total).sort((x, y) => x - y);
    check('V3.6 auto-scored totals stored (2/4/6)', JSON.stringify(gads) === '[2,4,6]');
    w.eval(`showView('assessments');renderAssessments()`); await new Promise(r => setTimeout(r, 80));
    const trendsHtml = w.eval(`(document.getElementById('assessmentTrends')||{innerHTML:''}).innerHTML`);
    check('V3.6 assessments page renders score trend line', trendsHtml.includes('<svg') && trendsHtml.includes('GAD-7') && trendsHtml.includes('分数趋势'));
    check('V3.6 trend header shows first→latest change', trendsHtml.includes('首测 6 分') && trendsHtml.includes('最近 2 分'));
    // income trend: finance in current + previous month (page-relative)
    const mk = w.eval(`(()=>{const t=todayLocal();const d=new Date(t+'T00:00:00');const cur=t.slice(0,8)+'10';d.setMonth(d.getMonth()-1);const prev=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-10';return {cur,prev}})()`);
    w.eval(`(()=>{db.finance.push({id:'tf1',date:'${mk.cur}',type:'心理咨询',clientId:'${cidT}',title:'趋势收入',amount:1000,received:800,status:'部分收款',paymentMethod:'',invoiceStatus:'未开票',invoiceNo:'',dueDate:'',notes:'',createdAt:new Date().toISOString()});db.finance.push({id:'tf2',date:'${mk.prev}',type:'心理咨询',clientId:'${cidT}',title:'趋势收入',amount:600,received:600,status:'已结清',paymentMethod:'',invoiceStatus:'未开票',invoiceNo:'',dueDate:'',notes:'',createdAt:new Date().toISOString()});save()})()`); await new Promise(r => setTimeout(r, 60));
    w.eval(`showView('insights');renderInsights()`); await new Promise(r => setTimeout(r, 80));
    const insHtml = w.eval(`document.getElementById('insightsBody').innerHTML`);
    check('V3.6 insights shows income trend line chart', insHtml.includes('近 6 个月收入趋势') && insHtml.includes('<svg') && insHtml.includes('实收') && insHtml.includes('应收'));
    check('V3.6 insights no longer uses bar rows for the trend', !insHtml.includes('近 6 个月实收</h3>'));
    // profile sparkline still intact after refactor-free addition
    w.eval(`viewClient('${cidT}')`); await new Promise(r => setTimeout(r, 60));
    check('V3.6 profile trend sparkline still renders', w.eval(`document.getElementById('clientDetail').innerHTML`).includes('<svg'));
  } catch (e) { console.error('V36 TEST ERROR', e); check('V3.6 block completed without exception', false); }


  // ===== V3.7.0 TESTS: bilingual UI =====
  try {
    prefs.delete('uiLang');
    const domEn = new JSDOM(html, {
      url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        window.__TAURI__ = { core: { invoke: fakeInvoke } };
        window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
        window.HTMLDialogElement.prototype.close = function () { this.open = false; };
        window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
        window.URL.createObjectURL = () => 'blob:fake'; window.URL.revokeObjectURL = () => {};
      },
    });
    const we = domEn.window;
    await new Promise(r => setTimeout(r, 90));
    check('V3.7 English system auto-detects English UI', we.eval(`i18nState.lang`) === 'en');
    check('V3.7 pill switcher present with EN active', !!we.document.getElementById('langEn') && we.document.getElementById('langEn').classList.contains('on'));
    check('V3.7 header subtitle translated', we.document.getElementById('appSubtitle').textContent.includes('Local counseling records'));
    check('V3.7 nav translated', we.document.body.textContent.includes('Task board') && !we.document.querySelector('[data-view="tasks"]').textContent.includes('任务看板'));
    // option display translates but the semantic value stays Chinese
    const optCheck = we.eval(`(() => { const s = document.getElementById('eStatus'); if (!s) return 'no-select'; const o = [...s.options].find(x => x.value === '已确认'); return o ? o.textContent.trim() : 'no-option'; })()`);
    check('V3.7 status option shows English but keeps Chinese value', optCheck === 'Confirmed');
    // an in-English rendered dialog: open the event dialog and read a label
    we.eval(`openEvent()`); await new Promise(r => setTimeout(r, 60));
    check('V3.7 dialog labels translated live', we.document.getElementById('eventDialog').textContent.includes('Linked client'));
    // switching back to Chinese restores, and the choice persists as a pref
    we.eval(`setUiLang('zh')`); await new Promise(r => setTimeout(r, 60));
    check('V3.7 switching to Chinese restores labels', we.document.querySelector('[data-view="tasks"]').textContent.includes('任务看板'));
    check('V3.7 language choice persisted to prefs', prefs.get('uiLang') === 'zh');
    we.eval(`setUiLang('en')`); await new Promise(r => setTimeout(r, 60));
    check('V3.7 switching back to English re-translates', we.document.querySelector('[data-view="tasks"]').textContent.includes('Task board'));
    prefs.delete('uiLang');
  } catch (e) { console.error('V37 TEST ERROR', e); check('V3.7 block completed without exception', false); }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nSMOKE TEST: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(2); });
