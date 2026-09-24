/** 家庭成员、阅读状态、阅读打卡、读书笔记 */
const express = require('express');
const { db, ensureReadings } = require('../db');
const { wrap, str, num, int, today, STATUSES } = require('../util');
const { bookOf, memberOf, memberIdOrNull, childOf, notFound } = require('../scope');

const router = express.Router();

// ------------------------------------------------------------------ 成员

router.get(
  '/members',
  wrap((req, res) => {
    const members = db
      .prepare(
        `SELECT m.*, (u.id IS NOT NULL) AS has_account FROM members m
           LEFT JOIN users u ON u.id = m.user_id AND u.family_id = m.family_id
          WHERE m.family_id = ? ORDER BY m.sort_order, m.id`
      )
      .all(req.familyId)
      .map((m) => {
        m.has_account = !!m.has_account;
        m.is_me = m.user_id === req.user.id;
        const counts = db
          .prepare(
            `SELECT status, COUNT(*) AS c FROM readings WHERE member_id = ? GROUP BY status`
          )
          .all(m.id);
        m.counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
        for (const c of counts) m.counts[c.status] = c.c;
        return m;
      });
    res.json(members);
  })
);

router.post(
  '/members',
  wrap((req, res) => {
    const b = req.body || {};
    const name = str(b.name);
    if (!name) return res.status(400).json({ error: '名字必填' });
    if (db.prepare('SELECT id FROM members WHERE family_id = ? AND name = ?').get(req.familyId, name)) {
      return res.status(409).json({ error: '这个名字已经有了' });
    }
    const maxOrder = db.prepare('SELECT IFNULL(MAX(sort_order),0) AS m FROM members WHERE family_id = ?').get(req.familyId).m;
    const info = db
      .prepare('INSERT INTO members (family_id, name, emoji, color, sort_order) VALUES (?,?,?,?,?)')
      .run(req.familyId, name, str(b.emoji) || '📖', str(b.color) || '#4f8cff', maxOrder + 1);
    const id = Number(info.lastInsertRowid);
    // 新成员对家里已有的书默认「待读」
    db.prepare(
      `INSERT OR IGNORE INTO readings (book_id, member_id, status) SELECT id, ?, '待读' FROM books WHERE family_id = ?`
    ).run(id, req.familyId);
    res.status(201).json(db.prepare('SELECT * FROM members WHERE id = ?').get(id));
  })
);

router.put(
  '/members/:id',
  wrap((req, res) => {
    const b = req.body || {};
    const cur = memberOf(req.familyId, req.params.id);
    if (!cur) return notFound(res, '成员');
    const id = cur.id;
    const name = str(b.name) || cur.name;
    if (name !== cur.name && db.prepare('SELECT id FROM members WHERE family_id = ? AND name = ? AND id <> ?').get(req.familyId, name, id)) {
      return res.status(409).json({ error: '这个名字已经有了' });
    }
    // 关联了账号的档案，启用/停用跟着家庭成员身份走，不能手动改
    const active = cur.user_id || b.active === undefined ? cur.active : int(b.active, 1);
    db.prepare('UPDATE members SET name=?, emoji=?, color=?, sort_order=?, active=? WHERE id=?').run(
      name,
      str(b.emoji) || cur.emoji,
      str(b.color) || cur.color,
      int(b.sort_order, cur.sort_order),
      active,
      id
    );
    res.json(db.prepare('SELECT * FROM members WHERE id = ?').get(id));
  })
);

router.delete(
  '/members/:id',
  wrap((req, res) => {
    const cur = memberOf(req.familyId, req.params.id);
    if (!cur) return notFound(res, '成员');
    if (cur.user_id && db.prepare('SELECT 1 FROM users WHERE id = ? AND family_id = ?').get(cur.user_id, req.familyId)) {
      return res.status(400).json({ error: '这是家里某个账号的档案，要删请先在「家庭」里把他移出' });
    }
    const info = db.prepare('DELETE FROM members WHERE id = ?').run(cur.id);
    res.json({ deleted: Number(info.changes) });
  })
);

