// 网页版冒烟测试：node tests/web-smoke-test.cjs（需要 jsdom：npm i --no-save jsdom）
const fs = require('fs');
const { JSDOM } = require('jsdom');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const results = [];
const check = (name, cond) => { results.push([name, !!cond]); if (!cond) console.log('FAIL:', name); };

async function boot(seed) {
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.alert = () => {}; window.confirm = () => true; window.scrollTo = () => {};
      window.URL.createObjectURL = () => 'blob:x'; window.URL.revokeObjectURL = () => {};
      if (seed) window.localStorage.setItem('mx_counselor_lite_v1', JSON.stringify(seed));
    },
  });
  await new Promise((r) => setTimeout(r, 120));
  return dom;
}
const saveBtnId = (w, prefix) => {
  const b = w.document.querySelector(`[onclick^="${prefix}"]`);
  return b ? b.getAttribute('onclick').match(/'([^']+)'/)[1] : null;
};

(async () => {
  const seed = { clients: [], sessions: [], events: [], tasks: [], goals: [], quickNotes: [], finances: [], referrals: [], referralLinks: [], settings: { ownerName: '测试咨询师', practiceName: '测试工作室', accent: '#315f6b', workbenchIcon: '★' } };
  const dom = await boot(seed);
  const w = dom.window;
  const S = () => w.eval('S');
  check('boots (S exists)', typeof S() === 'object');
  check('accent migrated to portal #4a778b', S().settings.accent === '#4a778b');
  check('workbenchIcon → workstationIcon', S().settings.workstationIcon === '★' && !('workbenchIcon' in S().settings));
  check('aurora header CSS present', html.includes('linear-gradient(125deg,#132228'));

  // client + 单独同意
  w.editClient();
  w.document.getElementById('cName').value = '网页测试来访者';
  w.saveClient('new-client-id', false);
  check('client created', S().clients.length === 1);
  const cid = S().clients[0].id;
  check('checklist includes sensitive=false', S().clients[0].checklist.sensitive === false);
  w.openClient(cid);
  check('client detail shows 单独同意 item', w.document.body.innerHTML.includes('敏感个人信息单独同意已取得'));
  check('client detail has crisis + delete actions', w.document.body.innerHTML.includes('安全与危机资源') && w.document.body.innerHTML.includes('彻底删除'));
  w.eval(`setCheck('${cid}','sensitive',true)`);
  check('sensitive consent persists', JSON.parse(w.localStorage.getItem('mx_counselor_lite_v1')).clients[0].checklist.sensitive === true);

  // crisis dialog
  w.showCrisisResources();
  check('crisis dialog shows 12356', w.document.body.innerHTML.includes('12356'));

  // task: subtasks + auto-category + overdue badge
  w.editTask();
  const tid = saveBtnId(w, 'saveTask');
  w.document.getElementById('kTitle').value = '月底对账与发票';
  w.document.getElementById('kDue').value = '2020-01-01';
  w.eval("editingSubtasks = [{title:'核对记录',done:true},{title:'开发票',done:false}]");
  w.saveTask(tid);
  const tk = S().tasks.find((x) => x.id === tid);
  check('task saved with subtasks', tk && tk.subtasks.length === 2);
  check('task auto-categorized 财务收费', tk.category === '财务收费');
  w.go('tasks');
  check('board renders subtask progress + overdue badge', w.document.getElementById('tasks').innerHTML.includes('子任务 1/2') && w.document.getElementById('tasks').innerHTML.includes('已逾期'));

  // recurrence: weekly task completion spawns next
  w.editTask();
  const rid = saveBtnId(w, 'saveTask');
  w.document.getElementById('kTitle').value = '每周案例梳理';
  w.document.getElementById('kDue').value = '2026-10-20';
  w.document.getElementById('kRepeat').value = '每周';
  w.eval("editingSubtasks = []");
  w.saveTask(rid);
  w.setTaskStatus(rid, '已完成');
  const spawned = S().tasks.filter((x) => x.title === '每周案例梳理');
  check('weekly completion spawns next (+7d)', spawned.length === 2 && spawned.some((x) => x.due === '2026-10-27' && x.status === '待处理'));
  check('completedAt stamped', !!S().tasks.find((x) => x.id === rid).completedAt);

  // auto-archive sweep + restore
  w.eval(`S.tasks.find(x=>x.id==='${rid}').completedAt = new Date(Date.now()-20*86400000).toISOString(); sweepTaskArchive();`);
  check('task >14d auto-archived', S().tasks.find((x) => x.id === rid).archived === true);
  w.go('archive');
  check('archive page lists archived task', w.document.getElementById('archive').innerHTML.includes('每周案例梳理'));
  w.restoreTask(rid);
  check('archived task restored', S().tasks.find((x) => x.id === rid).archived === false);

  // privacy page renders with practice name in the notice template
  w.go('privacy');
  check('privacy page renders notice with practice name', w.document.getElementById('privacy').innerHTML.includes('测试工作室'));


  // ---- Customization: font / density / header style / home modules / landing page ----
  check('default header style is aurora (brand)', w.document.body.classList.contains('hdr-aurora'));
  w.go('settings');
  w.document.getElementById('setFontSize').value = 'large';
  w.document.getElementById('setDensity').value = 'compact';
  w.document.getElementById('setHeaderStyle').value = 'solid';
  w.document.getElementById('setHomePage').value = 'tasks';
  w.document.querySelector('.hm-input[data-module="fees"]').checked = false;
  w.saveSettings();
  const cs = S().settings;
  check('customization persisted', cs.fontSize === 'large' && cs.density === 'compact' && cs.headerStyle === 'solid' && cs.homePage === 'tasks' && cs.homeModules.fees === false);
  check('large font applies zoom', w.document.body.style.zoom === '1.08');
  check('compact + solid header classes applied', w.document.body.classList.contains('compact') && w.document.body.classList.contains('hdr-solid'));
  w.go('today');
  check('hidden home module card not displayed', w.document.querySelector('#today [data-module="fees"]').style.display === 'none');
  w.resetAppearance();
  check('reset appearance restores brand defaults', S().settings.accent === '#4a778b' && S().settings.headerStyle === 'aurora' && S().settings.fontSize === 'normal');



  // ---- Templates: builtins (record + plan), hide/restore, custom CRUD, plan application ----
  check('web builtins = 12 (9 record + 1 general + 2 plan)', w.eval('BUILTIN_TEMPLATES.length') === 12 && w.eval('visibleBuiltins().length') === 12);
  check('web plan templates available', w.eval('planTemplates().length') === 2);
  w.hideBuiltin('builtin-soap-cn');
  check('web builtin hidden', w.eval('visibleBuiltins().length') === 11);
  w.restoreBuiltins();
  check('web builtins restored', w.eval('visibleBuiltins().length') === 12);
  w.editTemplate();
  w.document.getElementById('tName').value = '我的网页方案模板';
  w.document.getElementById('tKind').value = '方案';
  w.document.getElementById('tPlanGoals').value = '网页目标Y';
  const tBtn = w.document.querySelector('[onclick^="saveTemplate"]');
  const tplId = tBtn.getAttribute('onclick').match(/saveTemplate\('([^']+)'/)[1];
  w.saveTemplate(tplId, '');
  check('web custom plan template saved', S().templates.length === 1 && S().templates[0].kind === '方案' && S().templates[0].planGoals === '网页目标Y');
  w.openClient(cid);
  check('web plan picker lists plan templates', [...w.document.getElementById('planPick').options].some((o) => o.value === 'builtin-plan-cn'));
  w.document.getElementById('planPick').value = 'builtin-plan-cn';
  w.applyPlanTemplateW(cid);
  check('web plan template applied to plan fields', w.document.getElementById('pGoals').value.includes('阶段目标'));
  w.closeModal(true);
  w.deleteTemplate(tplId);
  check('web custom template deleted', S().templates.length === 0);

  // ---- V1.15.0: easy template pack (kinds) + hide/restore a new builtin + corpus phrase panel ----
  check('web new builtin kinds correct', w.eval(`(()=>{const m=Object.fromEntries(BUILTIN_TEMPLATES.map(t=>[t.id,t.kind]));return m['builtin-contact-log-cn']==='记录'&&m['builtin-crisis-cn']==='记录'&&m['builtin-concept-cn']==='记录'&&m['builtin-family-cn']==='记录'&&m['builtin-group-cn']==='记录'&&m['builtin-supervision-cn']==='记录'&&m['builtin-referral-note-cn']==='通用'})()`));
  check('web new builtins carry sections + slots', w.eval(`['builtin-contact-log-cn','builtin-crisis-cn','builtin-concept-cn','builtin-family-cn','builtin-group-cn','builtin-supervision-cn','builtin-referral-note-cn'].every(id=>{const t=BUILTIN_TEMPLATES.find(x=>x.id===id);return t&&t.content.includes('<h3>')&&t.content.includes('【')})`));
  w.hideBuiltin('builtin-crisis-cn');
  check('web new builtin hidden', w.eval('visibleBuiltins().length') === 11 && w.eval(`visibleBuiltins().some(t=>t.id==='builtin-crisis-cn')`) === false);
  w.restoreBuiltins();
  check('web new builtin restored', w.eval('visibleBuiltins().length') === 12);
  w.editSession();
  w.togglePhrasePanel();
  check('web phrase panel renders corpus groups', w.document.getElementById('phraseGroups').innerHTML.includes('评估与进展') && w.document.getElementById('phraseGroups').innerHTML.includes('干预 · CBT／认知行为') && w.document.getElementById('phraseGroups').innerHTML.includes('苏格拉底式提问'));
  const ed = w.document.getElementById('sessionEditor');
  ed.focus();
  w.insertCorpusPhrase('咨询师运用苏格拉底式提问，协助来访者检验自动思维的真实性。');
  check('web phrase inserted into focused editor', ed.textContent.includes('苏格拉底式提问'));
  const chip = [...w.document.querySelectorAll('.phrase-chip')].find((b) => b.textContent.includes('无条件积极关注'));
  chip.click();
  check('web phrase chip click inserts', ed.textContent.includes('无条件积极关注'));
  w.closeModal(true);

  // ---- Borrowed-from-EHR features: assessments / waitlist / event status / insights / statement / documents / default fee ----
  const savedParsed = () => JSON.parse(w.localStorage.getItem('mx_counselor_lite_v1'));
  w.openAssessment('', cid);
  w.eval('assessmentAnswers[0]=3;assessmentAnswers[8]=1');
  w.updateAssessmentTotal();
  check('web PHQ-9 live total + risk note', w.document.getElementById('aTotal').textContent === '4' && w.document.getElementById('aRiskNote').innerHTML.includes('12356'));
  const aBtn = w.document.querySelector('[onclick^="saveAssessment"]');
  const aid2 = aBtn.getAttribute('onclick').match(/saveAssessment\('([^']+)'\)/)[1];
  w.saveAssessment(aid2);
  const asmt = savedParsed().assessments[0];
  check('web assessment auto-scored + flagged + persisted', asmt && asmt.total === 4 && asmt.severity === '最小' && asmt.flag === true);

  w.openWaitlist();
  w.document.getElementById('wName').value = '候补网页版';
  w.document.getElementById('wContact').value = '13900000000';
  const wBtn = w.document.querySelector('[onclick^="saveWaitlist"]');
  const wid2 = wBtn.getAttribute('onclick').match(/saveWaitlist\('([^']+)'\)/)[1];
  w.saveWaitlist(wid2);
  check('web waitlist saved', savedParsed().waitlist.length === 1);
  w.convertToClient(wid2);
  const conv = savedParsed();
  check('web waitlist converted to client', conv.clients.some((c) => c.name === '候补网页版') && conv.waitlist[0].status === '已建档');
  w.closeModal(true);

  w.editEvent('', cid, '2026-11-02');
  w.document.getElementById('eStatus').value = '爽约';
  const eBtn = w.document.querySelector('[onclick^="saveEvent"]');
  const eid2 = eBtn.getAttribute('onclick').match(/saveEvent\('([^']+)'\)/)[1];
  w.saveEvent(eid2);
  const ev = savedParsed().events[savedParsed().events.length - 1];
  check('web event status persisted + color', ev.status === '爽约' && w.eventStatusColor(ev) === '#a13b3b');

  w.go('insights');
  check('web insights renders', w.document.getElementById('insights').innerHTML.includes('出勤情况'));
  w.go('statement');
  check('web statement renders', w.document.getElementById('statement').innerHTML.includes('收费对账单'));

  w.openClient(cid);
  w.document.getElementById('docName').value = '知情同意书';
  w.addDocument(cid);
  check('web client document added', savedParsed().clients.find((c) => c.id === cid).documents.length === 1);

  w.editClient(cid);
  w.document.getElementById('cFee').value = '600';
  w.saveClient(cid, true);
  check('web client default fee saved', savedParsed().clients.find((c) => c.id === cid).defaultFee === '600');
  w.editFinanceForClient(cid);
  await new Promise((r) => setTimeout(r, 30));
  check('web finance prefilled from default fee', w.document.getElementById('fAmount').value === '600');
  w.closeModal(true);

  // full client deletion cascades (seed a session + the task belongs to client)
  w.eval(`S.sessions.unshift({id:'s1',clientId:'${cid}',date:'2026-10-01'})`);
  w.eval(`S.tasks.find(x=>x.id==='${tid}').clientId='${cid}'`);
  w.save();
  await w.deleteClientForever(cid);
  check('client + cascaded data deleted', !S().clients.some((x) => x.id === cid) && !S().sessions.some((x) => x.clientId === cid) && !S().tasks.some((x) => x.clientId === cid) && !S().assessments.some((x) => x.clientId === cid));

  dom.window.close();
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nWEB TEST: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
