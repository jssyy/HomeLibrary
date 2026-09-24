/**
 * 在线阅读器：EPUB 走 epub.js，PDF 走 pdf.js。
 * 阅读位置和进度按「书 × 成员」存回服务端，换设备接着读。
 */
const $ = (s) => document.querySelector(s);

const fileId = Number(location.pathname.split('/').pop());
const params = new URLSearchParams(location.search);

const state = {
  file: null,
  memberId: Number(params.get('member') || 0) || null, // 没指定就用当前账号自己的档案，见 boot()
  percent: 0,
  location: null,
  fontScale: Number(localStorage.getItem('rd_font') || 100),
  theme: localStorage.getItem('rd_theme') || 'light',
  flow: localStorage.getItem('rd_flow') || 'paginated',
  barsVisible: true,
};

let book = null;      // epub.js Book
let rendition = null; // epub.js Rendition
let pdf = null;       // pdf.js PDFDocumentProxy
let renderPdfNear = null; // 渲染视口附近的 PDF 页

// ------------------------------------------------------------------ 工具

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'rd-toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2000);
}

async function apiGet(url) {
  const r = await fetch(url);
  if (r.status === 401) location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

async function apiSend(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ------------------------------------------------------------------ 进度保存

const saveProgress = debounce(async () => {
  if (!state.memberId || !state.file) return;
  try {
    await apiSend('PUT', `/api/books/${state.file.book_id}/readings/${state.memberId}`, {
      progress: Math.round(state.percent * 1000) / 10,
      location: state.location,
      status: state.percent >= 0.995 ? '已读' : '在读',
      log: false,
    });
  } catch { /* 网络断了不打断阅读 */ }
}, 1500);

function setPercent(p) {
  state.percent = Math.min(Math.max(p || 0, 0), 1);
  const pct = Math.round(state.percent * 100);
  $('#progress').value = pct;
  $('#pctText').textContent = `${pct}%`;
  saveProgress();
}

// ------------------------------------------------------------------ 启动

async function boot() {
  applyTheme(state.theme);

  try {
    if (!state.memberId) state.memberId = (await apiGet('/api/auth/me')).member_id;
    state.file = await apiGet(`/api/files/${fileId}`);
  } catch (e) {
    $('#loading').textContent = `打不开：${e.message}`;
    return;
  }

  $('#rdTitle').textContent = state.file.title || state.file.name;
  document.title = state.file.title || '阅读';
  $('#bookLink').href = `/#/book/${state.file.book_id}`;
  $('#btnBack').addEventListener('click', () => {
    location.href = `/#/book/${state.file.book_id}`;
  });

  buildMemberSelect();
  bindUi();

  const mine = state.file.readings.find((r) => r.member_id === state.memberId);
  state.location = mine ? mine.location : null;
  state.percent = mine ? (mine.progress || 0) / 100 : 0;

  if (state.file.format === 'epub') await openEpub();
  else if (state.file.format === 'pdf') await openPdf();
  else $('#loading').textContent = '这个格式暂时不支持在线阅读，可以先下载到本地看。';
}

function buildMemberSelect() {
  const sel = $('#memberSelect');
  sel.innerHTML = '';
  for (const r of state.file.readings) {
    const opt = document.createElement('option');
    opt.value = r.member_id;
    opt.textContent = `${r.emoji} ${r.member_name}（${r.status} ${Math.round(r.progress || 0)}%）`;
    if (r.member_id === state.memberId) opt.selected = true;
    sel.append(opt);
  }
  if (!state.memberId && state.file.readings.length) {
    state.memberId = state.file.readings[0].member_id;
    sel.value = state.memberId;
  }
  sel.addEventListener('change', () => {
    state.memberId = Number(sel.value);
    const r = state.file.readings.find((x) => x.member_id === state.memberId);
    if (r && r.location) {
      state.location = r.location;
      if (rendition) rendition.display(r.location);
      else if (pdf) scrollToPdfPage(Number(r.location) || 1);
    }
    toast(`切换到 ${r ? r.member_name : ''} 的进度`);
  });
}

// ------------------------------------------------------------------ EPUB

async function openEpub() {
  book = window.ePub(`/api/files/${fileId}/raw`, { openAs: 'epub' });

  rendition = book.renderTo('viewer', {
    width: '100%',
    height: '100%',
    flow: state.flow,
    spread: 'none',
    allowScriptedContent: false,
  });

  applyEpubTheme();
  await rendition.display(state.location || undefined);
  $('#loading').hidden = true;

  book.ready
    .then(() => book.locations.generate(1650))
    .then(() => {
      const loc = rendition.currentLocation();
      if (loc && loc.start) setPercent(book.locations.percentageFromCfi(loc.start.cfi));
    })
    .catch(() => { /* 分页索引生成失败不影响阅读 */ });

  rendition.on('relocated', (loc) => {
    state.location = loc.start.cfi;
    if (book.locations && book.locations.length()) {
      setPercent(book.locations.percentageFromCfi(loc.start.cfi));
    }
  });

  rendition.on('selected', (cfiRange, contents) => {
    const text = String(contents.window.getSelection()).trim();
    if (text) showSelMenu(text, cfiRange);
  });

  rendition.on('click', () => hideSelMenu());
  rendition.on('keydown', onKey);

  // 目录
  const nav = await book.loaded.navigation;
  const list = $('#tocList');
  const walk = (items, depth = 0) => {
    for (const item of items) {
      const a = document.createElement('a');
      a.textContent = item.label.trim();
      a.href = '#';
      if (depth) a.className = 'sub';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        rendition.display(item.href);
        closePanels();
      });
      list.append(a);
      if (item.subitems && item.subitems.length) walk(item.subitems, depth + 1);
    }
  };
  walk(nav.toc || []);

  $('#progress').addEventListener('change', (e) => {
    if (book.locations && book.locations.length()) {
      rendition.display(book.locations.cfiFromPercentage(Number(e.target.value) / 100));
    }
  });
}

