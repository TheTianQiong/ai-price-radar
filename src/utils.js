// 通用工具：抓取、重试、Markdown/HTML 表格解析、金额解析、字符串规整

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带超时与重试的抓取。返回文本。
 * @param {string} url
 * @param {object} env Worker 环境（读取 FETCH_TIMEOUT_MS / FETCH_RETRIES）
 */
export async function fetchText(url, env = {}) {
  const timeout = Number(env.FETCH_TIMEOUT_MS) || 15000;
  const retries = Number(env.FETCH_RETRIES) || 1;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; ai-price-radar/1.0)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      if (!text || text.length < 50) throw new Error(`响应过短（${text?.length ?? 0} 字节）`);
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('fetch 失败');
}

/** 模型名 -> 稳定 slug：小写、非字母数字变连字符 */
export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 解析金额 -> 每 1M tokens 的价格（数字）。
 * 返回 null 表示「不可用/未提供」，返回 0 表示「免费」。
 * 处理：$10 / MTok、¥2.00、2.5元、免费、Free of charge、Not available、-、
 *      原价12元 限时5折（取原价）、¥0.1 / 1k tokens（×1000 换算到 /M）。
 */
export function parseMoney(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (!s) return null;
  // 占位 / 不可用
  if (/^(—|-|–|n\/a|na|none|not available|unsupported|未提供|暂不支持|不适用|—)$/i.test(s)) return null;
  // 免费
  if (/免费|free of charge|^free$/i.test(s)) return 0;
  // 非按 token 计费的维度（存储/小时、每分钟、每图）不当作 token 价
  if (/(per\s*hour|\/hr|hour storage|per\s*minute|per\s*image|per\s*image|per second)/i.test(s)) return null;
  // 单位换算倍率 -> 统一到 /1M tokens
  let mult = 1;
  if (/(\/\s*1,?000\s*tokens?|\/k\s*tokens?|\/ktok|每千\s*tokens?|per\s*1,?000\s*tokens?)/i.test(s)) mult = 1000;
  // 取第一个货币相邻或独立出现的数字（原价优先：原价12元 限时5折 -> 12）
  const m = s.match(/(?:[¥$￥]|\b)(\d{1,3}(?:,\d{3})*\.?\d*)/);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(val)) return null;
  return val * mult;
}

/** 把连续的 Markdown 表格行收集成表格 grid（二维字符串数组），分隔行跳过 */
function collectTableLines(lines) {
  const grid = [];
  let table = null;
  for (const line of lines) {
    const t = line.trim();
    if (/^\|.*\|\s*$/.test(t)) {
      const cells = t.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      if (!table) {
        table = [];
        grid.push(table);
      }
      table.push(cells);
    } else {
      table = null;
    }
  }
  return grid;
}

/**
 * 把 Markdown 按标题切分成区块。返回 [{ level, heading, tables }]（只含至少一张表的区块）。
 * @param {string} md
 */
export function parseMarkdownSections(md) {
  const sections = [];
  let current = null;
  let tableLines = [];
  const flush = () => {
    const tables = collectTableLines(tableLines);
    if (current && tables.length) current.tables.push(...tables);
    tableLines = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flush();
      sections.push(current);
      current = { level: h[1].length, heading: h[2].trim(), tables: [] };
    } else {
      tableLines.push(line);
    }
  }
  flush();
  sections.push(current);
  return sections.filter((s) => s && s.tables.length > 0);
}

/** 在 Markdown 文本中直接收集所有表格 grid */
export function parseMarkdownTables(md) {
  return collectTableLines(md.split('\n'));
}

const stripTags = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();

/** 抽取 HTML 中所有 <table> 为 grid（二维字符串数组） */
export function htmlTablesToGrids(html) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html))) {
    const grid = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(tm[1]))) {
      const cells = [];
      const tdRe = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let td;
      while ((td = tdRe.exec(tr[1]))) cells.push(stripTags(td[1]));
      if (cells.length) grid.push(cells);
    }
    if (grid.length) tables.push(grid);
  }
  return tables;
}

/** 在文本中抽取所有顶层方括号数组的 inner 内容（用于 OpenAI .md 的 rows={[...]}） */
export function extractTopLevelArrays(text) {
  const inners = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === '[') depth++;
      else if (text[j] === ']') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    const inner = text.slice(i + 1, j - 1).trim();
    if (inner) inners.push(inner);
    i = j - 1;
  }
  return inners;
}

/** 把数组 inner 字符串按顶层逗号切成字段；字符串去引号、数字转 float */
export function parseArrayFields(inner) {
  const fields = [];
  let cur = '';
  let inStr = false;
  for (const ch of inner) {
    if (ch === '"') inStr = !inStr;
    if (ch === ',' && !inStr) {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) fields.push(cur.trim());
  return fields.map((f) => {
    const t = f.trim();
    if (/^".*"$/.test(t)) return t.slice(1, -1);
    const n = parseFloat(t);
    return Number.isNaN(n) ? t : n;
  });
}

/** 从行内截取模型 ID（过滤说明性文字） */
export function cleanModelName(cell) {
  return String(cell)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown 链接 -> 链接文本
    .replace(/\s*\(.*retired.*\)/gi, '')     // 退役标注
    .replace(/\s*\(.*下线.*\)/gi, '')
    .replace(/\*/g, '')
    .trim();
}
