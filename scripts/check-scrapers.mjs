// 本地验证脚本：逐个抓取官方定价页并运行解析器，打印结果
// 用法：node scripts/check-scrapers.mjs [provider1 provider2 ...]（缺省验证全部）

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scrapersDir = join(__dirname, '..', 'src', 'scrapers');
const only = process.argv.slice(2);

const files = readdirSync(scrapersDir).filter((f) => f.endsWith('.js'));
let failed = 0;

for (const f of files) {
  const mod = await import(`file://${join(scrapersDir, f)}`);
  const { provider, label, url, currency, parse } = mod;
  if (only.length && !only.includes(provider)) continue;

  console.log(`\n===== ${label} (${provider}, ${currency}) =====`);
  console.log(`源: ${url}`);
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; ai-price-radar/1.0)' } });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    console.log(`抓取 ${(text.length / 1024).toFixed(0)} KB, ${Date.now() - t0}ms`);

    const raw = await parse(text, { FETCH_TIMEOUT_MS: 20000, FETCH_RETRIES: 0 });
    const { normalize } = await import(`file://${join(__dirname, '..', 'src', 'convert.js')}`);
    const rows = normalize(mod, raw, 7.15);
    console.log(`✓ 解析 ${rows.length} 个模型:`);
    for (const r of rows) {
      const inS = r.inputUsd != null ? `in $${r.inputUsd}` : 'in -';
      const outS = r.outputUsd != null ? `out $${r.outputUsd}` : 'out -';
      const cny = r.inputCny != null ? ` (¥${r.inputCny}/${r.outputCny})` : '';
      const cache = r.cacheHitUsd != null ? `, cache $${r.cacheHitUsd}` : '';
      const free = r.free ? ', 免费' : '';
      console.log(`  ${r.model.padEnd(22)} ${inS} ${outS}${cny}${cache}${free}${r.notes ? '  notes=' + r.notes : ''}`);
    }
  } catch (e) {
    failed++;
    console.log(`✗ 失败: ${e.message}`);
    if (process.env.DEBUG_SCRAPER) {
      try {
        const res = await fetch(url);
        const t = await res.text();
        console.log(t.slice(0, 1500));
      } catch {}
    }
  }
}

console.log(failed ? `\n结果：${failed} 个厂商解析失败` : '\n结果：全部通过 ✅');
process.exit(failed ? 1 : 0);
