// AI 价格雷达 前端逻辑
const state = {
  currency: 'usd',
  days: 90,
  logScale: false,
  selected: new Set(), // "provider/model"
  latest: null,
  history: new Map(),  // "provider/model" -> { provider, model, points }
  chart: null,
};

const $ = (id) => document.getElementById(id);

function fmt(n) {
  if (n == null) return '-';
  if (n === 0) return '0';
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(3).replace(/\.?0+$/, '');
}
function fmtCtx(n) {
  if (!n) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`请求失败 ${res.status} ${url}`);
  return res.json();
}

init();

async function init() {
  // 等待 ECharts CDN 加载完成
  while (!window.echarts) await new Promise((r) => setTimeout(r, 100));

  try {
    const [meta, latest] = await Promise.all([fetchJson('/api/meta'), fetchJson('/api/prices/latest')]);
    state.meta = meta;
    state.latest = latest;
    renderMetaBar();
    renderModelCheckbox();
    renderLatestTable();
    renderFetchStatus();
    for (const p of latest.providers) {
      if (p.models.length) state.selected.add(`${p.provider}/${p.models[0].model}`);
    }
    renderSelectedCount();
    initChart();
    bindEvents();
    await loadHistory();
  } catch (e) {
    $('metaBar').textContent = '⚠️ 初始化失败：' + e.message + '（可能是尚未抓取到任何数据，等待首次 cron 或手动触发）';
  }
}

function renderMetaBar() {
  const l = state.latest;
  const fx = l.fx?.usdToCny;
  $('fxNote').textContent = fx ? `1 USD ≈ ${fx} CNY（固定汇率）` : '';
  const lastRun = l.lastRun?.at;
  $('metaBar').textContent = lastRun ? `最近抓取：${lastRun}（UTC）` : '暂无抓取记录';
}

function renderModelCheckbox() {
  const el = $('modelCheckbox');
  el.innerHTML = state.latest.providers
    .map(
      (p) => `
      <fieldset class="model-group">
        <legend>${p.label || p.provider} <span class="cur">${p.currency}</span></legend>
        ${p.models
          .map(
            (m) => `
          <label class="model-item" title="${p.provider}/${m.model}">
            <input type="checkbox" value="${p.provider}/${m.model}" ${state.selected.has(`${p.provider}/${m.model}`) ? 'checked' : ''} />
            <span>${m.model}</span>
            ${m.free ? '<span class="badge free">免费</span>' : ''}
          </label>`
          )
          .join('')}
      </fieldset>`
    )
    .join('');
}

function renderSelectedCount() {
  $('selectedCount').textContent = `已选 ${state.selected.size} 个模型`;
}

function renderLatestTable() {
  const el = $('latestTable');
  if (!state.latest.providers.length) {
    el.innerHTML = '<p class="empty">暂无数据。首次部署后等待每日定时抓取，或手动 POST /api/trigger 触发。</p>';
    return;
  }
  el.innerHTML = state.latest.providers
    .map((p) => `
      <div class="provider-block">
        <div class="provider-head">
          <span class="provider-name">${p.label || p.provider}</span>
          <span class="badge cur">${p.currency}</span>
          <span class="badge status ${p.lastStatus || ''}">${p.lastStatus || '未知'}</span>
          ${p.lastRun ? `<span class="badge time">${shortDate(p.lastRun)}</span>` : ''}
        </div>
        <table>
          <thead><tr><th>模型</th><th>上下文</th><th>输入</th><th>输出</th><th>缓存命中</th></tr></thead>
          <tbody>${p.models.map((m) => rowHtml(m)).join('')}</tbody>
        </table>
      </div>`)
    .join('');
}

function rowHtml(m) {
  const usd = state.currency === 'usd';
  const inV = usd ? m.inputUsd : m.inputCny;
  const outV = usd ? m.outputUsd : m.outputCny;
  const cacheV = usd ? m.cacheHitUsd : m.cacheHitCny;
  const sym = usd ? '$' : '¥';
  const free = (m.inputUsd === 0 && m.outputUsd === 0) || m.free;
  const price = (v) => (free ? '<span class="free-txt">免费</span>' : sym + fmt(v));
  return `<tr>
    <td>${m.model}${free ? ' <span class="badge free">免费</span>' : ''}</td>
    <td class="num">${fmtCtx(m.contextWindow)}</td>
    <td class="num">${price(inV)}</td>
    <td class="num">${price(outV)}</td>
    <td class="num">${cacheV == null ? '—' : sym + fmt(cacheV)}</td>
  </tr>`;
}

