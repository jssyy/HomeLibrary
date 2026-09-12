/** 书架 */
import { h, toast, coverNode, STATUS_LIST } from '../ui.js';
import api from '../api.js';
import { store, go } from '../app.js';

const VIEW_KEY = 'hl_shelf_view';

export default async function shelf(root, { query }) {
  const state = {
    q: query.q || '',
    carrier: query.carrier || '',
    category: query.category || '',
    tag: query.tag || '',
    status: query.status || '',
    member: query.member || (store.currentMember ? String(store.currentMember) : ''),
    ebook: query.ebook || '',
    sort: query.sort || 'new',
    page: 1,
    size: 24,
    layout: localStorage.getItem(VIEW_KEY) || 'grid',
  };

  const searchBox = document.getElementById('globalSearch');
  if (searchBox && searchBox.value !== state.q) {
    searchBox.value = state.q;
    document.getElementById('btnClearSearch').hidden = !state.q;
  }

  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('div', { class: 'page-title' }, '书架'),
      h('div', { class: 'page-sub', id: 'shelfCount' }, '加载中…')
    ),
    h('div', { class: 'row' },
      h('select', {
        class: 'btn', style: { paddingRight: '10px' },
        onchange: (e) => { state.sort = e.target.value; reload(); },
      },
        [['new', '最近录入'], ['title', '书名'], ['author', '作者'], ['pub', '出版时间'], ['price', '定价'], ['rating', '评分']]
          .map(([v, l]) => h('option', { value: v, selected: state.sort === v || undefined }, l))
      ),
      h('button', {
        class: 'btn ghost', title: '切换视图',
        onclick: (e) => {
          state.layout = state.layout === 'grid' ? 'list' : 'grid';
          localStorage.setItem(VIEW_KEY, state.layout);
          e.target.textContent = state.layout === 'grid' ? '☰' : '▦';
          paint();
        },
      }, state.layout === 'grid' ? '☰' : '▦')
    )
  );

  const filterBar = h('div', { class: 'scroll-x', style: { marginBottom: '14px' } });
  const listBox = h('div', {});
  const moreBox = h('div', { style: { textAlign: 'center', marginTop: '22px' } });

  root.append(head, filterBar, listBox, moreBox,
    h('button', { class: 'fab', title: '扫码录入', onclick: () => go('/scan') }, '＋')
  );

  let items = [];
  let total = 0;

  async function buildFilters() {
    const facets = await api.facets().catch(() => ({ carriers: [], categories: [], tags: [] }));
    filterBar.innerHTML = '';

    const chip = (label, on, onclick) => h('button', { class: `chip ${on ? 'on' : ''}`, onclick }, label);

    // 成员 × 状态
    for (const m of store.members) {
      const on = String(state.member) === String(m.id);
      filterBar.append(chip(`${m.emoji} ${m.name}`, on, () => {
        state.member = on ? '' : String(m.id);
        reload();
      }));
    }
    if (state.member) {
      for (const s of STATUS_LIST) {
        const on = state.status === s;
        filterBar.append(chip(s, on, () => { state.status = on ? '' : s; reload(); }));
      }
    }
    filterBar.append(h('span', { style: { width: '1px', background: 'var(--line)', margin: '4px 2px', flex: 'none' } }));
    for (const c of facets.carriers || []) {
      const on = state.carrier === c.value;
      filterBar.append(chip(`${c.value} ${c.count}`, on, () => { state.carrier = on ? '' : c.value; reload(); }));
    }
    filterBar.append(chip('📁 有电子书', state.ebook === '1', () => {
      state.ebook = state.ebook === '1' ? '' : '1';
      reload();
    }));
    for (const c of (facets.categories || []).slice(0, 12)) {
      const on = state.category === c.value;
      filterBar.append(chip(`${c.value} ${c.count}`, on, () => { state.category = on ? '' : c.value; reload(); }));
    }
    for (const t of (facets.tags || []).slice(0, 12)) {
      const on = state.tag === t.value;
      filterBar.append(chip(`#${t.value}`, on, () => { state.tag = on ? '' : t.value; reload(); }));
    }
  }

  async function load(append = false) {
    const data = await api.books({
      q: state.q, carrier: state.carrier, category: state.category, tag: state.tag,
      status: state.status, member: state.member, ebook: state.ebook,
      sort: state.sort, page: state.page, size: state.size,
    });
    items = append ? items.concat(data.items) : data.items;
    total = data.total;
    document.getElementById('shelfCount').textContent =
      total ? `共 ${total} 本${state.q ? ` · 搜索「${state.q}」` : ''}` : '一本都还没有';
    paint();
    moreBox.innerHTML = '';
    if (items.length < total) {
      moreBox.append(h('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = '加载中…';
          state.page++;
          await load(true);
        },
      }, `加载更多（还有 ${total - items.length} 本）`));
    }
  }

  function reload() {
    state.page = 1;
    const qs = new URLSearchParams(
      Object.entries({ q: state.q, carrier: state.carrier, category: state.category, tag: state.tag, status: state.status, member: state.member, ebook: state.ebook, sort: state.sort })
        .filter(([, v]) => v)
    ).toString();
    history.replaceState(null, '', `#/${qs ? '?' + qs : ''}`);
    buildFilters();
    load().catch((e) => toast(e.message, 'err'));
  }

  function paint() {
    listBox.innerHTML = '';
    if (!items.length) {
      listBox.append(
        h('div', { class: 'empty' },
          h('div', { class: 'big' }, '📭'),
          h('div', {}, state.q ? '没找到匹配的书' : '书架还空着'),
          h('div', { class: 'small faint', style: { marginTop: '8px' } }, '点右下角「＋」扫码录入第一本书'),
        )
      );
      return;
    }
    listBox.append(state.layout === 'grid' ? gridNode(items) : rowsNode(items));
  }

  buildFilters();
  await load().catch((e) => toast(e.message, 'err'));
}

