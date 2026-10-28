(function () {
  var ed = document.querySelector('[data-lexical-editor="true"]');
  if (!ed) return 'no-editor';
  ed.focus();
  document.execCommand('selectAll');
  document.execCommand('delete');
  return JSON.stringify(ed.innerText);
})()
