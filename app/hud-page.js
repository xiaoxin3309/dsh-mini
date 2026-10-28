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
      }
    });
  }

  window.__dshHud = { probe: probe, sidebar: sidebar, insertImage: insertImage, insertText: insertText, quote: quote, post: post, compact: function () { style.textContent = CSS; } };
})();
