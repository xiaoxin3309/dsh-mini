(function () {
  function desc(el) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return {
      t: el.tagName.toLowerCase(),
      c: (el.getAttribute && el.getAttribute('class') || '').slice(0, 90),
      i: el.id || '',
      r: el.getAttribute('role') || '',
      d: el.getAttribute('data-testid') || el.getAttribute('data-slot') || el.getAttribute('data-name') || '',
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
      pos: cs.position, disp: cs.display
    };
  }
  var out = { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, n: 0, els: [], text: [] };
  var all = document.querySelectorAll('body *');
  out.n = all.length;
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 24) continue;
    out.els.push(desc(el));
    if (out.els.length >= 90) break;
  }
  // interactive bits: buttons / inputs / textareas
  var ints = document.querySelectorAll('button,[role="button"],input,textarea,[contenteditable="true"]');
  for (var j = 0; j < ints.length && j < 40; j++) {
    var e2 = ints[j];
    var r2 = e2.getBoundingClientRect();
    out.text.push({
      t: e2.tagName.toLowerCase(),
      aria: e2.getAttribute('aria-label') || '',
      title: e2.getAttribute('title') || '',
      ph: e2.getAttribute('placeholder') || (e2.getAttribute('data-placeholder') || ''),
      w: Math.round(r2.width), h: Math.round(r2.height)
    });
  }
  return out;
})()
