// Anthropic (Claude) 官方定价解析
// 源：platform.claude.com/docs/en/about-claude/pricing.md（官方 Markdown 版）
// 取 `## Model pricing` 下的第一张表（Base Input / Output / 缓存列），跳过 Batch、AWS/Vertex 等表。

import { parseMarkdownSections, parseMoney, slugify, cleanModelName } from '../utils.js';

export const provider = 'anthropic';
export const label = 'Anthropic';
export const url = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
export const currency = 'USD';

export function parse(text) {
  const sections = parseMarkdownSections(text);
  const modelSec = sections.find((s) => /^model pricing/i.test(s.heading));
  if (!modelSec) throw new Error('未找到 Model pricing 区块');
  const table = modelSec.tables[0];
  if (!table || table.length < 2) throw new Error('主表为空');

  const header = table[0].map((h) => h.toLowerCase());
  const colModel = header.findIndex((h) => h.includes('model'));
  const colInput = header.findIndex((h) => h.includes('base input'));
  const colOutput = header.findIndex((h) => h.includes('output') && h.includes('tokens'));
  const colCacheHit = header.findIndex((h) => h.includes('cache hits'));
  if (colModel < 0 || colInput < 0 || colOutput < 0) throw new Error(`表头不匹配：${table[0].join(' | ')}`);

  const rows = [];
  for (const r of table.slice(1)) {
    const modelRaw = cleanModelName(r[colModel] ?? '');
    if (!modelRaw) continue;
    const model = slugify(modelRaw);
    if (!model.startsWith('claude-')) continue; // 只收 Claude 模型
    const input = parseMoney(r[colInput]);
    const output = parseMoney(r[colOutput]);
    if (input == null && output == null) continue;
    const cacheHit = colCacheHit >= 0 ? parseMoney(r[colCacheHit]) : null;
    rows.push({ model, input, output, cacheHit, contextWindow: null });
  }
  if (!rows.length) throw new Error('未解析到任何 Claude 模型');
  return rows;
}