// ------------------------------------------------------------------ 阅读状态

/** PUT /api/books/:bookId/readings/:memberId —— 改某个人对某本书的阅读情况 */
router.put(
  '/books/:bookId/readings/:memberId',
  wrap((req, res) => {
    const book = bookOf(req.familyId, req.params.bookId);
    const member = memberOf(req.familyId, req.params.memberId);
    if (!book || !member) return notFound(res, '阅读记录');
    const bookId = book.id;
    const memberId = member.id;
    ensureReadings(bookId);
    const cur = db
      .prepare('SELECT * FROM readings WHERE book_id = ? AND member_id = ?')
      .get(bookId, memberId);
    if (!cur) return res.status(404).json({ error: '没有这条阅读记录' });

    const b = req.body || {};
    const status = str(b.status) || cur.status;
    let progress = b.progress === undefined ? cur.progress : num(b.progress);
    let startedAt = b.started_at === undefined ? cur.started_at : str(b.started_at);
    let finishedAt = b.finished_at === undefined ? cur.finished_at : str(b.finished_at);

    // 状态流转时自动补日期和进度，省得手填
    if (status === '在读' && !startedAt) startedAt = today();
    if (status === '已读') {
      if (!startedAt) startedAt = today();
      if (!finishedAt) finishedAt = today();
      if (!progress || progress < 100) progress = 100;
    }
    if (status === '待读' && b.progress === undefined) progress = 0;

    db.prepare(
      `UPDATE readings SET status=?, progress=?, location=?, started_at=?, finished_at=?,
              rating=?, review=?, updated_at=datetime('now','localtime')
        WHERE id = ?`
    ).run(
      status,
      progress || 0,
      b.location === undefined ? cur.location : str(b.location),
      startedAt,
      finishedAt,
      b.rating === undefined ? cur.rating : int(b.rating),
      b.review === undefined ? cur.review : str(b.review),
      cur.id
    );

    // 进度有变化就记一笔流水，统计和时间线要用
    if (b.log !== false && (status !== cur.status || (progress || 0) !== (cur.progress || 0))) {
      db.prepare(
        `INSERT INTO reading_logs (book_id, member_id, log_date, progress, note)
         VALUES (?,?,?,?,?)`
      ).run(bookId, memberId, today(), progress || 0, str(b.note) || (status !== cur.status ? `状态改为${status}` : null));
    }

    res.json(
      db
        .prepare(
          `SELECT r.*, m.name AS member_name, m.emoji, m.color FROM readings r
             JOIN members m ON m.id = r.member_id WHERE r.id = ?`
        )
        .get(cur.id)
    );
  })
);

/** 正在读的书（首页用） */
router.get(
  '/reading/current',
  wrap((req, res) => {
    const memberId = int(req.query.member);
    const args = [req.familyId];
    let where = "b.family_id = ? AND r.status = '在读'";
    if (memberId) {
      where += ' AND r.member_id = ?';
      args.push(memberId);
    }
    res.json(
      db
        .prepare(
          `SELECT r.*, b.title, b.author, b.cover_path, b.cover_url, b.pages,
                  m.name AS member_name, m.emoji, m.color,
                  (SELECT COUNT(*) FROM files f WHERE f.book_id = b.id) AS file_count
             FROM readings r
             JOIN books b ON b.id = r.book_id
             JOIN members m ON m.id = r.member_id
            WHERE ${where} AND b.archived = 0
            ORDER BY r.updated_at DESC LIMIT 30`
        )
        .all(...args)
    );
  })
);

// ------------------------------------------------------------------ 打卡流水

