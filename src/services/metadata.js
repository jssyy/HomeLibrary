/**
 * 书目元数据聚合。四个来源可在「设置」里各自开关：
 *   - Z-Library    ：按 ISBN 直查（需要在设置里填你登录后的 Cookie），中英文都覆盖
 *   - Google Books ：中英文都不错，匿名配额容易被代理出口 IP 打满，建议自备 API Key
 *   - Open Library ：完全免费无需 Key，英文书全，中文书较弱
 *   - 微信读书     ：国内直连，中文书名/作者搜索最好用（不支持按 ISBN 搜）
 *
 * 查到的结果保存进本地数据库（封面也落到本地 data/covers），
 * 之后浏览书库、看详情都是纯本地读取，不再联网。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const settings = require('../settings');
const http = require('./http');
const isbnUtil = require('./isbn');
const zlibrary = require('./zlibrary');
const douban = require('./douban');

function pickDate(d) {
  if (!d) return null;
  const m = /(\d{4})(?:[-/年](\d{1,2}))?(?:[-/月](\d{1,2}))?/.exec(String(d));
  if (!m) return null;
  return [m[1], m[2] && m[2].padStart(2, '0'), m[3] && m[3].padStart(2, '0')]
    .filter(Boolean)
    .join('-');
}

const EMPTY = {
  isbn13: null, isbn10: null, title: '', subtitle: '', author: '', translator: '',
  publisher: '', pub_date: null, pages: null, list_price: null, language: '',
  category: '', summary: '', cover_url: null, ext_rating: null, ext_rating_count: null,
  source: '', source_url: null,
};

// ---------------------------------------------------------------- Google Books
function fromGoogle(item) {
  const v = item.volumeInfo || {};
  const sale = item.saleInfo || {};
  const ids = v.industryIdentifiers || [];
  let cover = (v.imageLinks || {}).thumbnail || (v.imageLinks || {}).smallThumbnail || null;
  if (cover) cover = cover.replace(/^http:/, 'https:').replace(/&edge=curl/, '');
  return {
    ...EMPTY,
    source: 'googlebooks',
    source_url: v.canonicalVolumeLink || v.infoLink || null,
    isbn13: (ids.find((i) => i.type === 'ISBN_13') || {}).identifier || null,
    isbn10: (ids.find((i) => i.type === 'ISBN_10') || {}).identifier || null,
    title: v.title || '',
    subtitle: v.subtitle || '',
    author: (v.authors || []).join(' / '),
    publisher: v.publisher || '',
    pub_date: pickDate(v.publishedDate),
    pages: v.pageCount || null,
    list_price: (sale.listPrice && sale.listPrice.amount) || null,
    language: v.language || '',
    category: (v.categories || []).join(' / '),
    summary: v.description || '',
    cover_url: cover,
    ext_rating: v.averageRating || null,
    ext_rating_count: v.ratingsCount || null,
  };
}

async function googleBooks(query, isIsbn) {
  const key = settings.get('google_books_key');
  const q = isIsbn ? `isbn:${query}` : query;
  let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20`;
  if (key) url += `&key=${encodeURIComponent(key)}`;
  let data;
  try {
    data = await http.getJson(url);
  } catch (e) {
    if (e.status === 429) {
      throw new Error('配额已满：匿名调用受限，请在设置里填 Google Books API Key');
    }
    throw e;
  }
  return (data.items || []).map(fromGoogle).filter((b) => b.title);
}

// ---------------------------------------------------------------- Open Library
function fromOpenLibraryData(d, isbn) {
  const ids = d.identifiers || {};
  return {
    ...EMPTY,
    source: 'openlibrary',
    source_url: d.url || null,
    isbn13: (ids.isbn_13 || [])[0] || (isbn ? isbnUtil.to13(isbn) : null),
    isbn10: (ids.isbn_10 || [])[0] || null,
    title: d.title || '',
    subtitle: d.subtitle || '',
    author: (d.authors || []).map((a) => a.name).join(' / '),
    publisher: (d.publishers || []).map((p) => p.name).join(' / '),
    pub_date: pickDate(d.publish_date),
    pages: d.number_of_pages || null,
    category: (d.subjects || []).slice(0, 4).map((s) => s.name).join(' / '),
    summary:
      (d.notes && (d.notes.value || d.notes)) ||
      (d.excerpts && d.excerpts[0] && d.excerpts[0].text) ||
      '',
    cover_url: (d.cover || {}).large || (d.cover || {}).medium || null,
  };
}

async function openLibrary(query, isIsbn) {
  if (isIsbn) {
    const data = await http.getJson(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${query}&format=json&jscmd=data`
    );
    const d = data[`ISBN:${query}`];
    return d ? [fromOpenLibraryData(d, query)] : [];
  }
  if (String(query).length < 3) return [];
  const data = await http.getJson(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=15`
  );
  return (data.docs || [])
    .map((d) => ({
      ...EMPTY,
      source: 'openlibrary',
      source_url: d.key ? `https://openlibrary.org${d.key}` : null,
      isbn13: (d.isbn || []).find((x) => x.length === 13) || null,
      isbn10: (d.isbn || []).find((x) => x.length === 10) || null,
      title: d.title || '',
      subtitle: d.subtitle || '',
      author: (d.author_name || []).join(' / '),
      publisher: (d.publisher || [])[0] || '',
      pub_date: d.first_publish_year ? String(d.first_publish_year) : null,
      pages: d.number_of_pages_median || null,
      language: (d.language || [])[0] || '',
      category: (d.subject || []).slice(0, 4).join(' / '),
      cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
      ext_rating: d.ratings_average ? Number(d.ratings_average.toFixed(1)) : null,
      ext_rating_count: d.ratings_count || null,
    }))
    .filter((b) => b.title);
}

// ---------------------------------------------------------------- 微信读书
async function weread(query, isIsbn) {
  if (isIsbn) return []; // 微信读书不支持 ISBN 检索
  const url = `https://weread.qq.com/web/search/global?keyword=${encodeURIComponent(
    query
  )}&maxIdx=0&fragmentSize=120&count=20`;
  const data = await http.getJson(url, { headers: { Referer: 'https://weread.qq.com/' } });
  return (data.books || [])
    .map((b) => b.bookInfo || {})
    .filter((b) => b.title)
    .map((b) => ({
      ...EMPTY,
      source: 'weread',
      source_url:
        b.deepLink || (b.bookId ? `https://weread.qq.com/web/bookDetail/${b.bookId}` : null),
      title: b.title,
      author: b.author || '',
      publisher: b.publisher || '',
      pub_date: pickDate(b.publishTime),
      list_price: b.price > 0 ? b.price : null,
      summary: (b.intro || '').trim(),
      cover_url: b.cover ? String(b.cover).replace(/\/s_/, '/t7_') : null,
      language: 'zh',
    }));
}

// ---------------------------------------------------------------- Z-Library
async function zlib(query) {
  return zlibrary.search(query);
}

const PROVIDERS = [
  { key: 'source_douban', name: '豆瓣读书', fn: (q, isIsbn) => douban.search(q, isIsbn), isbn: true, keyword: true },
  { key: 'source_zlibrary', name: 'Z-Library', fn: zlib, isbn: true, keyword: true },
  { key: 'source_googlebooks', name: 'Google Books', fn: googleBooks, isbn: true, keyword: true },
  { key: 'source_openlibrary', name: 'Open Library', fn: openLibrary, isbn: true, keyword: true },
  { key: 'source_weread', name: '微信读书', fn: weread, isbn: false, keyword: true },
];

/**
 * 统一查询。
 * @param {string} query  ISBN 或 书名/作者关键字
 * @param {string[]} [only] 只用这些来源（provider key），不传则按设置里的开关
 */