export function gridNode(items) {
  return h('div', { class: 'book-grid' }, items.map(bookCard));
}

export function bookCard(b) {
  const badges = [];
  if (b.has_ebook) badges.push({ text: '电子', kind: 'ebook' });
  const reading = (b.readings || []).filter((r) => r.status === '在读');
  const done = (b.readings || []).filter((r) => r.status === '已读');
  if (reading.length) badges.push({ text: '在读', kind: 'reading' });
  else if (done.length) badges.push({ text: '已读', kind: 'done' });

  return h('div', { class: 'book-card', onclick: () => go(`/book/${b.id}`) },
    coverNode(b, { badges }),
    h('div', {},
      h('div', { class: 'book-title clamp2' }, b.title),
      h('div', { class: 'book-author ellip' }, b.author || ' '),
      h('div', { class: 'dots' },
        (b.readings || []).map((r) =>
          h('span', {
            class: `dot ${r.status === '在读' ? 'reading' : r.status === '已读' ? 'done' : ''}`,
            style: { background: r.status === '待读' ? 'var(--text-faint)' : r.color },
            title: `${r.member_name} · ${r.status}`,
          })
        )
      )
    )
  );
}

export function rowsNode(items) {
  return h('div', { class: 'book-rows' }, items.map((b) =>
    h('div', { class: 'book-row', onclick: () => go(`/book/${b.id}`) },
      h('div', { class: 'thumb' }, coverNode(b)),
      h('div', { style: { minWidth: '0', flex: '1' } },
        h('div', { class: 'ellip', style: { fontWeight: '600' } }, b.title),
        h('div', { class: 'tiny faint ellip' }, [b.author, b.publisher, b.pub_date && String(b.pub_date).slice(0, 4)].filter(Boolean).join(' · ')),
        h('div', { class: 'dots' },
          (b.readings || []).map((r) =>
            h('span', {
              class: `dot ${r.status === '在读' ? 'reading' : r.status === '已读' ? 'done' : ''}`,
              style: { background: r.status === '待读' ? 'var(--text-faint)' : r.color },
              title: `${r.member_name} · ${r.status}`,
            })
          )
        )
      ),
      b.has_ebook ? h('span', { class: 'src-tag' }, '电子书') : null
    )
  ));
}
