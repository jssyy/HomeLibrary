/** 书目查询、Z-Library 接入、设置、统计、导入导出 */
const express = require('express');
const { db } = require('../db');
const settings = require('../settings');
const metadata = require('../services/metadata');
const zlibrary = require('../services/zlibrary');
const http = require('../services/http');
const isbnUtil = require('../services/isbn');
const { wrap, str, int, num, csvEscape, CHANNELS, CARRIERS, STATUSES } = require('../util');
const { requireAdmin } = require('../auth');

const router = express.Router();

// ------------------------------------------------------------------ 书目查询

/** GET /api/lookup?q=ISBN或关键字 —— 扫码后就调这个 */
router.get(
  '/lookup',
  wrap(async (req, res) => {
    const q = str(req.query.q);
    if (!q) return res.status(400).json({ error: '要给个 ISBN 或关键字' });
    const only = str(req.query.sources) ? String(req.query.sources).split(',') : undefined;
    const out = await metadata.lookup(q, only);

    // 本地已有的同 ISBN 书。注意套装书整套共用一个 ISBN、每册书名不同，
    // 所以这里返回全部，由前端提示「已有这些分册」而不是直接拦住。
    if (out.isbn) {
      out.existing_list = db
        .prepare('SELECT id, title, volume, author FROM books WHERE family_id = ? AND isbn13 = ? ORDER BY volume, id')
        .all(req.familyId, out.isbn);
    } else {
      out.existing_list = db
        .prepare('SELECT id, title, volume, author FROM books WHERE family_id = ? AND title = ?')
        .all(req.familyId, q);
    }
    out.existing = out.existing_list[0] || null;
    out.zlib_url = zlibrary.searchUrl({ isbn: out.isbn, title: out.isbn ? null : q });
    res.json(out);
  })
);

/** 校验 / 规范化 ISBN，扫码时前端先调它做本地校验 */
router.get(
  '/isbn/:code',
  wrap((req, res) => {
    const raw = req.params.code;
    const ok = isbnUtil.isIsbn(raw);
    res.json({
      valid: ok,
      isbn13: ok ? isbnUtil.to13(raw) : null,
      isbn10: ok ? isbnUtil.to10(raw) : null,
      formatted: ok ? isbnUtil.format(isbnUtil.to13(raw)) : null,
    });
  })
);

// ------------------------------------------------------------------ Z-Library

/** 直接问 Z-Library 要书目（需要设置里填 Cookie） */
router.get(
  '/zlib/search',
  wrap(async (req, res) => {
    const q = str(req.query.q);
    if (!q) return res.status(400).json({ error: '要给个 ISBN 或关键字' });
    try {
      const results = await zlibrary.search(isbnUtil.isIsbn(q) ? isbnUtil.to13(q) : q);
      res.json({ results, url: zlibrary.searchUrl({ isbn: isbnUtil.isIsbn(q) ? q : null, title: q }) });
    } catch (e) {
      res.status(e.code === 'ZLIB_CHALLENGE' ? 428 : 502).json({
        error: String(e.message || e),
        code: e.code || 'ZLIB_ERROR',
        url: zlibrary.searchUrl({ isbn: isbnUtil.isIsbn(q) ? q : null, title: q }),
      });
    }
  })
);

router.get(
  '/zlib/health',
  requireAdmin,
  wrap(async (req, res) => res.json(await zlibrary.health()))
);

router.get(
  '/zlib/url',
  wrap((req, res) => {
    res.json({
      url: zlibrary.searchUrl({
        isbn: str(req.query.isbn),
        title: str(req.query.title),
        author: str(req.query.author),
      }),
    });
  })
);

/**
 * 浏览器书签小工具：在 z-library 的书籍页点一下，
 * 把页面上的书目读出来，跳回本地书库的录入页（带参数），免去手抄。
 * 走跳转而不是跨域 POST，不用配 CORS，也不碰站点的验证机制。
 */
