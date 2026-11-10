/* DSH HUD page script — injected by DSH小窗.exe after every navigation.
 * Compacts the app for a small always-on-top window and bridges it to the native shell. */
(function () {
  'use strict';
  if (window.__dshHudReady) return;
  window.__dshHudReady = true;

  var doc = document;
  var root = doc.documentElement;
  root.setAttribute('data-dsh-hud', '1');

  /* ---------- compact styling ----------
   * The app switches to its own narrow ("mobile") layout at this width: drawer
   * sidebar + slim header. We only need to trim the chrome. The overall 0.9 scale
   * is applied by the shell as a WebView2 zoom factor, NOT as a CSS `zoom` here:
   * CSS zoom shrinks the used height but not the viewport, which left a blank band
   * along the bottom (and a sliver on the right). */
  var CSS = [
    ':root[data-dsh-hud] .dsh-mobile-app-header{height:42px!important;min-height:42px!important;padding:0 4px!important}',
    ':root[data-dsh-hud] .dsh-mobile-app-header *{font-size:13px}',
    ':root[data-dsh-hud] button[title="CDP 浏览器实时视图"]{display:none!important}',
    ':root[data-dsh-hud] [class*="_composerSeat"]{padding-top:0!important;padding-bottom:6px!important}',
    ':root[data-dsh-hud] [class*="_headline"]{min-height:0!important}',
    ':root[data-dsh-hud] [class*="_scrollBody"]{scrollbar-width:thin}',
    ':root[data-dsh-hud] ::-webkit-scrollbar{width:6px;height:6px}',
    ':root[data-dsh-hud] ::-webkit-scrollbar-thumb{background:rgba(128,128,128,.35);border-radius:3px}',
    ':root[data-dsh-hud] ::-webkit-scrollbar-track{background:transparent}'
  ].join('\n');

  var style = doc.getElementById('dsh-hud-style');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'dsh-hud-style';
    (doc.head || root).appendChild(style);
  }
  style.textContent = CSS;

  /* ---------- probe (debug aid; results land in hud.log) ---------- */
  function probe() {
    function describe(el) {
      var r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') || '').slice(0, 70),
        w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.x), y: Math.round(r.y)
      };
    }
    var out = { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, els: [] };
    var els = doc.querySelectorAll('#root > div > *, .dsh-mobile-app-header');
    for (var i = 0; i < els.length && i < 24; i++) out.els.push(describe(els[i]));
    var seat = doc.querySelector('[class*="_composerSeat"]');
    if (seat) out.composer = describe(seat);
    return out;
  }

  /* ---------- sidebar: drive the app's own drawer button ---------- */
  function sidebar() {
    var labels = ['打开侧边栏', '关闭侧边栏', '收起侧边栏', '打开侧边栏'];
    for (var i = 0; i < labels.length; i++) {
      var b = doc.querySelector('button[aria-label="' + labels[i] + '"]');
      if (b) { b.click(); return true; }
    }
    return false;
  }

  /* ---------- screenshot -> composer ---------- */
  function editor() {
    var all = doc.querySelectorAll('[data-lexical-editor="true"]');
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return all[i];
    }
    return all[0] || null;
  }

  function insertImage(dataUrl) {
    var ed = editor();
    if (!ed) return false;
    try {
      var bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var file = new File([bytes], 'screenshot-' + Date.now() + '.png', { type: 'image/png' });
      var dt = new DataTransfer();
      dt.items.add(file);
      ed.focus();
      var ev;
      try {
        ev = new ClipboardEvent('paste', {
          dataTransfer: dt, clipboardData: dt, bubbles: true, cancelable: true, composed: true
        });
      } catch (e) {
        ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      }
      ed.dispatchEvent(ev);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- quoted text -> composer ---------- */
  function insertText(text) {
    var ed = editor();
    if (!ed) return false;
    try {
      ed.focus();
      var dt = new DataTransfer();
      dt.setData('text/plain', text);
      var ev;
      try {
        ev = new ClipboardEvent('paste', {
          dataTransfer: dt, clipboardData: dt, bubbles: true, cancelable: true, composed: true
        });
      } catch (e) {
        ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      }
      ed.dispatchEvent(ev);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* A quote from elsewhere on the desktop: every line becomes a markdown quote. */
  function quote(text) {
    var t = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/, '');
    if (!t) return false;
    var lines = t.split('\n');
    for (var i = 0; i < lines.length; i++) lines[i] = '> ' + lines[i];
    return insertText(lines.join('\n') + '\n\n');
  }

  /* ---------- translation desk ----------
   * The pill is clicked on the desktop, outside DSH, so its answer cannot be "pasted into
   * the composer": it opens here as a full-window overlay instead. Everything the desk
   * needs is local (text, selection rectangle, the screenshot frozen at click time) and
   * the model call streams from the plugin's own route — no DSH session is created. */
  var DESK_CSS = [
    '.dm-desk{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;',
    'background:rgba(9,9,11,.42);padding:24px 12px;overflow:auto;font:13px/1.65 -apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif}',
    '.dm-desk[hidden]{display:none}',
    '.dm-panel{width:100%;max-width:560px;background:#fff;color:#18181b;border-radius:14px;',
    'box-shadow:0 18px 48px rgba(0,0,0,.28);display:flex;flex-direction:column;max-height:calc(100vh - 48px);overflow:hidden}',
    '.dm-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #ececef}',
    '.dm-title{font-weight:700;font-size:13px}.dm-sub{flex:1;color:#8a8a93;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dm-btn{border:1px solid #e0e1e6;background:#fff;color:#3f3f46;border-radius:8px;padding:4px 9px;font-size:12px;cursor:pointer}',
    '.dm-btn:hover{background:#f4f4f5}.dm-btn:disabled{opacity:.45;cursor:default}',
    '.dm-body{padding:12px;overflow:auto}',
    '.dm-src{border-left:3px solid #d4d4d8;background:#fafafa;border-radius:0 8px 8px 0;padding:7px 10px;color:#52525b;',
    'white-space:pre-wrap;word-break:break-word;max-height:110px;overflow:auto;font-size:12px}',
    '.dm-shotwrap{position:relative;margin:10px 0 0;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden;background:#f4f4f5}',
    '.dm-shotwrap[hidden]{display:none}.dm-shot{display:block;width:100%;height:auto}',
    '.dm-box{position:absolute;border:2px solid #ef4444;background:rgba(239,68,68,.12);border-radius:2px;pointer-events:none}',
    '.dm-answer{margin:10px 0 0;white-space:pre-wrap;word-break:break-word;font-size:13px;color:#27272a;min-height:18px}',
    '.dm-line{display:block}.dm-h{font-weight:700;color:#111827}.dm-quote{color:#6b7280;border-left:2px solid #e5e7eb;padding-left:8px}',
    '.dm-sub{padding-left:14px}',
    '.dm-status{margin:8px 0 0;color:#9ca3af;font-size:11px;min-height:14px}',
    '.dm-foot{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #ececef;background:#fafafa}',
    '.dm-foot .dm-btn{flex:0 0 auto}',
  ].join('');

  var desk = null;

  function deskCss() {
    if (doc.getElementById('dsh-mini-desk-style')) return;
    var s = doc.createElement('style');
    s.id = 'dsh-mini-desk-style';
    s.textContent = DESK_CSS;
    (doc.head || root).appendChild(s);
  }

  function h(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /* Built once, then reused: reopening the desk must not leak a second overlay or a
   * second copy of the screenshot into the page. */
  function deskBuild() {
    deskCss();
    var rootEl = h('div', 'dm-desk');
    rootEl.hidden = true;
    var panel = h('div', 'dm-panel');
    var head = h('div', 'dm-head');
    var title = h('span', 'dm-title', '翻译');
    var sub = h('span', 'dm-sub', '');
    var copyBtn = h('button', 'dm-btn', '复制');
    copyBtn.type = 'button';
    var closeBtn = h('button', 'dm-btn', '✕');
    closeBtn.type = 'button';
    head.appendChild(title); head.appendChild(sub); head.appendChild(copyBtn); head.appendChild(closeBtn);

    var body = h('div', 'dm-body');
    var src = h('div', 'dm-src', '');
    var shotWrap = h('div', 'dm-shotwrap');
    shotWrap.hidden = true;
    var shot = h('img', 'dm-shot');
    var box = h('div', 'dm-box');
    shotWrap.appendChild(shot); shotWrap.appendChild(box);
    var answer = h('div', 'dm-answer', '');
    var status = h('div', 'dm-status', '');
    body.appendChild(src); body.appendChild(shotWrap); body.appendChild(answer); body.appendChild(status);

    var foot = h('div', 'dm-foot');
    var ctxBtn = h('button', 'dm-btn', '结合上下文');
    ctxBtn.type = 'button';
    var retryBtn = h('button', 'dm-btn', '重新翻译');
    retryBtn.type = 'button';
    foot.appendChild(ctxBtn); foot.appendChild(retryBtn);

    panel.appendChild(head); panel.appendChild(body); panel.appendChild(foot);
    rootEl.appendChild(panel);
    (doc.body || root).appendChild(rootEl);

    desk = {
      root: rootEl, title: title, sub: sub, src: src, shotWrap: shotWrap, shot: shot, box: box,
      answer: answer, status: status, copy: copyBtn, close: closeBtn, ctx: ctxBtn, retry: retryBtn,
      state: null
    };

    function act(fn) { return function (ev) { ev.preventDefault(); ev.stopPropagation(); fn(); }; }
    copyBtn.addEventListener('click', act(function () { deskCopy(); }));
    closeBtn.addEventListener('click', act(function () { deskClose(); }));
    ctxBtn.addEventListener('click', act(function () { deskRun('context'); }));
    retryBtn.addEventListener('click', act(function () { deskRun('translate'); }));
    rootEl.addEventListener('mousedown', function (ev) { if (ev.target === rootEl) deskClose(); });
    doc.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && desk && !desk.root.hidden) { ev.preventDefault(); deskClose(); }
    });
  }

  function deskCurrentAnswer() {
    var st = desk && desk.state;
    if (!st) return '';
    return (st.contextAnswer || st.answer || '').trim();
  }

  function deskCopy() {
    var text = deskCurrentAnswer();
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
    } catch (e) { }
    desk.status.textContent = '已复制';
  }

  function deskClose() {
    if (!desk) return;
    if (desk.state && desk.state.controller) { try { desk.state.controller.abort(); } catch (e) { } }
    desk.state = null;
    desk.root.hidden = true;
  }

  /* Minimal markdown-ish rendering: the prompt only produces `## heading`, `- bullet`,
   * two-space nested bullets and `> conclusion`, and the stream arrives in arbitrary
   * chunks, so re-render the whole buffer on every delta instead of patching nodes. */
  function deskInline(text) {
    var parts = String(text).split('**');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) {
        var strong = h('strong', '', parts[i]);
        parts[i] = strong;
      }
    }
    return parts;
  }

  function deskRenderAnswer(text) {
    var box = desk.answer;
    box.textContent = '';
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (!raw) { box.appendChild(h('div', 'dm-line', '\u00a0')); continue; }
      var indent = 0;
      while (raw.charAt(indent) === ' ') indent++;
      var line = raw.slice(indent);
      var el = h('span', 'dm-line');
      if (line.indexOf('## ') === 0) { el.className = 'dm-line dm-h'; line = line.slice(3); }
      else if (line.indexOf('> ') === 0) { el.className = 'dm-line dm-quote'; line = line.slice(2); }
      else if (line.indexOf('- ') === 0) {
        line = '\u2022 ' + line.slice(2);
        if (indent >= 2) el.className = 'dm-line dm-sub';
      }
      var pieces = deskInline(line);
      for (var j = 0; j < pieces.length; j++) {
        if (typeof pieces[j] === 'string') el.appendChild(doc.createTextNode(pieces[j]));
        else el.appendChild(pieces[j]);
      }
      box.appendChild(el);
    }
    box.scrollTop = box.scrollHeight;
  }

  function deskShowShot(payload) {
    var st = desk.state;
    if (!st || !st.shot) { desk.shotWrap.hidden = true; return; }
    desk.shot.src = st.shot;
    desk.shotWrap.hidden = false;
    var screen = payload.screen || {};
    var sel = payload.selection || {};
    var sw = screen.w || payload.shotWidth || 0;
    var sh = screen.h || payload.shotHeight || 0;
    if (sw > 0 && sh > 0 && sel.w > 0 && sel.h > 0) {
      var left = (sel.x - (screen.x || 0)) / sw;
      var top = (sel.y - (screen.y || 0)) / sh;
      desk.box.hidden = false;
      desk.box.style.left = (left * 100).toFixed(3) + '%';
      desk.box.style.top = (top * 100).toFixed(3) + '%';
      desk.box.style.width = ((sel.w / sw) * 100).toFixed(3) + '%';
      desk.box.style.height = ((sel.h / sh) * 100).toFixed(3) + '%';
    } else {
      desk.box.hidden = true;
    }
  }

  /* Opens the desk for one pill click. `payload` is what the helper froze: text, the
   * selection rectangle and the screen it was on. */
  function deskOpen(payload) {
    if (!desk) deskBuild();
    desk.root.hidden = false;
    desk.state = {
      id: (payload && payload.id) || '',
      text: String((payload && payload.text) || ''),
      selection: (payload && payload.selection) || null,
      screen: (payload && payload.screen) || null,
      shot: (payload && payload.shot) || null,
      shotWidth: (payload && payload.shotWidth) || 0,
      shotHeight: (payload && payload.shotHeight) || 0,
      answer: '',
      contextAnswer: '',
      mode: 'translate',
      busy: false,
      controller: null
    };
    desk.src.textContent = desk.state.text;
    desk.title.textContent = '翻译';
    desk.sub.textContent = desk.state.shot ? '已截屏，可稍后结合上下文' : '未截屏';
    desk.answer.textContent = '';
    desk.status.textContent = '';
    desk.ctx.style.display = desk.state.shot ? '' : 'none';
    desk.ctx.disabled = true;
    deskShowShot(desk.state);
    deskRun('translate');
    return true;
  }

  function deskRun(mode) {
    var st = desk && desk.state;
    if (!st || st.busy) return;
    st.busy = true;
    desk.ctx.disabled = true;
    desk.retry.disabled = true;
    desk.status.textContent = mode === 'context' ? '正在结合画面分析…' : '正在翻译…';
    desk.title.textContent = mode === 'context' ? '结合上下文' : '翻译';
    if (mode === 'translate') desk.answer.textContent = '';

    var body = {
      text: st.text, mode: mode, id: st.id,
      selection: st.selection, screen: st.screen
    };
    if (mode === 'context') {
      body.shot = st.shot;
      body.shotWidth = st.shotWidth;
      body.shotHeight = st.shotHeight;
    }

    st.controller = typeof AbortController === 'function' ? new AbortController() : null;
    var buffer = '';
    var target = mode;

    fetch('/dsh-mini/translate/describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: st.controller ? st.controller.signal : undefined
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.text().then(function (t) { throw new Error(t || ('HTTP ' + res.status)); });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { done(); return; }
          buffer += decoder.decode(r.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop();
          for (var i = 0; i < parts.length; i++) consume(parts[i]);
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      desk.status.textContent = '出错：' + (err && err.message ? err.message : err);
      st.busy = false;
      desk.retry.disabled = false;
      desk.ctx.disabled = !st.shot;
    });

    function consume(frame) {
      var lines = frame.split('\n');
      var event = 'message';
      var data = '';
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('event:') === 0) event = lines[i].slice(6).trim();
        else if (lines[i].indexOf('data:') === 0) data += lines[i].slice(5).trim();
      }
      if (!data) return;
      var obj;
      try { obj = JSON.parse(data); } catch (e) { return; }
      if (event === 'record') { if (obj.id) st.id = obj.id; }
      else if (event === 'delta') {
        if (target === 'context') st.contextAnswer += obj.text || '';
        else st.answer += obj.text || '';
        deskRenderAnswer(target === 'context' ? st.contextAnswer : st.answer);
      } else if (event === 'warn') {
        desk.status.textContent = '提示：' + (obj.message || '');
      } else if (event === 'error') {
        desk.status.textContent = '出错：' + (obj.message || '未知错误');
        done();
      } else if (event === 'done') {
        done();
      }
    }

    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      st.busy = false;
      desk.retry.disabled = false;
      desk.ctx.disabled = !st.shot;
      if (target === 'context') {
        desk.ctx.style.display = 'none';
        desk.status.textContent = deskCurrentAnswer() ? '' : '没有结果';
      } else {
        desk.status.textContent = deskCurrentAnswer() ? '' : '没有结果';
      }
      deskRenderAnswer(deskCurrentAnswer());
    }
  }

  /* ---------- native bridge ---------- */
  function post(obj) {
    try { window.chrome.webview.postMessage(obj); } catch (e) { }
  }

  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', function (ev) {
      var msg = ev.data;
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
      if (!msg || !msg.type) return;
      if (msg.type === 'cmd') {
        if (msg.cmd === 'toggle-sidebar') sidebar();
        else if (msg.cmd === 'screenshot') post({ type: 'shot' });
      } else if (msg.type === 'shot-result') {
        insertImage(msg.dataUrl);
      } else if (msg.type === 'translate') {
        deskOpen(msg.payload || msg);
      }
    });
  }

  window.__dshHud = { probe: probe, sidebar: sidebar, insertImage: insertImage, insertText: insertText, quote: quote, post: post, translate: deskOpen, compact: function () { style.textContent = CSS; } };
})();
