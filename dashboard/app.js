// Launch Radar v5 dashboard: renders the 342-row board, the fit scatter,
// the top-10 bar chart and the per-protocol detail from window.LAUNCH_RADAR
// (written by main.ts as data.js). No network. Plain script, no modules.
(function () {
  var D = window.LAUNCH_RADAR;
  if (!D) return;
  function $(id) { return document.getElementById(id); }
  function money(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
  function moneyShort(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(v / 1e3) + 'K';
  }
  function pct(v) { return (v * 100).toFixed(1) + '%'; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function ageLabel(d) {
    if (d <= 0) return '—';
    if (d < 365) return Math.round(d) + 'd';
    return (d / 365.25).toFixed(1) + 'y';
  }

  var state = { tier: 'cand', verdict: 'all', sort: 'implied', q: '' };

  function tierRows() {
    var rows = D.board.filter(function (r) {
      if (state.tier === 'cand' && r.flag !== null) return false;
      if (state.tier === 'flag' && r.flag === null) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort === 'odds' ? 'odds' : state.sort === 'ev' ? 'ev' : 'implied';
    var cand = rows.filter(function (r) { return r.flag === null; })
      .sort(function (a, b) { return b[key] - a[key]; });
    var flag = rows.filter(function (r) { return r.flag !== null; })
      .sort(function (a, b) { return b[key] - a[key]; });
    return { cand: cand, flag: flag };
  }

  function rowHtml(r) {
    var cls = r.flag === null ? 'cand' : 'flagged';
    var flag = r.flag === null ? '' : ' <span class="flagtag">' + esc(r.flag) + '</span>';
    return '<tr class="' + cls + '" data-slug="' + esc(r.slug) + '">' +
      '<td>' + r.rank + '</td>' +
      '<td><strong>' + esc(r.name) + '</strong>' + flag + '</td>' +
      '<td>' + esc(r.category || '—') + '</td>' +
      '<td>' + moneyShort(r.tvl) + '</td>' +
      '<td>' + (r.growth > 0 ? '+' : '') + r.growth.toFixed(1) + '%</td>' +
      '<td>' + ageLabel(r.ageDays) + '</td>' +
      '<td><strong>' + money(r.implied) + '</strong></td>' +
      '<td>' + moneyShort(r.lo) + '–' + moneyShort(r.hi) + '</td>' +
      '<td>' + pct(r.odds) + '</td>' +
      '<td>' + moneyShort(r.ev) + '</td>' +
      '<td><span class="badge ' + r.verdict + '">' + r.verdict + '</span></td>' +
      '<td>' + (r.perHour >= 0 ? '+' : '') + '$' + r.perHour.toFixed(2) + '</td>' +
      '<td>' + money(r.dstar) + '</td>' +
      '</tr>';
  }

  function renderBoard() {
    var t = tierRows();
    var html = '';
    t.cand.forEach(function (r) { html += rowHtml(r); });
    if (t.cand.length && t.flag.length && state.tier === 'all') {
      html += '<tr class="tierbreak"><td colspan="13">Flagged products below — ranked for reference only, not launch candidates</td></tr>';
    }
    t.flag.forEach(function (r) { html += rowHtml(r); });
    $('boardbody').innerHTML = html;
    var n = t.cand.length + t.flag.length;
    $('boardcount').textContent = 'Showing ' + n + ' of ' + D.board.length +
      ' pre-token protocols (candidates ' + t.cand.length + ', flagged ' + t.flag.length + ').';
    Array.prototype.forEach.call(document.querySelectorAll('#boardbody tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () {
        location.hash = tr.getAttribute('data-slug');
        showDetail(tr.getAttribute('data-slug'));
      });
    });
  }

  function evRank(r) {
    var tier = D.board.filter(function (x) { return (x.flag === null) === (r.flag === null); })
      .sort(function (a, b) { return b.ev - a.ev; });
    for (var i = 0; i < tier.length; i++) if (tier[i].slug === r.slug) return i + 1;
    return 0;
  }

  function showDetail(slug) {
    var r = null;
    for (var i = 0; i < D.board.length; i++) if (D.board[i].slug === slug) r = D.board[i];
    var el = $('detail');
    if (!r) { el.innerHTML = ''; return; }
    var tiers = r.flag === null ? '$100 / $500 / $5,000' : 'not a launch candidate';
    var steps = r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    el.innerHTML =
      '<h3>' + esc(r.name) + ' <span class="flagtag">' + (r.flag ? esc(r.flag) : 'launch candidate') + '</span></h3>' +
      '<dl>' +
      '<dt>Rank</dt><dd>' + r.rank + ' of ' + D.board.length + ' (rank range ' + r.rankLo + '–' + r.rankHi + ' within its tier)</dd>' +
      '<dt>Category / chain</dt><dd>' + esc(r.category || '—') + ' / ' + esc(r.chain) + '</dd>' +
      '<dt>TVL / 7d growth / age</dt><dd>' + money(r.tvl) + ' / ' + (r.growth > 0 ? '+' : '') + r.growth.toFixed(1) + '% / ' + ageLabel(r.ageDays) + '</dd>' +
      '<dt>Implied value</dt><dd><strong>' + money(r.implied) + '</strong> · 80% interval ' + money(r.lo) + ' – ' + money(r.hi) + '</dd>' +
      '<dt>Token odds (logistic)</dt><dd>' + pct(r.odds) + ' · cohort by age ' + pct(r.cohortAge) + ' · cohort by TVL ' + pct(r.cohortTvl) + '</dd>' +
      '<dt>EV (odds × implied)</dt><dd>' + money(r.ev) + ' · EV rank ' + evRank(r) + ' within its tier</dd>' +
      '<dt>Farm verdict</dt><dd><span class="badge ' + r.verdict + '">' + r.verdict + '</span></dd>' +
      '<dt>Break-even deposit</dt><dd>' + money(r.dstar) + ' · $/hour at $500: ' + (r.perHour >= 0 ? '+' : '') + '$' + r.perHour.toFixed(2) + ' · min viable capital ' + money(r.mvc) + ' · cost ' + money(r.cost) + '</dd>' +
      '<dt>Deposit tiers</dt><dd>' + tiers + '</dd>' +
      (r.watchlist ? '<dt>Watchlist</dt><dd>Yes — house watchlist member</dd>' : '') +
      '</dl>' +
      '<h3>Farm plan — 6 steps</h3><ol>' + steps + '</ol>';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderScatter() {
    var svg = $('scatter');
    var pts = D.scatter;
    var m = D.model;
    var xs = pts.map(function (p) { return Math.log(p.tvl); });
    var ys = pts.map(function (p) { return Math.log(p.mcap); });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var W = 640, H = 360, L = 56, Rr = 14, T = 14, B = 40;
    var X = function (x) { return L + (x - x0) / (x1 - x0) * (W - L - Rr); };
    var Y = function (y) { return H - B - (y - y0) / (y1 - y0) * (H - T - B); };
    var s = '';
    s += '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - Rr) + '" y2="' + (H - B) + '" stroke="#2d333b"/>';
    s += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (H - B) + '" stroke="#2d333b"/>';
    pts.forEach(function (p) {
      s += '<circle cx="' + X(Math.log(p.tvl)).toFixed(1) + '" cy="' + Y(Math.log(p.mcap)).toFixed(1) + '" r="3" fill="#58a6ff" opacity="0.7"/>';
    });
    var lx0 = X(x0), ly0 = Y(m.b0 + m.b1 * x0), lx1 = X(x1), ly1 = Y(m.b0 + m.b1 * x1);
    s += '<line x1="' + lx0.toFixed(1) + '" y1="' + ly0.toFixed(1) + '" x2="' + lx1.toFixed(1) + '" y2="' + ly1.toFixed(1) + '" stroke="#3fb950" stroke-width="2"/>';
    s += '<text x="' + ((W - L - Rr) / 2 + L) + '" y="' + (H - 8) + '" fill="#9da7b3" font-size="12" text-anchor="middle">log TVL (USD)</text>';
    s += '<text x="14" y="' + ((H - T - B) / 2 + T) + '" fill="#9da7b3" font-size="12" text-anchor="middle" transform="rotate(-90 14 ' + ((H - T - B) / 2 + T) + ')">log mcap (USD)</text>';
    s += '<text x="' + (W - Rr) + '" y="' + (T + 4) + '" fill="#3fb950" font-size="12" text-anchor="end">M1 fit (growth = 0)</text>';
    svg.innerHTML = s;
  }

  function renderBar() {
    var svg = $('bar');
    var top = D.topCand10;
    var max = top[0].implied;
    var W = 640, H = 360, L = 170, rowH = 30, T = 8;
    var s = '';
    top.forEach(function (r, i) {
      var y = T + i * rowH;
      var w = (r.implied / max) * (W - L - 90);
      s += '<text x="' + (L - 8) + '" y="' + (y + 15) + '" fill="#e6edf3" font-size="12" text-anchor="end">' + esc(r.name) + '</text>';
      s += '<rect x="' + L + '" y="' + (y + 2) + '" width="' + w.toFixed(1) + '" height="18" rx="3" fill="#58a6ff"/>';
      s += '<text x="' + (L + w + 6).toFixed(1) + '" y="' + (y + 15) + '" fill="#9da7b3" font-size="12">' + moneyShort(r.implied) + '</text>';
    });
    svg.innerHTML = s;
    svg.setAttribute('viewBox', '0 0 640 ' + (T + top.length * rowH));
  }

  $('tier').addEventListener('change', function (e) { state.tier = e.target.value; renderBoard(); });
  $('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  window.addEventListener('hashchange', function () {
    var slug = location.hash.replace(/^#/, '');
    if (slug) showDetail(slug);
  });

  renderBoard();
  renderScatter();
  renderBar();
  if (location.hash) showDetail(location.hash.replace(/^#/, ''));
})();
