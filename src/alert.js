// 抓取异常检测与告警
// 检测：状态从 ok -> error/partial 的「变化瞬间」才告警（连续失败不再重复提醒）。
// 通知：webhook（钉钉/企业微信/Slack/通用）+ 邮件（SMTP 或 HTTP 邮件 API）。配置来自 D1 settings（env 为默认值）。

import * as db from './db.js';
import { getSettings } from './settings.js';
import { sendEmail } from './email.js';

/**
 * 根据本次抓取结果做告警状态检测与通知。
 * @param {object} env
 * @param {object} results  runAll 的 providers 结果（含 label/status/error/okCount）
 * @param {string} date     'YYYY-MM-DD'
 * @returns {Promise<string[]>} 本次触发告警的厂商列表
 */
export async function detectAndAlert(env, results, date) {
  const triggered = [];
  for (const [provider, res] of Object.entries(results)) {
    const prev = await db.getAlertState(env, provider);
    const prevStatus = prev?.last_status ?? null;
    const currentStatus = res.status;
    const isFailure = currentStatus === 'error' || currentStatus === 'partial';
    const freshFail = isFailure && prevStatus !== currentStatus;

    await db.setAlertState(env, provider, currentStatus, res.okCount || 0, new Date().toISOString());

    if (freshFail) {
      triggered.push({ provider, label: res.label || provider, status: currentStatus, error: res.error || '解析结果异常' });
    }
  }

  if (triggered.length) {
    await notifyChannels(env, buildMessage(triggered, date));
  }
  return triggered;
}

/** 向已配置的所有通道发送一条通知，返回各通道结果 */
export async function notifyChannels(env, text) {
  const settings = await getSettings(env);
  const results = { webhook: null, email: null };

  if (settings.alert.webhookUrl) {
    results.webhook = await sendWebhook(settings.alert.webhookUrl, text);
  }
  if (settings.email.smtpHost || settings.email.apiUrl) {
    const toList = (settings.email.to || '').split(/[,，;]/).map((s) => s.trim()).filter(Boolean);
    if (toList.length) {
      const res = await sendEmail(settings.email, {
        from: settings.email.from,
        toList,
        subject: `AI价格雷达：抓取异常提醒（${new Date().toISOString().slice(0, 10)}）`,
        text: stripMarkdown(text),
        html: text.replace(/\n/g, '<br/>'),
      });
      results.email = res.ok ? { ok: true } : { ok: false, error: res.error };
    }
  }
  return results;
}

/** 发送测试通知（管理后台用） */
export async function sendTestNotification(env) {
  const settings = await getSettings(env);
  const text =
    `## ✅ AI 价格雷达 · 测试通知\n\n` +
    `如果收到本条消息，说明通知通道配置正确。\n\n` +
    `时间: ${new Date().toISOString()}\n` +
    `通道: webhook / 邮件\n` +
    `配置位置: 管理后台 /admin 的通知设置`;
  const results = await notifyChannels(env, text);
  const ok = (results.webhook?.ok === true || results.webhook === null) && (results.email?.ok === true || results.email === null);
  return { ok, results };
}

function buildMessage(items, date) {
  const lines = ['## ⚠️ AI 价格雷达 · 抓取异常', '', `日期: ${date} (UTC)`, ''];
  for (const it of items) {
    lines.push(
      `### ${it.label}`,
      `- 状态: **${it.status === 'error' ? '失败' : '疑似改版'}**`,
      `- 原因: ${it.error}`,
      `- 建议: 官方定价页可能已改版，请登录管理后台 → 抓取，或运行 \`npm run check:scrapers ${it.provider}\` 验证`,
      ''
    );
  }
  return lines.join('\n');
}

/** 发送到 webhook（按 URL 自动识别钉钉/企业微信/Slack/通用） */
export async function sendWebhook(url, text) {
  if (!url) return { ok: false, error: '未配置 webhook URL' };
  let body;
  const u = url.toLowerCase();
  if (u.includes('dingtalk')) {
    body = { msgtype: 'markdown', markdown: { title: 'AI价格雷达告警', text } };
  } else if (u.includes('qyapi.weixin') || u.includes('qyapi.work')) {
    body = { msgtype: 'text', text: { content: stripMarkdown(text) } };
  } else if (u.includes('slack')) {
    body = { text: stripMarkdown(text) };
  } else {
    body = { text, content: text };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function stripMarkdown(s) {
  return String(s).replace(/^#{1,3}\s*/gm, '').replace(/\*\*/g, '');
}