function applyEpubTheme() {
  if (!rendition) return;
  const colors = {
    light: { bg: '#f7f3ec', fg: '#241e18' },
    sepia: { bg: '#f3e9d6', fg: '#3a2f22' },
    dark: { bg: '#14120f', fg: '#d8d0c4' },
  }[state.theme];
  rendition.themes.override('color', colors.fg);
  rendition.themes.override('background', colors.bg);
  rendition.themes.override('line-height', '1.75');
  rendition.themes.fontSize(`${state.fontScale}%`);
}

// ------------------------------------------------------------------ PDF

async function openPdf() {
  $('#viewer').hidden = true;
  const scroll = $('#pdfScroll');
  scroll.hidden = false;

  const pdfjs = await import('/vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
  pdf = await pdfjs.getDocument({ url: `/api/files/${fileId}/raw` }).promise;

  $('#loading').hidden = true;
  $('#flowGroup').hidden = true;

  const width = Math.min(scroll.clientWidth - 20, 900);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rendered = new Set();

  // 先放占位，滚到哪儿渲染哪儿，几百页也不卡
  const firstPage = await pdf.getPage(1);
  const baseViewport = firstPage.getViewport({ scale: 1 });
  const scale = width / baseViewport.width;

  for (let i = 1; i <= pdf.numPages; i++) {
    const ph = document.createElement('div');
    ph.className = 'pdf-placeholder';
    ph.dataset.page = i;
    ph.style.width = `${width}px`;
    ph.style.height = `${Math.round(baseViewport.height * scale)}px`;
    scroll.append(ph);
  }

  // 只渲染视口附近的页：几百页的 PDF 也不会卡。
  // 不用 IntersectionObserver，是因为页面不可见时它不回调，
  // 程序化跳页（续读、点目录）就渲染不出来。
  async function renderNear() {
    const from = scroll.scrollTop - 800;
    const to = scroll.scrollTop + scroll.clientHeight + 800;
    for (const el of [...scroll.children]) {
      const num = Number(el.dataset.page);
      if (!num || rendered.has(num)) continue;
      const top = el.offsetTop;
      if (top + el.offsetHeight < from || top > to) continue;
      rendered.add(num);
      try {
        const page = await pdf.getPage(num);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page';
        canvas.dataset.page = num;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        el.replaceWith(canvas);
      } catch (e) {
        console.error('[pdf] 第', num, '页渲染失败', e);
        rendered.delete(num); // 失败了下次滚到再试
      }
    }
  }
  renderPdfNear = renderNear;

  // 滚动 → 渲染 + 进度
  scroll.addEventListener('scroll', debounce(() => {
    renderNear();
    const page = currentPdfPage();
    state.location = String(page);
    setPercent(page / pdf.numPages);
    $('#pctText').textContent = `${page}/${pdf.numPages}`;
  }, 200));
  window.addEventListener('resize', debounce(renderNear, 300));
  await renderNear();

  $('#progress').addEventListener('change', (e) => {
    scrollToPdfPage(Math.max(1, Math.round((Number(e.target.value) / 100) * pdf.numPages)));
  });

  // 目录
  const outline = await pdf.getOutline().catch(() => null);
  const list = $('#tocList');
  if (outline && outline.length) {
    const walk = (items, depth = 0) => {
      for (const item of items) {
        const a = document.createElement('a');
        a.textContent = item.title;
        a.href = '#';
        if (depth) a.className = 'sub';
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
            const index = await pdf.getPageIndex(dest[0]);
            scrollToPdfPage(index + 1);
            closePanels();
          } catch { /* 有些 PDF 的目标解析不出来 */ }
        });
        list.append(a);
        if (item.items && item.items.length) walk(item.items, depth + 1);
      }
    };
    walk(outline);
  } else {
    list.innerHTML = '<div style="padding:12px;color:var(--rd-dim);font-size:13px">这个 PDF 没有目录</div>';
  }

  if (state.location) scrollToPdfPage(Number(state.location) || 1);
  else if (state.percent > 0) scrollToPdfPage(Math.max(1, Math.round(state.percent * pdf.numPages)));

  // PDF 里选中文字也能存笔记
  scroll.addEventListener('mouseup', () => {
    const text = String(window.getSelection()).trim();
    if (text.length > 1) showSelMenu(text, String(currentPdfPage()));
    else hideSelMenu();
  });
}

