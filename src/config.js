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
  PORT: Number(process.env.HL_PORT || 8080),
  // 手机摄像头扫码要求安全上下文(https 或 localhost)，局域网访问请开 https
  HTTPS: String(process.env.HL_HTTPS || 'true') !== 'false',
  // 可选的家庭访问口令；留空表示局域网内免登录
  PIN: process.env.HL_PIN || '',
  SECRET: process.env.HL_SECRET || 'home-library-local-secret',
  // Z-Library 站点地址（官方镜像会变动，可在 .env 里覆盖）
  ZLIB_BASE: process.env.HL_ZLIB_BASE || 'https://zh.z-library.sk',
  // 元数据来源
  GOOGLE_BOOKS_KEY: process.env.HL_GOOGLE_BOOKS_KEY || '',
  UPLOAD_LIMIT_MB: Number(process.env.HL_UPLOAD_LIMIT_MB || 200),
};

for (const d of [config.DATA_DIR, config.FILES_DIR, config.COVERS_DIR, config.CERT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

module.exports = config;
