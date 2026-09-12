const BOOK_FIELDS = [
  'isbn13', 'isbn10', 'title', 'subtitle', 'original_title', 'author', 'translator',
  'publisher', 'pub_date', 'pages', 'list_price', 'category', 'tags', 'series', 'volume',
  'language', 'summary', 'carrier', 'location', 'cover_url', 'cover_path',
  'source', 'source_url', 'ext_rating', 'ext_rating_count', 'owned', 'archived',
];

const STATUSES = ['待读', '在读', '已读', '弃读'];
const CARRIERS = ['纸质书', '电子书', '有声书'];
const CHANNELS = ['京东', '当当', '淘宝/天猫', '拼多多', '多抓鱼', '孔夫子', '实体书店', '微信读书', 'Kindle', '赠送', '其他'];

/** express 异步路由包装，省掉满屏 try/catch */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v, dflt = null) {
  const n = num(v);
  return n === null ? dflt : Math.trunc(n);
}

function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function today() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function now() {
  return `${today()} ${new Date().toTimeString().slice(0, 8)}`;
}

/** 把 undefined/空串统一成 null，方便写库 */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === '' || v === undefined ? null : v;
  return out;
}

/** 生成 UPDATE 的 SET 片段 */
function setClause(obj) {
  const keys = Object.keys(obj);
  return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => obj[k]) };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = {
  BOOK_FIELDS, STATUSES, CARRIERS, CHANNELS,
  wrap, pick, num, int, str, today, now, clean, setClause, csvEscape,
};
