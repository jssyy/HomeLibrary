/** 统计：买了多少、花了多少、谁读得最多 */
import { h, toast, money } from '../ui.js';
import api from '../api.js';
import { go } from '../app.js';

export default async function stats(root, { query }) {
  let year = query.year || String(new Date().getFullYear());
  const body = h('div', {});
  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'page-title' }, '统计'),
        h('div', { class: 'page-sub' }, '家里的书和阅读情况')
      ),
      h('div', { class: 'row', id: 'yearRow' })
    ),
    body
  );

  async function load() {
    body.innerHTML = '<div class="card pad muted">统计中…</div>';
    let data;
    try {
      data = await api.stats(year);
    } catch (e) {
      return toast(e.message, 'err');
    }

    const yearRow = document.getElementById('yearRow');
    yearRow.innerHTML = '';
    const years = data.years && data.years.length ? data.years : [year];
    for (const y of years) {
      yearRow.append(h('button', {
        class: `chip ${y === year ? 'on' : ''}`,
        onclick: () => { year = y; load(); },
      }, `${y} 年`));
    }

    const o = data.overview;
    body.innerHTML = '';
    body.append(
      h('div', { class: 'tiles' },
        tile('藏书总量', o.books, '本'),
        tile(`${year} 年购入`, o.bought_year, '本'),
        tile(`${year} 年花费`, money(o.spend_year).replace('¥', ''), '元'),
        tile('累计花费', money(o.spend_total).replace('¥', ''), '元'),
        tile(`${year} 年读完`, o.finished_year, '本'),
        tile('有电子版', o.ebooks, '本')
      ),

      section('每月购书', chart(data.byMonth, (d) => d.count, (d) => d.month.slice(5) + '月',
        (d) => `${d.month}：${d.count} 本 · ${money(d.amount)}`)),

      section('每月读完', chart(data.finishedByMonth, (d) => d.count, (d) => d.month.slice(5) + '月',
        (d) => `${d.month}：${d.count} 本`)),

      section('家庭成员', h('div', { style: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' } },
        data.members.map((m) =>
          h('div', { class: 'card pad' },
            h('div', { class: 'row' },
              h('span', { style: { fontSize: '20px' } }, m.emoji),
              h('span', { style: { fontWeight: '650' } }, m.name),
              h('span', { style: { flex: '1' } }),
              h('span', { class: 'tiny faint' }, `${year} 年 ${m.finished_year} 本`)
            ),
            h('div', { class: 'row', style: { marginTop: '10px', gap: '14px' } },
              miniStat('已读', m.finished, 'var(--ok)'),
              miniStat('在读', m.reading, 'var(--warn)'),
              miniStat('待读', m.todo, 'var(--text-faint)')
            ),
            h('div', { class: 'tiny faint', style: { marginTop: '8px' } }, `累计读过约 ${m.pages_read.toLocaleString()} 页`),
            h('div', { class: 'row', style: { marginTop: '8px' } },
              h('button', { class: 'btn sm ghost', onclick: () => go(`/?member=${m.id}&status=在读`) }, '看在读'),
              h('button', { class: 'btn sm ghost', onclick: () => go(`/?member=${m.id}&status=已读`) }, '看已读')
            )
          )
        )
      )),

      data.channels.length ? section('购买渠道', h('div', { class: 'card pad' },
        data.channels.map((c) => bar(c.channel, c.count, Math.max(...data.channels.map((x) => x.count)), `${c.count} 本 · ${money(c.amount)}`))
      )) : null,

      data.categories.length ? section('分类分布', h('div', { class: 'card pad' },
        data.categories.map((c) => bar(c.name, c.count, Math.max(...data.categories.map((x) => x.count)), `${c.count} 本`))
      )) : null,

      data.authors.length ? section('读得最多的作者', h('div', { class: 'card pad' },
        data.authors.map((a) => bar(a.name, a.count, Math.max(...data.authors.map((x) => x.count)), `${a.count} 本`))
      )) : null,

      h('div', { class: 'section' },
        h('div', { class: 'row' },
          h('a', { class: 'btn sm', href: '/api/export.csv' }, '导出 CSV（Excel 可开）'),
          h('a', { class: 'btn sm', href: '/api/export.json' }, '导出 JSON 备份')
        )
      )
    );
  }

  function tile(k, v, u) {
    return h('div', { class: 'card tile' },
      h('div', { class: 'k' }, k),
      h('div', { class: 'v' }, String(v ?? 0), h('span', { class: 'u' }, u))
    );
  }

  function miniStat(label, v, color) {
    return h('div', {},
      h('div', { style: { fontSize: '18px', fontWeight: '700', color } }, String(v || 0)),
      h('div', { class: 'tiny faint' }, label)
    );
  }

  function section(title, node) {
    return h('div', { class: 'section' }, h('div', { class: 'section-title' }, title), node);
  }

  function chart(rows, valueOf, labelOf, titleOf) {
    if (!rows || !rows.length) return h('div', { class: 'card pad muted small' }, '这一年还没有数据');
    const max = Math.max(...rows.map(valueOf), 1);
    return h('div', { class: 'card pad' },
      h('div', { class: 'barchart' }, rows.map((d) =>
        h('div', { class: 'col', title: titleOf(d) },
          h('span', { class: 'tiny faint' }, String(valueOf(d))),
          h('i', { style: { height: `${(valueOf(d) / max) * 100}%` } }),
          h('span', { class: 'lbl' }, labelOf(d))
        )
      ))
    );
  }

  function bar(label, v, max, right) {
    return h('div', { style: { margin: '7px 0' } },
      h('div', { class: 'row tiny', style: { marginBottom: '3px' } },
        h('span', { class: 'ellip', style: { flex: '1' } }, label),
        h('span', { class: 'faint' }, right)
      ),
      h('div', { class: 'bar' }, h('i', { style: { width: `${(v / max) * 100}%` } }))
    );
  }

  await load();
}
