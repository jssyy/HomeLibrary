/**
 * Z-Library 接入。
 *
 * 站点前面有 DiamWall 浏览器验证（JS 挑战），匿名的服务端请求会被 307/513 挡住。
 * 这里不做任何验证绕过，提供两条正规路径：
 *
 *   1) 服务端带 Cookie 查询：你在浏览器登录 z-library 后，把 Cookie 贴到「设置」里，
 *      服务端就用你自己的会话按 ISBN 搜索并解析书目，结果直接写进本地数据库。
 *   2) 浏览器取数：打开 z-library 搜索页（你的浏览器能过验证），用书签小工具
 *      在书籍页点一下，把书目回传到本地 /api/zlib/import 入库。
 *
 * 两条路都是「抓一次、存本地」，之后看书库不再联网。
 * 只取书目信息（书名/作者/出版社/年份/ISBN/封面/简介），不下载书籍文件。
 */
const settings = require('../settings');
const http = require('./http');
const isbnUtil = require('./isbn');

function base() {
  return String(settings.get('zlib_base') || 'https://zh.z-library.sk').replace(/\/+$/, '');
}

/** 搜索页链接（给浏览器打开用） */
function searchUrl({ isbn, title, author } = {}) {
  const q = isbn || [title, author].filter(Boolean).join(' ');
  if (!q) return base();
  return `${base()}/s/${encodeURIComponent(q)}`;
}

/** 详情页外链集合，书籍详情页展示 */
function links(book = {}) {
  const isbn = book.isbn13 || book.isbn10 || '';
  const kw = [book.title, book.author].filter(Boolean).join(' ');
  return [
    {
      name: 'Z-Library',
      url: searchUrl({ isbn, title: book.title, author: book.author }),
      primary: true,
    },
    {
      name: '微信读书',
      url: `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(book.title || '')}`,
    },
    {
      name: 'Open Library',
      url: isbn
        ? `https://openlibrary.org/isbn/${isbn}`
        : `https://openlibrary.org/search?q=${encodeURIComponent(kw)}`,
    },
    {
      name: 'Google Books',
      url: `https://books.google.com/books?vid=ISBN${isbn}` ,
    },
  ].filter((l) => l.url);
}

// ---------------------------------------------------------------- HTML 解析

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) {
    out[m[1].toLowerCase()] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function isChallenge(html) {
  return /DiamWall|Verifying your browser|cf-browser-verification|challenge-platform/i.test(html || '');
}

/**
 * 解析搜索结果页。z-library 的结果是 <z-bookcard> 自定义元素，
 * 属性里就带着我们要的字段；同时兼容老的 resItemBox 结构。
 */
function parseSearchHtml(html) {
  const out = [];
  const cardRe = /<z-bookcard\b([^>]*)>([\s\S]*?)<\/z-bookcard>/gi;
  let m;
  while ((m = cardRe.exec(html))) {
    const a = attrs(m[0].slice(0, m[0].indexOf('>') + 1));
    const inner = m[2] || '';
    const slot = (name) => {
      const r = new RegExp(`<[^>]*slot=["']${name}["'][^>]*>([\\s\\S]*?)<`, 'i');
      const mm = r.exec(inner);
      return mm ? stripTags(mm[1]) : '';
    };
    const imgMatch = /<img\b([^>]*)>/i.exec(inner);
    const img = imgMatch ? attrs(imgMatch[0]) : {};
    const title = slot('title') || a.name || '';
    if (!title) continue;
    out.push(normalize({
      title,
      author: slot('author') || a.authors || a.author || '',
      publisher: a.publisher || '',
      year: a.year || '',
      isbn: a.isbn || '',
      href: a.href || '',
      cover: img['data-src'] || img.src || '',
      extension: (a.extension || '').toLowerCase(),
      filesize: a.filesize || '',
      language: a.language || '',
      rating: a.rating || '',
      id: a.id || '',
    }));
  }
  if (out.length) return out;

  // 兼容：老版列表结构
  const boxRe = /<div[^>]*class="[^"]*resItemBox[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
  while ((m = boxRe.exec(html))) {
    const block = m[1];
    const t = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!t) continue;
    const authors = /<div[^>]*class="[^"]*authors[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const year = /property="year"[^>]*>([\s\S]*?)</i.exec(block);
    const pub = /title="Publisher"[^>]*>([\s\S]*?)</i.exec(block);
    const img = /<img[^>]*(?:data-src|src)="([^"]+)"/i.exec(block);
    out.push(normalize({
      title: stripTags(t[2]),
      href: t[1],
      author: authors ? stripTags(authors[1]) : '',
      year: year ? stripTags(year[1]) : '',
      publisher: pub ? stripTags(pub[1]) : '',
      cover: img ? img[1] : '',
    }));
  }
  return out;
}

