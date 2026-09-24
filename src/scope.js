/**
 * 数据隔离：每个家庭只能看到、改到自己家的数据。
 * 书挂在家庭下，购买、阅读、笔记、电子书都通过书间接归属家庭。
 */
const { db } = require('./db');
const { int } = require('./util');

/** 本家庭的书，不是就返回 null */
function bookOf(familyId, bookId) {
  const id = int(bookId);
  return id ? db.prepare('SELECT * FROM books WHERE id = ? AND family_id = ?').get(id, familyId) || null : null;
}

/** 本家庭的成员档案 */
function memberOf(familyId, memberId) {
  const id = int(memberId);
  return id ? db.prepare('SELECT * FROM members WHERE id = ? AND family_id = ?').get(id, familyId) || null : null;
}

/** 表单里传来的成员 id：属于本家庭才认，否则当作未指定 */
function memberIdOrNull(familyId, v) {
  const m = memberOf(familyId, v);
  return m ? m.id : null;
}

/** 通过书判断子记录（购买、笔记、打卡、文件）是否属于本家庭 */
function childOf(table, familyId, id) {
  const rid = int(id);
  if (!rid) return null;
  return (
    db
      .prepare(`SELECT t.* FROM ${table} t JOIN books b ON b.id = t.book_id WHERE t.id = ? AND b.family_id = ?`)
      .get(rid, familyId) || null
  );
}

/** 路由里常用：找不到就回 404 */
function notFound(res, what = '书') {
  return res.status(404).json({ error: `${what}不存在` });
}

module.exports = { bookOf, memberOf, memberIdOrNull, childOf, notFound };
