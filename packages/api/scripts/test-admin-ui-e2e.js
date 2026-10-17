// 管理界面 UI→后端 端到端测试：点真实界面，断言后端状态真的变了。
// 前置：本地已起 API(:3000, CONNECT_AUTH=1 SESSION_KEY=devsecret) 与 web(:5001)；
// 用法：CTOKEN=<签好的 connect token> node packages/api/scripts/test-admin-ui-e2e.js
// 依赖：puppeteer-core + 本机 chrome-headless-shell（路径见 EXE）。

const puppeteer = require('/tmp/pp/node_modules/puppeteer-core');
const EXE = '/root/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = process.env.CTOKEN;
const api = async (p, b) => (await fetch('http://127.0.0.1:3000/' + p, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Connect-Token': TOKEN }, body: JSON.stringify(b || {}) })).json();
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, x ?? '')); };
(async () => {
  const created = await api('permissions/save-role-detail', { role: { name: 'UI-E2E-' + Date.now(), description: 'ui e2e' } });
  const roleId = created?.role?.id;
  ok(!!roleId, '前置：建测试角色（接口）');
  const browser = await puppeteer.launch({ executablePath: EXE, headless: true, protocolTimeout: 240000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.setRequestInterception(true);
  page.on('request', r => { const h = Object.assign({}, r.headers()); if (r.url().includes('localhost:3000')) h['X-Connect-Token'] = TOKEN; r.continue({ headers: h }).catch(() => {}); });
  const errs = []; page.on('pageerror', e => errs.push(String(e.message).slice(0, 90)));
  await page.evaluateOnNewDocument(t => { try { localStorage.setItem('accessToken', t); } catch (e) {} }, TOKEN);
  await page.goto('http://localhost:5001', { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(3500);
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /No, thanks/i.test(e.innerText || '')); if (b) b.click(); });
    await sleep(350);
    if (!(await page.evaluate(() => /Anonymous usage analytics/.test(document.body.innerText)))) break;
  }
  await page.evaluate(() => document.querySelector('[title="Administration"]')?.click());
  await sleep(1200);
  await page.evaluate(() => document.querySelector('[data-testid="AdminMenu_AdminConsoleTab"]')?.click());
  await sleep(4000);
  await page.evaluate(() => document.querySelector('[data-testid="ConsoleNav_roles"]')?.click());
  await sleep(3500);
  const sel = await page.evaluate(id => { const el = document.querySelector(`[data-testid="AdminV2Roles_role_${id}"]`); if (el) { el.click(); return true; } return false; }, roleId);
  ok(sel, '选中测试角色（界面）');
  await sleep(2500);

  // A. 数据库子页：加一条正则规则 → 断言后端
  await page.evaluate(() => document.querySelector('[data-testid="AdminV2Roles_addDbRule"]')?.click());
  await sleep(700);
  await page.select('[data-testid="AdminV2Roles_modeSelect"]', 'regex');
  await sleep(600);
  await page.type('[data-testid="AdminV2Roles_regex"]', '^mp_(cd|sh)$');
  await sleep(300);
  await page.evaluate(() => document.querySelector('[data-testid="AdminV2Roles_saveRule"]')?.click());
  await sleep(2800);
  let d = await api('permissions/get-role-detail', { roleId });
  ok((d?.databases ?? []).some(x => x.database_names_regex === '^mp_(cd|sh)$'), 'A. 界面加库规则（正则）→ 后端已落库', JSON.stringify(d?.databases ?? []).slice(0, 120));
  const uiRows = await page.$$eval('[data-testid^="AdminV2Roles_dbRule_"]', e => e.length);
  ok(uiRows >= 1, 'A2. 界面规则表回显行数 ≥1', `实际 ${uiRows}`);

  // B. 对象子页：加对象规则
  await page.evaluate(() => [...document.querySelectorAll('.pills .p')].find(e => e.innerText.trim() === '对象')?.click());
  await sleep(1200);
  await page.evaluate(() => { const i = document.querySelector('input[placeholder="对象名（逗号分隔）"]'); if (i) { i.value = 't_ui'; i.dispatchEvent(new Event('input', { bubbles: true })); } });
  await sleep(300);
  await page.evaluate(() => document.querySelector('[data-testid="AdminV2Roles_addObj"]')?.click());
  await sleep(2500);
  d = await api('permissions/get-role-detail', { roleId });
  ok((d?.tables ?? []).length >= 1, 'B. 界面加对象规则 → 后端已落库', JSON.stringify(d?.tables ?? []).slice(0, 120));

  // C. 细粒度：加行过滤
  await page.evaluate(() => [...document.querySelectorAll('.pills .p')].find(e => e.innerText.trim().startsWith('细粒度'))?.click());
  await sleep(1200);
  await page.evaluate(() => {
    const set = (ph, v) => { const i = document.querySelector(`input[placeholder="${ph}"]`); if (i) { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('表名', 't_ui'); set('列名 tenant_id', 'tenant_id');
  });
  await sleep(300);
  await page.evaluate(() => document.querySelector('[data-testid="AdminV2Roles_addFilter"]')?.click());
  await sleep(2500);
  d = await api('permissions/get-role-detail', { roleId });
  ok((d?.rowFilters ?? []).length >= 1, 'C. 界面加行过滤 → 后端已落库', JSON.stringify(d?.rowFilters ?? []).slice(0, 120));

  // D. 成员子页：把一个成员挂上该角色
  await page.evaluate(() => [...document.querySelectorAll('.pills .p')].find(e => e.innerText.trim() === '成员')?.click());
  await sleep(1500);
  const ul = await api('permissions/get-user-list');
  const target = ul.users.find(u => !(u.roles ?? []).includes(roleId));
  const before = JSON.stringify(target?.roles ?? []);
  await page.evaluate(id => document.querySelector(`[data-testid="AdminV2Roles_member_${id}"]`)?.click(), target.id);
  await sleep(2500);
  const ul2 = await api('permissions/get-user-list');
  ok((ul2.users.find(u => u.id === target.id)?.roles ?? []).includes(roleId), 'D. 界面勾选成员 → 后端该成员角色已更新', `${before} → ${JSON.stringify(ul2.users.find(u => u.id === target.id)?.roles)}`);

  console.log('pageerrors =', JSON.stringify([...new Set(errs)]));
  console.log(`\nUI→后端 端到端：${pass} 通过 / ${fail} 失败`);
  await api('permissions/delete-role', { roleId });
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
