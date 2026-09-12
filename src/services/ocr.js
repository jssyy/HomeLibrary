/**
 * 版权页拍照识别。
 *
 * 思路：不指望 OCR 把整页中文都认对（手机拍的照片有角度、背面透印，
 * 中文识别率一般在 70~90%），而是让它认出 **ISBN 那串数字**——
 * 数字容错高，而且 ISBN 自带校验位，可以自己验、自己纠常见的形近误识。
 * 拿到 ISBN 之后书目直接问豆瓣要权威数据；OCR 的中文结果只用来补
 * 豆瓣没有的字段（分册名、定价、开本之类），并把原文回传给人核对。
 *
 * 模型放在 data/ocr/（node scripts/setup-ocr.js 下载），本地跑，不传云端。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const isbnUtil = require('./isbn');

const OCR_DIR = path.join(config.DATA_DIR, 'ocr');
const IDLE_MS = 5 * 60 * 1000; // 闲置 5 分钟就把 worker 收掉，省内存

let workerPromise = null;
let idleTimer = null;

function modelsReady() {
  return ['chi_sim', 'eng'].every((l) => {
    const f = path.join(OCR_DIR, `${l}.traineddata`);
    return fs.existsSync(f) && fs.statSync(f).size > 100 * 1024;
  });
}

async function getWorker() {
  if (!modelsReady()) {
    const err = new Error('OCR 模型还没下载，先执行：npm run ocr:setup');
    err.code = 'OCR_NO_MODEL';
    throw err;
  }
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('chi_sim+eng', 1, {
      langPath: OCR_DIR,
      cachePath: OCR_DIR,
      gzip: false,
    });
  }
  scheduleIdleShutdown();
  return workerPromise;
}

function scheduleIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const w = workerPromise;
    workerPromise = null;
    try {
      (await w).terminate();
    } catch { /* 已经没了就算了 */ }
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

/**
 * 预处理：手机照片直接喂给 tesseract 效果一般，
 * 放大到合适尺寸 + 灰度 + 拉对比度，识别率能明显提升。
 */
