(function () {
  var out = { vw: innerWidth, vh: innerHeight, top: [], tabs: [], composer: {} };

  function d(el) {
    var r = el.getBoundingClientRect();
    return {
      t: el.tagName.toLowerCase(),
      c: (el.getAttribute('class') || '').slice(0, 80),
      a: el.getAttribute('aria-label') || '',
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y)
    };
  }

  var all = document.querySelectorAll('#root *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var r = el.getBoundingClientRect();
    if (r.height >= 10 && r.width >= 100 && r.y < 60 && r.y > -40) {
      out.top.push(d(el));
      if (out.top.length >= 22) break;
    }
  }

  // composer geometry: the seat that holds the input
  var tb = document.querySelector('[data-lexical-editor="true"]');
  if (tb) {
    var seat = tb.parentElement;
    for (var up = 0; up < 6 && seat; up++) {
      var rr = seat.getBoundingClientRect();
      if (rr.height > 100) {
        out.composer = { c: seat.getAttribute('class') || '', w: Math.round(rr.width), h: Math.round(rr.height), y: Math.round(rr.y) };
        break;
      }
      seat = seat.parentElement;
    }
  }
  return out;
})()