function renderFetchStatus() {
  const el = $('fetchStatus');
  const items = state.latest.providers.map((p) => {
    const cls = p.lastStatus === 'ok' ? 'ok' : p.lastStatus === 'partial' ? 'partial' : 'err';
    return `<li><span class="dot ${cls}"></span>${p.label || p.provider}：${statusText(p.lastStatus)}${p.lastRun ? ` · ${shortDate(p.lastRun)}` : ''}</li>`;
  });
  el.innerHTML = `<ul class="status-list">${items.join('') || '<li>无记录</li>'}</ul>`;

  // 顶部异常横幅
  const issues = state.latest.providers.filter((p) => p.lastStatus === 'error' || p.lastStatus === 'partial');
  const banner = $('alertBanner');
  if (issues.length) {
    const parts = issues
      .map((p) => `${p.label || p.provider}（${statusText(p.lastStatus)}）`)
      .join('、');
    banner.textContent = `⚠️ 有厂商抓取异常：${parts}。官方定价页可能改版，详见下方抓取状态。`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function statusText(s) {
  return s === 'ok' ? '正常' : s === 'partial' ? '疑似改版' : s || '无记录';
}

function bindEvents() {
  $('currencyToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cur]');
    if (!btn) return;
    state.currency = btn.dataset.cur;
    document.querySelectorAll('#currencyToggle button').forEach((b) => b.classList.toggle('active', b === btn));
    renderLatestTable();
    renderChart();
  });

  $('daysSelect').addEventListener('change', (e) => {
    state.days = Number(e.target.value);
    renderChart(); // 数据已全量缓存，前端过滤
  });

  $('logScale').addEventListener('change', (e) => {
    state.logScale = e.target.checked;
    renderChart();
  });

  $('modelCheckbox').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    const key = cb.value;
    if (cb.checked) state.selected.add(key);
    else state.selected.delete(key);
    renderSelectedCount();
    loadHistory();
  });

  $('selectAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#modelCheckbox input').forEach((cb) => (cb.checked = true));
    document.querySelectorAll('#modelCheckbox input').forEach((cb) => state.selected.add(cb.value));
    renderSelectedCount();
    loadHistory();
  });
  $('selectNoneBtn').addEventListener('click', () => {
    document.querySelectorAll('#modelCheckbox input').forEach((cb) => (cb.checked = false));
    state.selected.clear();
    renderSelectedCount();
    loadHistory();
  });

  window.addEventListener('resize', () => state.chart && state.chart.resize());
}

function initChart() {
  state.chart = echarts.init($('chart'));
  renderChart();
}

async function loadHistory() {
  const uncached = [...state.selected].filter((k) => !state.history.has(k));
  await Promise.all(
    uncached.map(async (key) => {
      const [p, m] = key.split('/');
      try {
        const h = await fetchJson(`/api/prices/history?provider=${encodeURIComponent(p)}&model=${encodeURIComponent(m)}&days=9999`);
        state.history.set(key, { provider: h.provider, model: h.model, points: h.points });
      } catch (e) {
        state.history.set(key, { provider: p, model: m, points: [], error: e.message });
      }
    })
  );
  renderChart();
}

function renderChart() {
  if (!state.chart) return;
  const keys = [...state.selected];
  const cutoff = state.days === 9999 ? null : daysAgo(state.days);

  const dateSet = new Set();
  const seriesMap = {};
  for (const key of keys) {
    const h = state.history.get(key);
    if (!h || h.error) continue;
    seriesMap[key] = h;
    for (const p of h.points) if (!cutoff || p.date >= cutoff) dateSet.add(p.date);
  }
  const dates = [...dateSet].sort();
  const usd = state.currency === 'usd';

  const series = [];
  for (const key of keys) {
    const h = seriesMap[key];
    if (!h) continue;
    const byDate = new Map(h.points.map((p) => [p.date, p]));
    const val = (d, out) => {
      const p = byDate.get(d);
      if (!p) return null;
      const v = out ? (usd ? p.outputUsd : p.outputCny) : usd ? p.inputUsd : p.inputCny;
      if (state.logScale && (v == null || v <= 0)) return null;
      return v;
    };
    series.push({
      name: `${h.provider}/${h.model} 输入`,
      type: 'line',
      smooth: true,
      symbol: 'none',
      data: dates.map((d) => val(d, false)),
      lineStyle: { width: 2 },
    });
    series.push({
      name: `${h.provider}/${h.model} 输出`,
      type: 'line',
      smooth: true,
      symbol: 'none',
      data: dates.map((d) => val(d, true)),
      lineStyle: { type: 'dashed', width: 2 },
    });
  }

  const unit = usd ? 'USD' : 'CNY';
  const option = {
    tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '-' : fmt(v)) },
    legend: { type: 'scroll', top: 0, textStyle: { fontSize: 11 } },
    grid: { top: 70, left: 90, right: 40, bottom: 80 },
    xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
    yAxis: state.logScale
      ? { type: 'log', name: `价格（${unit} / 1M tokens）`, axisLabel: { formatter: (v) => fmt(v) } }
      : { type: 'value', name: `价格（${unit} / 1M tokens）` },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 20, bottom: 20 }],
    series,
  };
  state.chart.setOption(option, true);
}
