// 双币换算与归一化：抓取时一次性完成，USD/CNY 都落库，历史查询无需运行时换算
// 这是全项目唯一的汇率逻辑位置

/**
 * @param {object} provider scraper 对象（含 provider / currency）
 * @param {Array<{model:string,input?:number,output?:number,cacheHit?:number,cacheWrite?:number,contextWindow?:number|null,notes?:object}>} raw
 * @param {number} usdToCny 固定汇率（1 USD = ? CNY）
 * @returns {Array<object>} 可直接写入 price_history 的行
 */
export function normalize(provider, raw, usdToCny) {
  const fx = Number(usdToCny) || 7.15;
  const isCny = provider.currency === 'CNY';
  const toUsd = (v) => (v == null ? null : isCny ? round(v / fx) : v);
  const toCny = (v) => (v == null ? null : isCny ? v : round(v * fx));

  return raw.map((r) => {
    const free = r.input === 0 && r.output === 0;
    return {
      provider: provider.provider,
      model: r.model,
      currency: provider.currency,
      inputUsd: toUsd(r.input),
      outputUsd: toUsd(r.output),
      inputCny: toCny(r.input),
      outputCny: toCny(r.output),
      cacheHitUsd: toUsd(r.cacheHit),
      cacheHitCny: toCny(r.cacheHit),
      cacheWriteUsd: toUsd(r.cacheWrite),
      cacheWriteCny: toCny(r.cacheWrite),
      contextWindow: r.contextWindow ?? null,
      notes: r.notes && Object.keys(r.notes).length ? JSON.stringify(r.notes) : null,
      free,
    };
  });
}

function round(v) {
  return Math.round(v * 100000) / 100000;
}
