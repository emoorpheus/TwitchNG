// node tools/ui-lab.mjs <ipk> <out> --pre tools/ui-lab-pre-history.js: turns the first 3 cards of the shown grid into history cards (upstream markup: single-line title class + a
// "watched on ..." line, Screens.js createCell* with Extra_when), so the NG layout of the history screens can be checked without a user
(function () {
  var hs = document.querySelectorAll('#screens_holder .stream_thumbnail_live_holder'), n = 0, i, th, t, w;
  for (i = 0; i < hs.length && n < 3; i++) {
    if (!hs[i].offsetParent) continue;
    th = hs[i].querySelector('.stream_text_holder');
    if (!th || th.getAttribute('data-lab-hist')) { n++; continue; }
    th.setAttribute('data-lab-hist', '1');
    t = th.querySelector('.stream_info_live_title');
    if (t) t.className = 'stream_info_live_title_single_line';
    w = document.createElement('div'); w.className = 'stream_info_live';
    w.innerHTML = (window.STR_WATCHED || 'Watched on') + ' 5 ноя, 14:02&nbsp;' + (window.STR_UNTIL || 'until') + '<span> 01:12:40</span>';
    th.appendChild(w); n++;
  }
  return n;
})()
