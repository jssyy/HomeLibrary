/** 账号：注册、登录、退出、找回密码、验证邮箱、改资料 */
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const auth = require('../auth');
const mailer = require('../services/mailer');
const family = require('../family');
const { wrap, str } = require('../util');

const router = express.Router();

const RESET_TTL = 60 * 60 * 1000; // 重置链接 1 小时有效
const VERIFY_TTL = 3 * 24 * 60 * 60 * 1000; // 验证链接 3 天有效

const loginByIp = auth.rateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const loginByEmail = auth.rateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const mailByIp = auth.rateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const mailByEmail = auth.rateLimiter({ windowMs: 60 * 60 * 1000, max: 3 });
const registerByIp = auth.rateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

/**
 * 站点管理员：配了 HL_ADMIN_EMAILS 就只认名单里的邮箱；
 * 没配才让第一个注册的账号当管理员（公网上谁先注册谁就是管理员，所以公开部署建议配上）。
 */
function shouldBeAdmin(email, userCount) {
  if (config.ADMIN_EMAILS.length) return config.ADMIN_EMAILS.includes(email);
  return userCount === 0;
}

// 账号不存在时拿它跑一遍校验，免得靠响应时间判断邮箱有没有注册
const DUMMY_HASH = auth.hashPassword('dummy-password-1');

const tooMany = (res) => res.status(429).json({ error: '操作太频繁了，歇一会儿再试' });

/** 登录后前端需要的全部身份信息 */
function mePayload(userId) {
  const user = db
    .prepare('SELECT id, email, name, email_verified, is_admin, family_id, created_at FROM users WHERE id = ?')
    .get(userId);
  if (!user) return null;
  const fam = family.familyById(user.family_id);
  const member = fam
    ? db.prepare('SELECT * FROM members WHERE family_id = ? AND user_id = ?').get(fam.id, user.id)
    : null;
  const isOwner = !!fam && fam.owner_id === user.id;
  return {
    user: { ...user, email_verified: !!user.email_verified, is_admin: !!user.is_admin },
    family: fam
      ? {
          id: fam.id,
          name: fam.name,
          is_owner: isOwner,
          invite_code: fam.invite_code,
          member_count: db.prepare('SELECT COUNT(*) AS c FROM users WHERE family_id = ?').get(fam.id).c,
        }
      : null,
    member_id: member ? member.id : null,
  };
}

async function sendVerifyMail(req, user) {
  const token = auth.issueToken(user.id, 'verify', VERIFY_TTL);
  const url = `${auth.publicOrigin(req)}/login.html#verify=${token}`;
  await mailer.actionMail({
    to: user.email,
    subject: '【家庭图书馆】验证你的邮箱',
    intro: `${user.name}，欢迎加入家庭图书馆！点下面的按钮验证邮箱，之后忘记密码时就能用它找回。`,
    button: '验证邮箱',
    url,
    outro: '链接 3 天内有效。如果不是你本人注册的，忽略这封邮件即可。',
  });
}

// ------------------------------------------------------------------ 公共

/** 登录页用：是否开放注册、邀请码对应哪个家庭 */
router.get(
  '/auth/config',
  wrap((req, res) => {
    const invite = family.familyByInvite(req.query.invite);
    res.json({
      allow_register: config.ALLOW_REGISTER || db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0,
      mail_configured: mailer.isConfigured(),
      invite: invite ? { family_name: invite.name } : null,
    });
  })
);

router.get(
  '/auth/me',
  wrap((req, res) => {
    if (!req.user) return res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
    res.json(mePayload(req.user.id));
  })
);