router.get(
  '/zlib/bookmarklet',
  wrap((req, res) => {
    const origin = str(req.query.origin) || `${req.protocol}://${req.get('host')}`;
    const code = `javascript:(function(){
  function t(sel){var e=document.querySelector(sel);return e?e.textContent.trim():'';}
  function prop(name){
    var ds=document.querySelectorAll('.bookProperty');
    for(var i=0;i<ds.length;i++){
      var l=ds[i].querySelector('.property_label'),v=ds[i].querySelector('.property_value');
      if(l&&v&&l.textContent.toLowerCase().indexOf(name)>=0)return v.textContent.trim();
    }
    var p=document.querySelector('.property_'+name+' .property_value');
    return p?p.textContent.trim():'';
  }
  var img=document.querySelector('.z-book-cover img,.details-book-cover img,img.cover,z-cover img');
  var d={
    title:t('h1[itemprop=name]')||t('h1'),
    author:t('a.color1')||t('[itemprop=author]'),
    publisher:prop('publisher'),
    pub_date:prop('year'),
    isbn13:prop('isbn 13')||prop('isbn'),
    pages:prop('pages'),
    language:prop('language'),
    summary:t('#bookDescriptionBox'),
    cover_url:img?(img.getAttribute('data-src')||img.src):'',
    source:'zlibrary',
    source_url:location.href
  };
  var qs=Object.keys(d).filter(function(k){return d[k];}).map(function(k){return k+'='+encodeURIComponent(d[k]);}).join('&');
  window.open('${origin}/#/add?'+qs,'_blank');
})();`.replace(/\n\s*/g, '');
    res.json({ code, origin });
  })
);

// ------------------------------------------------------------------ 设置

// 书库名字、成员这些是家庭自己的；代理、书目来源、识别引擎、各种 Key 是全站共用的，
// 只有站点管理员能看能改。普通成员只拿到界面需要的选项。
router.get(
  '/settings',
  wrap((req, res) => {
    const all = settings.all();
    const base = {
      currency: all.currency,
      options: { channels: CHANNELS, carriers: CARRIERS, statuses: STATUSES },
      can_admin: !!req.user.is_admin,
    };
    if (!req.user.is_admin) return res.json(base);
    // Cookie 只回显长度，不回显内容
    res.json({
      ...all,
      ...base,
      zlib_cookie: all.zlib_cookie ? `已保存（${all.zlib_cookie.length} 字符）` : '',
      zlib_cookie_set: !!all.zlib_cookie,
      google_books_key: all.google_books_key ? '已保存' : '',
      google_books_key_set: !!all.google_books_key,
      vision_api_key: all.vision_api_key ? '已保存' : '',
      vision_api_key_set: !!all.vision_api_key,
      providers: metadata.PROVIDERS.map((p) => ({ key: p.key, name: p.name, isbn: p.isbn })),
    });
  })
);

router.put(
  '/settings',
  requireAdmin,
  wrap((req, res) => {
    const patch = { ...(req.body || {}) };
    // 前端没改就不要把回显文本写回去
    if (patch.zlib_cookie === '' || /^已保存/.test(String(patch.zlib_cookie || ''))) delete patch.zlib_cookie;
    if (patch.google_books_key === '已保存') delete patch.google_books_key;
    if (patch.vision_api_key === '' || patch.vision_api_key === '已保存') delete patch.vision_api_key;
    settings.set(patch);
    res.json({ ok: true });
  })
);

/** 网络自检：代理、各来源连通性 */
router.get(
  '/settings/test',
  requireAdmin,
  wrap(async (req, res) => {
    const [douban, google, openlib, weread, zlib] = await Promise.all([
      http.ping('https://book.douban.com/j/subject_suggest?q=test'),
      http.ping('https://www.googleapis.com/books/v1/volumes?q=isbn:9780140449136'),
      http.ping('https://openlibrary.org/api/books?bibkeys=ISBN:9780140449136&format=json'),
      http.ping('https://weread.qq.com/web/search/global?keyword=test&maxIdx=0&count=1'),
      zlibrary.health(),
    ]);
    res.json({
      proxy: { enabled: settings.bool('proxy_enabled'), url: settings.get('proxy_url') },
      douban,
      googlebooks: google,
      openlibrary: openlib,
      weread,
      zlibrary: zlib,
    });
  })
);

