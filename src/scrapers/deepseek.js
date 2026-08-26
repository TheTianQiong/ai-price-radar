// DeepSeek 官方定价解析
// 源：api-docs.deepseek.com/quick_start/pricing（静态 HTML）
// 转置大表：首行是模型，后续行首列是特性标签（BASE URL/MODEL VERSION/CONTEXT LENGTH/PRICING 等）。
// 定价行形如 [label, metric, OFF-PEAK|PEAK, price...]；PEAK 续行为 [PEAK, price...]。
// 主价取 PEAK（标准价），OFF-PEAK 记入 notes。

import { htmlTablesToGrids, parseMoney, slugify } from '../utils.js';

export const provider = 'deepseek';
export const label = 'DeepSeek';
export const url = 'https://api-docs.deepseek.com/quick_start/pricing';
export const currency = 'USD';

export function parse(html) {
  const tables = htmlTablesToGrids(html);
  let table = null;
  for (const t of tables) {
    const flat = t.map((r) => r.join(' ')).join('\n');
    if (/\bmodel\b/i.test(t[0]?.[0] || '') && /input tokens/i.test(flat) && /cache/i.test(flat)) {
      table = t;
      break;
    }
  }
  if (!table) throw new Error('未找到 DeepSeek 价格表');

  const models = table[0].slice(1).filter((c) => c.trim()).map((c) => c.trim());
  if (!models.length) throw new Error('表头无模型列');

  const byMetric = { input: {}, cacheHit: {}, output: {} };
  let lastMetric = '';
  let contextLength = null;
  for (const row of table.slice(1)) {
    const cells = row.map((c) => String(c).trim());
    const first = cells[0] || '';
    if (/^CONTEXT LENGTH/i.test(first)) {
      const cm = (cells[1] || '').match(/(\d+(?:\.\d+)?)\s*([KkMm])?/);
      if (cm) contextLength = cm[2] && /[Mm]/.test(cm[2]) ? Math.round(Number(cm[1]) * 1000000) : Math.round(Number(cm[1]));
      continue;
    }
    // 动态定位 tier 列（OFF-PEAK|PEAK）；该列之前的单元格里找 metric 标签
    const tierIdx = cells.findIndex((c) => /^(OFF-?PEAK|PEAK)$/i.test(c));
    if (tierIdx < 0) continue;
    const tier = cells[tierIdx];
    const metricCell = cells.slice(0, tierIdx).find((c) => /(INPUT|OUTPUT)\s*TOKENS|CACHE/i.test(c));
    if (metricCell) lastMetric = metricCell;

    const key = lastMetric.toUpperCase().includes('CACHE HIT')
      ? 'cacheHit'
      : lastMetric.toUpperCase().includes('CACHE MISS')
        ? 'input'
        : lastMetric.toUpperCase().includes('OUTPUT')
          ? 'output'
          : null;
    if (!key) continue;

    const prices = cells.slice(tierIdx + 1).map((c) => parseMoney(c));
    if (/OFF/i.test(tier)) byMetric[key].off = prices;
    else byMetric[key].peak = prices;
  }

  const rows = [];
  models.forEach((m, i) => {
    const input = byMetric.input.peak?.[i];
    const output = byMetric.output.peak?.[i];
    const cacheHit = byMetric.cacheHit.peak?.[i];
    if (input == null && output == null) return;
    rows.push({
      model: slugify(m),
      input,
      output,
      cacheHit,
      contextWindow: contextLength,
      notes: {
        tier: 'peak',
        cacheHitOffPeak: byMetric.cacheHit.off?.[i],
        cacheMissOffPeak: byMetric.input.off?.[i],
        outputOffPeak: byMetric.output.off?.[i],
      },
    });
  });
  if (!rows.length) throw new Error('DeepSeek 解析结果为空');
  return rows;
}
