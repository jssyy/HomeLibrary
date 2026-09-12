/**
 * 从旧的 book_library/library.db 迁移数据。
 *
 *   node scripts/migrate-old-db.js [旧库路径] [--covers]
 *
 * 旧库里 reading_progress 是 "爸爸已读|妈妈待读|凡凡待读" 这样的拼接字符串，
 * 这里拆成每位成员一条阅读记录。加 --covers 会把封面下载到本地（要能连上图片站）。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

process.removeAllListeners('warning');

const config = require('../src/config');
const { db, ensureReadings } = require('../src/db');
const meta = require('../src/services/metadata');
const isbnUtil = require('../src/services/isbn');

const args = process.argv.slice(2);
const withCovers = args.includes('--covers');
const oldPath =
  args.find((a) => !a.startsWith('--')) ||
  path.join(config.ROOT, '..', 'book_library', 'library.db');

const STATUSES = ['待读', '在读', '已读', '弃读'];

function parseProgress(raw) {
  // "爸爸已读|妈妈待读|凡凡待读" -> [{name:'爸爸', status:'已读'}, ...]
  const out = [];
  for (const part of String(raw || '').split('|')) {
    const p = part.trim();
    if (!p) continue;
    const status = STATUSES.find((s) => p.endsWith(s));
    if (!status) continue;
    const name = p.slice(0, p.length - status.length).trim();
    if (!name) continue;
    out.push({ name, status });
  }
  return out;
}

function tsToDate(v) {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v).slice(0, 10);
  const d = new Date(n > 1e11 ? n : n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 老库里的成员名对应到新库；默认成员没用过就直接改名，避免出现「宝宝」和「凡凡」两份 */
function resolveMember(name, usedNames) {
  const hit = db.prepare('SELECT * FROM members WHERE name = ?').get(name);
  if (hit) return hit.id;

  const spare = db
    .prepare(
      `SELECT m.* FROM members m
        WHERE m.active = 1
          AND NOT EXISTS (SELECT 1 FROM readings r WHERE r.member_id = m.id AND r.status <> '待读')
        ORDER BY m.sort_order`
    )
    .all()
    .find((m) => !usedNames.has(m.name));

  if (spare) {
    db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, spare.id);
    console.log(`  成员「${spare.name}」→「${name}」`);
    return spare.id;
  }
  const maxOrder = db.prepare('SELECT IFNULL(MAX(sort_order),0) AS m FROM members').get().m;
  const info = db
    .prepare('INSERT INTO members (name, emoji, color, sort_order) VALUES (?,?,?,?)')
    .run(name, '📖', '#7c5cff', maxOrder + 1);
  console.log(`  新建成员「${name}」`);
  return Number(info.lastInsertRowid);
}

async function main() {
  if (!fs.existsSync(oldPath)) {
    console.error(`找不到旧库：${oldPath}`);
    process.exit(1);
  }
  console.log(`读取旧库：${oldPath}`);
  const old = new DatabaseSync(oldPath, { readOnly: true });
  const rows = old.prepare('SELECT * FROM books ORDER BY id').all();
  console.log(`共 ${rows.length} 条记录\n`);

  // 先把所有出现过的成员建好
  const memberNames = new Set();
  for (const r of rows) for (const p of parseProgress(r.reading_progress)) memberNames.add(p.name);
  const memberIds = new Map();
  const used = new Set(memberNames);
  for (const name of memberNames) memberIds.set(name, resolveMember(name, used));
  console.log('');

  let added = 0;
  let skipped = 0;
  const toCover = [];

  for (const r of rows) {
    const isbn13 = r.isbn ? isbnUtil.to13(r.isbn) : null;
    if (isbn13) {
      const dup = db.prepare('SELECT id FROM books WHERE isbn13 = ?').get(isbn13);
      if (dup) {
        skipped++;
        continue;
      }
    }
    const carrier = r.book_carrier === '电子书' ? '电子书' : '纸质书';
    const info = db
      .prepare(
        `INSERT INTO books
          (isbn13, isbn10, title, author, publisher, pub_date, pages, list_price,
           summary, carrier, cover_url, source, source_url, ext_rating, ext_rating_count, owned)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
      )
      .run(
        isbn13,
        isbn13 ? isbnUtil.to10(isbn13) : null,
        r.title || '(无题)',
        r.author || null,
        r.publisher || null,
        tsToDate(r.pub_year),
        r.pages || null,
        r.price || null,
        r.intro || null,
        carrier,
        r.pic_url || null,
        'import',
        r.url || null,
        r.rating || null,
        r.votes || null
      );
    const bookId = Number(info.lastInsertRowid);
    ensureReadings(bookId);

    for (const p of parseProgress(r.reading_progress)) {
      const mid = memberIds.get(p.name);
      if (!mid) continue;
      db.prepare(
        `INSERT INTO readings (book_id, member_id, status, progress)
         VALUES (?,?,?,?)
         ON CONFLICT(book_id, member_id) DO UPDATE SET status = excluded.status, progress = excluded.progress`
      ).run(bookId, mid, p.status, p.status === '已读' ? 100 : 0);
    }
    if (r.pic_url) toCover.push({ bookId, url: r.pic_url, hint: isbn13 || r.title });
    added++;
  }

  console.log(`导入完成：新增 ${added} 本，跳过重复 ${skipped} 本`);

  if (withCovers && toCover.length) {
    console.log(`\n开始下载 ${toCover.length} 张封面…`);
    let ok = 0;
    const queue = [...toCover];
    const workers = Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const job = queue.shift();
        const name = await meta.cacheCover(job.url, job.hint);
        if (name) {
          db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(name, job.bookId);
          ok++;
          if (ok % 20 === 0) console.log(`  已下载 ${ok}/${toCover.length}`);
        }
      }
    });
    await Promise.all(workers);
    console.log(`封面下载完成：${ok}/${toCover.length}`);
    if (ok < toCover.length) {
      console.log('没下下来的可以之后在书籍详情页点「重新抓取」，或者在设置里开代理再跑一次。');
    }
  } else if (toCover.length) {
    console.log('\n封面暂未下载（加 --covers 参数可下载到本地，断网也能看）。');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
