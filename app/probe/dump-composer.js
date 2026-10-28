(function () {
  var ed = document.querySelector('[data-lexical-editor="true"]');
  if (!ed) return 'no-editor';
  return JSON.stringify(ed.innerText).slice(0, 200);
})()