// ------------------------------------------------------------------ 统计

router.get(
  '/stats',
  wrap((req, res) => {
    const year = str(req.query.year) || String(new Date().getFullYear());
    const f = req.familyId;
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const many = (sql, ...a) => db.prepare(sql).all(...a);
    // 购买、阅读都通过书归属家庭
    const P = 'purchases p JOIN books b ON b.id = p.book_id AND b.family_id = ?';
    const R = 'readings r JOIN books b ON b.id = r.book_id AND b.family_id = ?';

    const overview = {
      books: one('SELECT COUNT(*) AS c FROM books WHERE family_id=? AND archived=0 AND owned=1', f).c,
      wishlist: one('SELECT COUNT(*) AS c FROM books WHERE family_id=? AND owned=0', f).c,
      ebooks: one('SELECT COUNT(DISTINCT fl.book_id) AS c FROM files fl JOIN books b ON b.id = fl.book_id WHERE b.family_id=?', f).c,
      pages: one('SELECT IFNULL(SUM(pages),0) AS c FROM books WHERE family_id=? AND archived=0 AND owned=1', f).c,
      spend_total: one(`SELECT IFNULL(SUM(p.price*IFNULL(p.quantity,1)),0) AS c FROM ${P}`, f).c,
      spend_year: one(
        `SELECT IFNULL(SUM(p.price*IFNULL(p.quantity,1)),0) AS c FROM ${P} WHERE strftime('%Y',p.purchased_at)=?`,
        f, year
      ).c,
      bought_year: one(`SELECT COUNT(*) AS c FROM ${P} WHERE strftime('%Y',p.purchased_at)=?`, f, year).c,
      finished_year: one(
        `SELECT COUNT(*) AS c FROM ${R} WHERE r.status='已读' AND strftime('%Y',r.finished_at)=?`,
        f, year
      ).c,
    };

    const byMonth = many(
      `SELECT strftime('%Y-%m', p.purchased_at) AS month, COUNT(*) AS count,
              IFNULL(SUM(p.price*IFNULL(p.quantity,1)),0) AS amount
         FROM ${P} WHERE p.purchased_at IS NOT NULL AND strftime('%Y',p.purchased_at)=?
        GROUP BY month ORDER BY month`,
      f, year
    );

    const finishedByMonth = many(
      `SELECT strftime('%Y-%m', r.finished_at) AS month, COUNT(*) AS count
         FROM ${R} WHERE r.status='已读' AND r.finished_at IS NOT NULL AND strftime('%Y',r.finished_at)=?
        GROUP BY month ORDER BY month`,
      f, year
    );

    const members = many(
      `SELECT m.id, m.name, m.emoji, m.color,
              SUM(CASE WHEN r.status='已读' THEN 1 ELSE 0 END) AS finished,
              SUM(CASE WHEN r.status='在读' THEN 1 ELSE 0 END) AS reading,
              SUM(CASE WHEN r.status='待读' THEN 1 ELSE 0 END) AS todo,
              SUM(CASE WHEN r.status='已读' AND strftime('%Y',r.finished_at)=? THEN 1 ELSE 0 END) AS finished_year,
              IFNULL(SUM(CASE WHEN r.status='已读' THEN b.pages ELSE 0 END),0) AS pages_read
         FROM members m
         LEFT JOIN readings r ON r.member_id = m.id
         LEFT JOIN books b ON b.id = r.book_id
        WHERE m.active = 1 AND m.family_id = ?
        GROUP BY m.id ORDER BY m.sort_order`,
      year, f
    );

    const channels = many(
      `SELECT IFNULL(p.channel,'未填') AS channel, COUNT(*) AS count,
              IFNULL(SUM(p.price*IFNULL(p.quantity,1)),0) AS amount
         FROM ${P} GROUP BY p.channel ORDER BY amount DESC LIMIT 12`,
      f
    );

    const categories = many(
      `SELECT category AS name, COUNT(*) AS count FROM books
        WHERE family_id=? AND category IS NOT NULL AND category<>'' AND archived=0
        GROUP BY category ORDER BY count DESC LIMIT 12`,
      f
    );

    const authors = many(
      `SELECT author AS name, COUNT(*) AS count FROM books
        WHERE family_id=? AND author IS NOT NULL AND author<>'' AND archived=0
        GROUP BY author ORDER BY count DESC LIMIT 10`,
      f
    );

    const years = many(
      `SELECT DISTINCT strftime('%Y', p.purchased_at) AS year FROM ${P} WHERE p.purchased_at IS NOT NULL ORDER BY year DESC`,
      f
    ).map((r) => r.year);

    res.json({ year, years, overview, byMonth, finishedByMonth, members, channels, categories, authors });
  })
);

