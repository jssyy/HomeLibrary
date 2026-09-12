/** 应用外壳：路由、导航、全局状态 */
import { h, $, toast, debounce } from './ui.js';
import api from './api.js';

export const store = {
  members: [],
  settings: {},
  currentMember: Number(localStorage.getItem('hl_member') || 0) || null,
  refreshMembers: async () => {
    store.members = await api.members();
    renderMemberChips();
    return store.members;
  },
  setMember(id) {
    store.currentMember = id || null;
    if (id) localStorage.setItem('hl_member', id);
    else localStorage.removeItem('hl_member');
    renderMemberChips();
  },
  member(id) {
    return store.members.find((m) => m.id === Number(id));
  },
};

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
    h('div', { class: 'tiny faint', style: { width: '100%', marginBottom: '4px' } }, '家庭成员'),
    ...store.members.map((m) =>
      h('button', {
        class: `member-chip ${store.currentMember === m.id ? 'on' : ''}`,
        style: store.currentMember === m.id ? { borderColor: m.color, color: m.color } : {},
        onclick: () => {
          store.setMember(store.currentMember === m.id ? null : m.id);
          render();
        },
        title: `已读 ${m.counts['已读']} · 在读 ${m.counts['在读']}`,
      }, `${m.emoji} ${m.name}`)
    )
  );
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
    const [, settings] = await Promise.all([store.refreshMembers(), api.settings()]);
    store.settings = settings;
    if (settings.library_name) $('#brandName').textContent = settings.library_name;
    document.title = settings.library_name || '家庭图书馆';
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
