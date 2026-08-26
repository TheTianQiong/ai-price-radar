// 管理后台 API：登录 / 概览 / 手动抓取 / 单厂商排查 / 设置读写 / 日志 / 测试通知
// 除 login 外的接口都要求 x-admin-token（HMAC 签名，12h 有效期）

import { runAll, runSingle, ALL_PROVIDERS } from './scrape.js';
import * as db from './db.js';
import { getSettings, setSetting, signAdminToken, verifyAdminToken, ALLOWED_SETTING_KEYS } from './settings.js';
import { sendTestNotification } from './alert.js';

export async function handleAdmin(path, request, env) {
  const api = path.slice('/api/admin/'.length);

  if (api === 'login' && request.method === 'POST') {
    return login(request, env);
  }
  if (!(await requireAdmin(request, env))) {
    return json({ ok: false, error: '未授权或登录已过期' }, 401);
  }

  switch (api) {
    case 'overview':
      return json(await overview(env));
    case 'trigger':
      return json({ ok: true, ...(await runAll(env)) });
    case 'run':
      return json(await runOneAdmin(request, env));
    case 'settings':
      return request.method === 'GET' ? json({ ok: true, settings: await getSettings(env) }) : json(await updateSettings(request, env));
    case 'logs':
      return json(await logs(request, env));
    case 'test-notification':
      return json(await sendTestNotification(env));
    default:
      return json({ ok: false, error: 'Not Found' }, 404);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const token = request.headers.get('x-admin-token');
  return token ? await verifyAdminToken(env.ADMIN_PASSWORD, token) : false;
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: '未配置 ADMIN_PASSWORD（请在 wrangler.jsonc 设置）' }, 503);
  const { password } = await request.json().catch(() => ({}));
  if (password === env.ADMIN_PASSWORD) {
    return json({ ok: true, token: await signAdminToken(env.ADMIN_PASSWORD) });
  }
  return json({ ok: false, error: '密码错误' }, 401);
}

async function overview(env) {
  const [states, meta, countRes] = await Promise.all([
    db.lastFetchStates(env),
    db.queryMeta(env),
    env.DB.prepare('SELECT COUNT(*) AS n FROM price_history').all(),
  ]);
  const countByProvider = {};
  for (const m of meta) countByProvider[m.provider] = (countByProvider[m.provider] || 0) + 1;
  const stateByProvider = {};
  for (const s of states) stateByProvider[s.provider] = s;

  const providers = ALL_PROVIDERS.map((p) => ({
    provider: p.provider,
    label: p.label,
    currency: p.currency,
    url: p.url,
    modelCount: countByProvider[p.provider] || 0,
    lastStatus: stateByProvider[p.provider]?.status ?? null,
    lastRun: stateByProvider[p.provider]?.run_at ?? null,
    lastError: stateByProvider[p.provider]?.error ?? null,
    lastDurationMs: stateByProvider[p.provider]?.duration_ms ?? null,
  }));
  return {
    ok: true,
    providers,
    totalRows: Number(countRes.results?.[0]?.n || 0),
    settings: await getSettings(env),
    generatedAt: new Date().toISOString(),
  };
}

async function runOneAdmin(request, env) {
  const { provider } = await request.json().catch(() => ({}));
  if (!provider) return { ok: false, error: '缺少 provider 参数' };
  try {
    const r = await runSingle(provider, env);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function updateSettings(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== 'object') return { ok: false, error: '参数错误' };
  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED_SETTING_KEYS.includes(k)) continue;
    await setSetting(env, k, v);
  }
  return { ok: true, settings: await getSettings(env) };
}

async function logs(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
  const rows = await db.recentLogs(env, limit);
  return { ok: true, logs: rows };
}
