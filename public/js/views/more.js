/** 手机端的「我的」聚合页：账号、统计、笔记、成员、设置入口 */
import { h } from '../ui.js';
import api from '../api.js';
import { store, go, logout } from '../app.js';

export default async function more(root) {
  const stats = await api.stats().catch(() => null);

  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'page-title' }, (store.me && store.me.family.name) || '家庭图书馆'),
        h('div', { class: 'page-sub' }, stats ? `藏书 ${stats.overview.books} 本 · 累计花费 ¥${Math.round(stats.overview.spend_total)}` : '')
      )
    ),

    store.me
      ? h('div', { class: 'section' },
          h('div', { class: 'card pad' },
            h('div', { class: 'setting-row' },
              h('span', { style: { fontSize: '22px' } }, '👤'),
              h('div', { style: { flex: '1', minWidth: '0' } },
                h('div', { style: { fontWeight: '600' } }, store.me.user.name),
                h('div', { class: 'desc ellip' }, store.me.user.email)
              ),
              h('button', { class: 'btn sm danger', onclick: logout }, '退出')
            )
          )
        )
      : '', // append(null) 会显示成 "null"

    h('div', { class: 'section' },
      h('div', { class: 'section-title' }, '家庭成员'),
      h('div', { class: 'card pad' },
        store.members.filter((m) => m.active).map((m) =>
          h('div', {
            class: 'setting-row', style: { cursor: 'pointer' },
            onclick: () => go(`/?member=${m.id}`),
          },
            h('span', { style: { fontSize: '22px' } }, m.emoji),
            h('div', { style: { flex: '1' } },
              h('div', { style: { fontWeight: '600' } }, m.name),
              h('div', { class: 'desc' }, `已读 ${m.counts['已读']} · 在读 ${m.counts['在读']} · 待读 ${m.counts['待读']}`)
            ),
            h('span', { class: 'faint' }, '›')
          )
        )
      )
    ),

    h('div', { class: 'section' },
      h('div', { class: 'card pad' },
        entry('📊', '统计', '买书花费、阅读排行', '/stats'),
        entry('✍️', '读书笔记', '划线和想法', '/notes'),
        entry('📚', '书架', '全部藏书', '/'),
        entry('⚙️', '设置', '账号、家庭、邀请家人', '/settings')
      )
    ),

    h('div', { class: 'section' },
      h('div', { class: 'card pad' },
        h('a', { class: 'setting-row', href: '/api/export.csv', style: { textDecoration: 'none', color: 'inherit' } },
          h('span', { style: { fontSize: '20px' } }, '📤'),
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '导出 CSV'),
            h('div', { class: 'desc' }, '用 Excel 打开')
          )
        ),
        h('a', { class: 'setting-row', href: '/api/export.json', style: { textDecoration: 'none', color: 'inherit' } },
          h('span', { style: { fontSize: '20px' } }, '💾'),
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, '导出 JSON 备份'),
            h('div', { class: 'desc' }, '完整数据')
          )
        )
      )
    )
  );

  function entry(ico, title, desc, path) {
    return h('div', { class: 'setting-row', style: { cursor: 'pointer' }, onclick: () => go(path) },
      h('span', { style: { fontSize: '20px' } }, ico),
      h('div', { style: { flex: '1' } },
        h('div', { style: { fontWeight: '600' } }, title),
        h('div', { class: 'desc' }, desc)
      ),
      h('span', { class: 'faint' }, '›')
    );
  }
}
