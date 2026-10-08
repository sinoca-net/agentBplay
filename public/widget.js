// Widget para la landing: <script src="https://TU-DOMINIO/widget.js" defer></script>
// Opcional: data-prov="PBA" en el script, o cualquier botón con data-open-chat para abrirlo.
(function () {
  var s = document.currentScript, base = s.src.replace(/\/widget\.js.*$/, '');
  var qs = new URLSearchParams(location.search), p = new URLSearchParams({ embed: 1 });
  ['utm_source', 'utm_campaign', 'src', 'prov'].forEach(function (k) { if (qs.get(k)) p.set(k, qs.get(k)); });
  if (s.dataset.prov && !p.get('prov')) p.set('prov', s.dataset.prov);
  var css = document.createElement('style');
  css.textContent = '#bpc-btn{position:fixed;right:18px;bottom:18px;width:60px;height:60px;border-radius:50%;background:#1fa463;box-shadow:0 4px 14px rgba(0,0,0,.25);border:none;cursor:pointer;z-index:2147483000;display:grid;place-items:center}' +
    '#bpc-btn:after{content:"";position:absolute;top:4px;right:4px;width:12px;height:12px;border-radius:50%;background:#ff3b30;border:2px solid #fff}' +
    '#bpc-frame{position:fixed;right:18px;bottom:90px;width:380px;height:620px;max-height:calc(100vh - 110px);border:none;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.3);z-index:2147483001;display:none;background:#ece5dd}' +
    '@media(max-width:520px){#bpc-frame{right:0;bottom:0;width:100%;height:100%;max-height:none;border-radius:0}}';
  document.head.appendChild(css);
  var btn = document.createElement('button');
  btn.id = 'bpc-btn'; btn.setAttribute('aria-label', 'Abrir chat');
  btn.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path fill="#fff" d="M12 3C6.5 3 2 6.9 2 11.7c0 2.6 1.3 4.9 3.4 6.5L4.6 22l4.2-2.2c1 .3 2.1.4 3.2.4 5.5 0 10-3.9 10-8.6S17.5 3 12 3z"/></svg>';
  var frame = document.createElement('iframe');
  frame.id = 'bpc-frame'; frame.title = 'Chat'; frame.allow = 'notifications';
  function open() { if (!frame.src) frame.src = base + '/chat?' + p.toString(); frame.style.display = 'block'; btn.style.display = window.innerWidth <= 520 ? 'none' : 'grid'; }
  function close() { frame.style.display = 'none'; btn.style.display = 'grid'; }
  btn.onclick = function () { frame.style.display === 'block' ? close() : open(); };
  window.addEventListener('message', function (e) { if (e.data === 'bpc:close') close(); });
  document.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-open-chat]'); if (t) { e.preventDefault(); open(); } });
  document.body.appendChild(btn); document.body.appendChild(frame);
  window.BPLAYChat = { open: open, close: close };
})();
