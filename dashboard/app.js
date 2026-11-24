// Launch Radar v4 dashboard. Reads window.RADAR (written by main.ts into
// data.js) and renders the board, the charts, the traded anchors and the
// excluded list. No network: everything comes from data.js.

const R = window.RADAR;

function $(id) { return document.getElementById(id); }

function money(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(3);
}

function moneyFull(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function pct(x, digits) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return (x * 100).toFixed(digits === undefined ? 1 : digits) + '%';
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ageText(days) {
  if (days === null || days === undefined) return '—';
  if (days >= 365) return (days / 365).toFixed(1) + 'y';
  if (days >= 30) return Math.round(days / 30) + 'mo';
  return days + 'd';
}

function verdictBadge(v) {
  return '<span class="badge ' + (v === 'farm' ? '' : v) + '">' + esc(v) + '</span>';
}

// ---- board ----

let currentRows = R.board;

function renderBoard() {
  const q = ($('q').value || '').trim().toLowerCase();
  const watchOnly = $('watchOnly').checked;
  const farmOnly = $('farmOnly').checked;
  currentRows = R.board.filter((r) => {
    if (watchOnly && !r.watchlist) return false;
    if (farmOnly && r.verdict !== 'farm') return false;
    if (!q) return true;
    const hay = (r.name + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
    return hay.indexOf(q) !== -1;
  });
  const tb = $('board').querySelector('tbody');
  tb.innerHTML = currentRows.map((r) => '<tr data-slug="' + esc(r.slug) + '">'
    + '<td class="num">' + r.rank + '</td>'
    + '<td><strong>' + esc(r.name) + '</strong>' + (r.watchlist ? '<span class="badge wl">watchlist</span>' : '') + '</td>'
    + '<td>' + esc(r.category || '—') + '</td>'
    + '<td>' + esc(r.chains.join(', ')) + '</td>'
    + '<td class="num">' + money(r.tvl_usd) + '</td>'
    + '<td class="num">' + (r.change_7d === null ? '—' : r.change_7d.toFixed(1) + '%') + '</td>'
    + '<td class="num">' + ageText(r.age_days) + '</td>'
    + '<td class="num"><strong>' + money(r.implied_value_usd) + '</strong></td>'
    + '<td class="num">' + money(r.lo_usd) + ' – ' + money(r.hi_usd) + '</td>'
    + '<td class="num">' + pct(r.odds) + '</td>'
    + '<td class="num">' + money(r.ev_usd) + '</td>'
    + '<td class="num">' + money(r.min_capital_usd) + '</td>'
    + '<td>' + verdictBadge(r.verdict) + '</td>'
    + '</tr>').join('');
  $('count').textContent = currentRows.length + ' of ' + R.board.length + ' candidates';
  tb.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => { location.hash = '#detail=' + tr.getAttribute('data-slug'); });
  });
}

// ---- detail ----

