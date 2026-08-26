// 邮件通知：SMTP（Cloudflare Workers 出站 TCP，cloudflare:sockets）或 HTTP 邮件 API（Resend/Mailgun 等）
// SMTP 支持普通端口(25/587)与 STARTTLS(587)；隐式 TLS(465) 需连接后 startTls 升级，cloudflare:sockets 不直接支持，
// 若你的 SMTP 服务商仅提供隐式 TLS，请改用 HTTP 邮件 API。

const CRLF = '\r\n';

/**
 * 发送一封邮件。
 * @param {object} emailCfg getSettings().email
 * @param {object} mail { from, toList:string[], subject, text?, html? }
 */
export async function sendEmail(emailCfg, mail) {
  const cfg = {
    smtpHost: emailCfg?.smtpHost || '',
    smtpPort: Number(emailCfg?.smtpPort) || 587,
    smtpUser: emailCfg?.smtpUser || '',
    smtpPass: emailCfg?.smtpPass || '',
    smtpTls: emailCfg?.smtpTls || 'starttls',
    apiUrl: emailCfg?.apiUrl || '',
    apiKey: emailCfg?.apiKey || '',
  };
  const toList = (mail.toList || []).filter(Boolean);
  if (!toList.length) return { ok: false, error: '收件人为空' };
  const from = mail.from || cfg.smtpUser || 'no-reply@localhost';
  const subject = sanitizeHeader(mail.subject || '');
  const body = mail.html || mail.text || '';

  // SMTP 优先；失败且配置了 API 时回退
  if (cfg.smtpHost) {
    try {
      return await sendSmtp(cfg, { from, toList, subject, body });
    } catch (e) {
      if (cfg.apiUrl) return await sendHttpApi(cfg, { from, toList, subject, body, text: mail.text });
      return { ok: false, error: String(e?.message || e) };
    }
  }
  if (cfg.apiUrl) return await sendHttpApi(cfg, { from, toList, subject, body, text: mail.text });
  return { ok: false, error: '未配置 SMTP 或邮件 API' };
}

async function sendSmtp(cfg, mail) {
  let mod = null;
  try {
    mod = await import('cloudflare:sockets');
  } catch {
    mod = null;
  }
  if (!mod?.connect) throw new Error('当前运行时不支持出站 TCP（SMTP 需支持 cloudflare:sockets 的环境）');

  const socket = mod.connect({ hostname: cfg.smtpHost, port: cfg.smtpPort });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let pending = '';

  const readLine = async () => {
    for (;;) {
      const idx = pending.indexOf(CRLF);
      if (idx >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP 连接被关闭');
      pending += dec.decode(value);
    }
  };
  const readResp = async () => {
    const line = await readLine();
    return { code: Number(line.slice(0, 3)), text: line.slice(4) };
  };
  const send = async (s) => {
    await writer.write(enc.encode(s + CRLF));
  };
  const expect = (r, codes) => {
    if (!codes.includes(r.code)) throw new Error(`SMTP 响应 ${r.code}: ${r.text}`);
  };

  try {
    let r = await readResp();
    expect(r, [220]);
    await send('EHLO ai-price-radar');
    r = await readResp();
    expect(r, [250]);

    if (cfg.smtpTls === 'starttls') {
      await send('STARTTLS');
      r = await readResp();
      expect(r, [220]);
      await socket.startTls();
      await send('EHLO ai-price-radar');
      r = await readResp();
      expect(r, [250]);
    } else if (cfg.smtpTls === 'tls') {
      throw new Error('隐式 TLS(465) 暂不支持，请用 STARTTLS(587) 或配置 HTTP 邮件 API');
    }

    if (cfg.smtpUser) {
      await send('AUTH LOGIN');
      r = await readResp();
      expect(r, [334]);
      await send(btoa(cfg.smtpUser));
      r = await readResp();
      expect(r, [334]);
      await send(btoa(cfg.smtpPass));
      r = await readResp();
      expect(r, [235]);
    }

    await send(`MAIL FROM:<${mail.from}>`);
    r = await readResp();
    expect(r, [250]);
    for (const rcpt of mail.toList) {
      await send(`RCPT TO:<${rcpt}>`);
      r = await readResp();
      expect(r, [250, 251]);
    }
    await send('DATA');
    r = await readResp();
    expect(r, [354]);
    const msg = [
      `From: ${mail.from}`,
      `To: ${mail.toList.join(', ')}`,
      `Subject: ${mail.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      mail.body,
    ].join(CRLF);
    // 报文结束符：单独一行的 .
    await send(msg + CRLF + '.');
    r = await readResp();
    expect(r, [250]);
    await send('QUIT');
    return { ok: true };
  } finally {
    try {
      socket.close();
    } catch {}
  }
}

async function sendHttpApi(cfg, mail) {
  const res = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      from: mail.from,
      to: mail.toList.join(','),
      subject: mail.subject,
      text: mail.text || stripHtml(mail.body),
      html: mail.body,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`邮件 API HTTP ${res.status}`);
  return { ok: true };
}

function sanitizeHeader(s) {
  return String(s).replace(/[\r\n]/g, ' ').trim();
}

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