function currentPdfPage() {
  const scroll = $('#pdfScroll');
  const mid = scroll.scrollTop + scroll.clientHeight / 2;
  let page = 1;
  let acc = 12;
  for (const el of scroll.children) {
    const height = el.offsetHeight + 14;
    if (acc + height > mid) {
      page = Number(el.dataset.page) || page;
      break;
    }
    acc += height;
    page = Number(el.dataset.page) || page;
  }
  return page;
}

function scrollToPdfPage(num) {
  const scroll = $('#pdfScroll');
  const el = [...scroll.children].find((c) => Number(c.dataset.page) === num);
  if (!el) return;
  scroll.scrollTo({ top: el.offsetTop - 12, behavior: 'auto' });
  if (renderPdfNear) renderPdfNear();
  state.location = String(num);
  if (pdf) {
    setPercent(num / pdf.numPages);
    $('#pctText').textContent = `${num}/${pdf.numPages}`;
  }
}

// ------------------------------------------------------------------ 交互

function bindUi() {
  $('#btnToc').addEventListener('click', () => togglePanel('tocPanel'));
  $('#btnSettings').addEventListener('click', () => togglePanel('setPanel'));
  $('#mask').addEventListener('click', closePanels);
  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', closePanels);
  }

  $('#btnPrev').addEventListener('click', prev);
  $('#btnNext').addEventListener('click', next);
  $('#tapPrev').addEventListener('click', prev);
  $('#tapNext').addEventListener('click', next);

  $('#fontUp').addEventListener('click', () => setFont(state.fontScale + 10));
  $('#fontDown').addEventListener('click', () => setFont(state.fontScale - 10));
  $('#fontSize').textContent = `${state.fontScale}%`;

  for (const b of document.querySelectorAll('.theme-pick')) {
    b.classList.toggle('on', b.dataset.theme === state.theme);
    b.addEventListener('click', () => {
      applyTheme(b.dataset.theme);
      for (const x of document.querySelectorAll('.theme-pick')) x.classList.toggle('on', x === b);
    });
  }
  for (const b of document.querySelectorAll('.flow-pick')) {
    b.classList.toggle('on', b.dataset.flow === state.flow);
    b.addEventListener('click', () => {
      state.flow = b.dataset.flow;
      localStorage.setItem('rd_flow', state.flow);
      for (const x of document.querySelectorAll('.flow-pick')) x.classList.toggle('on', x === b);
      if (rendition) {
        rendition.flow(state.flow);
        applyEpubTheme();
      }
    });
  }

  document.addEventListener('keydown', onKey);

  $('#selNote').addEventListener('click', saveSelectionAsNote);
  $('#selCopy').addEventListener('click', () => {
    navigator.clipboard.writeText(selection.text).then(() => toast('已复制'));
    hideSelMenu();
  });

  // 点中间区域收起/展开工具栏
  $('#stage').addEventListener('click', (e) => {
    if (e.target.id === 'stage') toggleBars();
  });
}

