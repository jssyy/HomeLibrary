/** 电子书文件：上传、读取（支持 Range，在线阅读要用）、删除 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { db } = require('../db');
const { wrap, int, str } = require('../util');
const { bookOf, childOf, notFound } = require('../scope');

const router = express.Router();

/** 上传前先确认书是本家庭的，免得文件先落了盘 */
function ownBook(req, res, next) {
  req.book = bookOf(req.familyId, req.params.id);
  if (!req.book) return notFound(res);
  next();
}

const ALLOWED = { '.epub': 'epub', '.pdf': 'pdf', '.txt': 'txt', '.mobi': 'mobi', '.azw3': 'azw3' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.FILES_DIR),
  filename: (req, file, cb) => {
    // multer 按 latin1 解码文件名，这里转回 UTF-8 才不会乱码
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(original).toLowerCase();
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.UPLOAD_LIMIT_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(original).toLowerCase();
    if (!ALLOWED[ext]) return cb(new Error(`只支持 ${Object.keys(ALLOWED).join(' / ')} 格式`));
    cb(null, true);
  },
});

/** POST /api/books/:id/files —— 上传电子书 */
router.post(
  '/books/:id/files',
  ownBook,
  upload.array('files', 10),
  wrap((req, res) => {
    const bookId = req.book.id;

    const inserted = [];
    for (const f of req.files || []) {
      const original = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const ext = path.extname(original).toLowerCase();
      const info = db
        .prepare('INSERT INTO files (book_id, name, path, format, size) VALUES (?,?,?,?,?)')
        .run(bookId, original, f.filename, ALLOWED[ext] || ext.slice(1), f.size);
      inserted.push(db.prepare('SELECT * FROM files WHERE id = ?').get(Number(info.lastInsertRowid)));
    }
    // 有电子版了，载体顺手标一下
    if (inserted.length) {
      db.prepare("UPDATE books SET carrier = CASE WHEN carrier = '纸质书' THEN '纸质书+电子书' ELSE carrier END WHERE id = ? AND carrier IS NOT NULL").run(bookId);
    }
    res.status(201).json(inserted);
  })
);

/** GET /api/files/:id/raw —— 阅读器取文件，express 自带 Range 支持 */
router.get(
  '/files/:id/raw',
  wrap((req, res) => {
    const f = childOf('files', req.familyId, req.params.id);
    if (!f) return notFound(res, '文件');
    const abs = path.join(config.FILES_DIR, f.path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (f.format === 'epub') res.type('application/epub+zip');
    else if (f.format === 'pdf') res.type('application/pdf');
    res.sendFile(abs);
  })
);

/** 下载（带原始文件名） */
router.get(
  '/files/:id/download',
  wrap((req, res) => {
    const f = childOf('files', req.familyId, req.params.id);
    if (!f) return notFound(res, '文件');
    res.download(path.join(config.FILES_DIR, f.path), f.name);
  })
);

router.get(
  '/files/:id',
  wrap((req, res) => {
    const f = db
      .prepare(
        `SELECT f.*, b.title, b.author, b.id AS book_id FROM files f
           JOIN books b ON b.id = f.book_id WHERE f.id = ? AND b.family_id = ?`
      )
      .get(int(req.params.id), req.familyId);
    if (!f) return res.status(404).json({ error: '文件不存在' });
    f.readings = db
      .prepare(
        `SELECT r.*, m.name AS member_name, m.emoji, m.color FROM readings r
           JOIN members m ON m.id = r.member_id
          WHERE r.book_id = ? AND m.active = 1 ORDER BY m.sort_order`
      )
      .all(f.book_id);
    res.json(f);
  })
);

router.delete(
  '/files/:id',
  wrap((req, res) => {
    const f = childOf('files', req.familyId, req.params.id);
    if (!f) return notFound(res, '文件');
    try {
      fs.unlinkSync(path.join(config.FILES_DIR, f.path));
    } catch {
      /* 文件可能已经被手工删了，不影响清库 */
    }
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    res.json({ deleted: 1 });
  })
);

/** 上传自定义封面 */
const COVER_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const coverUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.COVERS_DIR),
    filename: (req, file, cb) => {
      const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = path.extname(original).toLowerCase();
      cb(null, `up_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${COVER_EXT.includes(ext) ? ext : '.jpg'}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  // 封面是静态托管的，只收图片，免得有人传个 html 上来
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return cb(new Error('封面只支持 jpg / png / webp / gif'));
    cb(null, true);
  },
});

router.post(
  '/books/:id/cover',
  ownBook,
  coverUpload.single('cover'),
  wrap((req, res) => {
    if (!req.file) return res.status(400).json({ error: '没收到图片' });
    const id = req.book.id;
    db.prepare("UPDATE books SET cover_path = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(
      req.file.filename,
      id
    );
    res.json({ cover_path: req.file.filename });
  })
);

module.exports = router;
