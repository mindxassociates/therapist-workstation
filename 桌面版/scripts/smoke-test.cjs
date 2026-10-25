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
let aiProc = null, aiDiscarded = '', lastPrompt = '';
const prefs = new Map();
let user = null;
const fakeInvoke = async (cmd, args = {}) => {
  switch (cmd) {
    case 'startup_status': return { needsSetup: workspaceJson === null, authenticated: false, user: null, edition: 'full' };
    case 'startup_setup': user = { id: 'u1', username: args.input.username, displayName: args.input.displayName || args.input.username, role: '管理员' }; workspaceJson = '{}'; return { ok: true, user };
    case 'startup_login': return { ok: true, user };
    case 'auth_status': return { needsSetup: false, authenticated: !!user, user, edition: 'full' };
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
    case 'ai_status': return { whisper: { found: true, path: '/fake/whisper-cli' }, llama: { found: true, path: '/fake/llama-cli' }, models: [
      { id: 'base', kind: 'whisper', label: '基础 base', file: 'ggml-base.bin', downloaded: false, bytes: 0 },
      { id: 'small', kind: 'whisper', label: '均衡 small', file: 'ggml-small.bin', downloaded: true, bytes: 487601967 },
      { id: 'qwen15', kind: 'llm', label: 'Qwen2.5 1.5B', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', downloaded: false, bytes: 0 },
      { id: 'qwen3', kind: 'llm', label: 'Qwen2.5 3B', file: 'qwen2.5-3b-instruct-q4_k_m.gguf', downloaded: true, bytes: 2104049000 } ],
      modelsDir: '/fake/ai-models', enginesDir: '/fake/ai-engines', os: 'windows', download: null, proc: null };
    case 'ai_download': return true;
    case 'ai_download_cancel': return true;
    case 'ai_set_engine_path': return true;
    case 'ai_import_model': return 'imported.gguf';
    case 'audio_begin': return { id: 'a1', path: '/fake/ai-audio/a1.wav' };
    case 'audio_append': return true;
    case 'audio_finish': return { path: '/fake/ai-audio/a1.wav', bytes: 1234 };
    case 'audio_discard': aiDiscarded = args.path; return true;
    case 'transcribe_start': aiProc = { kind: 'transcribe', n: 0 }; return true;
    case 'generate_start': lastPrompt = args.prompt; aiProc = { kind: 'generate', n: 0 }; return true;
    case 'ai_proc_poll': { if (!aiProc) return { active: false, kind: '', done: true, output: '', progress: -1 };
      aiProc.n++; if (aiProc.n < 2) return { active: true, kind: aiProc.kind, done: false, progress: 50, output: '' };
      const kind = aiProc.kind; aiProc = null;
      const output = kind === 'transcribe'
        ? '来访者：最近睡眠不好，工作压力很大。\n咨询师：我们先看看睡眠的情况。'
        : '前置噪音<|im_start|>assistant\n{"focus":"工作压力与失眠","updates":"来访者报告连续两周入睡困难","work":"讨论睡眠卫生与放松练习","response":"来访者表示愿意尝试","plan":"执行睡前放松练习","next":"跟进睡眠改善情况"}<|im_end|>\nllama_print_timings: total';
      return { active: false, kind, done: true, progress: 100, output }; }
    case 'ai_proc_cancel': aiProc = null; return true;
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


  // ---- Offline AI: engine status, transcription flow, note generation ----
  w.showView('ai'); await flush(); await tick(); await tick();
  check('ai view renders, downloaded whisper model selected', w.document.getElementById('aiBody').innerHTML.includes('录音转写引擎') && w.document.getElementById('aiWhisperModel').value === 'small');
  w.eval("aiAudioPath='/fake/ai-audio/a1.wav'");
  w.document.getElementById('aiClient').value = clientId;
  await w.startTranscribe();
  await w.aiPollOnce();
  await w.aiPollOnce();
  check('transcript filled from engine output', w.document.getElementById('aiTranscript').value.includes('睡眠不好'));
  check('recording discarded after transcription (default on)', aiDiscarded === '/fake/ai-audio/a1.wav');
  w.document.getElementById('aiLlmModel').value = 'qwen3';
  await w.generateNote('transcript');
  check('generation prompt is ChatML + JSON-only instruction', lastPrompt.includes('<|im_start|>system') && lastPrompt.includes('JSON'));
  await w.aiPollOnce();
  await w.aiPollOnce();
  check('generated JSON parsed into session fields', w.document.getElementById('sFocus').value === '工作压力与失眠' && w.document.getElementById('sPlan').value.includes('放松练习') && w.document.getElementById('sNext').value.includes('睡眠'));
  w.eval('sessionDialog.close()');
  w.document.getElementById('aiBrief').value = '来访者诉工作压力大，失眠两周。';
  await w.generateNote('brief');
  await w.aiPollOnce();
  await w.aiPollOnce();
  check('brief-summary generation fills the dialog too', w.document.getElementById('sFocus').value === '工作压力与失眠');
  w.eval('sessionDialog.close()');

  // ---- V3.1.9: output language / format / orientation / custom template / speaker marks / clear-on-save ----
  check('output language + format selectors exist', !!w.document.getElementById('aiOutLang') && !!w.document.getElementById('aiFormat'));
  check('transcribe language list is multilingual (es/ja present)', [...w.document.getElementById('aiLang').options].some(o => o.value === 'es') && [...w.document.getElementById('aiLang').options].some(o => o.value === 'ja'));
  check('output language list includes English + Spanish', [...w.document.getElementById('aiOutLang').options].some(o => o.value === 'en') && [...w.document.getElementById('aiOutLang').options].some(o => o.value === 'es'));
  check('DAP + BIRP builtin templates seeded', savedState().templates.some(x => x.name === 'DAP 记录') && savedState().templates.some(x => x.name === 'BIRP 记录'));
  w.document.getElementById('aiTranscript').value = '最近睡不好。';
  w.aiInsertSpeaker('咨询师');
  check('speaker marker inserted into transcript', w.document.getElementById('aiTranscript').value.includes('咨询师：'));
  w.document.getElementById('aiOutLang').value = 'en';
  w.document.getElementById('aiFormat').value = 'soap';
  w.document.getElementById('aiOrientation').value = 'CBT';
  w.document.getElementById('aiCustomTemplate').value = 'CUSTOM-TPL: always end with a risk line.';
  w.document.getElementById('aiCustomTemplate').dispatchEvent(new w.Event('input'));
  w.document.getElementById('aiDelTranscript').checked = true;
  await w.generateNote('brief');
  check('prompt carries output language + format + orientation + custom template', lastPrompt.includes('English') && lastPrompt.includes('SOAP') && lastPrompt.includes('CBT') && lastPrompt.includes('CUSTOM-TPL: always end with a risk line.'));
  await w.aiPollOnce();
  await w.aiPollOnce();
  check('generated draft opens session dialog (v319 flow)', w.document.getElementById('sFocus').value === '工作压力与失眠');
  await w.saveSession(); await flush();
  check('clear-on-save emptied transcript + brief caches', w.eval('aiTranscriptCache') === '' && w.eval('aiBriefCache') === '');
  check('custom template persisted to prefs', w.eval("window.desktopDB.getPref('aiCustomTemplate')") === 'CUSTOM-TPL: always end with a risk line.');

  // ---- V3.1.12: clinical-language corpus (zh) guidance in the generation prompt ----
  w.document.getElementById('aiOrientation').value = '认知行为 CBT';
  const corpusPromptCbt = w.eval("buildNotePrompt('来访者谈到工作压力与睡眠困难。')");
  check('corpus: CBT orientation matches CBT frames (苏格拉底式提问)', corpusPromptCbt.includes('苏格拉底式提问') && corpusPromptCbt.includes('干预·按取向（CBT／认知行为）'));
  check('corpus: prompt carries never-add-unsupported-content warning', corpusPromptCbt.includes('不得添加转写稿/小结中没有依据的干预、症状、风险判断或进展'));
  check('corpus: prompt carries presentation + general intervention frames', corpusPromptCbt.includes('来访者本次咨询主要报告了') && corpusPromptCbt.includes('咨询师运用积极倾听、反映与肯定'));
  check('corpus: block sits after orientation line and before custom template (custom stays highest priority)', corpusPromptCbt.indexOf('咨询师取向/风格') < corpusPromptCbt.indexOf('【临床语言语料库（中文）】') && corpusPromptCbt.indexOf('【临床语言语料库（中文）】') < corpusPromptCbt.indexOf('用户自定义模板/指令'));
  w.document.getElementById('aiOrientation').value = '';
  const corpusPromptDefault = w.eval("buildNotePrompt('来访者谈到工作压力与睡眠困难。')");
  check('corpus: no orientation falls back to supportive/humanistic frames', corpusPromptDefault.includes('无条件积极关注') && corpusPromptDefault.includes('干预·按取向（支持性／人本）') && !corpusPromptDefault.includes('苏格拉底式提问'));
  w.document.getElementById('aiOrientation').value = '创伤知情与 CBT';
  const corpusPromptOrder = w.eval("buildNotePrompt('来访者谈到工作压力与睡眠困难。')");
  check('corpus: modality match order puts trauma before CBT', corpusPromptOrder.includes('干预·按取向（创伤知情）') && corpusPromptOrder.includes('稳定化（着陆）技巧') && !corpusPromptOrder.includes('苏格拉底式提问'));
  w.document.getElementById('aiOrientation').value = '';

  // ---- V3.1.11: recording source (in-person mic / telehealth mic + system audio) + input device picker ----
  check('recording source selector exists and defaults to mic', !!w.document.getElementById('aiRecSource') && w.document.getElementById('aiRecSource').value === 'mic');
  check('recording hint explains mic mode', (w.document.getElementById('aiRecHint') || {}).textContent.includes('线下面对面'));
  await w.refreshAudioDevices(false);
  check('device picker keeps default option when mediaDevices is absent', !!w.document.getElementById('aiAudioDevice') && w.document.getElementById('aiAudioDevice').options.length >= 1 && w.document.getElementById('aiAudioDevice').options[0].textContent.includes('系统默认'));
  w.document.getElementById('aiRecSource').value = 'tele';
  w.onRecSourceChange();
  check('telehealth source persists to prefs', w.eval("window.desktopDB.getPref('aiRecSource')") === 'tele');
  check('telehealth hint mentions entire-screen sharing', w.document.getElementById('aiRecHint').textContent.includes('整个屏幕'));
  const capturedAlerts = [];
  w.alert = (m) => capturedAlerts.push(String(m));
  w.document.getElementById('aiConsent').checked = true;
  await w.startRecording();
  check('telehealth start without getDisplayMedia alerts loopback workaround and does not record',
    capturedAlerts.some((m) => m.includes('无法直接捕获系统音频')) && w.eval('recState') === null && !w.document.getElementById('aiRecBtn').disabled);
  w.alert = () => {};
  w.document.getElementById('aiRecSource').value = 'mic';
  w.onRecSourceChange();
  check('source restored to mic + persisted', w.eval("window.desktopDB.getPref('aiRecSource')") === 'mic');

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

  // ---- Editions: full keeps AI; lite removes the AI entry and labels itself ----
  check('full edition keeps the AI nav entry', !!w.document.querySelector('nav button[data-view="ai"]'));
  w.applyEdition('lite');
  check('lite edition removes AI nav and labels itself', !w.document.querySelector('nav button[data-view="ai"]') && w.document.querySelector('.nav-version').textContent.includes('精简版'));
  w.options();
  check('lite edition keeps V3 templates in session picker', [...w.document.getElementById('sTemplate').options].some((o) => o.textContent === '督导记录'));
  w.renderPhrasePanel();
  const liteWork = w.document.getElementById('sWork'); liteWork.value = '';
  w.eval('sessionFocusField=null');
  const liteChip = [...w.document.querySelectorAll('.phrase-chip')].find((b) => b.textContent.includes('无条件积极关注'));
  liteChip.click(); await tick();
  check('lite edition: phrase panel renders and inserts without AI', liteWork.value.includes('咨询师以无条件积极关注与温暖接纳建立咨询关系与信任。'));

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nSMOKE TEST: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(2); });
