// 端到端冒烟测试：用 node:sqlite 模拟 D1，驱动真实的 Worker 处理器与抓取管线
// 覆盖：healthz / trigger(含鉴权) / latest / history / meta，以及真实抓取 -> 落库 -> 查询
// 用法：node scripts/smoke.mjs

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/index.js';
import { detectAndAlert } from '../src/alert.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- D1 兼容 shim（基于 node:sqlite） ----------
class D1Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...args) {
    this.params = args;
    return this;
  }
  run() {
    const res = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: { changes: res.changes } };
  }
  all() {
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { results: rows.map((r) => ({ ...r })) };
  }
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  const migDir = join(__dirname, '..', 'migrations');
  for (const f of readdirSync(migDir).sort()) {
    if (f.endsWith('.sql')) db.exec(readFileSync(join(migDir, f), 'utf8'));
  }
  return {
    prepare(sql) {
      return new D1Stmt(db, sql);
    },
    batch(stmts) {
      return stmts.map((s) => s.run());
    },
  };
}

const env = {
  DB: makeDb(),
  USD_TO_CNY: '7.15',
  TRIGGER_SECRET: 'test-secret',
  FETCH_TIMEOUT_MS: '20000',
  FETCH_RETRIES: '1',
  SCRAPE_PROVIDERS: 'anthropic,openai,gemini,deepseek,kimi,qwen,glm',
  ADMIN_PASSWORD: 'admin-secret',
  ALERT_WEBHOOK_URL: '',
  // 模拟 assets 绑定（/admin 页面路由）
  ASSETS: { fetch: (url) => new Response('mock asset ' + url.pathname, { headers: { 'content-type': 'text/html' } }) },
};

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`);
  }
}

const base = 'http://localhost';
const call = (path, init) => worker.fetch(new Request(base + path, init), env);

console.log('=== 1. healthz ===');
{
  const r = await call('/healthz');
  const j = await r.json();
  check('healthz 200 + ok', r.status === 200 && j.ok === true, `(${r.status})`);
}

console.log('=== 2. 未授权 trigger ===');
{
  const r = await call('/api/trigger', { method: 'POST' });
  check('无 secret 返回 401', r.status === 401, `(${r.status})`);
}

console.log('=== 3. 首次 latest（无数据） ===');
{
  const r = await call('/api/prices/latest');
  const j = await r.json();
  check('latest 200', r.status === 200);
  check('providers 为空数组', Array.isArray(j.providers) && j.providers.length === 0);
}

console.log('=== 4. 授权 trigger（真实抓取全部厂商） ===');
{
  const t0 = Date.now();
  const r = await call('/api/trigger', { method: 'POST', headers: { 'x-trigger-secret': 'test-secret' } });
  const j = await r.json();
  const ok = j.providers || {};
  const names = Object.keys(ok);
  console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，状态：`);
  for (const n of names) console.log(`    ${n}: ${ok[n].status}${ok[n].error ? ' ' + ok[n].error : ''} (${ok[n].okCount} 模型)`);
  check('trigger 200', r.status === 200, `(${r.status})`);
  check('7 家厂商都返回', names.length === 7, `(实际 ${names.length})`);
  check('全部成功', names.every((n) => ok[n].status === 'ok'), `(${names.filter((n) => ok[n].status !== 'ok').join(',') || '全部 ok'})`);
  const total = names.reduce((s, n) => s + (ok[n].okCount || 0), 0);
  check('模型总数 > 50', total > 50, `(共 ${total} 个模型)`);
}

console.log('=== 5. latest（有数据） ===');
{
  const r = await call('/api/prices/latest');
  const j = await r.json();
  check('providers 有 7 家', j.providers.length === 7, `(${j.providers.length})`);
  const anthropic = j.providers.find((p) => p.provider === 'anthropic');
  check('anthropic 含 claude-sonnet-5', anthropic?.models?.some((m) => m.model === 'claude-sonnet-5'));
  const c = anthropic?.models?.find((m) => m.model === 'claude-sonnet-5');
  if (c) check('claude-sonnet-5 双币正确', c.inputUsd === 2 && c.outputUsd === 10 && c.inputCny > 14 && c.outputCny > 70, `(${c.inputUsd}/${c.outputUsd} usd)`);
  check('fx 汇率返回', j.fx?.usdToCny === 7.15);
}

console.log('=== 6. history ===');
{
  const r = await call('/api/prices/history?provider=anthropic&model=claude-sonnet-5&days=90');
  const j = await r.json();
  check('history 200 + 有数据', j.ok === true && j.points.length >= 1, `(${j.points.length} 点)`);
  const p = j.points[0];
  if (p) check('history 双币列', p.inputUsd === 2 && p.outputUsd === 10 && p.inputCny > 14);
  check('history 缺参数报错', (await (await call('/api/prices/history')).json()).ok === false);
}

console.log('=== 7. meta ===');
{
  const r = await call('/api/meta');
  const j = await r.json();
  check('meta 200', r.status === 200);
  check('meta 含 7 家 provider', j.providers.length === 7, `(${j.providers.length})`);
  check('meta 各厂商模型>0', j.providers.every((p) => p.models.length > 0));
  check('meta lastStatus 全 ok', j.providers.every((p) => p.lastStatus === 'ok'));
}

