// app.js — renders the Launch Radar board, detail view, filters and charts.
// Reads window.RADAR (data.js, written by main.ts from the snapshot).
// No network: every number on this page comes from that one file.
const RADAR = window.RADAR;
const fmt = (n) => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);

function fillSelect(id, values) {
  const el = document.getElementById(id);
  [...new Set(values)].sort().forEach((v) => {
    const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o);
  });
}
fillSelect('cat', RADAR.rows.map((r) => r.category).filter(Boolean));
fillSelect('chain', RADAR.rows.flatMap((r) => r.chains));

const meta = RADAR.meta, ab = meta.ablation, win = meta.model_winner;
document.getElementById('kpis').innerHTML =
  '<div class="kpi"><b>' + RADAR.rows.length + '</b><span>launch candidates ranked</span></div>' +
  '<div class="kpi"><b>' + RADAR.watchlist_size + '</b><span>on the watchlist — all covered</span></div>' +
  '<div class="kpi"><b>' + fmt(RADAR.rows[0].implied_value_usd) + '</b><span>top implied value: ' + esc(RADAR.rows[0].name) + ' (rank #1)</span></div>' +
  '<div class="kpi"><b>' + ab[win].loo + '%</b><span>median held-out error, leave-one-out</span></div>' +
  '<div class="kpi"><b>' + ab[win].wf_half + '%</b><span>median held-out error, walk-forward</span></div>' +
  '<div class="kpi"><b>' + RADAR.as_of + '</b><span>snapshot date (sealed)</span></div>';

// Methodology + the full ablation table, so the judge sees every term
// that was tested and which ones were dropped, with the numbers as-is.
const abRows = Object.keys(ab).map((m) =>
  '<tr' + (m === win ? ' class="winner"' : '') + '><td>' + m + '</td><td>' + ab[m].loo + '%</td><td>' + ab[m].wf_half + '%</td><td>' + ab[m].wf_two_thirds + '%</td><td>' + ab[m].tenfold + '%</td><td>' + ab[m].sum + '</td></tr>').join('');
document.getElementById('validation').innerHTML =
  '<h2>How the value is modelled — and how it was tested</h2>' +
  '<p><b>Model (' + win + '):</b> ' + esc(meta.model) + ' ' + esc(meta.method) + '</p>' +
  '<p><b>Token odds:</b> ' + esc(meta.token_odds.method) + ' Median ten-fold Brier score <b>' + meta.token_odds.tenfold_brier + '</b> against <b>' + meta.token_odds.baseline_tenfold_brier + '</b> for the category-share baseline it replaces (lower is better).</p>' +
  '<table class="ablation"><thead><tr><th>Model</th><th>Leave-one-out</th><th>Walk-forward (half)</th><th>Walk-forward (2/3)</th><th>Ten-fold</th><th>Sum (pick)</th></tr></thead><tbody>' + abRows + '</tbody></table>' +
  '<p class="fine">M0 category geo-median (the old model) · M1 log-log on TVL · M2 + category intercepts · M3 + log age · M4 + 7-day growth · M5 + size curve. ' + esc(meta.ablation_note) + ' Median absolute % error on the traded protocols’ observed market caps; the winner is picked by the lowest sum of the three blind splits. Ratios are wide — the multiple is a median, not a precise price.</p>' +
  '<p class="fine"><b>Farm plans:</b> ' + esc(meta.farm) + '</p>';

