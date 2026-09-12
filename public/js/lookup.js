/**
 * 逐源并行查书目：哪个来源先回来就先显示哪个，
 * 不必等最慢的那个（国内没开代理时，Google / Z-Library 会一直等到超时）。
 */
import api from './api.js';
import { store } from './app.js';

export const SOURCE_NAMES = {
  source_douban: '豆瓣',
  source_zlibrary: 'Z-Library',
  source_googlebooks: 'Google Books',
  source_openlibrary: 'Open Library',
  source_weread: '微信读书',
};

export function sourceLabel(source) {
  return {
    douban: '豆瓣', zlibrary: 'Z-Library', googlebooks: 'Google Books',
    openlibrary: 'Open Library', weread: '微信读书', import: '旧库导入', manual: '手工',
  }[source] || source || '';
}

/** 当前启用、且支持这种查询方式的来源 */
export function activeProviders(isIsbn) {
  const providers = store.settings.providers || [];
  return providers.filter((p) => store.settings[p.key] === '1' && (!isIsbn || p.isbn));
}

/**
 * @param {string} query
 * @param {{onStart:Function,onSource:Function,onResults:Function}} handlers
 * @returns {Promise<{results:array, errors:array, isbn:string|null, existing:object|null}>}
 */
export async function lookupProgressive(query, handlers = {}) {
  const q = String(query || '').trim();
  const isIsbn = /^[\d-]{10,17}[\dXx]?$/.test(q.replace(/\s/g, ''));
  const providers = activeProviders(isIsbn);

  if (handlers.onStart) handlers.onStart(providers, isIsbn);

  const seen = new Set();
  const all = [];
  const errors = [];
  let meta = { isbn: null, existing: null, existing_list: [], zlib_url: null };

  await Promise.all(
    providers.map(async (p) => {
      try {
        const out = await api.lookup(q, p.key);
        meta = {
          isbn: out.isbn,
          existing: out.existing || meta.existing,
          existing_list: (out.existing_list && out.existing_list.length) ? out.existing_list : meta.existing_list,
          zlib_url: out.zlib_url,
        };
        const fresh = [];
        for (const r of out.results || []) {
          const key = `${r.source}|${r.isbn13 || `${r.title}|${r.author}`}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          fresh.push(r);
          all.push(r);
        }
        for (const e of out.errors || []) errors.push(e);
        if (handlers.onSource) {
          handlers.onSource(p, {
            ok: !(out.errors || []).length,
            count: fresh.length,
            error: (out.errors || [])[0],
          });
        }
        if (fresh.length && handlers.onResults) handlers.onResults(fresh, meta);
      } catch (e) {
        errors.push({ provider: p.name, message: e.message });
        if (handlers.onSource) handlers.onSource(p, { ok: false, count: 0, error: { message: e.message } });
      }
    })
  );

  return { results: all, errors, ...meta };
}
