const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 账号：邮箱 + 密码登录
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  email_verified INTEGER DEFAULT 0,
  is_admin       INTEGER DEFAULT 0,   -- 站点管理员：能改代理、书目来源、识别引擎这些全站设置
  family_id      INTEGER REFERENCES families(id) ON DELETE SET NULL,
  created_at     TEXT DEFAULT (datetime('now','localtime')),
  last_login_at  TEXT
);

-- 家庭：一个家庭一个书库，成员共享
CREATE TABLE IF NOT EXISTS families (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invite_code TEXT UNIQUE,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);

-- 登录会话，库里只存 token 的哈希
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,       -- 毫秒时间戳
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 一次性令牌：重置密码 / 验证邮箱
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          TEXT PRIMARY KEY,       -- token 的哈希
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,          -- reset / verify
  expires_at  INTEGER NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(user_id, purpose);

-- 家庭成员（阅读档案）：可以关联账号，也可以是没有账号的小朋友
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id  INTEGER REFERENCES families(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  emoji      TEXT DEFAULT '📖',
  color      TEXT DEFAULT '#4f8cff',
  sort_order INTEGER DEFAULT 0,
  active     INTEGER DEFAULT 1
);

-- 书籍
CREATE TABLE IF NOT EXISTS books (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id      INTEGER REFERENCES families(id) ON DELETE CASCADE,
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
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(table, column, definition) {
  if (hasColumn(table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] ${table} 新增列 ${column}`);
}

// 套装书：整套共用一个 ISBN，每册书名不同，用这个字段区分第几册
addColumn('books', 'volume', 'TEXT');
addColumn('books', 'family_id', 'INTEGER REFERENCES families(id) ON DELETE CASCADE');

// 老库的 members.name 是全局唯一的，多家庭后只需要家庭内唯一，得重建表才能去掉约束。
// 按 SQLite 官方的步骤：关外键 → 建新表 → 拷数据 → 删旧表 → 改名。
if (!hasColumn('members', 'family_id')) {
  db.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    db.exec(`
      CREATE TABLE members_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        family_id  INTEGER REFERENCES families(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        name       TEXT NOT NULL,
        emoji      TEXT DEFAULT '📖',
        color      TEXT DEFAULT '#4f8cff',
        sort_order INTEGER DEFAULT 0,
        active     INTEGER DEFAULT 1
      );
      INSERT INTO members_new (id, name, emoji, color, sort_order, active)
        SELECT id, name, emoji, color, sort_order, active FROM members;
      DROP TABLE members;
      ALTER TABLE members_new RENAME TO members;
    `);
  });
  db.exec('PRAGMA foreign_keys = ON');
  console.log('[db] members 表已升级为按家庭划分');
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_books_family_isbn ON books(family_id, isbn13);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_family ON books(family_id, archived, owned);
CREATE INDEX IF NOT EXISTS idx_members_family ON members(family_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
CREATE INDEX IF NOT EXISTS idx_users_family ON users(family_id);
`);

// 单机版升级上来的数据：挂到一个「待认领」的家庭下（owner 为空），
// 第一个注册的账号会自动成为它的主人，原来的书和阅读记录都还在。
const orphanBooks = db.prepare('SELECT COUNT(*) AS c FROM books WHERE family_id IS NULL').get().c;
const orphanMembers = db.prepare('SELECT COUNT(*) AS c FROM members WHERE family_id IS NULL').get().c;
if (orphanBooks || orphanMembers) {
  tx(() => {
    const nameRow = db.prepare("SELECT value FROM settings WHERE key = 'library_name'").get();
    let fam = db.prepare('SELECT id FROM families WHERE owner_id IS NULL ORDER BY id LIMIT 1').get();
    if (!fam) {
      const info = db
        .prepare('INSERT INTO families (name, invite_code) VALUES (?, ?)')
        .run((nameRow && nameRow.value) || '我们家的图书馆', newInviteCode());
      fam = { id: Number(info.lastInsertRowid) };
    }
    db.prepare('UPDATE books SET family_id = ? WHERE family_id IS NULL').run(fam.id);
    db.prepare('UPDATE members SET family_id = ? WHERE family_id IS NULL').run(fam.id);
  });
  console.log('[db] 旧数据已归入待认领的家庭，第一个注册的账号会成为它的主人');
}

/** 邀请码：去掉容易看错的字符（0/O、1/I/L） */
function newInviteCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = require('crypto').randomBytes(8);
  let code = '';
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

/** 保证每本书对所属家庭的每个在册成员都有一条阅读记录 */
function ensureReadings(bookId) {
  db.prepare(
    `INSERT OR IGNORE INTO readings (book_id, member_id, status)
     SELECT b.id, m.id, '待读' FROM books b JOIN members m ON m.family_id = b.family_id
      WHERE b.id = ? AND m.active = 1`
  ).run(bookId);
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

module.exports = { db, ensureReadings, tx, newInviteCode };
