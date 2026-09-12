/** 书籍：列表 / 详情 / 新增（含扫码录入）/ 修改 / 删除 / 购买记录 */
const express = require('express');
const { db, ensureReadings, tx } = require('../db');
const meta = require('../services/metadata');
const zlibrary = require('../services/zlibrary');
const { wrap, pick, str, num, int, today, BOOK_FIELDS, clean, setClause } = require('../util');
const isbnUtil = require('../services/isbn');

const router = express.Router();

// ------------------------------------------------------------------ 查询组装

const LIST_SORTS = {
  new: 'b.created_at DESC, b.id DESC',
  title: 'b.title COLLATE NOCASE ASC',
  author: 'b.author COLLATE NOCASE ASC',
  pub: 'b.pub_date DESC',
  price: 'b.list_price DESC',
  rating: 'b.ext_rating DESC',
};

function attachRelations(books) {
  if (!books.length) return books;
  const ids = books.map((b) => b.id);
  const ph = ids.map(() => '?').join(',');

  const readings = db
    .prepare(
      `SELECT r.*, m.name AS member_name, m.emoji, m.color
         FROM readings r JOIN members m ON m.id = r.member_id
        WHERE r.book_id IN (${ph}) AND m.active = 1
        ORDER BY m.sort_order, m.id`
    )
    .all(...ids);

  const purchases = db
    .prepare(
      `SELECT p.*, m.name AS buyer_name
         FROM purchases p LEFT JOIN members m ON m.id = p.buyer_id
        WHERE p.book_id IN (${ph})
        ORDER BY p.purchased_at DESC, p.id DESC`
    )
    .all(...ids);

  const files = db.prepare(`SELECT * FROM files WHERE book_id IN (${ph}) ORDER BY id`).all(...ids);
  const noteCounts = db
    .prepare(`SELECT book_id, COUNT(*) AS c FROM notes WHERE book_id IN (${ph}) GROUP BY book_id`)
    .all(...ids);

  const byId = new Map(books.map((b) => [b.id, b]));
  for (const b of books) {
    b.readings = [];
    b.purchases = [];
    b.files = [];
    b.note_count = 0;
  }
  for (const r of readings) byId.get(r.book_id)?.readings.push(r);
  for (const p of purchases) byId.get(p.book_id)?.purchases.push(p);
  for (const f of files) byId.get(f.book_id)?.files.push(f);
  for (const n of noteCounts) {
    const b = byId.get(n.book_id);
    if (b) b.note_count = n.c;
  }
  for (const b of books) {
    b.spend = b.purchases.reduce((s, p) => s + (p.price || 0) * (p.quantity || 1), 0);
    b.bought_at = b.purchases.length ? b.purchases[0].purchased_at : null;
    b.has_ebook = b.files.length > 0;
  }
  return books;
}

