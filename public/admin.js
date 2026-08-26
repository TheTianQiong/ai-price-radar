// 管理后台前端逻辑
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'apr_admin_token';

let token = localStorage.getItem(TOKEN_KEY) || '';

function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers['x-admin-token'] = token;
  if (opts.body && typeof opts.body === 'object') headers['content-type'] = 'application/json';
  return fetch(path, {
    ...opts,
    headers,
    body: opts.body && typeof opts.body === 'object' ? JSON.stringify(opts.body) : opts.body,
  }).then(async (r) => {
    if (r.status === 401) {
      logout();
      throw new Error('未授权或登录已过期，请重新登录');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  });
}

function logout() {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  $('mainView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('pwInput').value = '';
}

function shortDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function statusPill(s) {
  const map = { ok: '正常', partial: '疑似改版', error: '失败', null: '未抓取' };
  return `<span class="status-pill ${s || 'none'}">${map[s] ?? '未知'}</span>`;
}

// ---------- 登录 ----------
async function doLogin() {
  $('loginMsg').textContent = '';
  const password = $('pwInput').value;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || '登录失败');
    token = j.token;
    localStorage.setItem(TOKEN_KEY, token);
    $('loginView').classList.add('hidden');
    $('mainView').classList.remove('hidden');
    loadOverview();
  } catch (e) {
    $('loginMsg').textContent = '⚠️ ' + e.message;
  }
}

// ---------- Tab ----------
document.querySelectorAll('.tabs button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
    $('tab-' + btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'overview') loadOverview();
    if (btn.dataset.tab === 'logs') loadLogs();
    if (btn.dataset.tab === 'settings') loadSettings();
  });
});

// ---------- 概览 ----------
async function loadOverview() {
  try {
    const j = await api('/api/admin/overview');
    $('ovTotalRows').textContent = j.totalRows;
    $('ovGeneratedAt').textContent = `生成于 ${shortDate(j.generatedAt)}`;
    $('ovBody').innerHTML = j.providers
      .map(
        (p) => `<tr>
          <td><b>${p.label}</b><div class="muted">${p.provider} · ${p.currency}</div></td>
          <td>${statusPill(p.lastStatus)}</td>
          <td>${p.modelCount}</td>
          <td>${shortDate(p.lastRun)}</td>
          <td class="muted">${p.lastError ? `<span class="err">${esc(p.lastError)}</span>` : '-'}</td>
          <td><button class="mini-btn" data-run="${p.provider}">单跑</button></td>
        </tr>`
      )
      .join('');
    document.querySelectorAll('#ovBody button[data-run]').forEach((btn) => {
      btn.addEventListener('click', () => runProvider(btn.dataset.run));
    });
  } catch (e) {
    $('ovBody').innerHTML = `<tr><td colspan="6" class="err">${esc(e.message)}</td></tr>`;
  }
}

async function runProvider(provider) {
  $('runResult').classList.remove('hidden');
  $('runResult').textContent = `正在重跑 ${provider} ...`;
  try {
    const j = await api('/api/admin/run', { method: 'POST', body: { provider } });
    const r = j.result;
    $('runResult').textContent =
      `[${provider}] 状态: ${r.status}  模型数: ${r.okCount}  耗时: ${r.durationMs}ms\n` +
      (r.error ? `提示: ${r.error}\n` : '') +
      `时间: ${j.runAt}`;
  } catch (e) {
    $('runResult').textContent = '失败: ' + e.message;
  }
}

// ---------- 抓取 ----------
$('scrapeAll').addEventListener('click', async () => {
  const box = $('scrapeResult');
  box.classList.remove('hidden');
  box.textContent = '正在抓取全部厂商（真实访问官方定价页）...';
  try {
    const j = await api('/api/admin/trigger', { method: 'POST' });
    const lines = Object.entries(j.providers).map(
      ([k, v]) => `${k}: ${v.status}  (${v.okCount} 模型${v.error ? '，' + v.error : ''})`
    );
    box.textContent = '抓取完成\n' + lines.join('\n');
    loadOverview();
  } catch (e) {
    box.textContent = '失败: ' + e.message;
  }
});

