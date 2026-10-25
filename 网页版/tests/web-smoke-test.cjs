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

  // full client deletion cascades (seed a session + the task belongs to client)
  w.eval(`S.sessions.unshift({id:'s1',clientId:'${cid}',date:'2026-10-01'})`);
  w.eval(`S.tasks.find(x=>x.id==='${tid}').clientId='${cid}'`);
  w.save();
  await w.deleteClientForever(cid);
  check('client + cascaded data deleted', S().clients.length === 0 && S().sessions.length === 0 && !S().tasks.some((x) => x.clientId === cid));

  dom.window.close();
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nWEB TEST: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
