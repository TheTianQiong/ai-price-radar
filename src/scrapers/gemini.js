// Google Gemini 官方定价解析
// 源：ai.google.dev/gemini-api/docs/pricing.md.txt（官方 Markdown 文本版）
// 每模型一个 `##` 节，内含子表（Free Tier | Paid Tier）。取 Input price / Output price 行的 Paid Tier 列。

import { parseMoney, slugify } from '../utils.js';

export const provider = 'gemini';
export const label = 'Google Gemini';
export const url = 'https://ai.google.dev/gemini-api/docs/pricing.md.txt';
export const currency = 'USD';

export function parse(text) {
  const modelParts = splitByH2(text);
  const rows = [];
  for (const part of modelParts) {
    const { title, lines } = part;
    if (!/^gemini\s/i.test(title)) continue; // 只处理 Gemini 模型节

    // 取该节的第一张标准表（若存在 ### Standard 则用其所在表）
    const { tables, standardTable } = collectTables(lines);
    const table = standardTable || tables[0];
    if (!table || table.length < 2) continue;

    const header = table[0].map((h) => h.toLowerCase());
    const paidCol = header.findIndex((h) => h.includes('paid tier'));
    if (paidCol < 0) continue;

    let input = null;
    let output = null;
    for (const r of table.slice(1)) {
      const label = (r[0] || '').toLowerCase();
      if (label.includes('input price')) input = parseMoney(r[paidCol]);
      else if (label.includes('output price')) output = parseMoney(r[paidCol]);
    }
    if (input == null && output == null) continue;

    const model = extractModelId(title, lines) || slugify(title.replace(/^gemini\s+/i, 'gemini-'));
    // 只保留文本对话模型，过滤实时/图像/语音/嵌入/机器人等
    if (/(live|image|tts|audio|embed|robotics|computer-|translate|search)/i.test(model)) continue;
    rows.push({ model, input, output, contextWindow: null, notes: { outputIncludesThinking: true } });
  }
  if (!rows.length) throw new Error('未解析到任何 Gemini 模型');
  return rows;
}

// 按 `## ` 二级标题切分，保留该节的原始行
function splitByH2(md) {
  const parts = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (cur) parts.push(cur);
      cur = { title: h[1].trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// 在节内收集 Markdown 表；识别 `### Standard` 子标题后的表
function collectTables(lines) {
  const tables = [];
  let table = null;
  let standardTable = null;
  let inStandard = false;
  for (const line of lines) {
    const sub = line.trim().match(/^###\s+(.+?)\s*$/);
    if (sub) {
      table = null;
      inStandard = /standard/i.test(sub[1]);
      continue;
    }
    const t = line.trim();
    if (/^\|.*\|\s*$/.test(t)) {
      const cells = t.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) {
        table = [];
        tables.push(table);
        if (inStandard) standardTable = table;
      }
      table.push(cells);
    } else {
      table = null;
    }
  }
  return { tables, standardTable };
}

// 优先用节内的反引号代码（gemini-...），否则用标题 slug
function extractModelId(title, lines) {
  const probe = lines.slice(0, 15).join(' ');
  const m = probe.match(/`(gemini-[\w.-]+)`/);
  if (m) return m[1];
  const m2 = probe.match(/\b(gemini-[\w.-]+)\b/);
  if (m2) return m2[1];
  return null;
}