// ---------- 通知设置 ----------
const SET_FIELD_MAP = [
  ['set-webhookUrl', 'alert.webhook_url'],
  ['set-smtpHost', 'email.smtp_host'],
  ['set-smtpPort', 'email.smtp_port'],
  ['set-smtpTls', 'email.smtp_tls'],
  ['set-smtpUser', 'email.smtp_user'],
  ['set-smtpPass', 'email.smtp_pass'],
  ['set-from', 'email.from'],
  ['set-to', 'email.to'],
  ['set-apiUrl', 'email.api_url'],
  ['set-apiKey', 'email.api_key'],
];

async function loadSettings() {
  try {
    const j = await api('/api/admin/settings');
    const raw = j.settings.raw;
    for (const [fieldId, key] of SET_FIELD_MAP) $(fieldId).value = raw[key] || '';
  } catch (e) {
    $('settingsMsg').textContent = '⚠️ ' + e.message;
  }
}

$('saveSettings').addEventListener('click', async () => {
  const body = {};
  for (const [fieldId, key] of SET_FIELD_MAP) body[key] = $(fieldId).value.trim();
  try {
    const j = await api('/api/admin/settings', { method: 'PUT', body });
    $('settingsMsg').textContent = '✅ 已保存';
    $('settingsMsg').className = 'ok';
    setTimeout(() => ($('settingsMsg').textContent = ''), 3000);
    return j;
  } catch (e) {
    $('settingsMsg').textContent = '⚠️ ' + e.message;
    $('settingsMsg').className = 'err';
  }
});

$('testNotify').addEventListener('click', async () => {
  $('settingsMsg').textContent = '发送中...';
  $('settingsMsg').className = 'muted';
  try {
    // 先保存再测试，确保用最新配置
    const body = {};
    for (const [fieldId, key] of SET_FIELD_MAP) body[key] = $(fieldId).value.trim();
    await api('/api/admin/settings', { method: 'PUT', body });
    const j = await api('/api/admin/test-notification', { method: 'POST' });
    const parts = [];
    for (const [ch, r] of Object.entries(j.results)) {
      parts.push(`${ch}: ${r?.ok === true ? '✅ 已发送' : r?.ok === null ? '未配置' : '❌ ' + (r?.error || '失败')}`);
    }
    $('settingsMsg').textContent = '测试结果: ' + parts.join('  ');
    $('settingsMsg').className = parts.some((p) => p.includes('❌')) ? 'err' : 'ok';
  } catch (e) {
    $('settingsMsg').textContent = '⚠️ ' + e.message;
    $('settingsMsg').className = 'err';
  }
});

// ---------- 日志 ----------
async function loadLogs() {
  try {
    const j = await api('/api/admin/logs?limit=50');
    $('logsBody').innerHTML = j.logs
      .map(
        (l) => `<tr>
          <td>${shortDate(l.run_at)}</td>
          <td>${l.provider}</td>
          <td>${statusPill(l.status)}</td>
          <td>${l.ok_count}</td>
          <td>${l.duration_ms}</td>
          <td class="muted">${l.error ? `<span class="err">${esc(l.error)}</span>` : '-'}</td>
        </tr>`
      )
      .join('');
  } catch (e) {
    $('logsBody').innerHTML = `<tr><td colspan="6" class="err">${esc(e.message)}</td></tr>`;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// ---------- 初始化 ----------
$('loginBtn').addEventListener('click', doLogin);
$('pwInput').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
$('logoutBtn').addEventListener('click', logout);
$('ovRefresh').addEventListener('click', loadOverview);
$('logsRefresh').addEventListener('click', loadLogs);

if (token) {
  // 尝试用已有 token 进入
  api('/api/admin/overview')
    .then(() => {
      $('loginView').classList.add('hidden');
      $('mainView').classList.remove('hidden');
      loadOverview();
    })
    .catch(() => {});
}
