/** 扫码录入：摄像头扫 ISBN 条码 → 各来源并行查书目 → 入库 */
import { h, toast, coverNode, money } from '../ui.js';
import api from '../api.js';
import { store, go } from '../app.js';
import { lookupProgressive, sourceLabel } from '../lookup.js';
import { resolveDuplicate } from '../duplicate.js';
import { pickAndRecognize, confirmFields } from '../photo.js';

const SUPPORTED_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

export default async function scan(root) {
  let stream = null;
  let stopped = false;
  let zxingReader = null;
  let rafId = null;
  let lastCode = '';
  let lastTime = 0;

  const video = h('video', { playsinline: '', muted: '', autoplay: '' });
  const stage = h('div', { class: 'scanner-stage' },
    video,
    h('div', { class: 'scan-frame' }),
    h('div', { class: 'scan-hint' }, '把书背面的条形码放进框里')
  );
  const statusLine = h('div', { class: 'small muted', style: { marginTop: '10px', textAlign: 'center' } }, '正在打开摄像头…');
  const resultBox = h('div', { style: { marginTop: '16px' } });

  const manualInput = h('input', {
    type: 'text', placeholder: '手动输入 ISBN 或书名',
    style: { flex: '1', padding: '9px 12px', borderRadius: '999px', border: '1px solid var(--line)', background: 'var(--card)' },
  });
  manualInput.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') doLookup(manualInput.value.trim());
  });

  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('div', { class: 'page-title' }, '扫码录入'),
        h('div', { class: 'page-sub' }, '对准书背条码，识别到 ISBN 会自动查书目')
      ),
      h('button', { class: 'btn sm', onclick: () => go('/add') }, '手动录入')
    ),
    stage,
    statusLine,
    h('div', { class: 'row', style: { marginTop: '12px' } },
      manualInput,
      h('button', { class: 'btn primary', onclick: () => doLookup(manualInput.value.trim()) }, '查询'),
      h('button', { class: 'btn', onclick: pickPhoto, title: '用照片识别条码' }, '🖼')
    ),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn sm', onclick: scanCopyright }, '📷 拍版权页识别'),
      h('span', { class: 'tiny faint' }, '书后面没条码、或者想连分册名/定价一起录，用这个')
    ),
    resultBox
  );

  /** 拍版权页 → 识别 → 带着结果跳到录入页 */
  async function scanCopyright() {
    const out = await pickAndRecognize();
    if (!out) return;
    const picked = await confirmFields(out);
    if (!picked) return;
    sessionStorage.setItem('hl_photo_fields', JSON.stringify(picked));
    go('/add?from_photo=1');
  }

  // ---------------------------------------------------------------- 摄像头

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return fail('这个浏览器不支持调用摄像头，用下面的输入框手动输 ISBN 也一样。');
    }
    if (!window.isSecureContext) {
      return fail('浏览器只在 https 或 localhost 下才允许开摄像头。请用 https 地址访问（服务默认已开 https）。');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      statusLine.textContent = '摄像头已就绪，正在识别…';
      if ('BarcodeDetector' in window) {
        const formats = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
        const use = SUPPORTED_FORMATS.filter((f) => formats.includes(f));
        if (use.length) return nativeLoop(new window.BarcodeDetector({ formats: use }));
      }
      zxingLoop();
    } catch (e) {
      fail(
        e.name === 'NotAllowedError'
          ? '没拿到摄像头权限。在浏览器地址栏的权限设置里允许摄像头后刷新页面。'
          : `打不开摄像头：${e.message}。可以手动输 ISBN，或用 🖼 拍张条码照片识别。`
      );
    }
  }

  function fail(msg) {
    statusLine.innerHTML = '';
    statusLine.append(h('span', { class: 'status-warn' }, msg));
    stage.style.display = 'none';
    manualInput.focus();
  }

  function nativeLoop(detector) {
    const tick = async () => {
      if (stopped) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) onCode(codes[0].rawValue);
      } catch { /* 个别帧解不出来是正常的 */ }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  async function zxingLoop() {
    await loadScript('/vendor/zxing.min.js');
    if (!window.ZXing) return fail('条码识别库没加载成功，用手动输入吧。');
    const { BarcodeFormat, DecodeHintType, BrowserMultiFormatReader } = window.ZXing;
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    ]);
    zxingReader = new BrowserMultiFormatReader(hints, 300);
    zxingReader
      .decodeFromStream(stream, video, (result) => {
        if (result) onCode(result.getText());
      })
      .catch((e) => fail(`识别器启动失败：${e.message}`));
  }

  function stopCamera() {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (zxingReader) {
      try { zxingReader.reset(); } catch { /* ignore */ }
    }
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  // ---------------------------------------------------------------- 条码

  function onCode(raw) {
    const code = String(raw || '').replace(/\D/g, '');
    const now = Date.now();
    if (!code || (code === lastCode && now - lastTime < 4000)) return;
    lastCode = code;
    lastTime = now;
    beep();
    if (navigator.vibrate) navigator.vibrate(60);
    manualInput.value = code;
    doLookup(code);
  }

  let audioCtx;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g);
      g.connect(audioCtx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.06;
      o.start();
      o.stop(audioCtx.currentTime + 0.09);
    } catch { /* 静音也无所谓 */ }
  }

  async function pickPhoto() {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      statusLine.textContent = '正在识别图片…';
      try {
        const bitmap = await createImageBitmap(file);
        let code = null;
        if ('BarcodeDetector' in window) {
          const d = new window.BarcodeDetector({ formats: SUPPORTED_FORMATS });
          const r = await d.detect(bitmap);
          if (r.length) code = r[0].rawValue;
        }
        if (!code) {
          await loadScript('/vendor/zxing.min.js');
          const canvas = h('canvas', { width: bitmap.width, height: bitmap.height });
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          const reader = new window.ZXing.BrowserMultiFormatReader();
          const res = await reader.decodeFromCanvas(canvas);
          code = res && res.getText();
        }
        if (code) {
          statusLine.textContent = `识别到 ${code}`;
          onCode(code);
        } else {
          statusLine.textContent = '图里没找到条码。可以手动输 ISBN，或直接「拍封面录入」。';
        }
      } catch {
        statusLine.textContent = '没认出条码。可以手动输 ISBN，或直接「拍封面录入」。';
      }
    });
    input.click();
  }

  // ---------------------------------------------------------------- 查书目

  async function doLookup(q) {
    if (!q) return;
    resultBox.innerHTML = '';

    const headLine = h('div', { class: 'section-title' }, '查询中…');
    const sourceRow = h('div', { class: 'scroll-x', style: { marginBottom: '10px' } });
    const listCard = h('div', { class: 'card pad' }, h('div', { class: 'muted small' }, `正在问各个来源要「${q}」的书目…`));
    const banner = h('div', {});
    resultBox.append(banner, headLine, sourceRow, listCard);

    const chips = new Map();
    let count = 0;
    let bannerShown = false;

    const out = await lookupProgressive(q, {
      onStart(providers) {
        if (!providers.length) {
          listCard.innerHTML = '';
          listCard.append(h('div', { class: 'muted small' }, '所有书目来源都关掉了，去「设置 › 书目来源」打开至少一个。'));
          return;
        }
        for (const p of providers) {
          const chip = h('span', { class: 'src-tag' }, `${p.name} …`);
          chips.set(p.key, chip);
          sourceRow.append(chip);
        }
      },
      onSource(p, r) {
        const chip = chips.get(p.key);
        if (!chip) return;
        chip.textContent = r.ok ? `${p.name} ✓${r.count}` : `${p.name} ✗`;
        chip.style.color = r.ok ? 'var(--ok)' : 'var(--text-faint)';
        if (r.error) chip.title = r.error.message;
      },
      onResults(fresh, meta) {
        if (!count) listCard.innerHTML = '';
        for (const r of fresh) listCard.append(resultItem(r, meta.isbn));
        count += fresh.length;
        headLine.innerHTML = '';
        headLine.append(`查到 ${count} 条结果`, h('span', { class: 'count' }, '点一条即可入库'));
        if (!bannerShown && meta.existing_list && meta.existing_list.length) {
          bannerShown = true;
          banner.append(existingCard(meta.existing_list));
        }
      },
    });

    if (!count) {
      listCard.innerHTML = '';
      headLine.textContent = '没查到';
      listCard.append(
        h('div', {}, `各个来源都没有「${q}」的书目信息。`),
        out.errors.length
          ? h('ul', { class: 'tiny faint', style: { margin: '8px 0 0', paddingLeft: '18px' } },
              out.errors.map((e) => h('li', {}, `${e.provider}：${e.message}`)))
          : null,
        h('div', { class: 'row', style: { marginTop: '12px' } },
          h('button', { class: 'btn primary sm', onclick: () => go(`/add?isbn13=${encodeURIComponent(out.isbn || '')}&photo=1`) }, '📷 拍封面录入'),
          h('button', { class: 'btn sm', onclick: () => go(`/add?isbn13=${encodeURIComponent(out.isbn || '')}`) }, '手动录入'),
          out.zlib_url
            ? h('a', { class: 'btn sm', href: out.zlib_url, target: '_blank', rel: 'noopener noreferrer' }, '去 Z-Library 找')
            : null,
          h('a', { class: 'btn sm ghost', href: '#/settings' }, '检查网络设置')
        )
      );
    }
  }

  /** 已有同 ISBN 的书。套装书整套共用一个 ISBN，所以这里只是提醒，不拦着录入 */
  function existingCard(list) {
    const books = Array.isArray(list) ? list : [list];
    return h('div', { class: 'card pad', style: { marginBottom: '12px', borderColor: 'var(--accent)' } },
      h('div', { class: 'row', style: { alignItems: 'flex-start' } },
        h('span', {}, '📚'),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { fontWeight: '600' } },
            books.length > 1 ? `书库里已有 ${books.length} 本同 ISBN 的书` : '书库里已经有这个 ISBN 了'),
          h('div', { class: 'tiny faint', style: { marginTop: '2px' } },
            '套装书整套共用一个 ISBN。如果这是另一册，照常点「直接入库」，之后填上分册名即可。'),
          h('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            books.map((b) =>
              h('div', { class: 'row', style: { gap: '8px' } },
                h('span', { class: 'small ellip', style: { flex: '1' } },
                  `《${b.title}》${b.volume ? ` · ${b.volume}` : ''}`),
                h('button', { class: 'btn sm ghost', onclick: () => go(`/book/${b.id}`) }, '打开')
              )
            )
          )
        )
      )
    );
  }

  function resultItem(r, isbn) {
    return h('div', { class: 'result-item' },
      h('div', { class: 'thumb' }, coverNode(r)),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { style: { fontWeight: '600' } }, r.title),
        h('div', { class: 'tiny faint' }, [r.author, r.publisher, r.pub_date].filter(Boolean).join(' · ')),
        h('div', { class: 'row', style: { marginTop: '6px', gap: '6px' } },
          h('span', { class: 'src-tag' }, sourceLabel(r.source)),
          r.isbn13 ? h('span', { class: 'tiny faint mono' }, r.isbn13) : null,
          r.zlib_extension ? h('span', { class: 'src-tag' }, r.zlib_extension.toUpperCase()) : null,
          r.list_price ? h('span', { class: 'tiny faint' }, money(r.list_price)) : null
        )
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('button', { class: 'btn primary sm', onclick: () => quickAdd(r, isbn) }, '直接入库'),
        h('button', { class: 'btn sm', onclick: () => go(`/add?${toQuery(r, isbn)}`) }, '编辑后入库')
      )
    );
  }

  async function quickAdd(r, isbn) {
    const payload = {
      ...r,
      isbn13: r.isbn13 || isbn || null,
      carrier: r.carrier_hint || '纸质书',
      purchase: {
        purchased_at: new Date().toISOString().slice(0, 10),
        price: r.list_price ?? null,
        buyer_id: store.actingMember(),
      },
    };
    try {
      let book;
      try {
        book = await api.createBook(payload);
      } catch (e) {
        if (e.status !== 409) throw e;
        // 同 ISBN 未必是同一本（套装书），让用户定夺
        book = await resolveDuplicate(e, payload);
        if (!book) return;
      }
      toast(`《${book.title}》已入库`, 'ok');
      resultBox.innerHTML = '';
      resultBox.append(
        h('div', { class: 'card pad row' },
          h('div', { style: { width: '44px' } }, coverNode(book)),
          h('div', { style: { flex: '1' } },
            h('div', { style: { fontWeight: '600' } }, book.title),
            h('div', { class: 'tiny faint' }, '已入库，可以接着扫下一本')
          ),
          h('button', { class: 'btn sm', onclick: () => go(`/book/${book.id}`) }, '查看')
        )
      );
      manualInput.value = '';
      lastCode = '';
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  await startCamera();
  return stopCamera; // 路由切走时关掉摄像头
}

function toQuery(r, isbn) {
  const fields = ['isbn13', 'isbn10', 'title', 'subtitle', 'author', 'translator', 'publisher',
    'pub_date', 'pages', 'list_price', 'language', 'category', 'summary', 'cover_url',
    'source', 'source_url', 'ext_rating', 'ext_rating_count'];
  const sp = new URLSearchParams();
  for (const f of fields) if (r[f]) sp.set(f, r[f]);
  if (!sp.get('isbn13') && isbn) sp.set('isbn13', isbn);
  return sp.toString();
}

const loaded = new Set();
export function loadScript(src) {
  if (loaded.has(src)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { loaded.add(src); resolve(); };
    s.onerror = () => reject(new Error(`加载失败：${src}`));
    document.head.append(s);
  });
}
