/** 统一的外网请求出口：按设置决定是否走代理 */
const settings = require('../settings');

let cached = { url: null, agent: null };

function dispatcher() {
  if (!settings.bool('proxy_enabled')) return undefined;
  const url = settings.get('proxy_url');
  if (!url) return undefined;
  if (cached.url !== url) {
    const { ProxyAgent } = require('undici');
    cached = { url, agent: new ProxyAgent(url) };
  }
  return cached.agent;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function request(url, { timeout = 12000, headers = {}, raw = false, method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: ctrl.signal,
      dispatcher: dispatcher(),
      headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', ...headers },
    });
    if (!res.ok) {
      // 接口报错时把返回体带上，不然只看到一个光秃秃的状态码
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch { /* 读不出来就算了 */ }
      const err = new Error(detail ? `HTTP ${res.status}：${detail}` : `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return raw ? res : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  return request(url, opts);
}

async function getBuffer(url, opts = {}) {
  const res = await request(url, { ...opts, raw: true });
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}

/** 测试代理/网络连通性 */
async function ping(url, timeout = 8000) {
  const t0 = Date.now();
  try {
    await request(url, { timeout, raw: true });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e.message || e) };
  }
}

module.exports = { getJson, getBuffer, request, ping, UA };
