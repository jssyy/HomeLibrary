/** 应用外壳：路由、导航、全局状态 */
import { h, $, toast, debounce } from './ui.js';
import api from './api.js';

const memberKey = () => `hl_member_${store.me ? store.me.user.id : 0}`;

export const store = {
  me: null, // { user, family, member_id }
  members: [],
  settings: {},
  // 侧边栏选中的成员：用来筛书架、看某人在读什么。按账号分开记，换人登录不串
  currentMember: null,
  refreshMembers: async () => {
    store.members = await api.members();
    renderMemberChips();
    return store.members;
  },
  setMember(id) {
    store.currentMember = id || null;
    try {
      if (id) localStorage.setItem(memberKey(), id);
      else localStorage.removeItem(memberKey());
    } catch { /* 隐私模式 */ }
    renderMemberChips();
  },
  member(id) {
    return store.members.find((m) => m.id === Number(id));
  },
  /** 「以谁的身份」录购买、写笔记：侧边栏选了谁就是谁，否则是自己 */
  actingMember() {
    return store.currentMember || (store.me && store.me.member_id) || null;
  },
};

export async function logout() {
  try {
    await api.logout();
  } catch { /* 反正要走 */ }
  // 离线缓存里有上一个人的书库数据，退出时清掉
  if (window.caches) {
    try {
      for (const k of await caches.keys()) await caches.delete(k);
    } catch { /* ignore */ }
  }
  location.href = '/login.html';
}

const NAV = [
  { path: '/', label: '书架', ico: '📚', mobile: true },
  { path: '/purchases', label: '购书记录', ico: '🧾', mobile: true },
  { path: '/scan', label: '扫码录入', ico: '⌸', mobile: true, center: true },
  { path: '/reading', label: '在读', ico: '📖', mobile: true },
  { path: '/notes', label: '笔记', ico: '✍️' },
  { path: '/stats', label: '统计', ico: '📊' },
  { path: '/settings', label: '设置', ico: '⚙️' },
  { path: '/more', label: '我的', ico: '👤', mobile: true, mobileOnly: true },
];

const routes = [];
export function route(pattern, loader) {
  const names = [];
  const re = new RegExp(
    '^' + pattern.replace(/:([\w]+)/g, (_, n) => {
      names.push(n);
      return '([^/]+)';
    }) + '$'
  );
  routes.push({ re, names, loader });
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(query || '')) };
}

export function go(to, { replace = false } = {}) {
  const url = `#${to}`;
  if (replace) location.replace(url);
  else location.hash = to;
}

let currentCleanup = null;

async function render() {
  const { path, query } = parseHash();
  const view = $('#view');

  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    if (currentCleanup) {
      try { currentCleanup(); } catch { /* ignore */ }
      currentCleanup = null;
    }
    view.innerHTML = '';
    highlightNav(path);
    window.scrollTo(0, 0);
    try {
      const mod = await r.loader();
      const out = await mod.default(view, { params, query });
      if (typeof out === 'function') currentCleanup = out;
    } catch (e) {
      console.error(e);
      view.innerHTML = '';
      view.append(
        h('div', { class: 'empty' },
          h('div', { class: 'big' }, '😵'),
          h('div', {}, '页面出错了'),
          h('div', { class: 'small faint', style: { marginTop: '6px' } }, e.message || String(e))
        )
      );
    }
    return;
  }
  view.innerHTML = '<div class="empty"><div class="big">🧭</div><div>没有这个页面</div></div>';
}

function highlightNav(path) {
  for (const a of document.querySelectorAll('.nav a, .tabbar a')) {
    const p = a.getAttribute('data-path');
    a.classList.toggle('active', p === path || (p !== '/' && path.startsWith(p)));
  }
  const back = $('#btnBack');
  if (back) back.hidden = ['/', '/purchases', '/scan', '/reading', '/more'].includes(path);
}