function showDetail(slug) {
  const r = R.board.find((x) => x.slug === slug);
  const sec = $('detail');
  if (!r) {
    sec.hidden = true;
    return;
  }
  $('board-section').hidden = true;
  $('detail-title').textContent = '#' + r.rank + ' — ' + r.name;
  const anchor = r.peer_anchor
    ? esc(r.peer_anchor.name) + ' (mcap ' + money(r.peer_anchor.mcap_usd) + ', TVL ' + money(r.peer_anchor.tvl_usd) + ')'
    : '—';
  $('detail-body').innerHTML =
    '<dl>'
    + '<dt>Category</dt><dd>' + esc(r.category || '—') + '</dd>'
    + '<dt>Chains</dt><dd>' + esc(r.chains.join(', ')) + '</dd>'
    + '<dt>TVL</dt><dd>' + moneyFull(r.tvl_usd) + '</dd>'
    + '<dt>7-day change</dt><dd>' + (r.change_7d === null ? 'not reported' : r.change_7d.toFixed(2) + '% (clipped to ' + Math.max(-50, Math.min(50, r.change_7d)).toFixed(2) + '% for the model)') + '</dd>'
    + '<dt>Age</dt><dd>' + ageText(r.age_days) + '</dd>'
    + '<dt>Implied value</dt><dd><strong>' + moneyFull(r.implied_value_usd) + '</strong> (interval ' + money(r.lo_usd) + ' – ' + money(r.hi_usd) + ', q80 ' + r.interval_log.toFixed(2) + ' log units)</dd>'
    + '<dt>Launch odds</dt><dd>' + pct(r.odds) + ' (ridge-logistic, CV Brier ' + R.odds.logisticCv.toFixed(4) + ')</dd>'
    + '<dt>Expected value</dt><dd>' + moneyFull(r.ev_usd) + ' = implied &times; odds</dd>'
    + '<dt>Farm cost</dt><dd>' + money(r.farm_cost_usd) + ' (gas by chain + bridge when multi-chain)</dd>'
    + '<dt>Minimum capital</dt><dd>' + money(r.min_capital_usd) + ' = max($50, 10 &times; farm cost)</dd>'
    + '<dt>Verdict</dt><dd>' + verdictBadge(r.verdict) + ' — break-even ' + (Number.isFinite(r.break_even_x) ? r.break_even_x.toFixed(6) + '&times; EV' : '—') + '</dd>'
    + '<dt>Peer anchor</dt><dd>' + anchor + '</dd>'
    + '<dt>Watchlist</dt><dd>' + (r.watchlist ? 'yes' : 'no') + '</dd>'
    + '</dl>'
    + '<h3>Farm plan — six steps</h3>'
    + '<ol>' + r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>'
    + '<p class="note">The implied value is the model\u2019s claim for the token if the protocol\u2019s record stayed as it is. It is not a prediction of whether or when a token is issued.</p>';
  sec.hidden = false;
  sec.scrollIntoView();
}

function hideDetail() {
  $('detail').hidden = true;
  $('board-section').hidden = false;
}

// ---- charts (inline SVG, drawn from the same data as the board) ----

function svgScatter() {
  const pts = R.traded.filter((t) => t.in_fit && t.mcap_usd > 0).map((t) => ({
    x: Math.log(t.tvl_usd),
    y: Math.log(t.mcap_usd),
  }));
  const W = 520, H = 340, P = 44;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs) - 0.3, x1 = Math.max(...xs) + 0.3;
  const y0 = Math.min(...ys) - 0.3, y1 = Math.max(...ys) + 0.3;
  const X = (v) => P + ((v - x0) / (x1 - x0)) * (W - 2 * P);
  const Y = (v) => H - P - ((v - y0) / (y1 - y0)) * (H - 2 * P);
  const b = R.model.beta;
  // Fitted line at growth 0%: log(mcap) = b0 + b1*log(TVL).
  const ly0 = b[0] + b[1] * x0, ly1 = b[0] + b[1] * x1;
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of log TVL against log market cap for the 111 fit protocols, with the fitted line">';
  s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>';
  for (let g = Math.ceil(x0); g <= x1; g++) {
    s += '<line x1="' + X(g).toFixed(1) + '" y1="' + (H - P) + '" x2="' + X(g).toFixed(1) + '" y2="' + P + '" stroke="#eef1f4"/>';
  }
  for (let g = Math.ceil(y0); g <= y1; g++) {
    s += '<line x1="' + P + '" y1="' + Y(g).toFixed(1) + '" x2="' + (W - P) + '" y2="' + Y(g).toFixed(1) + '" stroke="#eef1f4"/>';
  }
  s += '<line x1="' + X(x0).toFixed(1) + '" y1="' + Y(ly0).toFixed(1) + '" x2="' + X(x1).toFixed(1) + '" y2="' + Y(ly1).toFixed(1) + '" stroke="#0b5fff" stroke-width="2"/>';
  for (const p of pts) {
    s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3" fill="#0d1526" opacity="0.65"/>';
  }
  s += '<text x="' + (W / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="12" fill="#5b636b">log TVL (USD)</text>';
  s += '<text x="14" y="' + (H / 2) + '" text-anchor="middle" font-size="12" fill="#5b636b" transform="rotate(-90 14 ' + (H / 2) + ')">log market cap (USD)</text>';
  s += '<text x="' + (W - P) + '" y="' + (H - P - 8) + '" text-anchor="end" font-size="11" fill="#0b5fff">fitted line at growth 0%</text>';
  s += '</svg>';
  return s;
}