function onKey(e) {
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') next();
  if (e.key === 'Escape') closePanels();
}

function prev() {
  if (rendition) rendition.prev();
  else if (pdf) scrollToPdfPage(Math.max(1, currentPdfPage() - 1));
}

function next() {
  if (rendition) rendition.next();
  else if (pdf) scrollToPdfPage(Math.min(pdf.numPages, currentPdfPage() + 1));
}

function setFont(v) {
  state.fontScale = Math.min(Math.max(v, 70), 220);
  localStorage.setItem('rd_font', state.fontScale);
  $('#fontSize').textContent = `${state.fontScale}%`;
  applyEpubTheme();
}

function applyTheme(t) {
  state.theme = t;
  localStorage.setItem('rd_theme', t);
  document.body.className = `theme-${t}`;
  applyEpubTheme();
}

function togglePanel(id) {
  const panel = $(`#${id}`);
  const willOpen = panel.hidden;
  closePanels();
  if (willOpen) {
    panel.hidden = false;
    $('#mask').hidden = false;
  }
}

function closePanels() {
  $('#tocPanel').hidden = true;
  $('#setPanel').hidden = true;
  $('#mask').hidden = true;
}

function toggleBars() {
  state.barsVisible = !state.barsVisible;
  $('#topBar').classList.toggle('hidden', !state.barsVisible);
  $('#bottomBar').classList.toggle('hidden', !state.barsVisible);
}

// ------------------------------------------------------------------ 划词笔记

let selection = { text: '', cfi: null };

function showSelMenu(text, cfi) {
  selection = { text, cfi };
  const menu = $('#selMenu');
  menu.hidden = false;
  // 简单放在屏幕中下部，手机上够用
  menu.style.left = '50%';
  menu.style.transform = 'translateX(-50%)';
  menu.style.bottom = '78px';
  menu.style.top = 'auto';
}

function hideSelMenu() {
  $('#selMenu').hidden = true;
}

async function saveSelectionAsNote() {
  if (!selection.text) return;
  const note = prompt('写点想法（可留空）：', '');
  if (note === null) return hideSelMenu();
  try {
    await apiSend('POST', `/api/books/${state.file.book_id}/notes`, {
      member_id: state.memberId,
      quote: selection.text,
      note: note || null,
      cfi: selection.cfi ? String(selection.cfi) : null,
      chapter: currentChapter(),
    });
    toast('笔记已保存');
  } catch (e) {
    toast(`保存失败：${e.message}`);
  }
  hideSelMenu();
}

function currentChapter() {
  if (!rendition || !book) return pdf ? `第 ${currentPdfPage()} 页` : null;
  const loc = rendition.currentLocation();
  if (!loc || !loc.start) return null;
  const item = book.spine && book.spine.get(loc.start.href);
  const nav = book.navigation && book.navigation.get(item && item.href);
  return (nav && nav.label && nav.label.trim()) || null;
}

boot();
