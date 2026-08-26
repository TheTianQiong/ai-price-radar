// 智谱 GLM 官方定价解析
// bigmodel.cn/pricing 是 Vue SPA，价格数据内嵌在官方静态 bundle（app.<hash>.js）中：
//   newModel.model[0] = 文本模型分组，其 modelList:[ {name:"GLM-5.3", inPrice:["8元"], outPrice:["28元"], hit:["2元"], upDownText:["1M"], ...} ]
// 解析流程：抓 shell 页面 -> 提取 app.js URL -> 抓 bundle -> 解析 modelList。

import { fetchText, parseMoney, slugify } from '../utils.js';

export const provider = 'glm';
export const label = '智谱 GLM';
export const url = 'https://bigmodel.cn/pricing';
export const currency = 'CNY';

export async function parse(shellHtml, env = {}) {
  const m = shellHtml.match(/<script[^>]+src="([^"]*wd-paas-front\/js\/app\.[a-z0-9]+\.js)"/);
  if (!m) throw new Error('未找到 app.js bundle URL');
  const bundleUrl = m[1].startsWith('http') ? m[1] : m[1].startsWith('//') ? 'https:' + m[1] : 'https:' + m[1];
  const bundle = await fetchText(bundleUrl, env);
  return extractFromBundle(bundle);
}

function extractFromBundle(bundle) {
  const anchor = bundle.indexOf('modelName:"文本模型"');
  if (anchor < 0) throw new Error('未找到文本模型区块');
  const listStart = bundle.indexOf('modelList:[', anchor);
  if (listStart < 0) throw new Error('未找到 modelList');
  const nextGroup = bundle.indexOf('modelName:"视觉理解"', listStart);
  const sliceEnd = nextGroup > listStart ? nextGroup : listStart + 120000;
  const slice = bundle.slice(listStart, sliceEnd);

  const rows = [];
  const objRe = /\{name:"(?:[^"\\]|\\.)*"[^{}]*?\}/g;
  let om;
  while ((om = objRe.exec(slice))) {
    const o = om[0];
    // 注意：bundle 里的对象键不带引号（name:"GLM-5.3"），用 \b 防止误匹配 className 等
    const name = o.match(/\bname:"([^"]*)"/)?.[1];
    if (!name) continue; // 阶梯续行（name 为空）跳过，取第一档为主价
    const input = parseMoney(o.match(/\binPrice:\["([^"]*)"/)?.[1]);
    const output = parseMoney(o.match(/\boutPrice:\["([^"]*)"/)?.[1]);
    const hit = parseMoney(o.match(/\bhit:\["([^"]*)"/)?.[1]);
    if (input == null && output == null) continue;

    const ctxRaw = o.match(/\bupDownText:\["([^"]*)"/)?.[1] ?? '';
    let contextWindow = null;
    const cm = ctxRaw.match(/^(\d+(?:\.\d+)?)\s*([KkMm])?$/);
    if (cm) {
      const n = Number(cm[1]);
      contextWindow = !cm[2] ? Math.round(n) : /[mM]/.test(cm[2]) ? Math.round(n * 1000000) : Math.round(n * 1000);
    }
    rows.push({ model: slugify(name), input, output, cacheHit: hit, contextWindow });
  }
  if (rows.length < 5) throw new Error(`GLM 解析到模型过少（${rows.length}）`);
  return rows;
}