async function lookup(query, only) {
  const raw = String(query || '').trim();
  if (!raw) return { results: [], errors: [], isbn: null };

  const isbn13 = isbnUtil.isIsbn(raw) ? isbnUtil.to13(raw) : null;
  const q = isbn13 || raw;

  const active = PROVIDERS.filter((p) => {
    if (isbn13 && !p.isbn) return false;
    if (!isbn13 && !p.keyword) return false;
    return only ? only.includes(p.key) : settings.bool(p.key);
  });

  const settled = await Promise.allSettled(active.map((p) => p.fn(q, !!isbn13)));

  const results = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      results.push(...r.value);
    } else {
      const msg = String((r.reason && r.reason.message) || r.reason);
      errors.push({
        provider: active[i].name,
        code: r.reason && r.reason.code,
        message: /fetch failed|ECONN|timeout|aborted|UND_ERR/i.test(msg)
          ? `${msg}（连不上，可在设置里开启代理）`
          : msg,
      });
    }
  });

  if (isbn13) {
    for (const r of results) {
      if (!r.isbn13) r.isbn13 = isbn13;
      if (!r.isbn10) r.isbn10 = isbnUtil.to10(isbn13);
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = `${r.source}|${r.isbn13 || `${r.title}|${r.author}`}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  deduped.sort((a, b) => score(b) - score(a));
  return { results: deduped, errors, isbn: isbn13 };
}

function score(b) {
  let s = 0;
  if (b.isbn13) s += 4;
  if (b.cover_url) s += 3;
  if (b.summary) s += 2;
  if (b.publisher) s += 1;
  if (b.pub_date) s += 1;
  if (b.pages) s += 1;
  if (b.source === 'douban') s += 2;   // 中文书信息最全
  if (b.source === 'zlibrary') s += 1;
  return s;
}

/** 合并多个来源的同一本书，字段互补（先到的优先，空位由后面的补） */
function merge(list) {
  const out = { ...EMPTY };
  const sources = [];
  for (const r of list) {
    if (r.source && !sources.includes(r.source)) sources.push(r.source);
    for (const [k, v] of Object.entries(r)) {
      if (v === null || v === undefined || v === '') continue;
      if (out[k] === null || out[k] === undefined || out[k] === '') out[k] = v;
    }
  }
  out.source = sources.join('+');
  return out;
}

/** 把封面缓存到本地，返回文件名；失败返回 null（不阻塞录入） */
async function cacheCover(url, hint) {
  if (!url || !/^https?:/i.test(url)) return null;
  try {
    // 不少图片站有防盗链，不带 Referer 会被 403/418 挡掉
    let referer;
    try {
      referer = new URL(url).origin + '/';
    } catch {
      referer = undefined;
    }
    const { buffer, contentType } = await http.getBuffer(url, {
      timeout: 15000,
      headers: referer ? { Referer: referer } : {},
    });
    if (buffer.length < 1024) return null; // 多半是占位图
    const ext = /png/.test(contentType) ? '.png' : /webp/.test(contentType) ? '.webp' : '.jpg';
    const name = `${String(hint || 'cover').replace(/[^\w-]/g, '').slice(0, 24)}_${crypto
      .randomBytes(4)
      .toString('hex')}${ext}`;
    fs.writeFileSync(path.join(config.COVERS_DIR, name), buffer);
    return name;
  } catch {
    return null;
  }
}

module.exports = { lookup, cacheCover, merge, PROVIDERS };