function svgBars() {
  const bands = [
    { label: '>$100M', test: (v) => v > 1e8 },
    { label: '$50–100M', test: (v) => v > 5e7 && v <= 1e8 },
    { label: '$10–50M', test: (v) => v > 1e7 && v <= 5e7 },
    { label: '$1–10M', test: (v) => v > 1e6 && v <= 1e7 },
    { label: '<$1M', test: (v) => v <= 1e6 },
  ];
  const counts = bands.map((bd) => R.board.filter((r) => bd.test(r.implied_value_usd)).length);
  const max = Math.max(...counts, 1);
  const W = 520, H = 340, P = 44, BW = 46;
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Candidates per implied-value band">';
  s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>';
  bands.forEach((bd, i) => {
    const h = ((H - 2 * P) * counts[i]) / max;
    const x = P + 18 + i * ((W - 2 * P - 20) / bands.length);
    const bw = ((W - 2 * P - 20) / bands.length) - 16;
    s += '<rect x="' + x.toFixed(1) + '" y="' + (H - P - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="#0b5fff"/>';
    s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - P - h - 6).toFixed(1) + '" text-anchor="middle" font-size="13" font-weight="700" fill="#1a1d21">' + counts[i] + '</text>';
    s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - P + 16) + '" text-anchor="middle" font-size="11" fill="#5b636b">' + bd.label + '</text>';
  });
  s += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="12" fill="#5b636b">implied value band</text>';
  s += '</svg>';
  return s;
}

// ---- traded anchors and excluded list ----

function renderTraded() {
  const tb = $('traded').querySelector('tbody');
  tb.innerHTML = R.traded.map((t) => '<tr>'
    + '<td><strong>' + esc(t.name) + '</strong></td>'
    + '<td>' + esc(t.category || '—') + '</td>'
    + '<td class="num">' + money(t.tvl_usd) + '</td>'
    + '<td class="num">' + money(t.mcap_usd) + '</td>'
    + '<td class="num">' + (t.multiple > 0 ? t.multiple.toFixed(2) + 'x' : '—') + '</td>'
    + '<td>' + (t.in_fit ? 'yes' : '—') + '</td>'
    + '</tr>').join('');
}

function renderExcluded() {
  const tb = $('excluded').querySelector('tbody');
  tb.innerHTML = R.excluded.map((e) => '<tr>'
    + '<td><strong>' + esc(e.name) + '</strong></td>'
    + '<td>' + esc(e.category || '—') + '</td>'
    + '<td class="num">' + money(e.tvl_usd) + '</td>'
    + '<td class="num">' + money(e.implied_value_usd) + '</td>'
    + '<td>' + esc(e.reason) + '</td>'
    + '</tr>').join('');
}

// ---- init and hash routing (for the three screenshots) ----

function applyHash() {
  const h = location.hash || '';
  if (h.indexOf('#detail=') === 0) {
    showDetail(decodeURIComponent(h.slice('#detail='.length)));
    return;
  }
  hideDetail();
  if (h === '#filter=watchlist') {
    $('watchOnly').checked = true;
    $('farmOnly').checked = false;
  } else if (h === '#filter=farm') {
    $('farmOnly').checked = true;
    $('watchOnly').checked = false;
  } else {
    $('watchOnly').checked = false;
    $('farmOnly').checked = false;
  }
  renderBoard();
  if (h === '#filter=watchlist' || h === '#filter=farm') {
    $('board-section').scrollIntoView();
  }
}

$('q').addEventListener('input', renderBoard);
$('watchOnly').addEventListener('change', renderBoard);
$('farmOnly').addEventListener('change', renderBoard);
$('back').addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; });
window.addEventListener('hashchange', applyHash);

$('scatter').innerHTML = svgScatter();
$('bars').innerHTML = svgBars();
renderTraded();
renderExcluded();
applyHash();
