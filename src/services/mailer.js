/**
 * 发信，按优先级：
 *   1. Brevo 邮件 API（https，云平台屏蔽 SMTP 端口时也能发）
 *   2. SMTP
 *   3. 都没配：把邮件打印到控制台（自己部署、局域网用也能找回密码）
 */
const config = require('../config');

let transport = null;

function getTransport() {
  if (!config.SMTP_HOST) return null;
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

function isConfigured() {
  return !!(config.BREVO_API_KEY || config.SMTP_HOST);
}

/** "家庭图书馆 <a@b.com>" → { name, email } */
function parseAddress(v) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(String(v || ''));
  if (m) return { name: m[1].replace(/^["']|["']$/g, '') || undefined, email: m[2].trim() };
  return { email: String(v || '').trim() };
}

async function sendViaBrevo({ to, subject, text, html }) {
  const sender = parseAddress(config.MAIL_FROM);
  if (!sender.email) throw new Error('用 Brevo 发信需要配置 HL_MAIL_FROM（在 Brevo 里验证过的发件邮箱）');
  const res = await fetch(config.BREVO_API_URL, {
    method: 'POST',
    headers: { 'api-key': config.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: sender.name || '家庭图书馆', email: sender.email },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html || undefined,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo 返回 ${res.status}：${body.slice(0, 300)}`);
  }
  return { sent: true, via: 'brevo' };
}

async function send({ to, subject, text, html }) {
  if (config.BREVO_API_KEY) return sendViaBrevo({ to, subject, text, html });
  const t = getTransport();
  if (!t) {
    console.log(
      [
        '',
        '  ✉️  没配 SMTP，邮件内容打印在这里：',
        `  收件人：${to}`,
        `  主题：  ${subject}`,
        ...text.split('\n').map((l) => `  ${l}`),
        '',
      ].join('\n')
    );
    return { logged: true };
  }
  await t.sendMail({ from: config.MAIL_FROM, to, subject, text, html });
  return { sent: true };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 统一的邮件样式：一段说明 + 一个按钮 + 备用链接 */
function actionMail({ to, subject, intro, button, url, outro }) {
  const text = [intro, '', `${button}：${url}`, '', outro].filter((x) => x !== undefined).join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#2b2620">
  <div style="font-size:28px">📚</div>
  <p style="line-height:1.7">${escapeHtml(intro)}</p>
  <p><a href="${escapeHtml(url)}" style="display:inline-block;background:#b5602a;color:#fff;padding:10px 20px;border-radius:10px;text-decoration:none">${escapeHtml(button)}</a></p>
  <p style="font-size:12px;color:#8a8175;word-break:break-all">按钮点不开的话，把这个链接复制到浏览器：<br>${escapeHtml(url)}</p>
  ${outro ? `<p style="font-size:12px;color:#8a8175">${escapeHtml(outro)}</p>` : ''}
</div>`;
  return send({ to, subject, text, html });
}

module.exports = { send, actionMail, isConfigured };