router.post(
  '/auth/register',
  wrap(async (req, res) => {
    if (!registerByIp(auth.clientIp(req))) return tooMany(res);
    const b = req.body || {};
    const email = auth.normalizeEmail(b.email);
    const name = str(b.name);
    if (!email) return res.status(400).json({ error: '邮箱格式不对' });
    if (!name) return res.status(400).json({ error: '填一个称呼吧，家里人看到的就是它' });
    if (name.length > 20) return res.status(400).json({ error: '称呼最多 20 个字' });
    const pwErr = auth.checkPassword(b.password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const invite = family.familyByInvite(b.invite);
    if (!config.ALLOW_REGISTER && userCount > 0 && !invite) {
      return res.status(403).json({ error: '暂不开放注册，请找家里人要邀请链接' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return res.status(409).json({ error: '这个邮箱已经注册过了，直接登录或找回密码吧' });
    }

    const isAdmin = shouldBeAdmin(email, userCount);
    const info = db
      .prepare('INSERT INTO users (email, password_hash, name, is_admin) VALUES (?,?,?,?)')
      .run(email, auth.hashPassword(b.password), name, isAdmin ? 1 : 0);
    const user = { id: Number(info.lastInsertRowid), email, name };

    // 单机版升级上来的旧数据由第一个账号认领；拿着邀请链接来的直接进对应家庭
    if (userCount === 0 && !invite) family.claimOrphanFamily(user);
    else if (invite) family.attachUser(user, invite.id);

    auth.createSession(res, req, user.id);
    sendVerifyMail(req, user).catch((e) => console.error('[mail] 验证邮件发送失败：', e.message));
    res.status(201).json(mePayload(user.id));
  })
);

router.post(
  '/auth/login',
  wrap((req, res) => {
    const b = req.body || {};
    const email = auth.normalizeEmail(b.email);
    if (!loginByIp(auth.clientIp(req)) || (email && !loginByEmail(email))) return tooMany(res);
    const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    const ok = auth.verifyPassword(b.password || '', user ? user.password_hash : DUMMY_HASH) && !!user;
    if (!ok) return res.status(401).json({ error: '邮箱或密码不对' });

    // 登录页带着邀请码来、自己还没有家庭的，顺手加入
    const invite = family.familyByInvite(b.invite);
    if (invite && !user.family_id) family.attachUser(user, invite.id);

    // 后来才加进 HL_ADMIN_EMAILS 的老账号，登录时补上管理员身份
    if (!user.is_admin && config.ADMIN_EMAILS.includes(user.email)) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
    }

    auth.createSession(res, req, user.id);
    res.json(mePayload(user.id));
  })
);

router.post(
  '/auth/logout',
  wrap((req, res) => {
    auth.destroySession(req, res);
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------ 找回密码

router.post(
  '/auth/forgot',
  wrap(async (req, res) => {
    const email = auth.normalizeEmail((req.body || {}).email);
    if (!email) return res.status(400).json({ error: '邮箱格式不对' });
    if (!mailByIp(auth.clientIp(req)) || !mailByEmail(email)) return tooMany(res);

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      const token = auth.issueToken(user.id, 'reset', RESET_TTL);
      const url = `${auth.publicOrigin(req)}/login.html#reset=${token}`;
      try {
        await mailer.actionMail({
          to: user.email,
          subject: '【家庭图书馆】重置密码',
          intro: `${user.name}，有人（希望是你）申请重置家庭图书馆的登录密码。点下面的按钮设置新密码。`,
          button: '设置新密码',
          url,
          outro: '链接 1 小时内有效，只能用一次。如果不是你本人操作，忽略这封邮件即可，密码不会改变。',
        });
      } catch (e) {
        console.error('[mail] 重置邮件发送失败：', e.message);
        return res.status(502).json({ error: '邮件没发出去，请稍后再试或联系管理员' });
      }
    }
    // 不管邮箱有没有注册都回一样的话，防止被人拿来探测邮箱
    res.json({ ok: true });
  })
);

router.get(
  '/auth/reset/check',
  wrap((req, res) => {
    const userId = auth.peekToken(str(req.query.token), 'reset');
    if (!userId) return res.status(400).json({ error: '链接无效或已过期，请重新申请' });
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
    res.json({ ok: true, email: u && u.email });
  })
);

router.post(
  '/auth/reset',
  wrap((req, res) => {
    const b = req.body || {};
    const pwErr = auth.checkPassword(b.password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const userId = auth.consumeToken(str(b.token), 'reset');
    if (!userId) return res.status(400).json({ error: '链接无效或已过期，请重新申请' });

    // 能收到重置邮件，说明邮箱也是本人的
    db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(auth.hashPassword(b.password), userId);
    auth.revokeSessions(userId); // 其它设备上的登录全部失效
    auth.createSession(res, req, userId);
    res.json(mePayload(userId));
  })
);

// ------------------------------------------------------------------ 验证邮箱

router.post(
  '/auth/verify',
  wrap((req, res) => {
    const userId = auth.consumeToken(str((req.body || {}).token), 'verify');
    if (!userId) return res.status(400).json({ error: '验证链接无效或已过期，登录后可以重新发送' });
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
    res.json({ ok: true });
  })
);

router.post(
  '/auth/verify/resend',
  auth.requireUser,
  wrap(async (req, res) => {
    if (req.user.email_verified) return res.json({ ok: true, already: true });
    if (!mailByIp(auth.clientIp(req)) || !mailByEmail(req.user.email)) return tooMany(res);
    await sendVerifyMail(req, req.user);
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------ 个人资料

router.put(
  '/auth/profile',
  auth.requireUser,
  wrap((req, res) => {
    const name = str((req.body || {}).name);
    if (!name) return res.status(400).json({ error: '称呼不能为空' });
    if (name.length > 20) return res.status(400).json({ error: '称呼最多 20 个字' });
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    res.json(mePayload(req.user.id));
  })
);

router.put(
  '/auth/password',
  auth.requireUser,
  wrap((req, res) => {
    const b = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!loginByEmail(user.email)) return tooMany(res);
    if (!auth.verifyPassword(b.old_password || '', user.password_hash)) {
      return res.status(400).json({ error: '当前密码不对' });
    }
    const pwErr = auth.checkPassword(b.password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), user.id);
    auth.revokeSessions(user.id, req); // 其它设备退出，当前设备保持登录
    res.json({ ok: true });
  })
);

module.exports = router;