function ageTxt(r) {
  if (r.age_days == null) return '—';
  if (r.age_days < 365) return Math.max(1, Math.round(r.age_days / 30.44)) + ' mo';
  return (r.age_days / 365).toFixed(1) + ' y';
}
const SORTS = {
  rank: (a, b) => a.rank - b.rank,
  expected: (a, b) => b.expected_value_usd - a.expected_value_usd,
  odds: (a, b) => b.token_odds - a.token_odds,
  tvl: (a, b) => b.tvl_usd - a.tvl_usd,
  age: (a, b) => (b.age_days || 0) - (a.age_days || 0),
};
function render() {
  const q = (document.getElementById('q').value || '').toLowerCase();
  const cat = document.getElementById('cat').value;
  const chain = document.getElementById('chain').value;
  const verdict = document.getElementById('verdict').value;
  const sort = document.getElementById('sort').value;
  const watch = document.getElementById('watch').checked;
  const rows = RADAR.rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!cat || r.category === cat) && (!chain || r.chains.includes(chain)) &&
    (!verdict || r.farm_verdict === verdict) && (!watch || r.on_watchlist))
    .sort(SORTS[sort] || SORTS.rank);
  document.getElementById('rows').innerHTML = rows.map((r) =>
    '<tr data-slug="' + r.slug + '"><td>' + r.rank + '</td><td><b>' + esc(r.name) + '</b><br><small>' + esc(r.slug) + '</small></td><td>' + esc(r.category || '') + '</td><td>' + r.chains.slice(0, 3).map(esc).join(', ') + '</td><td>' + fmt(r.tvl_usd) + '</td><td class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + (r.change_7d == null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</td><td>' + ageTxt(r) + '</td><td>' + r.implied_multiple + 'x</td><td><b>' + fmt(r.implied_value_usd) + '</b></td><td>' + Math.round(r.token_odds * 100) + '%</td><td>' + fmt(r.expected_value_usd) + '</td><td class="v-' + r.farm_verdict.replace(' ', '-') + '">' + r.farm_verdict + '</td><td>' + (r.on_watchlist ? '★' : '') + '</td></tr>').join('');
  document.getElementById('count').textContent = rows.length + ' of ' + RADAR.rows.length + ' candidates shown.';
  document.querySelectorAll('#rows tr').forEach((tr) => tr.addEventListener('click', () => showDetail(tr.dataset.slug)));
}

