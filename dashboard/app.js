// app.js — renders the Launch Radar board, detail view and filters.
// Reads window.RADAR (data.js, written by main.ts from the snapshot).
const RADAR = window.RADAR;
const fmt = (n) => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + Math.round(n).toLocaleString('en-US');
const params = new URLSearchParams(location.search);

function fillSelect(id, values) {
  const el = document.getElementById(id);
  [...new Set(values)].sort().forEach((v) => {
    const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o);
  });
}
fillSelect('cat', RADAR.rows.map((r) => r.category).filter(Boolean));
fillSelect('chain', RADAR.rows.flatMap((r) => r.chains));

document.getElementById('kpis').innerHTML =
  '<div class="kpi"><b>' + RADAR.rows.length + '</b><span>pre-token rows</span></div>' +
  '<div class="kpi"><b>' + RADAR.watchlist_size + '</b><span>on watchlist</span></div>' +
  '<div class="kpi"><b>' + fmt(RADAR.rows[0].expected_value_usd) + '</b><span>top expected value (' + RADAR.rows[0].name + ')</span></div>' +
  '<div class="kpi"><b>' + RADAR.meta.global_multiple + 'x</b><span>global mcap/TVL multiple</span></div>' +
  '<div class="kpi"><b>' + RADAR.as_of + '</b><span>snapshot date</span></div>';

document.getElementById('validation').innerHTML =
  '<b>How the model was tested (held-out, reported as-is):</b> traded protocols split by listing date — older half trains the category multiples, newer half tests them. ' +
  'Median predicted/actual <b>' + RADAR.meta.validation.median_ratio + 'x</b> on ' + RADAR.meta.validation.n_test + ' held-out protocols (median absolute error ' + RADAR.meta.validation.median_abs_pct_error + '%, ratios are wide — the multiple is a median, not a precise price). ' +
  RADAR.meta.method;

function render() {
  const q = (document.getElementById('q').value || '').toLowerCase();
  const cat = document.getElementById('cat').value;
  const chain = document.getElementById('chain').value;
  const watch = document.getElementById('watch').checked;
  const rows = RADAR.rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!cat || r.category === cat) && (!chain || r.chains.includes(chain)) &&
    (!watch || r.on_watchlist));
  document.getElementById('rows').innerHTML = rows.map((r, i) =>
    '<tr data-slug="' + r.slug + '"><td>' + (i + 1) + '</td><td><b>' + r.name + '</b><br><small>' + r.slug + '</small></td><td>' + (r.category || '') + '</td><td>' + r.chains.slice(0, 3).join(', ') + '</td><td>' + fmt(r.tvl_usd) + '</td><td class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + (r.change_7d == null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</td><td>' + r.multiple + 'x</td><td>' + fmt(r.implied_value_usd) + '</td><td>' + Math.round(r.token_odds * 100) + '%</td><td><b>' + fmt(r.expected_value_usd) + '</b></td><td>' + (r.on_watchlist ? '★' : '') + '</td></tr>').join('');
  document.querySelectorAll('#rows tr').forEach((tr) => tr.addEventListener('click', () => showDetail(tr.dataset.slug)));
}

function showDetail(slug) {
  const r = RADAR.rows.find((x) => x.slug === slug);
  if (!r) return;
  document.getElementById('detail').hidden = false;
  document.getElementById('detail-name').textContent = r.name + ' — ' + fmt(r.expected_value_usd) + ' expected value';
  document.getElementById('detail-body').innerHTML =
    '<p>Category: ' + (r.category || '—') + ' · Chains: ' + r.chains.join(', ') + ' · TVL ' + fmt(r.tvl_usd) +
    ' · Implied value ' + fmt(r.implied_value_usd) + ' at ' + r.multiple + 'x · Token odds ' + Math.round(r.token_odds * 100) + '% · Watchlist: ' + (r.on_watchlist ? 'yes' : 'no') + '</p>' +
    '<p>' + r.note + '</p>' +
    '<h3>Farm plan (deposit tiers $100 / $1,000 / $10,000)</h3><ol>' + r.farm_plan.map((s) => '<li>' + s + '</li>').join('') + '</ol>' +
    '<p>Cost: gas on the protocol\'s main chain plus the deposit itself; no token purchase is required to farm.</p>';
  document.getElementById('detail').scrollIntoView();
}

['q', 'cat', 'chain', 'watch'].forEach((id) => document.getElementById(id).addEventListener('input', render));
if (params.get('category')) { document.getElementById('cat').value = params.get('category'); }
if (params.get('chain')) { document.getElementById('chain').value = params.get('chain'); }
render();
if (params.get('slug')) showDetail(params.get('slug'));