console.log('=== 8. 二次 trigger 幂等（同日 upsert） ===');
{
  const r = await call('/api/trigger', { method: 'POST', headers: { 'x-trigger-secret': 'test-secret' } });
  const j = await r.json();
  check('二次 trigger 成功', r.status === 200 && Object.values(j.providers).every((p) => p.status === 'ok'));
  const latest = await (await call('/api/prices/latest')).json();
  const total = latest.providers.reduce((s, p) => s + p.models.length, 0);
  check('价格行未重复膨胀', total > 50 && total < 250, `(${total} 模型)`);
}

console.log('=== 9. 路由 404 ===');
{
  const r = await call('/api/not-exist');
  check('未知 API 404', r.status === 404);
}

console.log('=== 10. RSS 订阅源 ===');
{
  const r = await call('/api/feed');
  const xml = await r.text();
  check('feed 200 + RSS', r.status === 200 && r.headers.get('content-type').includes('xml'));
  check('feed 含 channel 和条目', xml.includes('<channel>') && xml.includes('<item>') && xml.includes('</rss>'));
}

console.log('=== 12. 管理后台 ===');
{
  // /admin 页面
  const page = await call('/admin');
  check('/admin 返回页面', page.status === 200 && (await page.text()).includes('mock asset'));

  // 未登录访问管理接口
  const unauth = await call('/api/admin/overview');
  check('未登录 401', unauth.status === 401);

  // 登录
  const badLogin = await call('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  check('错误密码 401', badLogin.status === 401);
  const login = await (
    await call('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-secret' }),
    })
  ).json();
  check('登录成功得 token', login.ok === true && !!login.token);
  const tok = login.token;

  // 概览
  const ov = await (await call('/api/admin/overview', { headers: { 'x-admin-token': tok } })).json();
  check('概览 7 家 + 模型数', ov.ok === true && ov.providers.length === 7 && ov.providers.every((p) => p.modelCount > 0));

  // 测试通知（未配置任何通道 -> 各通道 null，不抛错）
  const tn = await (await call('/api/admin/test-notification', { method: 'POST', headers: { 'x-admin-token': tok } })).json();
  check('测试通知不抛错', tn.ok === true && tn.results.webhook === null && tn.results.email === null);

  // 设置读写
  const put = await (
    await call('/api/admin/settings', {
      method: 'PUT',
      headers: { 'x-admin-token': tok, 'content-type': 'application/json' },
      body: JSON.stringify({ 'alert.webhook_url': 'https://example.com/hook', 'email.to': 'a@b.com' }),
    })
  ).json();
  check('设置可写并生效', put.ok === true && put.settings.alert.webhookUrl === 'https://example.com/hook');
  const get = await (await call('/api/admin/settings', { headers: { 'x-admin-token': tok } })).json();
  check('设置可读回写', get.settings.email.to === 'a@b.com');

  // 单厂商重跑
  const run = await (
    await call('/api/admin/run', {
      method: 'POST',
      headers: { 'x-admin-token': tok, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic' }),
    })
  ).json();
  check('单厂商重跑 ok', run.ok === true && run.result.status === 'ok' && run.result.okCount > 0);

  // 日志
  const logs = await (await call('/api/admin/logs?limit=10', { headers: { 'x-admin-token': tok } })).json();
  check('日志非空', logs.ok === true && logs.logs.length > 0);
}

console.log('=== 13. 告警状态变化检测 ===');
{
  // 首次 runAll 后 alert_state 应有 7 条且全为 ok
  const states = env.DB.prepare('SELECT provider, last_status FROM alert_state').all().results;
  check('alert_state 有 7 家', states.length === 7, `(${states.length})`);
  check('首轮全部 ok（不告警）', states.every((s) => s.last_status === 'ok'));

  const mkResult = (status, error) => ({
    anthropic: { status, okCount: 0, error, label: 'Anthropic' },
    openai: { status: 'ok', okCount: 30, label: 'OpenAI' },
  });
  // 模拟 Anthropic 失败 -> 应触发
  const t1 = await detectAndAlert(env, mkResult('error', '未解析到任何模型'), '2026-08-27');
  check('首次失败触发告警', t1.length === 1 && t1[0].provider === 'anthropic');
  // 再次同样失败 -> 不应重复告警
  const t2 = await detectAndAlert(env, mkResult('error', '未解析到任何模型'), '2026-08-28');
  check('连续失败不重复告警', t2.length === 0);
  // 恢复 ok -> 再失败 -> 应再次触发
  await detectAndAlert(env, mkResult('ok', null), '2026-08-29');
  const t3 = await detectAndAlert(env, mkResult('partial', '疑似页面改版：模型数从 15 骤降至 3'), '2026-08-30');
  check('恢复后再失败会重新告警', t3.length === 1 && t3[0].status === 'partial');
  // 未配置 webhook 时静默（sendAlert 返回 false 不抛错）
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