/** 把 z-library 的原始字段整理成书库统一的书目结构 */
function normalize(r) {
  const isbn13 = r.isbn ? isbnUtil.to13(r.isbn) : null;
  return {
    source: 'zlibrary',
    source_url: r.href ? new URL(r.href, base()).href : null,
    isbn13,
    isbn10: isbn13 ? isbnUtil.to10(isbn13) : (r.isbn && isbnUtil.isValidIsbn10(isbnUtil.clean(r.isbn)) ? isbnUtil.clean(r.isbn) : null),
    title: r.title || '',
    subtitle: '',
    author: r.author || '',
    translator: '',
    publisher: r.publisher || '',
    pub_date: r.year ? String(r.year).slice(0, 4) : null,
    pages: r.pages ? Number(r.pages) : null,
    list_price: null,
    language: r.language || '',
    category: '',
    summary: r.summary || '',
    cover_url: r.cover ? new URL(r.cover, base()).href : null,
    ext_rating: r.rating ? Number(r.rating) : null,
    ext_rating_count: null,
    // z-library 特有：文件格式与大小，提示这本有没有电子版可取
    zlib_extension: r.extension || '',
    zlib_filesize: r.filesize || '',
    carrier_hint: r.extension ? '电子书' : null,
  };
}

// ---------------------------------------------------------------- 服务端查询

function headers() {
  const cookie = settings.get('zlib_cookie');
  const h = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    Referer: base() + '/',
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

class ZlibChallengeError extends Error {
  constructor() {
    super('Z-Library 要求浏览器验证：请在「设置」里更新 Cookie，或改用浏览器书签小工具录入');
    this.code = 'ZLIB_CHALLENGE';
  }
}

/**
 * 按 ISBN / 关键字在 z-library 上查书目。
 * @returns {Promise<Array>} 统一结构的书目数组
 */
async function search(query, { contentType = 'book' } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `${base()}/s/${encodeURIComponent(q)}?content_type=${contentType}`;
  const res = await http.request(url, { raw: true, timeout: 20000, headers: headers() });
  const html = await res.text();
  if (isChallenge(html)) throw new ZlibChallengeError();
  return parseSearchHtml(html);
}

/** 抓单本书籍详情页，补齐简介等字段 */
async function detail(bookUrl) {
  const res = await http.request(bookUrl, { raw: true, timeout: 20000, headers: headers() });
  const html = await res.text();
  if (isChallenge(html)) throw new ZlibChallengeError();

  const pick = (re) => {
    const m = re.exec(html);
    return m ? stripTags(m[1]) : '';
  };
  const title = pick(/<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/i) || pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const summary = pick(/id="bookDescriptionBox"[^>]*>([\s\S]*?)<\/div>/i);
  const prop = (name) => pick(new RegExp(`property="${name}"[^>]*>([\\s\\S]*?)<\\/div>`, 'i'));
  const img = /<img[^>]*class="[^"]*(?:cover|z-cover)[^"]*"[^>]*(?:data-src|src)="([^"]+)"/i.exec(html);
  return normalize({
    title,
    author: pick(/<a[^>]*class="[^"]*color1[^"]*"[^>]*>([\s\S]*?)<\/a>/i),
    publisher: prop('publisher'),
    year: prop('year'),
    isbn: prop('isbn') || prop('isbn 13'),
    pages: prop('pages'),
    summary,
    cover: img ? img[1] : '',
    href: bookUrl,
  });
}

/** 连通性自检，设置页用 */
async function health() {
  try {
    const res = await http.request(base() + '/', { raw: true, timeout: 12000, headers: headers() });
    const html = await res.text();
    if (isChallenge(html)) {
      return { ok: false, reason: 'challenge', message: '被浏览器验证挡住，需要在设置里填入你登录后的 Cookie' };
    }
    const loggedIn = /登出|logout|profile|我的书架/i.test(html);
    return { ok: true, loggedIn, message: loggedIn ? '已连接（检测到登录态）' : '已连接（未登录，搜索可能受限）' };
  } catch (e) {
    return { ok: false, reason: 'network', message: String(e.message || e) };
  }
}

module.exports = { search, detail, links, searchUrl, base, health, parseSearchHtml, normalize, isChallenge, ZlibChallengeError };
