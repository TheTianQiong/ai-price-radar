// 阿里云百炼（通义千问）官方定价解析
// 源：help.aliyun.com/zh/model-studio/model-pricing（HTML，多表）
// 过滤：表头含 `模型 ID` + `输入单价（每百万Token）`；优先国内（中国内地/华北2）分区；
// 阶梯价取第一档落主列，其余入 notes；只处理 qwen 模型。

import { htmlTablesToGrids, parseMoney, slugify } from '../utils.js';

export const provider = 'qwen';
export const label = '通义千问';
export const url = 'https://help.aliyun.com/zh/model-studio/model-pricing';
export const currency = 'CNY';

export function parse(html) {
  const tables = htmlTablesToGrids(html);
  const seen = new Map(); // model -> row
  let parsedAny = false;

  for (const t of tables) {
    if (!t.length) continue;
    const header = t[0].map((h) => h.toLowerCase());
    const colId = header.findIndex((h) => h.includes('模型 id') || h.includes('model id'));
    const colInput = header.findIndex((h) => h.includes('输入单价'));
    const colOutput = header.findIndex((h) => h.includes('输出单价'));
    if (colId < 0 || colInput < 0 || colOutput < 0) continue;
    const colRegion = header.findIndex((h) => h.includes('服务部署范围'));
    const colTier = header.findIndex((h) => h.includes('输入token'));

    for (const row of t.slice(1)) {
      const idCell = row[colId] || '';
      const mm = idCell.match(/qwen[\w.-]*/i);
      if (!mm) continue; // 只处理 qwen 模型行
      const model = slugify(mm[0]);
      if (!model.startsWith('qwen')) continue;
      // 白名单：只保留主流文本对话/编码/omni 系列（max/plus/flash/turbo/long/omni/coder），
      // 过滤开源量化版（qwen3-8-2-4t-a95b 等）、数学/翻译/文档/深度研究等专用模型及快照版本
      const KEEP = /^qwen3?(?:-\d+(?:\.\d+)?)?-(?:max|plus|flash|turbo|long|omni|coder)(?:-(?:max|plus|flash|turbo|lite|mini))?(?:-latest|-prime|-preview)?$/;
      if (!KEEP.test(model)) continue;

      // 区域过滤：优先国内价
      if (colRegion >= 0) {
        const region = row[colRegion] || '';
        if (!/中国内地|华北2（北京）|国内/.test(region)) continue;
      }
      const inputCell = row[colInput] || '';
      if (/\$/.test(inputCell) && !/元/.test(inputCell)) continue; // 跳过美元分区行

      const input = parseMoney(inputCell);
      const output = parseMoney(row[colOutput]);
      if (input == null && output == null) continue;
      parsedAny = true;

      const tier = colTier >= 0 ? row[colTier] || null : null;
      const prev = seen.get(model);
      if (prev) {
        if (prev.input === input && prev.output === output) continue; // 重复表/相同行
        prev.notes ||= { tiers: [] };
        prev.notes.tiers.push({ tier, input, output }); // 阶梯多档
        continue;
      }
      seen.set(model, { model, input, output, contextWindow: null, notes: tier ? { tiers: [{ tier, input, output }] } : null });
    }
  }

  if (!parsedAny) throw new Error('Qwen 未解析到任何价格行');
  const rows = [...seen.values()];
  if (!rows.length) throw new Error('Qwen 解析结果为空');
  return rows;
}