/** GET /api/books —— 书架列表，支持搜索/筛选/排序/分页 */
router.get(
  '/books',
  wrap((req, res) => {
    const q = str(req.query.q);
    const where = [];
    const args = [];

    if (q) {
      where.push(
        '(b.title LIKE ? OR b.subtitle LIKE ? OR b.author LIKE ? OR b.publisher LIKE ? OR b.isbn13 LIKE ? OR b.tags LIKE ? OR b.series LIKE ? OR b.volume LIKE ?)'
      );
      const like = `%${q}%`;
      args.push(like, like, like, like, like, like, like, like);
    }
    for (const [field, value] of [
      ['carrier', req.query.carrier],
      ['category', req.query.category],
      ['location', req.query.location],
    ]) {
      const v = str(value);
      if (v) {
        where.push(`b.${field} = ?`);
        args.push(v);
      }
    }
    const tag = str(req.query.tag);
    if (tag) {
      where.push("(',' || IFNULL(b.tags,'') || ',') LIKE ?");
      args.push(`%,${tag},%`);
    }
    where.push('b.archived = ?', 'b.owned = ?');
    args.push(int(req.query.archived, 0), int(req.query.owned, 1));

    // 按成员阅读状态筛选
    const memberId = int(req.query.member);
    const status = str(req.query.status);
    if (memberId && status) {
      where.push('EXISTS (SELECT 1 FROM readings r WHERE r.book_id = b.id AND r.member_id = ? AND r.status = ?)');
      args.push(memberId, status);
    } else if (memberId) {
      where.push('EXISTS (SELECT 1 FROM readings r WHERE r.book_id = b.id AND r.member_id = ? AND r.status <> ?)');
      args.push(memberId, '待读');
    } else if (status) {
      where.push('EXISTS (SELECT 1 FROM readings r WHERE r.book_id = b.id AND r.status = ?)');
      args.push(status);
    }
    if (str(req.query.ebook) === '1') where.push('EXISTS (SELECT 1 FROM files f WHERE f.book_id = b.id)');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = LIST_SORTS[str(req.query.sort) || 'new'] || LIST_SORTS.new;
    const size = Math.min(Math.max(int(req.query.size, 24), 1), 200);
    const page = Math.max(int(req.query.page, 1), 1);

    const total = db.prepare(`SELECT COUNT(*) AS c FROM books b ${whereSql}`).get(...args).c;
    const items = db
      .prepare(`SELECT b.* FROM books b ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, size, (page - 1) * size);

    res.json({ items: attachRelations(items), total, page, size, pages: Math.ceil(total / size) });
  })
);

/** 书架侧边栏用的分面统计 */
router.get(
  '/books/facets',
  wrap((req, res) => {
    const rows = (sql) => db.prepare(sql).all();
    res.json({
      carriers: rows(
        "SELECT carrier AS value, COUNT(*) AS count FROM books WHERE archived=0 AND owned=1 AND carrier IS NOT NULL GROUP BY carrier ORDER BY count DESC"
      ),
      categories: rows(
        "SELECT category AS value, COUNT(*) AS count FROM books WHERE archived=0 AND owned=1 AND category<>'' AND category IS NOT NULL GROUP BY category ORDER BY count DESC LIMIT 40"
      ),
      locations: rows(
        "SELECT location AS value, COUNT(*) AS count FROM books WHERE archived=0 AND owned=1 AND location<>'' AND location IS NOT NULL GROUP BY location ORDER BY count DESC LIMIT 40"
      ),
      tags: (() => {
        const counter = new Map();
        for (const r of db.prepare("SELECT tags FROM books WHERE tags IS NOT NULL AND tags<>''").all()) {
          for (const t of String(r.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
            counter.set(t, (counter.get(t) || 0) + 1);
          }
        }
        return [...counter.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 40);
      })(),
    });
  })
);

/** GET /api/books/by-isbn/:isbn —— 本地同 ISBN 的所有书（套装分册） */
router.get(
  '/books/by-isbn/:isbn',
  wrap((req, res) => {
    const isbn = isbnUtil.to13(req.params.isbn) || req.params.isbn;
    const items = db.prepare('SELECT * FROM books WHERE isbn13 = ? ORDER BY volume, id').all(isbn);
    res.json({ isbn, items: attachRelations(items) });
  })
);

/** GET /api/books/:id —— 详情，含阅读情况、购买记录、笔记、电子书文件、外部链接 */
router.get(
  '/books/:id',
  wrap((req, res) => {
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(int(req.params.id));
    if (!book) return res.status(404).json({ error: '书不存在' });
    ensureReadings(book.id);
    attachRelations([book]);
    book.notes = db
      .prepare(
        `SELECT n.*, m.name AS member_name, m.emoji FROM notes n
         LEFT JOIN members m ON m.id = n.member_id
         WHERE n.book_id = ? ORDER BY n.created_at DESC, n.id DESC`
      )
      .all(book.id);
    book.logs = db
      .prepare(
        `SELECT l.*, m.name AS member_name, m.emoji FROM reading_logs l
         LEFT JOIN members m ON m.id = l.member_id
         WHERE l.book_id = ? ORDER BY l.log_date DESC, l.id DESC LIMIT 50`
      )
      .all(book.id);
    // 套装书：同 ISBN 的其它分册
    book.siblings = book.isbn13
      ? db
          .prepare(
            `SELECT id, title, volume, series, cover_path, cover_url FROM books
              WHERE isbn13 = ? AND id <> ? ORDER BY volume, id`
          )
          .all(book.isbn13, book.id)
      : [];
    book.external_links = zlibrary.links(book);
    res.json(book);
  })
);

// ------------------------------------------------------------------ 新增/修改

function normalizeBookInput(body) {
  const data = pick(body, BOOK_FIELDS);
  if (data.isbn13) {
    const v = isbnUtil.to13(data.isbn13);
    if (v) {
      data.isbn13 = v;
      data.isbn10 = data.isbn10 || isbnUtil.to10(v);
    }
  }
  for (const f of ['pages', 'ext_rating_count', 'owned', 'archived']) {
    if (data[f] !== undefined) data[f] = int(data[f]);
  }
  for (const f of ['list_price', 'ext_rating']) {
    if (data[f] !== undefined) data[f] = num(data[f]);
  }
  if (data.tags !== undefined && data.tags !== null) {
    data.tags = String(data.tags)
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(',');
  }
  return clean(data);
}

/** POST /api/books —— 录入一本书（扫码/搜索/手工都走这里） */
router.post(
  '/books',
  wrap(async (req, res) => {
    const body = req.body || {};
    const data = normalizeBookInput(body);
    if (!data.title) return res.status(400).json({ error: '书名必填' });

    // 查重：同 ISBN 未必是同一本书——套装书整套共用一个 ISBN，每册书名不同。
    // 所以这里只是提醒，把已有的同 ISBN 书都返回给前端，由用户决定是打开旧的还是当新分册录入。
    if (data.isbn13 && !body.force) {
      const dups = db.prepare('SELECT * FROM books WHERE isbn13 = ? ORDER BY id').all(data.isbn13);
      if (dups.length) {
        attachRelations(dups);
        const sameTitle = dups.find((d) => d.title === data.title);
        return res.status(409).json({
          error: sameTitle
            ? '这本书已经在书库里了'
            : `书库里已有 ${dups.length} 本同 ISBN 的书（可能是套装的其它分册）`,
          duplicate: sameTitle || dups[0],
          duplicates: dups,
          same_title: !!sameTitle,
        });
      }
    }

    // 封面落到本地，断网也能看
    if (data.cover_url && !data.cover_path) {
      data.cover_path = await meta.cacheCover(data.cover_url, data.isbn13 || data.title);
    }

    const result = tx(() => {
      const keys = Object.keys(data);
      const info = db
        .prepare(
          `INSERT INTO books (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        )
        .run(...keys.map((k) => data[k]));
      const bookId = Number(info.lastInsertRowid);
      ensureReadings(bookId);

      // 一并写入购买记录
      const p = body.purchase;
      if (p && (p.purchased_at || p.price || p.channel)) {
        db.prepare(
          `INSERT INTO purchases (book_id, purchased_at, channel, price, quantity, buyer_id, note)
           VALUES (?,?,?,?,?,?,?)`
        ).run(
          bookId,
          str(p.purchased_at) || today(),
          str(p.channel),
          num(p.price),
          int(p.quantity, 1),
          int(p.buyer_id),
          str(p.note)
        );
      }
      // 一并写入各成员阅读状态
      for (const r of body.readings || []) {
        const memberId = int(r.member_id);
        if (!memberId) continue;
        db.prepare(
          `UPDATE readings SET status = ?, progress = ?, updated_at = datetime('now','localtime')
            WHERE book_id = ? AND member_id = ?`
        ).run(str(r.status) || '待读', num(r.progress) || 0, bookId, memberId);
      }
      return bookId;
    });

    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(result);
    attachRelations([book]);
    res.status(201).json(book);
  })
);

