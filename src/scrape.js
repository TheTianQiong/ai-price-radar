// 抓取编排：并行抓取各厂商官方定价页 -> 解析 -> 归一化双币 -> upsert 落库 -> 写抓取日志 -> 告警检测

import { fetchText } from './utils.js';
import { normalize } from './convert.js';
import * as db from './db.js';
import { detectAndAlert } from './alert.js';
import * as anthropic from './scrapers/anthropic.js';
import * as openai from './scrapers/openai.js';
import * as gemini from './scrapers/gemini.js';
import * as deepseek from './scrapers/deepseek.js';
import * as kimi from './scrapers/kimi.js';
import * as qwen from './scrapers/qwen.js';
import * as glm from './scrapers/glm.js';

export const ALL_PROVIDERS = [anthropic, openai, gemini, deepseek, kimi, qwen, glm];

/** 抓取全部启用的厂商（cron / 手动 trigger）。 */
export async function runAll(env) {
  const runAt = new Date().toISOString();
  const date = runAt.slice(0, 10);
  const usdToCny = Number(env.USD_TO_CNY) || 7.15;

  const enabled = (env.SCRAPE_PROVIDERS || ALL_PROVIDERS.map((p) => p.provider).join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const providers = ALL_PROVIDERS.filter((p) => enabled.includes(p.provider));
  const results = {};
  const jobs = providers.map(async (p) => {
    results[p.provider] = await runOne(p, env, runAt, date, usdToCny);
  });
  await Promise.allSettled(jobs);

  const alerts = await detectAndAlert(env, results, date);
  return { runAt, date, usdToCny, providers: results, alerts };
}

/** 单独抓取一个厂商（管理后台排查用，不做告警） */
export async function runSingle(providerId, env) {
  const provider = ALL_PROVIDERS.find((p) => p.provider === providerId);
  if (!provider) throw new Error(`未知厂商: ${providerId}`);
  const runAt = new Date().toISOString();
  const date = runAt.slice(0, 10);
  const result = await runOne(provider, env, runAt, date, Number(env.USD_TO_CNY) || 7.15);
  return { runAt, date, result };
}

/** 抓取单个厂商：失败不拖垮其他厂商；失败时不清空旧价。 */
async function runOne(provider, env, runAt, date, usdToCny) {
  const t0 = Date.now();
  try {
    const text = await fetchText(provider.url, env);
    const raw = await provider.parse(text, env);
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('解析结果为空');
    const rows = normalize(provider, raw, usdToCny);

    // 疑似改版检测：模型数比最近一次历史明显骤降（<60% 且历史上确有数据）则降级为 partial
    let status = 'ok';
    let note = null;
    const prevCount = await db.prevDayCount(env, provider.provider, date);
    if (prevCount > 3 && rows.length < Math.max(3, Math.round(prevCount * 0.6))) {
      status = 'partial';
      note = `疑似页面改版：模型数从 ${prevCount} 骤降至 ${rows.length}`;
    }

    await db.upsertPrices(env, date, rows);
    await db.logFetch(env, runAt, provider.provider, status, rows.length, status === 'ok' ? 0 : rows.length, note, Date.now() - t0);
    return { status, okCount: rows.length, errCount: status === 'ok' ? 0 : rows.length, label: provider.label, error: note, durationMs: Date.now() - t0 };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    await db.logFetch(env, runAt, provider.provider, 'error', 0, 0, msg, Date.now() - t0);
    return { status: 'error', okCount: 0, errCount: 1, label: provider.label, error: msg, durationMs: Date.now() - t0 };
  }
}
