// D1 帮助函数：价格 upsert、抓取日志、查询

const SELECT_COLS = `date, provider, model, currency,
  input_usd, output_usd, input_cny, output_cny,
  cache_hit_usd, cache_hit_cny, cache_write_usd, cache_write_cny,
  context_window, notes, updated_at`;

/**
 * 幂等写入某 provider 当日价格。复合主键 (date,provider,model)，同一天重跑只更新。
 * @param {object} env
 * @param {string} date 'YYYY-MM-DD'（UTC）
 * @param {Array<object>} rows normalize() 的输出
 */
export async function upsertPrices(env, date, rows) {
  if (!rows.length) return;
  const now = new Date().toISOString();
  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO price_history
        (date, provider, model, currency, input_usd, output_usd, input_cny, output_cny,
         cache_hit_usd, cache_hit_cny, cache_write_usd, cache_write_cny, context_window, notes, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(date, provider, model) DO UPDATE SET
         currency=excluded.currency,
         input_usd=excluded.input_usd, output_usd=excluded.output_usd,
         input_cny=excluded.input_cny, output_cny=excluded.output_cny,
         cache_hit_usd=excluded.cache_hit_usd, cache_hit_cny=excluded.cache_hit_cny,
         cache_write_usd=excluded.cache_write_usd, cache_write_cny=excluded.cache_write_cny,
         context_window=excluded.context_window, notes=excluded.notes, updated_at=excluded.updated_at`
    ).bind(
      date,
      r.provider,
      r.model,
      r.currency,
      r.inputUsd,
      r.outputUsd,
      r.inputCny,
      r.outputCny,
      r.cacheHitUsd,
      r.cacheHitCny,
      r.cacheWriteUsd,
      r.cacheWriteCny,
      r.contextWindow,
      r.notes,
      now
    )
  );
  await env.DB.batch(stmts);
}

/** 写抓取日志 */
export async function logFetch(env, runAt, provider, status, okCount, errCount, error, durationMs) {
  await env.DB.prepare(
    `INSERT INTO fetch_log (run_at, provider, status, ok_count, err_count, error, duration_ms)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(runAt, provider, status, okCount, errCount, error ? String(error).slice(0, 500) : null, durationMs)
    .run();
}

/** 每 provider 的最近一次抓取状态 */
export async function lastFetchStates(env) {
  const res = await env.DB.prepare(
    `SELECT provider, status, ok_count, err_count, error, run_at
     FROM fetch_log
     WHERE (provider, run_at) IN (
       SELECT provider, MAX(run_at) FROM fetch_log GROUP BY provider
     )`
  ).all();
  return res.results ?? [];
}

/** 最新一天（各 provider 各自的最新日期）的价格明细，可按 provider/model 过滤 */
export async function queryLatest(env, { provider, model } = {}) {
  let sql = `SELECT ${SELECT_COLS} FROM price_history ph
    WHERE date = (SELECT MAX(date) FROM price_history p2 WHERE p2.provider = ph.provider)`;
  const args = [];
  if (provider) {
    args.push(provider);
    sql += ' AND ph.provider = ?';
  }
  if (model) {
    args.push(model);
    sql += ' AND ph.model = ?';
  }
  sql += ' ORDER BY ph.provider, ph.model';
  const res = await env.DB.prepare(sql).bind(...args).all();
  return res.results ?? [];
}

/** 单模型时序（双币列都返回，前端切换币种零请求） */
export async function queryHistory(env, { provider, model, days }) {
  let sql = `SELECT date, input_usd, output_usd, input_cny, output_cny
    FROM price_history WHERE provider = ? AND model = ?`;
  const args = [provider, model];
  if (days && Number(days) > 0) {
    sql += ` AND date >= date('now', ?)`;
    args.push(`-${Number(days)} days`);
  }
  sql += ' ORDER BY date';
  const res = await env.DB.prepare(sql).bind(...args).all();
  return res.results ?? [];
}

/** 厂商清单 + 各厂商模型清单 */
export async function queryMeta(env) {
  const res = await env.DB.prepare(
    `SELECT DISTINCT provider, model FROM price_history ORDER BY provider, model`
  ).all();
  return res.results ?? [];
}

// ---------- 告警 ----------

/** 读取某厂商上次告警状态 */
export async function getAlertState(env, provider) {
  const res = await env.DB.prepare('SELECT * FROM alert_state WHERE provider = ?').bind(provider).all();
  return res.results?.[0] ?? null;
}

/** 写入/更新某厂商告警状态 */
export async function setAlertState(env, provider, status, modelCount, updatedAt) {
  await env.DB.prepare(
    `INSERT INTO alert_state (provider, last_status, model_count, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(provider) DO UPDATE SET
       last_status=excluded.last_status, model_count=excluded.model_count, updated_at=excluded.updated_at`
  )
    .bind(provider, status, modelCount, updatedAt)
    .run();
}

/** 某厂商在 today 之前最近一个有数据日期的模型数（用于「疑似改版」的数量骤降检测） */
export async function prevDayCount(env, provider, today) {
  const res = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM price_history
     WHERE provider = ? AND date = (SELECT MAX(date) FROM price_history WHERE provider = ? AND date < ?)`
  )
    .bind(provider, provider, today)
    .all();
  return Number(res.results?.[0]?.n || 0);
}

/** 最近的抓取日志（用于 RSS / 巡检） */
export async function recentLogs(env, limit = 50) {
  const res = await env.DB.prepare('SELECT * FROM fetch_log ORDER BY id DESC LIMIT ?').bind(limit).all();
  return res.results ?? [];
}