router.post(
  '/books/:bookId/logs',
  wrap((req, res) => {
    const b = req.body || {};
    const book = bookOf(req.familyId, req.params.bookId);
    if (!book) return notFound(res);
    const bookId = book.id;
    const memberId = memberIdOrNull(req.familyId, b.member_id);
    if (!memberId) return res.status(400).json({ error: '要选一位成员' });
    const info = db
      .prepare(
        `INSERT INTO reading_logs (book_id, member_id, log_date, minutes, pages, progress, note)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(bookId, memberId, str(b.log_date) || today(), int(b.minutes), int(b.pages), num(b.progress), str(b.note));

    if (b.progress !== undefined && b.progress !== null && b.progress !== '') {
      db.prepare(
        `UPDATE readings SET progress = ?, status = CASE WHEN status = '待读' THEN '在读' ELSE status END,
                updated_at = datetime('now','localtime')
          WHERE book_id = ? AND member_id = ?`
      ).run(num(b.progress), bookId, memberId);
    }
    res.status(201).json(db.prepare('SELECT * FROM reading_logs WHERE id = ?').get(Number(info.lastInsertRowid)));
  })
);

router.delete(
  '/logs/:id',
  wrap((req, res) => {
    const cur = childOf('reading_logs', req.familyId, req.params.id);
    if (!cur) return notFound(res, '打卡记录');
    const info = db.prepare('DELETE FROM reading_logs WHERE id = ?').run(cur.id);
    res.json({ deleted: Number(info.changes) });
  })
);

// ------------------------------------------------------------------ 笔记划线

router.get(
  '/notes',
  wrap((req, res) => {
    const where = ['b.family_id = ?'];
    const args = [req.familyId];
    const bookId = int(req.query.book);
    if (bookId) {
      where.push('n.book_id = ?');
      args.push(bookId);
    }
    const memberId = int(req.query.member);
    if (memberId) {
      where.push('n.member_id = ?');
      args.push(memberId);
    }
    const q = str(req.query.q);
    if (q) {
      where.push('(n.quote LIKE ? OR n.note LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    res.json(
      db
        .prepare(
          `SELECT n.*, b.title, b.author, m.name AS member_name, m.emoji
             FROM notes n JOIN books b ON b.id = n.book_id
             LEFT JOIN members m ON m.id = n.member_id
             ${whereSql} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`
        )
        .all(...args, Math.min(int(req.query.limit, 200), 1000))
    );
  })
);

router.post(
  '/books/:bookId/notes',
  wrap((req, res) => {
    const b = req.body || {};
    const book = bookOf(req.familyId, req.params.bookId);
    if (!book) return notFound(res);
    const info = db
      .prepare(
        `INSERT INTO notes (book_id, member_id, chapter, cfi, quote, note, color)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        book.id,
        memberIdOrNull(req.familyId, b.member_id),
        str(b.chapter),
        str(b.cfi),
        str(b.quote),
        str(b.note),
        str(b.color) || 'yellow'
      );
    res.status(201).json(db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(info.lastInsertRowid)));
  })
);

router.put(
  '/notes/:id',
  wrap((req, res) => {
    const b = req.body || {};
    const cur = childOf('notes', req.familyId, req.params.id);
    if (!cur) return notFound(res, '笔记');
    const id = cur.id;
    db.prepare('UPDATE notes SET quote=?, note=?, color=?, chapter=? WHERE id=?').run(
      b.quote === undefined ? cur.quote : str(b.quote),
      b.note === undefined ? cur.note : str(b.note),
      str(b.color) || cur.color,
      b.chapter === undefined ? cur.chapter : str(b.chapter),
      id
    );
    res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
  })
);

router.delete(
  '/notes/:id',
  wrap((req, res) => {
    const cur = childOf('notes', req.familyId, req.params.id);
    if (!cur) return notFound(res, '笔记');
    const info = db.prepare('DELETE FROM notes WHERE id = ?').run(cur.id);
    res.json({ deleted: Number(info.changes) });
  })
);

module.exports = router;
