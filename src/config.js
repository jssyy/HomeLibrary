const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.HL_DATA_DIR || path.join(ROOT, 'data');

// 读取 .env（极简实现，不引第三方依赖）
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const config = {
  ROOT,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'library.db'),
  FILES_DIR: path.join(DATA_DIR, 'files'),   // 电子书文件
  COVERS_DIR: path.join(DATA_DIR, 'covers'), // 本地缓存封面
  CERT_DIR: path.join(DATA_DIR, 'cert'),
  // 云平台（Render / Railway / Zeabur 等）通过 PORT 指定端口
  PORT: Number(process.env.HL_PORT || process.env.PORT || 8080),
  // 手机摄像头扫码要求安全上下文(https 或 localhost)，局域网访问请开 https
  HTTPS: String(process.env.HL_HTTPS || 'true') !== 'false',
  // 对外访问地址，用来拼邮件里的重置密码 / 验证链接，如 https://books.example.com
  // 不填就用请求里的 Host（只建议在局域网里这么用）
  // Render 会自动提供 RENDER_EXTERNAL_URL，部署在 Render 上可以不填
  PUBLIC_URL: (process.env.HL_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  // 是否开放注册；关掉后只有持邀请链接的人能注册
  ALLOW_REGISTER: String(process.env.HL_ALLOW_REGISTER || 'true') !== 'false',
  // 站点管理员邮箱（逗号分隔）；不填则第一个注册的账号是管理员
  ADMIN_EMAILS: String(process.env.HL_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // 反向代理后面部署时设置，如 1 或 loopback；透传给 express 的 trust proxy
  TRUST_PROXY: (() => {
    const v = process.env.HL_TRUST_PROXY;
    if (!v) return false;
    return /^\d+$/.test(v) ? Number(v) : v;
  })(),
  SESSION_DAYS: Number(process.env.HL_SESSION_DAYS || 30),
  // 发信（找回密码、验证邮箱）。不配 SMTP 时邮件内容打印在服务端控制台
  SMTP_HOST: process.env.HL_SMTP_HOST || '',
  SMTP_PORT: Number(process.env.HL_SMTP_PORT || 465),
  SMTP_SECURE: String(process.env.HL_SMTP_SECURE || (Number(process.env.HL_SMTP_PORT || 465) === 465)) !== 'false',
  SMTP_USER: process.env.HL_SMTP_USER || '',
  SMTP_PASS: process.env.HL_SMTP_PASS || '',
  MAIL_FROM: process.env.HL_MAIL_FROM || process.env.HL_SMTP_USER || '',
  // Z-Library 站点地址（官方镜像会变动，可在 .env 里覆盖）
  ZLIB_BASE: process.env.HL_ZLIB_BASE || 'https://zh.z-library.sk',
  // 元数据来源
  GOOGLE_BOOKS_KEY: process.env.HL_GOOGLE_BOOKS_KEY || '',
  // 书目来源里 Z-Library 的默认开关；对外公开的站点建议设成 false
  ZLIB_ENABLED: String(process.env.HL_ZLIB_ENABLED || 'true') !== 'false',
  UPLOAD_LIMIT_MB: Number(process.env.HL_UPLOAD_LIMIT_MB || 200),
};

for (const d of [config.DATA_DIR, config.FILES_DIR, config.COVERS_DIR, config.CERT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

module.exports = config;
