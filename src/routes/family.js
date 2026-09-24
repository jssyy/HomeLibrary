/** 家庭：创建、邀请加入、成员账号管理、转让、退出、解散 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, newInviteCode } = require('../db');
const auth = require('../auth');
const family = require('../family');
const { wrap, str, int } = require('../util');

const router = express.Router();

const joinByIp = auth.rateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

function requireOwner(req, res, next) {
  if (!auth.isFamilyOwner(req)) return res.status(403).json({ error: '只有家庭创建者能做这个操作' });
  next();
}

function familyPayload(req) {
  const fam = family.familyById(req.familyId);
  const isOwner = fam.owner_id === req.user.id;
  const accounts = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.email_verified, m.id AS member_id, m.emoji, m.color
         FROM users u LEFT JOIN members m ON m.family_id = u.family_id AND m.user_id = u.id
        WHERE u.family_id = ? ORDER BY u.id`
    )
    .all(fam.id)
    .map((a) => ({ ...a, email_verified: !!a.email_verified, is_owner: a.id === fam.owner_id, is_me: a.id === req.user.id }));
  return {
    id: fam.id,
    name: fam.name,
    is_owner: isOwner,
    // 家里人都能看到邀请码，方便拉人；只有创建者能重置
    invite_code: fam.invite_code,
    created_at: fam.created_at,
    accounts,
  };
}

router.get(
  '/family',
  auth.requireFamily,
  wrap((req, res) => res.json(familyPayload(req)))
);

router.post(
  '/family',
  auth.requireUser,
  wrap((req, res) => {
    if (req.familyId) return res.status(409).json({ error: '你已经在一个家庭里了，先退出才能新建' });
    const name = str((req.body || {}).name);
    if (!name) return res.status(400).json({ error: '给家庭起个名字吧' });
    if (name.length > 30) return res.status(400).json({ error: '名字最多 30 个字' });
    req.familyId = family.createFamily(req.user, name);
    res.status(201).json(familyPayload(req));
  })
);

/** 预览邀请码对应的家庭（加入前确认一下是不是找对了） */
router.get(
  '/family/invite/:code',
  auth.requireUser,
  wrap((req, res) => {
    if (!joinByIp(auth.clientIp(req))) return res.status(429).json({ error: '试得太频繁了，歇一会儿再来' });
    const fam = family.familyByInvite(req.params.code);
    if (!fam) return res.status(404).json({ error: '邀请码不对，找家里人再确认一下' });
    const count = db.prepare('SELECT COUNT(*) AS c FROM users WHERE family_id = ?').get(fam.id).c;
    res.json({ name: fam.name, member_count: count });
  })
);

router.post(
  '/family/join',
  auth.requireUser,
  wrap((req, res) => {
    if (!joinByIp(auth.clientIp(req))) return res.status(429).json({ error: '试得太频繁了，歇一会儿再来' });
    if (req.familyId) return res.status(409).json({ error: '你已经在一个家庭里了，先退出才能加入别的家庭' });
    const fam = family.familyByInvite((req.body || {}).code);
    if (!fam) return res.status(404).json({ error: '邀请码不对，找家里人再确认一下' });
    family.attachUser(req.user, fam.id);
    req.familyId = fam.id;
    res.json(familyPayload(req));
  })
);

router.put(
  '/family',
  auth.requireFamily,
  requireOwner,
  wrap((req, res) => {
    const name = str((req.body || {}).name);
    if (!name) return res.status(400).json({ error: '名字不能为空' });
    if (name.length > 30) return res.status(400).json({ error: '名字最多 30 个字' });
    db.prepare('UPDATE families SET name = ? WHERE id = ?').run(name, req.familyId);
    res.json(familyPayload(req));
  })
);

/** 邀请码泄露了就换一个，旧的立即失效 */
router.post(
  '/family/invite/reset',
  auth.requireFamily,
  requireOwner,
  wrap((req, res) => {
    db.prepare('UPDATE families SET invite_code = ? WHERE id = ?').run(newInviteCode(), req.familyId);
    res.json(familyPayload(req));
  })
);

/** 把某个账号移出家庭（他的阅读记录保留，成员档案停用） */
router.delete(
  '/family/accounts/:userId',
  auth.requireFamily,
  requireOwner,
  wrap((req, res) => {
    const userId = int(req.params.userId);
    if (userId === req.user.id) return res.status(400).json({ error: '不能移出自己，要走请用「退出家庭」' });
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND family_id = ?').get(userId, req.familyId);
    if (!u) return res.status(404).json({ error: '这个人不在家庭里' });
    family.detachUser(userId, req.familyId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // 立刻失去访问权限
    res.json(familyPayload(req));
  })
);

router.post(
  '/family/transfer',
  auth.requireFamily,
  requireOwner,
  wrap((req, res) => {
    const userId = int((req.body || {}).user_id);
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND family_id = ?').get(userId, req.familyId);
    if (!u || userId === req.user.id) return res.status(400).json({ error: '选一位家里的其他成员' });
    db.prepare('UPDATE families SET owner_id = ? WHERE id = ?').run(userId, req.familyId);
    res.json(familyPayload(req));
  })
);

router.post(
  '/family/leave',
  auth.requireFamily,
  wrap((req, res) => {
    if (auth.isFamilyOwner(req)) {
      const others = db.prepare('SELECT COUNT(*) AS c FROM users WHERE family_id = ? AND id <> ?').get(req.familyId, req.user.id).c;
      return res.status(400).json({
        error: others
          ? '你是家庭创建者，先把家庭转让给其他成员再退出'
          : '你是家里唯一的成员，退出等于解散家庭，请用「解散家庭」',
      });
    }
    family.detachUser(req.user.id, req.familyId);
    res.json({ ok: true });
  })
);

/** 解散：只有创建者、且家里只剩自己时可以；书、购买记录、电子书全部删除 */
router.delete(
  '/family',
  auth.requireFamily,
  requireOwner,
  wrap((req, res) => {
    const fam = family.familyById(req.familyId);
    if (str((req.body || {}).confirm) !== fam.name) {
      return res.status(400).json({ error: '请输入家庭名字确认解散' });
    }
    const others = db.prepare('SELECT COUNT(*) AS c FROM users WHERE family_id = ? AND id <> ?').get(fam.id, req.user.id).c;
    if (others) return res.status(400).json({ error: '家里还有其他成员，先把他们移出或把家庭转让出去' });

    const files = db
      .prepare('SELECT f.path FROM files f JOIN books b ON b.id = f.book_id WHERE b.family_id = ?')
      .all(fam.id);
    db.prepare('UPDATE users SET family_id = NULL WHERE family_id = ?').run(fam.id);
    db.prepare('DELETE FROM families WHERE id = ?').run(fam.id); // 书、成员、阅读、购买级联删除
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(config.FILES_DIR, f.path));
      } catch {
        /* 已经不在了 */
      }
    }
    res.json({ ok: true });
  })
);

module.exports = router;
