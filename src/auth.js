/**
 * 账号体系的底层：密码哈希、会话、一次性令牌、中间件、限流。
 * 只用 node 自带的 crypto，不引额外依赖。
 */
const crypto = require('crypto');
const { db } = require('./db');
const config = require('./config');

const COOKIE = 'hl_sid';

// ------------------------------------------------------------------ 密码

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

/** 返回错误提示；合格返回 null */
function checkPassword(password) {
  const s = String(password || '');
  if (s.length < 8) return '密码至少 8 位';
  if (s.length > 128) return '密码太长了';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return '密码需要同时包含字母和数字';
  return null;
}

function normalizeEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : null;
}

// ------------------------------------------------------------------ 令牌

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

/** 一次性令牌（重置密码 / 验证邮箱）：库里只存哈希，同用途的旧令牌作废 */
function issueToken(userId, purpose, ttlMs) {
  const token = randomToken();
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare('INSERT INTO auth_tokens (id, user_id, purpose, expires_at) VALUES (?,?,?,?)').run(
    sha256(token), userId, purpose, Date.now() + ttlMs
  );
  return token;
}

/** 核销令牌：有效就返回 user_id 并标记已用，否则 null */
function consumeToken(token, purpose) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM auth_tokens WHERE id = ? AND purpose = ?').get(sha256(token), purpose);
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  db.prepare("UPDATE auth_tokens SET used_at = datetime('now','localtime') WHERE id = ?").run(row.id);
  return row.user_id;
}

function peekToken(token, purpose) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM auth_tokens WHERE id = ? AND purpose = ?').get(sha256(token), purpose);
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  return row.user_id;
}

// ------------------------------------------------------------------ 会话

function createSession(res, req, userId) {
  const token = randomToken();
  const maxAge = config.SESSION_DAYS * 24 * 3600 * 1000;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?,?,?,?)').run(
    sha256(token), userId, Date.now() + maxAge, String(req.headers['user-agent'] || '').slice(0, 200)
  );
  db.prepare("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?").run(userId);
  setCookie(res, req, token, Math.floor(maxAge / 1000));
}

function setCookie(res, req, value, maxAgeSec) {
  const secure = req.secure; // 反向代理后面需要设置 HL_TRUST_PROXY 才准
  res.append(
    'Set-Cookie',
    `${COOKIE}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

function readCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

function destroySession(req, res) {
  const token = readCookie(req);
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
  setCookie(res, req, '', 0);
}

/** 让某个用户的所有会话失效（改密码、重置密码后用），可保留当前这一个 */
function revokeSessions(userId, exceptReq) {
  const keep = exceptReq ? readCookie(exceptReq) : null;
  if (keep) db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, sha256(keep));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

let lastSweep = 0;
function sweepExpired() {
  if (Date.now() - lastSweep < 3600 * 1000) return;
  lastSweep = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(Date.now() - 24 * 3600 * 1000);
}

/** 解析会话，挂到 req.user / req.familyId / req.memberId 上；不拦截 */
function loadUser(req, res, next) {
  sweepExpired();
  const token = readCookie(req);
  if (!token) return next();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.email_verified, u.is_admin, u.family_id, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    )
    .get(sha256(token));
  if (!row || row.expires_at < Date.now()) return next();
  delete row.expires_at;
  req.user = row;
  req.familyId = row.family_id || null;
  if (req.familyId) {
    const m = db.prepare('SELECT id FROM members WHERE family_id = ? AND user_id = ?').get(req.familyId, row.id);
    req.memberId = m ? m.id : null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
  next();
}

function requireFamily(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
  if (!req.familyId) return res.status(403).json({ error: '还没加入家庭', code: 'FAMILY_REQUIRED' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
  if (!req.user.is_admin) return res.status(403).json({ error: '只有站点管理员能改这项设置' });
  next();
}

function isFamilyOwner(req) {
  if (!req.familyId) return false;
  const f = db.prepare('SELECT owner_id FROM families WHERE id = ?').get(req.familyId);
  return !!f && f.owner_id === req.user.id;
}

// ------------------------------------------------------------------ 限流

/**
 * 极简的内存滑动窗口限流，防暴力破解和刷邮件。
 * 单进程部署够用；重启清零无所谓。
 */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }, windowMs).unref();

  return function hit(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= max;
  };
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** 邮件里链接的站点地址 */
function publicOrigin(req) {
  if (config.PUBLIC_URL) return config.PUBLIC_URL;
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = {
  hashPassword, verifyPassword, checkPassword, normalizeEmail,
  issueToken, consumeToken, peekToken,
  createSession, destroySession, revokeSessions,
  loadUser, requireUser, requireFamily, requireAdmin, isFamilyOwner,
  rateLimiter, clientIp, publicOrigin,
};
