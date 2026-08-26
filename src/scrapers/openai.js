// OpenAI 官方定价解析
// 源：developers.openai.com/api/docs/pricing.md（Mintlify .md 变体，标准 Markdown 表格）
// 取第一个「Short context input」表（旗舰模型 Standard 区），列：Model | 短上下文 input | cached | cacheWrites | output。
// 若 Markdown 表解析为空，回退到 JSX rows 数组。

import { parseMarkdownSections, parseMoney, slugify, extractTopLevelArrays, parseArrayFields } from '../utils.js';

export const provider = 'openai';
export const label = 'OpenAI';
export const url = 'https://developers.openai.com/api/docs/pricing.md';
export const currency = 'USD';

export function parse(text) {
  const rows = parseMarkdownTables(text);
  if (rows.length) return rows;

  // 回退：JSX rows={[...]} 数组
  const fallback = parseJsxArrays(text);
  if (fallback.length) return fallback;
  throw new Error('OpenAI 未解析到任何模型');
}

// 从 Markdown 表解析
function parseMarkdownTables(text) {
  const sections = parseMarkdownSections(text);
  // 找到第一个表头含 Short context input 的表（Standard 旗舰表）
  let table = null;
  for (const s of sections) {
    for (const t of s.tables) {
      const header = t[0].map((h) => h.toLowerCase());
      if (header.some((h) => h.includes('short context input')) && header.some((h) => h === 'model')) {
        table = t;
        break;
      }
    }
    if (table) break;
  }
  if (!table) return [];

  const header = table[0].map((h) => h.toLowerCase());
  const colInput = header.findIndex((h) => h.includes('short context input'));
  const colCached = header.findIndex((h) => h.includes('cached input'));
  const colOutput = header.findIndex((h) => h.includes('short context output'));
  const colModel = header.findIndex((h) => h === 'model' || h.includes('model'));
  if (colModel < 0 || colInput < 0 || colOutput < 0) return [];

  const rows = [];
  for (const r of table.slice(1)) {
    const model = slugify((r[colModel] || '').replace(/<.*$/i, '').trim()); // 去掉 (<272K context length)
    if (!model.startsWith('gpt-') && !model.startsWith('o')) continue;
    if (/^gpt-3-5/.test(model)) continue; // 已退役
    const input = parseMoney(r[colInput]);
    const output = parseMoney(r[colOutput]);
    if (input == null && output == null) continue;
    const cached = colCached >= 0 ? parseMoney(r[colCached]) : null;
    rows.push({ model, input, output, cacheHit: cached, contextWindow: null });
  }
  return rows;
}

// 回退解析 JSX rows={[...]}
function parseJsxArrays(text) {
  const rows = [];
  for (const inner of extractTopLevelArrays(text)) {
    const f = parseArrayFields(inner);
    if (!Array.isArray(f) || f.length < 3) continue;
    const model = typeof f[0] === 'string' ? f[0].trim() : null;
    if (!model || !/^(gpt-|o\d)/i.test(model)) continue;
    if (/(transcribe|realtime|live-|whisper|codex|search|image|audio|embed)/i.test(model)) continue;
    const nums = f.slice(1).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (nums.length < 2) continue;
    rows.push({ model: slugify(model), input: nums[0], output: nums[nums.length - 1], cacheHit: nums.length >= 3 ? nums[1] : null, contextWindow: null });
  }
  const byModel = new Map();
  for (const r of rows) {
    const prev = byModel.get(r.model);
    if (!prev || r.input > prev.input) byModel.set(r.model, r);
  }
  return [...byModel.values()];
}
