// AI 价格雷达 Worker 入口：静态资源由 assets 托管，这里处理 API 与定时任务

import { runAll, ALL_PROVIDERS } from './scrape.js';
import { handleAdmin } from './admin.js';
import * as db from './db.js';

const PROVIDER_LABELS = Object.fromEntries(ALL_PROVIDERS.map((p) => [p.provider, p.label]));

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === 'GET' && path === '/healthz') {
        return json({ ok: true });
      }
      if (request.method === 'GET' && path === '/api/meta') {
        return json(await handleMeta(env));
      }
      if (request.method === 'GET' && path === '/api/prices/latest') {
        return json(await handleLatest(env, url));
      }
      if (request.method === 'GET' && path === '/api/prices/history') {
        return json(await handleHistory(env, url));
      }
      if (request.method === 'GET' && path === '/api/feed') {
        return await handleFeed(env);
      }
      if (request.method === 'POST' && path === '/api/trigger') {
        return await handleTrigger(request, env);
      }
      if (path === '/admin' && request.method === 'GET') {
        // 管理后台页面（静态资源由 assets 托管）
        return env.ASSETS.fetch(new URL('/admin.html', request.url));
      }
      if (path.startsWith('/api/admin/')) {
        return await handleAdmin(path, request, env);
      }
      return json({ ok: false, error: 'Not Found' }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  },

  // Cron 触发：每天 00:15 UTC（北京 08:15）
  async scheduled(_event, env) {
    const result = await runAll(env);
    console.log('scheduled scrape 完成', JSON.stringify(result.providers));
  },
};

async function handleMeta(env) {
  const [states, models] = await Promise.all([db.lastFetchStates(env), db.queryMeta(env)]);
  const byProvider = {};
  for (const s of states) byProvider[s.provider] = s;
  const modelMap = {};
  for (const m of models) {
    (modelMap[m.provider] ||= []).push(m.model);
  }
  return {
    ok: true,
    fx: { usdToCny: Number(env.USD_TO_CNY) || 7.15, note: '固定汇率，抓取时换算落库' },
    providers: Object.entries(modelMap).map(([name, models]) => ({
      name,
      label: PROVIDER_LABELS[name] || name,
      models,
      lastFetched: byProvider[name]?.run_at ?? null,
      lastStatus: byProvider[name]?.status ?? null,
    })),
    generatedAt: new Date().toISOString(),
  };
}

async function handleLatest(env, url) {
  const provider = url.searchParams.get('provider') || undefined;
  const model = url.searchParams.get('model') || undefined;
  const rows = await db.queryLatest(env, { provider, model });
  const fx = Number(env.USD_TO_CNY) || 7.15;
  const states = await db.lastFetchStates(env);
  const stateMap = {};
  for (const s of states) stateMap[s.provider] = s;

  const grouped = {};
  for (const r of rows) {
    (grouped[r.provider] ||= []).push({
      model: r.model,
      inputUsd: r.input_usd,
      outputUsd: r.output_usd,
      inputCny: r.input_cny,
      outputCny: r.output_cny,
      cacheHitUsd: r.cache_hit_usd,
      cacheHitCny: r.cache_hit_cny,
      cacheWriteUsd: r.cache_write_usd,
      cacheWriteCny: r.cache_write_cny,
      contextWindow: r.context_window,
      currency: r.currency,
      notes: r.notes ? JSON.parse(r.notes) : null,
      free: r.input_usd === 0 && r.output_usd === 0,
    });
  }
  const providers = Object.entries(grouped).map(([name, models]) => {
    const st = stateMap[name];
    return { provider: name, label: PROVIDER_LABELS[name] || name, currency: models[0]?.currency ?? null, models, lastRun: st?.run_at ?? null, lastStatus: st?.status ?? null };
  });
  providers.sort((a, b) => a.provider.localeCompare(b.provider));

  return {
    ok: true,
    fx: { usdToCny: fx, note: '固定汇率，抓取时换算落库' },
    lastRun: { at: rows[0]?.updated_at ?? null },
    providers,
  };
}

async function handleHistory(env, url) {
  const provider = url.searchParams.get('provider');
  const model = url.searchParams.get('model');
  const days = url.searchParams.get('days') || '90';
  if (!provider || !model) return { ok: false, error: '缺少 provider 或 model 参数' };
  const rows = await db.queryHistory(env, { provider, model, days });
  const points = rows.map((r) => ({
    date: r.date,
    inputUsd: r.input_usd,
    outputUsd: r.output_usd,
    inputCny: r.input_cny,
    outputCny: r.output_cny,
  }));
  return { ok: true, provider, model, days: Number(days), points };
}

async function handleTrigger(request, env) {
  const secret = env.TRIGGER_SECRET;
  const given = request.headers.get('x-trigger-secret');
  if (!secret || given !== secret) return json({ ok: false, error: '未授权' }, 401);
  const result = await runAll(env); // 同步等待，调用方拿结果
  return json({ ok: true, ...result });
}

// RSS 订阅源：抓取状态异常时也会出现在这里，可在 Feedly/Inoreader 订阅
async function handleFeed(env) {
  const logs = await db.recentLogs(env, 50);
  const statusText = (s) => (s === 'ok' ? '抓取正常' : s === 'partial' ? '疑似改版' : '抓取失败');
  const items = logs.map((l, i) => {
    const label = PROVIDER_LABELS[l.provider] || l.provider;
    const isIssue = l.status !== 'ok';
    const title = `${isIssue ? '⚠️ ' : ''}${label} · ${statusText(l.status)}`;
    const desc = `厂商: ${label}<br/>状态: ${statusText(l.status)}<br/>模型数: ${l.ok_count}<br/>错误: ${l.error || '无'}<br/>耗时: ${l.duration_ms}ms`;
    const ts = new Date(l.run_at).getTime() - i; // 保证 pubDate 唯一递增
    return `<item>
  <title>${escapeXml(title)}</title>
  <description>${desc}</description>
  <pubDate>${new Date(ts).toUTCString()}</pubDate>
  <guid>fetch-${l.id}</guid>
</item>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>AI 价格雷达 · 抓取状态</title>
  <link>${env.APP_BASE_URL || '/'}</link>
  <description>各厂商官方定价页每日抓取状态（含失败/疑似改版告警）</description>
  <atom:link href="${escapeXml(env.APP_BASE_URL || '/')}api/feed" rel="self" type="application/rss+xml"/>
  ${items.join('\n')}
</channel>
</rss>`;
  return new Response(xml, {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}
