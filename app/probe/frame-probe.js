(function () {
  var out = [];
  var els = document.querySelectorAll('[class*="mP3x-q_"]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    out.push({
      c: el.getAttribute('class'),
      t: el.tagName.toLowerCase(),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y)
    });
  }
  var body = [];
  var kids = document.body.children;
  for (var j = 0; j < kids.length; j++) {
    var k = kids[j], rk = k.getBoundingClientRect();
    body.push({ t: k.tagName.toLowerCase(), c: (k.getAttribute('class') || '').slice(0, 60), w: Math.round(rk.width), h: Math.round(rk.height) });
  }
  return { frame: out, bodyKids: body };
})()