async function preprocess(buffer) {
  const Jimp = require('jimp');
  const img = await Jimp.read(buffer);
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const longSide = Math.max(w, h);

  // 太小的放大、太大的缩小：长边落在 1800~2400 之间最划算
  if (longSide < 1600) img.scale(Math.min(2.5, 1800 / longSide));
  else if (longSide > 2600) img.scale(2400 / longSide);

  img.grayscale().normalize().contrast(0.25);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

/** 跑一次 OCR，返回整页文本 */
async function recognize(buffer, { preprocess: pre = true } = {}) {
  const worker = await getWorker();
  const input = pre ? await preprocess(buffer) : buffer;
  const t0 = Date.now();
  const { data } = await worker.recognize(input);
  return { text: data.text || '', confidence: data.confidence, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ 文本解析

/** OCR 输出里全角/半角、多余空格都不稳定，先归一化再抽字段 */
function normalize(text) {
  return String(text || '')
    .replace(/[：﹕∶]/g, ':')
    .replace(/[（〈＜]/g, '(')
    .replace(/[）〉＞]/g, ')')
    .replace(/[，]/g, ',')
    .replace(/\r/g, '')
    // 中文字之间被插入的空格去掉（"出 版 社" -> "出版社"）
    .replace(/([一-龥])[ \t]+(?=[一-龥])/g, '$1');
}

/** 数字里常见的形近误识：O→0、l/I→1、S→5、B→8 */
function fixDigits(s) {
  return String(s || '')
    .replace(/[oO]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[sS]/g, '5')
    .replace(/[bB]/g, '8')
    .replace(/[zZ]/g, '2');
}

/**
 * 从一坨文本里把 ISBN 抠出来。
 * 先找带 ISBN 关键字的，再退而求其次找任何 978/979 开头的 13 位数字；
 * 校验位不过就试着纠正形近字符再验一次。
 */
function extractIsbn(text) {
  const candidates = [];

  const labelled = text.matchAll(/ISBN[\s:]*([0-9A-Za-z\-\s|]{10,25})/gi);
  for (const m of labelled) candidates.push(m[1]);

  // 没有 ISBN 字样时，找 978/979 开头的一串
  for (const m of text.matchAll(/(97[89][\d\s\-oOlI|]{10,18})/g)) candidates.push(m[1]);

  for (const raw of candidates) {
    for (const variant of [raw, fixDigits(raw)]) {
      const digits = String(variant).replace(/[^\dXx]/g, '');
      if (digits.length >= 13) {
        const cut = digits.slice(0, 13);
        if (isbnUtil.isValidIsbn13(cut)) return cut;
      }
      if (digits.length >= 10) {
        const cut10 = digits.slice(0, 10);
        if (isbnUtil.isValidIsbn10(cut10)) return isbnUtil.to13(cut10);
      }
    }
  }

  // 校验位没过也把最像的一条返回（前端会标"待确认"）
  for (const raw of candidates) {
    const digits = fixDigits(raw).replace(/[^\dXx]/g, '');
    if (digits.length >= 13) return digits.slice(0, 13);
  }
  return null;
}

function pick(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  const v = String(m[1] || '')
    .trim()
    // 版权页里字与字之间空得开，OCR 常在中间塞进引号之类的噪声
    .replace(/["'“”‘’`~^]/g, '')
    .replace(/[\s]{2,}/g, ' ')
    .replace(/[。.\-—_]+$/, '')
    .trim();
  return v || null;
}

/**
 * 解析版权页 / CIP 数据页，返回可以直接填进表单的字段。
 *
 * 套装书的版权页长这样：
 *   书  名：快乐读书吧：读书笔记彩图版 四年级 上册   ← 整套的名字
 *   分册名：希腊神话故事                              ← 这一册的名字
 *   定  价：110.00元（全三册）                        ← 整套的价格
 * 所以「分册名」当书名、「书名」当丛书名。
 */
function parseCopyrightPage(raw) {
  const text = normalize(raw);
  const fields = {};
  const notes = [];

  const isbn = extractIsbn(text);
  if (isbn) {
    fields.isbn13 = isbn;
    if (!isbnUtil.isValidIsbn13(isbn)) notes.push('ISBN 校验位对不上，请核对一下');
  }

  const bookName = pick(text, /书\s*名\s*:?\s*([^\n]+)/);
  const volumeName = pick(text, /分\s*册\s*名?\s*:?\s*([^\n]+)/);

  if (volumeName) {
    // 套装：分册名才是这一本。
    // volume 也写一份——按 ISBN 查到的书目往往是整套的名字，
    // title 会被那个覆盖，分册名得单独留着才不会丢。
    fields.title = volumeName;
    fields.volume = volumeName;
    if (bookName) fields.series = bookName;
    notes.push('这是套装分册：分册名已填进「书名」和「分册」，整套名填进「丛书」');
  } else if (bookName) {
    fields.title = bookName;
  }

  // 冒号是必需的：CIP 段落里的「张芳主编. — 石家庄…」没有冒号，不能误当成作者
  const author = pick(text, /(?:主\s*编|编\s*著|作\s*者|著\s*者)\s*:\s*([^\n(]+)/);
  if (author) fields.author = author.replace(/\s+/g, '');

  const translator = pick(text, /译\s*者\s*:?\s*([^\n]+)/);
  if (translator) fields.translator = translator;

  const publisher =
    pick(text, /出版发行\s*:?\s*([^\n(]+)/) ||
    pick(text, /([一-龥]{2,15}(?:出版社|出版公司|书店|大学出版社))/);
  if (publisher) {
    fields.publisher = publisher
      .replace(/\s/g, '')
      .replace(/[(（].*$/, '')          // 「（邮政编码：050061）」这类尾巴
      .replace(/^[^一-龥]+/, '');
  }

  // 版次：2024 年 4 月第 1 版
  const ver = /版\s*次\s*:?\s*(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(text) ||
    /(\d{4})\s*年\s*(\d{1,2})\s*月第\s*\d+\s*版/.exec(text);
  if (ver) fields.pub_date = `${ver[1]}-${String(ver[2]).padStart(2, '0')}`;

  // 定价：110.00 元（全三册）
  const price = /定\s*价\s*:?\s*([\d.]+)\s*元?\s*(\([^)]*\))?/.exec(text);
  if (price) {
    fields.list_price = Number(price[1]);
    if (price[2] && /全\s*[\d一二三四五六七八九十]+\s*册/.test(price[2])) {
      notes.push(`定价 ${price[1]} 元是整套价格${price[2]}，单册价请自行折算`);
    }
  }

  const pages = pick(text, /页\s*数\s*:?\s*(\d+)/);
  if (pages) fields.pages = Number(pages);

  const format = pick(text, /开\s*本\s*:?\s*([^\n]+)/);
  if (format) notes.push(`开本：${format}`);

  const words = pick(text, /字\s*数\s*:?\s*([\d.]+)\s*千字/);
  if (words) notes.push(`字数：${words} 千字`);

  // CIP 首段常见格式：书名 / 作者. — 地点: 出版社, 2024.4
  if (!fields.title || !fields.publisher) {
    const cip = /图书在版编目[^\n]*\n+([^\n]+)/.exec(text);
    if (cip) {
      const seg = cip[1];
      const m = /^([^/]+)\/\s*([^.]+)/.exec(seg);
      if (m) {
        if (!fields.title) fields.title = m[1].trim();
        if (!fields.author) fields.author = m[2].trim();
      }
    }
  }

  return { fields, notes };
}

/** 一步到位：图片 → 文本 → 字段 */
async function readBookPhoto(buffer) {
  const { text, confidence, ms } = await recognize(buffer);
  const { fields, notes } = parseCopyrightPage(text);
  return { fields, notes, text, confidence, ms };
}

module.exports = { recognize, parseCopyrightPage, readBookPhoto, extractIsbn, modelsReady, OCR_DIR };