// ------------------------------------------------------------------ 导入导出

/** 只导出本家庭的数据 */
router.get(
  '/export.json',
  wrap((req, res) => {
    const f = req.familyId;
    const byBook = (table) =>
      db.prepare(`SELECT t.* FROM ${table} t JOIN books b ON b.id = t.book_id WHERE b.family_id = ?`).all(f);
    const dump = {
      exported_at: new Date().toISOString(),
      family: db.prepare('SELECT id, name, created_at FROM families WHERE id = ?').get(f),
      members: db.prepare('SELECT id, name, emoji, color, sort_order, active FROM members WHERE family_id = ?').all(f),
      books: db.prepare('SELECT * FROM books WHERE family_id = ?').all(f),
      purchases: byBook('purchases'),
      readings: byBook('readings'),
      reading_logs: byBook('reading_logs'),
      notes: byBook('notes'),
      files: byBook('files'),
    };
    res.setHeader('Content-Disposition', `attachment; filename="home-library-${Date.now()}.json"`);
    res.json(dump);
  })
);

router.get(
  '/export.csv',
  wrap((req, res) => {
    const members = db.prepare('SELECT * FROM members WHERE family_id=? AND active=1 ORDER BY sort_order').all(req.familyId);
    const books = db.prepare('SELECT * FROM books WHERE family_id=? ORDER BY id').all(req.familyId);
    const head = [
      '书名', '副标题', '作者', '译者', '出版社', '出版日期', '页数', 'ISBN', '定价',
      '分类', '标签', '载体', '位置', '购买次数', '花费合计', '最近购买',
      ...members.map((m) => `${m.name}状态`),
      ...members.map((m) => `${m.name}进度`),
    ];
    const lines = [head.map(csvEscape).join(',')];
    for (const b of books) {
      const ps = db.prepare('SELECT * FROM purchases WHERE book_id=? ORDER BY purchased_at DESC').all(b.id);
      const rs = db.prepare('SELECT * FROM readings WHERE book_id=?').all(b.id);
      const byMember = new Map(rs.map((r) => [r.member_id, r]));
      const row = [
        b.title, b.subtitle, b.author, b.translator, b.publisher, b.pub_date, b.pages,
        b.isbn13 || b.isbn10, b.list_price, b.category, b.tags, b.carrier, b.location,
        ps.length, ps.reduce((s, p) => s + (p.price || 0) * (p.quantity || 1), 0),
        ps.length ? ps[0].purchased_at : '',
        ...members.map((m) => (byMember.get(m.id) || {}).status || ''),
        ...members.map((m) => (byMember.get(m.id) || {}).progress || 0),
      ];
      lines.push(row.map(csvEscape).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="home-library-${Date.now()}.csv"`);
    res.send('﻿' + lines.join('\n')); // BOM，Excel 打开不乱码
  })
);

module.exports = router;
