/** 运行时设置：存在 SQLite 的 settings 表里，界面上可改，改完即时生效 */
const { db } = require('./db');
const config = require('./config');

const DEFAULTS = {
  proxy_enabled: '0',
  proxy_url: 'http://127.0.0.1:7897',
  source_googlebooks: '1',
  source_openlibrary: '1',
  source_weread: '1',
  source_zlibrary: config.ZLIB_ENABLED ? '1' : '0',
  source_douban: '1',
  google_books_key: config.GOOGLE_BOOKS_KEY || '',
  zlib_base: config.ZLIB_BASE,
  zlib_cookie: '',
  douban_cookie: '',
  // 拍照识别：ocr_engine = auto | vision | local
  ocr_engine: 'auto',
  vision_enabled: '0',
  vision_base_url: 'https://open.bigmodel.cn/api/paas/v4',
  vision_api_key: '',
  vision_model: 'glm-4v-flash',
  currency: '¥',
};

const selAll = db.prepare('SELECT key, value FROM settings');
const upsert = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function all() {
  const rows = selAll.all();
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function get(key) {
  const v = all()[key];
  return v === undefined ? null : v;
}

function bool(key) {
  return String(get(key)) === '1' || String(get(key)) === 'true';
}

function set(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue; // 只允许已知配置项
    upsert.run(k, v === null || v === undefined ? '' : String(v));
  }
  return all();
}

module.exports = { all, get, set, bool, DEFAULTS };
