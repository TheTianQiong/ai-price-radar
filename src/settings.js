// 运行时可配置设置：存储于 D1 settings 表，env 变量作为部署默认值（DB 覆盖 env）
// 管理后台通过 /api/admin/settings 读写。

export const ALLOWED_SETTING_KEYS = [
  'alert.webhook_url',
  'email.smtp_host',
  'email.smtp_port',
  'email.smtp_user',
  'email.smtp_pass',
  'email.smtp_tls', // none | starttls
  'email.from',
  'email.to',
  'email.api_url', // HTTP 邮件 API（Resend/Mailgun 等），免费套餐可用
  'email.api_key',
];

// key -> env 变量名（部署默认值）
const ENV_MAP = {
  'alert.webhook_url': 'ALERT_WEBHOOK_URL',
  'email.smtp_host': 'EMAIL_SMTP_HOST',
  'email.smtp_port': 'EMAIL_SMTP_PORT',
  'email.smtp_user': 'EMAIL_SMTP_USER',
  'email.smtp_pass': 'EMAIL_SMTP_PASS',
  'email.smtp_tls': 'EMAIL_SMTP_TLS',
  'email.from': 'EMAIL_FROM',
  'email.to': 'EMAIL_TO',
  'email.api_url': 'EMAIL_API_URL',
  'email.api_key': 'EMAIL_API_KEY',
};

const DEFAULTS = {
  'alert.webhook_url': '',
  'email.smtp_host': '',
  'email.smtp_port': '587',
  'email.smtp_user': '',
  'email.smtp_pass': '',
  'email.smtp_tls': 'starttls',
  'email.from': '',
  'email.to': '',
  'email.api_url': '',
  'email.api_key': '',
};

/** 读取全部设置（env 默认 + DB 覆盖），返回结构化对象 */
export async function getSettings(env) {
  const res = await env.DB.prepare('SELECT key, value FROM settings').all();
  const overrides = {};
  for (const r of res.results || []) overrides[r.key] = r.value;

  const raw = {};
  for (const key of ALLOWED_SETTING_KEYS) {
    const envName = ENV_MAP[key];
    let v = DEFAULTS[key];
    if (envName && env[envName] != null && String(env[envName]) !== '') v = String(env[envName]);
    if (overrides[key] != null && overrides[key] !== '') v = overrides[key];
    raw[key] = v;
  }
  return {
    raw,
    alert: { webhookUrl: raw['alert.webhook_url'] },
    email: {
      smtpHost: raw['email.smtp_host'],
      smtpPort: raw['email.smtp_port'],
      smtpUser: raw['email.smtp_user'],
      smtpPass: raw['email.smtp_pass'],
      smtpTls: raw['email.smtp_tls'],
      from: raw['email.from'],
      to: raw['email.to'],
      apiUrl: raw['email.api_url'],
      apiKey: raw['email.api_key'],
    },
  };
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  )
    .bind(key, String(value ?? ''), new Date().toISOString())
    .run();
}

// ---------- 管理后台 token 鉴权（HMAC，无状态） ----------

export async function signAdminToken(password, ttlMs = 12 * 3600 * 1000) {
  const exp = String(Date.now() + ttlMs);
  const payload = btoa(exp);
  const sig = await hmacHex(password, payload);
  return `${payload}.${sig}`;
}

export async function verifyAdminToken(password, token) {
  if (!password || !token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  if ((await hmacHex(password, payload)) !== sig) return false;
  const exp = Number(atob(payload));
  return Number.isFinite(exp) && exp > Date.now();
}

async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