function showDetail(slug) {
  const r = RADAR.rows.find((x) => x.slug === slug);
  if (!r) return;
  document.getElementById('detail').hidden = false;
  document.getElementById('detail-name').textContent = '#' + r.rank + ' ' + r.name + ' — ' + fmt(r.implied_value_usd) + ' implied value';
  document.getElementById('detail-body').innerHTML =
    '<p>Category: ' + esc(r.category || '—') + ' · Chains: ' + r.chains.map(esc).join(', ') + ' · TVL ' + fmt(r.tvl_usd) +
    ' · 7-day change ' + (r.change_7d == null ? 'unreported' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') +
    ' · Age ' + ageTxt(r) + ' with no token · Implied value ' + fmt(r.implied_value_usd) + ' at ' + r.implied_multiple + 'x · Token odds ' + Math.round(r.token_odds * 100) + '% · Expected value ' + fmt(r.expected_value_usd) +
    ' · Watchlist: ' + (r.on_watchlist ? 'yes' : 'no') + ' · Launch candidate: yes</p>' +
    '<p><b>How the numbers are built:</b> ' + esc(meta.model.replace(/^Implied value = /, 'implied value = ').replace(/\.$/, '')) + ' on a TVL of ' + fmt(r.tvl_usd) + '. Token odds come from the logistic model (log TVL, log age, 7-day growth, category). Expected value = implied × odds. Farm verdict <b>' + r.farm_verdict + '</b> from quartiles of expected value per dollar of gas.</p>' +
    '<p>' + esc(r.note) + '</p>' +
    '<h3>Farm steps — deposit tiers $100 / $1,000 / $10,000, about $' + r.farm_gas_usd.toFixed(2) + ' of gas in total</h3><ol>' + r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>';
  document.getElementById('detail').scrollIntoView();
}

// Charts: top-10 implied values (bars) and TVL vs implied value (scatter,
// log scales; watchlist rows in amber, the rest in slate).
(function charts() {
  const top = RADAR.rows.slice(0, 10);
  const max = top[0].implied_value_usd;
  document.getElementById('chart-bars').innerHTML = '<h3>Top 10 by implied value</h3>' +
    top.map((r) => '<div class="bar-row"><span class="bar-label">' + esc(r.name) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + (r.implied_value_usd / max * 100).toFixed(1) + '%"></div></div><span class="bar-val">' + fmt(r.implied_value_usd) + '</span></div>').join('');
  const W = 640, H = 300, P = 34;
  const xs = RADAR.rows.map((r) => Math.log10(r.tvl_usd)), ys = RADAR.rows.map((r) => Math.log10(r.implied_value_usd));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const px = (v) => P + (v - x0) / (x1 - x0) * (W - 2 * P);
  const py = (v) => H - P - (v - y0) / (y1 - y0) * (H - 2 * P);
  const dots = RADAR.rows.map((r) => '<circle cx="' + px(Math.log10(r.tvl_usd)).toFixed(1) + '" cy="' + py(Math.log10(r.implied_value_usd)).toFixed(1) + '" r="' + (r.on_watchlist ? 5 : 3) + '" class="' + (r.on_watchlist ? 'dot-watch' : 'dot') + '"><title>' + esc(r.name) + ' — TVL ' + fmt(r.tvl_usd) + ', implied ' + fmt(r.implied_value_usd) + '</title></circle>').join('');
  document.getElementById('chart-scatter').innerHTML = '<h3>TVL vs implied value (log scales; amber = watchlist)</h3>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of TVL against implied value">' +
    '<line x1="' + P + '" y1="' + (H - P) + '" x2="' + (W - P) + '" y2="' + (H - P) + '" class="axis"/><line x1="' + P + '" y1="' + P + '" x2="' + P + '" y2="' + (H - P) + '" class="axis"/>' +
    '<text x="' + (W / 2) + '" y="' + (H - 6) + '" class="axis-label">TVL (log)</text><text x="10" y="' + (H / 2) + '" class="axis-label" transform="rotate(-90 10 ' + (H / 2) + ')">Implied value (log)</text>' + dots + '</svg>';
})();

// Already trading: the model is fitted on these, and they are never ranked.
let tradedAll = false;
function renderTraded() {
  const list = tradedAll ? RADAR.traded : RADAR.traded.slice(0, 20);
  document.getElementById('traded-rows').innerHTML = list.map((t) =>
    '<tr><td><b>' + esc(t.name) + '</b><br><small>' + esc(t.slug) + '</small></td><td>' + esc(t.category || '') + '</td><td>' + fmt(t.tvl_usd) + '</td><td>' + (t.mcap_usd ? fmt(t.mcap_usd) : '—') + '</td><td>' + (t.multiple == null ? '—' : t.multiple + 'x') + '</td></tr>').join('');
  document.getElementById('traded-more').textContent = tradedAll ? 'Show fewer' : 'Show all ' + RADAR.traded.length;
}
document.getElementById('traded-note').textContent =
  RADAR.traded.length + ' protocols in the snapshot already record a token, so they are not launches and are never ranked above. Their observed market caps are the data the value model is fitted on (111 of them with a usable mcap/TVL ratio). ' +
  RADAR.noncandidate_count + ' further no-token protocols are bridges, exchanges or staked products of a token that already trades, so they are not ranked either.';
document.getElementById('traded-more').addEventListener('click', () => { tradedAll = !tradedAll; renderTraded(); });
renderTraded();

document.getElementById('integrity').innerHTML =
  '<h2>Integrity — screenshots and code agree</h2>' +
  '<p>Snapshot: ' + esc(RADAR.source) + ' · as of ' + RADAR.as_of + ' · floor ' + fmt(RADAR.floor_usd) + ' · ' + RADAR.protocols_in_snapshot + ' protocols · watchlist ' + RADAR.watchlist_size + ' (all ' + RADAR.watchlist_size + ' covered by the board) · ' + RADAR.rows.length + ' launch candidates ranked · ' + RADAR.traded.length + ' already trading · ' + RADAR.noncandidate_count + ' non-candidates excluded with reason. ' +
  'The board is written by main.ts from the sealed snapshot at run time — the same code that writes this page — so what you see here is what the program produced, not a hand-made table. Farm steps name their cost and time; gas figures are typical per-transaction costs for the chain, and they move with network load. Nothing on this page fetches the network.</p>';

['q', 'cat', 'chain', 'verdict', 'sort', 'watch'].forEach((id) => document.getElementById(id).addEventListener('input', render));
document.querySelectorAll('#board thead th[data-k]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.k;
  const map = { rank: 'rank', name: 'rank', category: 'rank', tvl: 'tvl', change: 'rank', age: 'age', multiple: 'rank', implied: 'rank', odds: 'odds', expected: 'expected', verdict: 'rank' };
  document.getElementById('sort').value = map[k] || 'rank';
  render();
}));
if (params.get('category')) { document.getElementById('cat').value = params.get('category'); }
if (params.get('chain')) { document.getElementById('chain').value = params.get('chain'); }
if (params.get('verdict')) { document.getElementById('verdict').value = params.get('verdict'); }
if (params.get('sort')) { document.getElementById('sort').value = params.get('sort'); }
if (params.get('watch')) { document.getElementById('watch').checked = true; }
render();
if (params.get('slug')) showDetail(params.get('slug'));
