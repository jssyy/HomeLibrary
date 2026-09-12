/**
 * 豆瓣读书来源。
 * 官方 v2 API 早就关了，现在能用的是两个公开入口：
 *   - 关键字：/j/subject_suggest 返回 JSON
 *   - ISBN  ：/isbn/<isbn>/ 会 302 到条目页，解析页面拿完整字段
 * 国内直连可用，不需要代理。访问太频繁会被限流，所以每本书只查一次、结果落本地库。
 */
const http = require('./http');
const isbnUtil = require('./isbn');
const settings = require('../settings');

const BASE = 'https://book.douban.com';

function headers() {
  const h = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: `${BASE}/`,
  };
  const cookie = settings.get('douban_cookie');
  if (cookie) h.Cookie = cookie;
  return h;
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

const text = (html) => decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const EMPTY = {
  isbn13: null, isbn10: null, title: '', subtitle: '', original_title: '', author: '', translator: '',
  publisher: '', pub_date: null, pages: null, list_price: null, language: '',
  category: '', summary: '', cover_url: null, ext_rating: null, ext_rating_count: null,
  source: 'douban', source_url: null,
};

/** 条目页里 `<span class="pl">出版社:</span> xxx<br/>` 这种字段 */
function infoField(html, label) {
  const re = new RegExp(
    `<span[^>]*class="pl"[^>]*>\\s*${label}\\s*:?\\s*</span>([\\s\\S]*?)(?:<br\\s*/?>|</div>)`,
    'i'
  );
  const m = re.exec(html);
  // 豆瓣的冒号写在 label 标签外面，会被一起捕获，这里去掉
  return m ? text(m[1]).replace(/^[:：]\s*/, '') : '';
}

function parseSubject(html, url) {
  const pick = (re) => {
    const m = re.exec(html);
    return m ? text(m[1]) : '';
  };

  const title = pick(/<span[^>]*property="v:itemreviewed"[^>]*>([\s\S]*?)<\/span>/i) ||
    pick(/<title>([\s\S]*?)\(豆瓣\)<\/title>/i);
  if (!title) return null;

  const price = infoField(html, '定价');
  const pages = infoField(html, '页数');
  const isbn = infoField(html, 'ISBN').replace(/[^0-9Xx]/g, '');
  const pubDate = infoField(html, '出版年');
  const rating = pick(/<strong[^>]*class="[^"]*rating_num[^"]*"[^>]*>([\s\S]*?)<\/strong>/i);
  const votes = pick(/<span[^>]*property="v:votes"[^>]*>([\s\S]*?)<\/span>/i);
  const coverM = /<a[^>]*class="nbg"[^>]*>\s*<img[^>]*src="([^"]+)"/i.exec(html) ||
    /<img[^>]*rel="v:photo"[^>]*src="([^"]+)"/i.exec(html);

  // 简介：只取「内容简介」那一段（页面里「作者简介」也用同样的 .intro），
  // 段内可能有收起/展开两份，取更长的那份
  let summary = '';
  const start = html.search(/内容简介/);
  if (start >= 0) {
    const authorIntro = html.indexOf('作者简介', start);
    const segment = html.slice(start, authorIntro > 0 ? authorIntro : start + 20000);
    const introRe = /<div class="intro">([\s\S]*?)<\/div>/gi;
    let m;
    while ((m = introRe.exec(segment))) {
      const t = decode(m[1].replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '')).trim();
      if (t.length > summary.length) summary = t;
    }
  }

  const isbn13 = isbn ? isbnUtil.to13(isbn) : null;
  let cover = coverM ? coverM[1] : null;
  // s_ 是小图，换成大图
  if (cover) cover = cover.replace('/s/public/', '/l/public/').replace('/s_', '/l_');

  return {
    ...EMPTY,
    source_url: url,
    isbn13,
    isbn10: isbn13 ? isbnUtil.to10(isbn13) : null,
    title,
    subtitle: infoField(html, '副标题'),
    original_title: infoField(html, '原作名'),
    author: infoField(html, '作者').replace(/\s*\/\s*/g, ' / '),
    translator: infoField(html, '译者'),
    publisher: infoField(html, '出版社') || infoField(html, '出品方'),
    pub_date: pubDate ? normDate(pubDate) : null,
    pages: pages ? Number(pages.replace(/[^\d]/g, '')) || null : null,
    list_price: price ? Number((price.match(/[\d.]+/) || [])[0]) || null : null,
    series: infoField(html, '丛书'),
    language: 'zh',
    summary,
    cover_url: cover,
    ext_rating: rating ? Number(rating) || null : null,
    ext_rating_count: votes ? Number(votes) || null : null,
  };
}

function normDate(s) {
  const m = /(\d{4})(?:[-年/](\d{1,2}))?(?:[-月/](\d{1,2}))?/.exec(String(s));
  if (!m) return null;
  return [m[1], m[2] && m[2].padStart(2, '0'), m[3] && m[3].padStart(2, '0')].filter(Boolean).join('-');
}

/** 按 ISBN 查（豆瓣会 302 到条目页） */
async function byIsbn(isbn) {
  const res = await http.request(`${BASE}/isbn/${encodeURIComponent(isbn)}/`, {
    raw: true, timeout: 15000, headers: headers(),
  });
  const html = await res.text();
  if (/登录|验证码|sec\.douban\.com/.test(html) && !/v:itemreviewed/.test(html)) {
    const e = new Error('豆瓣要求登录/验证，可在设置里填豆瓣 Cookie');
    e.code = 'DOUBAN_BLOCKED';
    throw e;
  }
  const book = parseSubject(html, res.url || `${BASE}/isbn/${isbn}/`);
  return book ? [book] : [];
}

/** 关键字搜索（suggest 接口，字段少，够用来选条目） */
async function byKeyword(q) {
  const data = await http.getJson(
    `${BASE}/j/subject_suggest?q=${encodeURIComponent(q)}`,
    { headers: headers(), timeout: 12000 }
  );
  return (Array.isArray(data) ? data : [])
    .filter((d) => d.type === 'b' && d.title)
    .map((d) => ({
      ...EMPTY,
      source_url: d.url,
      title: decode(d.title),
      author: decode(d.author_name || ''),
      pub_date: d.year || null,
      cover_url: d.pic ? String(d.pic).replace('/s/public/', '/m/public/') : null,
      douban_id: d.id,
    }));
}

/** 补全：搜索结果字段太少时，按条目页再抓一次 */
async function detail(url) {
  const res = await http.request(url, { raw: true, timeout: 15000, headers: headers() });
  const html = await res.text();
  return parseSubject(html, url);
}

async function search(query, isIsbn) {
  return isIsbn ? byIsbn(query) : byKeyword(query);
}

module.exports = { search, byIsbn, byKeyword, detail, parseSubject };
