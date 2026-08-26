// Kimi（月之暗面）官方定价解析
// 源：platform.kimi.com 首页（React SSR，价格已渲染进 HTML）
// 卡片结构：<h3 class="home-card-title">K3</h3> ... 缓存命中</span><span ...>¥2.00 / MTok</span>
//            ... 输入</span><span ...>¥20.00 / MTok</span> ... 输出</span><span ...>¥100.00 / MTok</span>

export const provider = 'kimi';
export const label = 'Kimi';
export const url = 'https://platform.kimi.com';
export const currency = 'CNY';

const CANDIDATES = [
  { model: 'kimi-k3', title: 'K3' },
  { model: 'kimi-k2.7-code', title: 'K2.7 Code' },
  { model: 'kimi-k2.6', title: 'K2.6' },
];

export function parse(html) {
  const rows = [];
  for (const c of CANDIDATES) {
    const card = findCard(html, c.title);
    if (!card) continue;
    const prices = scanPrices(card);
    if (!prices) continue;
    rows.push({ model: c.model, input: prices.input, output: prices.output, cacheHit: prices.cache, contextWindow: null });
  }
  if (rows.length < 2) throw new Error(`Kimi 首页匹配到模型过少（${rows.length}）`);
  return rows;
}

// 锚定模型卡片标题元素，取其后 3000 字符作为卡片内容
function findCard(html, title) {
  const re = new RegExp(`home-card-title[^>]*>\\s*${escapeRe(title)}\\s*</h3>`);
  const m = re.exec(html);
  if (!m) return null;
  return html.slice(m.index, m.index + 3000);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 在卡片内按 缓存命中 -> 输入 -> 输出 的顺序取三个价格（标签与数字之间有 HTML 标签）
function scanPrices(card) {
  const m = card.match(
    /缓存命中[^¥￥]{0,120}?¥\s*([\d.]+)[\s\S]{0,300}?输入[^¥￥]{0,120}?¥\s*([\d.]+)[\s\S]{0,300}?输出[^¥￥]{0,120}?¥\s*([\d.]+)/
  );
  if (!m) return null;
  return { cache: parseFloat(m[1]), input: parseFloat(m[2]), output: parseFloat(m[3]) };
}