/** PUT /api/books/:id */
router.put(
  '/books/:id',
  wrap(async (req, res) => {
    const id = int(req.params.id);
    const exists = db.prepare('SELECT id, cover_path FROM books WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: '书不存在' });

    const data = normalizeBookInput(req.body || {});
    if (data.cover_url && data.cover_url !== req.body.__old_cover_url && !data.cover_path) {
      data.cover_path = (await meta.cacheCover(data.cover_url, data.isbn13 || data.title)) || exists.cover_path;
    }
    if (!Object.keys(data).length) return res.json(db.prepare('SELECT * FROM books WHERE id=?').get(id));

    const { sql, values } = setClause(data);
    db.prepare(`UPDATE books SET ${sql}, updated_at = datetime('now','localtime') WHERE id = ?`).run(
      ...values,
      id
    );
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
    attachRelations([book]);
    res.json(book);
  })
);

/** DELETE /api/books/:id */
router.delete(
  '/books/:id',
  wrap((req, res) => {
    const id = int(req.params.id);
    const info = db.prepare('DELETE FROM books WHERE id = ?').run(id);
    res.json({ deleted: Number(info.changes) });
  })
);

/** 重新抓取元数据（比如当初扫码时网络不通） */
router.post(
  '/books/:id/refresh',
  wrap(async (req, res) => {
    const id = int(req.params.id);
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
    if (!book) return res.status(404).json({ error: '书不存在' });

    const query = book.isbn13 || `${book.title} ${book.author || ''}`.trim();
    const { results, errors } = await meta.lookup(query);
    if (!results.length) return res.status(502).json({ error: '没查到书目信息', errors });

    const best = meta.merge(results.slice(0, 3));
    const patch = {};
    for (const f of ['subtitle', 'author', 'translator', 'publisher', 'pub_date', 'pages', 'category', 'summary', 'language', 'ext_rating', 'ext_rating_count', 'source_url']) {
      if (!book[f] && best[f]) patch[f] = best[f];
    }
    if (!book.cover_path && best.cover_url) {
      patch.cover_url = best.cover_url;
      patch.cover_path = await meta.cacheCover(best.cover_url, book.isbn13 || book.title);
    }
    if (Object.keys(patch).length) {
      const { sql, values } = setClause(patch);
      db.prepare(`UPDATE books SET ${sql}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...values, id);
    }
    const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
    attachRelations([updated]);
    res.json({ book: updated, patched: Object.keys(patch), errors });
  })
);

// ------------------------------------------------------------------ 购买记录

router.post(
  '/books/:id/purchases',
  wrap((req, res) => {
    const bookId = int(req.params.id);
    const p = req.body || {};
    const info = db
      .prepare(
        `INSERT INTO purchases (book_id, purchased_at, channel, price, quantity, buyer_id, note)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        bookId,
        str(p.purchased_at) || today(),
        str(p.channel),
        num(p.price),
        int(p.quantity, 1),
        int(p.buyer_id),
        str(p.note)
      );
    res.status(201).json(db.prepare('SELECT * FROM purchases WHERE id = ?').get(Number(info.lastInsertRowid)));
  })
);

router.put(
  '/purchases/:id',
  wrap((req, res) => {
    const id = int(req.params.id);
    const p = req.body || {};
    db.prepare(
      `UPDATE purchases SET purchased_at=?, channel=?, price=?, quantity=?, buyer_id=?, note=? WHERE id=?`
    ).run(
      str(p.purchased_at),
      str(p.channel),
      num(p.price),
      int(p.quantity, 1),
      int(p.buyer_id),
      str(p.note),
      id
    );
    res.json(db.prepare('SELECT * FROM purchases WHERE id = ?').get(id));
  })
);

router.delete(
  '/purchases/:id',
  wrap((req, res) => {
    const info = db.prepare('DELETE FROM purchases WHERE id = ?').run(int(req.params.id));
    res.json({ deleted: Number(info.changes) });
  })
);

/** 最近购买流水（购书记录页） */
router.get(
  '/purchases',
  wrap((req, res) => {
    const where = [];
    const args = [];
    const year = str(req.query.year);
    if (year) {
      where.push("strftime('%Y', p.purchased_at) = ?");
      args.push(year);
    }
    const buyer = int(req.query.buyer);
    if (buyer) {
      where.push('p.buyer_id = ?');
      args.push(buyer);
    }
    const channel = str(req.query.channel);
    if (channel) {
      where.push('p.channel = ?');
      args.push(channel);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(int(req.query.limit, 200), 1000);
    const rows = db
      .prepare(
        `SELECT p.*, b.title, b.author, b.cover_path, b.cover_url, b.isbn13, m.name AS buyer_name, m.emoji
           FROM purchases p
           JOIN books b ON b.id = p.book_id
           LEFT JOIN members m ON m.id = p.buyer_id
           ${whereSql}
          ORDER BY p.purchased_at DESC, p.id DESC LIMIT ?`
      )
      .all(...args, limit);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS count, IFNULL(SUM(p.price * IFNULL(p.quantity,1)),0) AS amount
           FROM purchases p JOIN books b ON b.id = p.book_id ${whereSql}`
      )
      .get(...args);
    res.json({ items: rows, ...totals });
  })
);

module.exports = router;
