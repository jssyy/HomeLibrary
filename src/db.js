const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 家庭成员
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  emoji      TEXT DEFAULT '📖',
  color      TEXT DEFAULT '#4f8cff',
  sort_order INTEGER DEFAULT 0,
  active     INTEGER DEFAULT 1
);

-- 书籍
CREATE TABLE IF NOT EXISTS books (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  isbn13         TEXT,
  isbn10         TEXT,
  title          TEXT NOT NULL,
  subtitle       TEXT,
  original_title TEXT,
  author         TEXT,
  translator     TEXT,
  publisher      TEXT,
  pub_date       TEXT,              -- YYYY / YYYY-MM / YYYY-MM-DD
  pages          INTEGER,
  list_price     REAL,              -- 定价
  category       TEXT,              -- 分类，如 文学/童书/科普
  tags           TEXT,              -- 逗号分隔
  series         TEXT,
  language       TEXT,
  summary        TEXT,
  carrier        TEXT DEFAULT '纸质书',  -- 纸质书 / 电子书 / 有声书
  location       TEXT,              -- 书架位置，如 客厅A-3
  cover_url      TEXT,
  cover_path     TEXT,              -- 本地缓存文件名
  source         TEXT,              -- googlebooks / openlibrary / manual / import
  source_url     TEXT,
  ext_rating     REAL,
  ext_rating_count INTEGER,
  owned          INTEGER DEFAULT 1, -- 1=已拥有 0=心愿单
  archived       INTEGER DEFAULT 0,
  created_at     TEXT DEFAULT (datetime('now','localtime')),
  updated_at     TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn13);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);

-- 购买记录（一本书可多次购买：复本、再版、送人）
CREATE TABLE IF NOT EXISTS purchases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  purchased_at TEXT,      -- YYYY-MM-DD
  channel      TEXT,      -- 京东 / 当当 / 淘宝 / 微信读书 / 实体书店 / 二手 / 赠送
  price        REAL,      -- 实付
  quantity     INTEGER DEFAULT 1,
  buyer_id     INTEGER REFERENCES members(id) ON DELETE SET NULL,
  note         TEXT,
  created_at   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_book ON purchases(book_id);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchased_at);

-- 每个成员对每本书的阅读情况
CREATE TABLE IF NOT EXISTS readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status      TEXT DEFAULT '待读',   -- 待读 / 在读 / 已读 / 弃读
  progress    REAL DEFAULT 0,        -- 0-100
  location    TEXT,                  -- epub CFI 或 pdf 页码，用于续读
  started_at  TEXT,
  finished_at TEXT,
  rating      INTEGER,               -- 1-5 星
  review      TEXT,
  updated_at  TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(book_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_readings_member ON readings(member_id, status);

-- 阅读打卡流水（用于统计与时间线）
CREATE TABLE IF NOT EXISTS reading_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  log_date  TEXT NOT NULL,
  minutes   INTEGER,
  pages     INTEGER,
  progress  REAL,
  note      TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_logs_date ON reading_logs(log_date);

-- 划线与读书笔记
CREATE TABLE IF NOT EXISTS notes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  chapter   TEXT,
  cfi       TEXT,
  quote     TEXT,
  note      TEXT,
  color     TEXT DEFAULT 'yellow',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id);

-- 电子书文件（在线阅读用）
CREATE TABLE IF NOT EXISTS files (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  path     TEXT NOT NULL,
  format   TEXT,          -- epub / pdf
  size     INTEGER,
  added_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_files_book ON files(book_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// ------------------------------------------------------------------ 列迁移
// 老版本建的库补上新加的列（SQLite 没有 ADD COLUMN IF NOT EXISTS）
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] ${table} 新增列 ${column}`);
}

// 套装书：整套共用一个 ISBN，每册书名不同，用这个字段区分第几册
addColumn('books', 'volume', 'TEXT');

// 首次运行时建一个成员，保证书籍至少有一条阅读记录可挂。
// 家里其他人在「设置 › 家庭成员」里自己加，称呼和头像都能改。
const memberCount = db.prepare('SELECT COUNT(*) AS c FROM members').get().c;
if (memberCount === 0) {
  db.prepare('INSERT INTO members (name, emoji, color, sort_order) VALUES (?,?,?,?)')
    .run('我', '📖', '#4f8cff', 1);
}

/** 保证每本书对每个在册成员都有一条阅读记录 */
function ensureReadings(bookId) {
  const members = db.prepare('SELECT id FROM members WHERE active = 1').all();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO readings (book_id, member_id, status) VALUES (?,?,?)'
  );
  for (const m of members) ins.run(bookId, m.id, '待读');
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, ensureReadings, tx };