function buildNav() {
  const desktop = $('#navDesktop');
  desktop.innerHTML = '';
  for (const n of NAV) {
    if (n.mobileOnly) continue;
    desktop.append(
      h('a', { href: `#${n.path}`, 'data-path': n.path },
        h('span', { class: 'ico' }, n.ico),
        h('span', {}, n.label)
      )
    );
  }
  const mobile = $('#navMobile');
  mobile.innerHTML = '';
  for (const n of NAV.filter((x) => x.mobile)) {
    mobile.append(
      h('a', { href: `#${n.path}`, 'data-path': n.path, class: n.center ? 'scan' : '' },
        h('span', { class: 'ico' }, n.ico),
        h('span', {}, n.label)
      )
    );
  }
}

function renderMemberChips() {
  const box = $('#memberChips');
  if (!box) return;
  box.innerHTML = '';
  box.append(
    store.me
      ? h('div', { class: 'row', style: { width: '100%', marginBottom: '10px', gap: '6px', flexWrap: 'nowrap' } },
          h('a', { href: '#/settings', class: 'small ellip', style: { flex: '1', color: 'var(--text-dim)' }, title: store.me.user.email }, `👤 ${store.me.user.name}`),
          h('button', { class: 'btn ghost sm', onclick: logout }, '退出'))
      : '', // append(null) 会显示成 "null"
    h('div', { class: 'tiny faint', style: { width: '100%', marginBottom: '4px' } }, '家庭成员'),
    ...store.members.filter((m) => m.active).map((m) =>
      h('button', {
        class: `member-chip ${store.currentMember === m.id ? 'on' : ''}`,
        style: store.currentMember === m.id ? { borderColor: m.color, color: m.color } : {},
        onclick: () => {
          store.setMember(store.currentMember === m.id ? null : m.id);
          render();
        },
        title: `已读 ${m.counts['已读']} · 在读 ${m.counts['在读']}`,
      }, `${m.emoji} ${m.name}${m.is_me ? '（我）' : ''}`)
    )
  );
}

export function applyFamilyName(name) {
  $('#brandName').textContent = name || '家庭图书馆';
  document.title = name || '家庭图书馆';
}

// ------------------------------------------------------------------ 路由表

route('/', () => import('./views/shelf.js'));
route('/book/:id', () => import('./views/book.js'));
route('/scan', () => import('./views/scan.js'));
route('/add', () => import('./views/edit.js'));
route('/edit/:id', () => import('./views/edit.js'));
route('/purchases', () => import('./views/purchases.js'));
route('/reading', () => import('./views/reading.js'));
route('/notes', () => import('./views/notes.js'));
route('/stats', () => import('./views/stats.js'));
route('/settings', () => import('./views/settings.js'));
route('/more', () => import('./views/more.js'));

// ------------------------------------------------------------------ 启动

async function boot() {
  buildNav();

  $('#btnScanTop').addEventListener('click', () => go('/scan'));
  $('#btnBack').addEventListener('click', () => history.back());

  const search = $('#globalSearch');
  const clear = $('#btnClearSearch');
  const onSearch = debounce(() => {
    const q = search.value.trim();
    clear.hidden = !q;
    const { path } = parseHash();
    if (path !== '/') go(`/?q=${encodeURIComponent(q)}`);
    else {
      history.replaceState(null, '', `#/?q=${encodeURIComponent(q)}`);
      render();
    }
  }, 320);
  search.addEventListener('input', onSearch);
  clear.addEventListener('click', () => {
    search.value = '';
    clear.hidden = true;
    go('/');
  });

  try {
    store.me = await api.me();
  } catch (e) {
    if (e.status === 401) return; // api.js 已经跳去登录页了
    toast('连不上服务：' + e.message, 'err');
  }
  if (store.me && !store.me.family) {
    location.href = '/login.html#family';
    return;
  }
  if (store.me) {
    try {
      store.currentMember = Number(localStorage.getItem(memberKey()) || 0) || null;
    } catch { /* 隐私模式 */ }
    applyFamilyName(store.me.family.name);
  }

  try {
    const [, settings] = await Promise.all([store.refreshMembers(), api.settings()]);
    store.settings = settings;
    if (store.currentMember && !store.member(store.currentMember)) store.setMember(null);
  } catch (e) {
    toast('连不上服务：' + e.message, 'err');
  }

  window.addEventListener('hashchange', render);
  render();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
