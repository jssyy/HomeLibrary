/** 家庭相关的公共操作：建家庭、入家庭、退家庭。路由和注册流程都要用 */
const { db, tx, newInviteCode } = require('./db');

const COLORS = ['#4f8cff', '#e0703a', '#2fa36b', '#b05cc9', '#d4a017', '#e05a7a', '#3aa6b9'];

function familyById(id) {
  return id ? db.prepare('SELECT * FROM families WHERE id = ?').get(id) : null;
}

function familyByInvite(code) {
  const c = String(code || '').trim().toUpperCase();
  return c ? db.prepare('SELECT * FROM families WHERE invite_code = ?').get(c) : null;
}

/** 给家庭挑一个没被用过的称呼，重名就加后缀 */
function uniqueMemberName(familyId, name, exceptId = 0) {
  let candidate = name;
  for (let i = 2; db.prepare('SELECT 1 FROM members WHERE family_id = ? AND name = ? AND id <> ?').get(familyId, candidate, exceptId); i++) {
    candidate = `${name}${i}`;
  }
  return candidate;
}

/**
 * 把账号放进家庭：关联（或新建）一条成员档案，并给家里所有书补上这个人的阅读记录。
 * 之前退出过又回来的，沿用原来的档案，阅读记录都还在。
 */
function attachUser(user, familyId) {
  return tx(() => {
    db.prepare('UPDATE users SET family_id = ? WHERE id = ?').run(familyId, user.id);

    let member = db.prepare('SELECT * FROM members WHERE family_id = ? AND user_id = ?').get(familyId, user.id);
    if (member) {
      db.prepare('UPDATE members SET active = 1 WHERE id = ?').run(member.id);
    } else {
      const stats = db
        .prepare('SELECT IFNULL(MAX(sort_order),0) AS maxOrder, COUNT(*) AS c FROM members WHERE family_id = ?')
        .get(familyId);
      const info = db
        .prepare('INSERT INTO members (family_id, user_id, name, emoji, color, sort_order) VALUES (?,?,?,?,?,?)')
        .run(familyId, user.id, uniqueMemberName(familyId, user.name), '📖', COLORS[stats.c % COLORS.length], stats.maxOrder + 1);
      member = { id: Number(info.lastInsertRowid) };
    }
    db.prepare(
      `INSERT OR IGNORE INTO readings (book_id, member_id, status)
       SELECT id, ?, '待读' FROM books WHERE family_id = ?`
    ).run(member.id, familyId);
    return member.id;
  });
}

function createFamily(user, name) {
  const familyId = tx(() => {
    const info = db
      .prepare('INSERT INTO families (name, owner_id, invite_code) VALUES (?,?,?)')
      .run(name, user.id, newInviteCode());
    return Number(info.lastInsertRowid);
  });
  attachUser(user, familyId);
  return familyId;
}

/**
 * 单机版升级上来的「待认领」家庭：第一个注册的人成为主人，
 * 并接管原来没有账号的第一个成员档案（通常就是原来的「我」），阅读记录原样保留。
 */
function claimOrphanFamily(user) {
  const fam = db.prepare('SELECT * FROM families WHERE owner_id IS NULL ORDER BY id LIMIT 1').get();
  if (!fam) return null;
  tx(() => {
    db.prepare('UPDATE families SET owner_id = ? WHERE id = ?').run(user.id, fam.id);
    const spare = db
      .prepare('SELECT id FROM members WHERE family_id = ? AND user_id IS NULL ORDER BY sort_order, id LIMIT 1')
      .get(fam.id);
    if (spare) db.prepare('UPDATE members SET user_id = ? WHERE id = ?').run(user.id, spare.id);
  });
  attachUser(user, fam.id);
  return fam.id;
}

/** 离开家庭：档案停用但保留（历史阅读记录、笔记署名还在），回来时恢复 */
function detachUser(userId, familyId) {
  tx(() => {
    db.prepare('UPDATE users SET family_id = NULL WHERE id = ? AND family_id = ?').run(userId, familyId);
    db.prepare('UPDATE members SET active = 0 WHERE family_id = ? AND user_id = ?').run(familyId, userId);
  });
}

module.exports = { familyById, familyByInvite, attachUser, createFamily, claimOrphanFamily, detachUser, uniqueMemberName };
