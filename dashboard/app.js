// Launch Radar v3 dashboard: sorts, filters and details the board main.ts wrote.
// The data comes from ../data.js (window.LAUNCH_RADAR_V3), written by the same run.
(function () {
  var D = window.LAUNCH_RADAR_V3;
  var rows = D.rows;
  function $(id) { return document.getElementById(id); }

  /** Short money: $12.4M, $836K, $512. */
  function money(x) {
    if (x === null || x === undefined) return '—';
    if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
    if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M';
    if (x >= 1e3) return '$' + (x / 1e3).toFixed(0) + 'K';
    return '$' + x.toFixed(0);
  }
  function moneyFull(x) {
    if (x === null || x === undefined) return '—';
    return '$' + Math.round(x).toLocaleString('en-US');
  }
  function pct(x) {
    if (x === null || x === undefined) return '—';
    return (x * 100).toFixed(1) + '%';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** State: view, category, query, sort, and the open detail slug. */
  var state = { view: 'candidate', cat: '', q: '', sort: 'implied', detail: null };

  /** Read #view=..&cat=..&sort=..&q=..&detail=.. from the URL hash. */
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    var parts = h.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent(kv[1] || '');
      if (k === 'view' && (v === 'candidate' || v === 'all' || v === 'traded' || v === 'excluded')) state.view = v;
      if (k === 'cat') state.cat = v;
      if (k === 'sort') state.sort = v;
      if (k === 'q') state.q = v;
      if (k === 'detail') state.detail = v;
    }
  }

  /** Rows for the current filter, sorted as chosen. */
  function currentRows() {
    var list = rows.filter(function (r) {
      if (state.view !== 'all' && r.status !== state.view) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'name') return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'odds') return (b.odds_12m || -1) - (a.odds_12m || -1);
      if (key === 'ev') return (b.ev_usd || -1) - (a.ev_usd || -1);
      return b.implied_value_usd - a.implied_value_usd;
    });
    return list;
  }

  /** Render the board table for the current state. */
  function render() {
    var list = currentRows();
    var tb = $('rows');
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var odds = r.odds_12m === null ? '—' : pct(r.odds_12m);
      var ev = r.ev_usd === null ? '—' : money(r.ev_usd);
      var cap = r.min_capital_usd === null ? '—' : money(r.min_capital_usd);
      var vclass = r.verdict === 'farm' ? 'v-farm' : r.verdict === 'watch' ? 'v-watch' : r.verdict === 'thin' ? 'v-thin' : '';
      html += '<tr data-slug="' + esc(r.slug) + '">'
        + '<td>' + (i + 1) + '</td>'
        + '<td><strong>' + esc(r.name) + '</strong><br><span style="color:var(--muted);font-size:12px">' + esc(r.slug) + ' · board #' + r.rank + '</span></td>'
        + '<td><span class="badge ' + r.status + '">' + r.status + '</span></td>'
        + '<td>' + money(r.tvl_usd) + '</td>'
        + '<td>' + money(r.implied_value_usd) + '</td>'
        + '<td>' + money(r.lo_usd) + ' – ' + money(r.hi_usd) + '</td>'
        + '<td>' + odds + '</td>'
        + '<td>' + ev + '</td>'
        + '<td class="' + vclass + '">' + r.verdict + '</td>'
        + '<td>' + cap + '</td></tr>';
    }
    tb.innerHTML = html;
    $('count').textContent = list.length + ' rows shown · ' + rows.length + ' on the board · click a row for its detail.';
  }

  /** Fill and show the detail panel for one protocol. */
  function showDetail(slug) {
    var r = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) { r = rows[i]; break; }
    if (!r) return;
    state.detail = slug;
    $('d-name').textContent = r.name;
    var sub = 'Board rank #' + r.rank + ' of ' + rows.length + ' · ' + r.status
      + (r.on_watchlist ? ' · on the watchlist' : '')
      + ' · ' + (r.category === null ? 'no category' : r.category)
      + ' · ' + r.chains.join(', ');
    $('d-sub').textContent = sub;
    var facts = [
      ['TVL', moneyFull(r.tvl_usd)],
      ['Implied value', moneyFull(r.implied_value_usd)],
      ['80% interval', money(r.lo_usd) + ' – ' + money(r.hi_usd)],
      ['Market cap (actual)', r.mcap_usd === null ? 'records no token' : moneyFull(r.mcap_usd)],
      ['Age', r.age_years.toFixed(2) + ' years'],
      ['Launch odds (12m)', pct(r.odds_12m)],
      ['Expected value', r.ev_usd === null ? '—' : moneyFull(r.ev_usd)],
      ['Verdict', r.verdict],
      ['Min capital', r.min_capital_usd === null ? '—' : money(r.min_capital_usd)],
      ['Gas cost', '$' + r.gas_cost_usd.toFixed(2)],
      ['Break-even', r.break_even_x === null ? '—' : (r.break_even_x * 100).toFixed(3) + '% of expected value'],
      ['7-day TVL change', r.change_7d === null ? 'unreported' : r.change_7d.toFixed(1) + '%'],
    ];
    var fh = '';
    for (var j = 0; j < facts.length; j++) {
      fh += '<div><dt>' + esc(facts[j][0]) + '</dt><dd>' + esc(facts[j][1]) + '</dd></div>';
    }
    $('d-facts').innerHTML = fh;
    if (r.peer) {
      $('d-peer').textContent = 'Nearest traded anchor: ' + r.peer.name + ' — market cap '
        + moneyFull(r.peer.mcap_usd) + ' on TVL ' + moneyFull(r.peer.tvl_usd)
        + '. The model was fitted on 128 such anchors; this is the closest one in the same category and size.';
    } else {
      $('d-peer').textContent = 'No traded anchor in this category.';
    }
    var sh = '';
    for (var k = 0; k < r.farm_steps.length; k++) sh += '<li>' + esc(r.farm_steps[k]) + '</li>';
    $('d-steps').innerHTML = sh;
    if (r.status === 'candidate') {
      $('d-cost').textContent = 'Plan cost: $' + r.gas_cost_usd.toFixed(2)
        + ' of gas and bridge, minimum viable capital ' + money(r.min_capital_usd)
        + '. Verdict ' + r.verdict + ': expected value ' + moneyFull(r.ev_usd)
        + ' against a cost of $' + r.gas_cost_usd.toFixed(2) + '.';
    } else if (r.status === 'traded') {
      $('d-cost').textContent = 'No launch to farm: this protocol already trades. The plan above is participation, not a farm.';
    } else {
      $('d-cost').textContent = 'Excluded from the candidate board: ' + (r.excluded_reason || 'rule') + '.';
    }
    $('detail').hidden = false;
    $('detail').scrollIntoView();
  }

  /** Fill the category filter from the data. */
  function fillCategories() {
    var cats = {};
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].category;
      if (c !== null) cats[c] = (cats[c] || 0) + 1;
    }
    var names = Object.keys(cats).sort();
    var sel = $('cat');
    for (var j = 0; j < names.length; j++) {
      var opt = document.createElement('option');
      opt.value = names[j];
      opt.textContent = names[j] + ' (' + cats[names[j]] + ')';
      sel.appendChild(opt);
    }
  }

  /** Push the current state into the URL hash (so views are linkable). */
  function writeHash() {
    var parts = ['view=' + encodeURIComponent(state.view)];
    if (state.cat) parts.push('cat=' + encodeURIComponent(state.cat));
    if (state.sort !== 'implied') parts.push('sort=' + encodeURIComponent(state.sort));
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.detail) parts.push('detail=' + encodeURIComponent(state.detail));
    history.replaceState(null, '', '#' + parts.join('&'));
  }

  function bind() {
    $('q').addEventListener('input', function (e) { state.q = e.target.value; render(); writeHash(); });
    $('view').addEventListener('change', function (e) { state.view = e.target.value; state.detail = null; $('detail').hidden = true; render(); writeHash(); });
    $('cat').addEventListener('change', function (e) { state.cat = e.target.value; render(); writeHash(); });
    $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); writeHash(); });
    $('rows').addEventListener('click', function (e) {
      var tr = e.target.closest('tr');
      if (tr && tr.getAttribute('data-slug')) { showDetail(tr.getAttribute('data-slug')); writeHash(); }
    });
    $('d-close').addEventListener('click', function () { state.detail = null; $('detail').hidden = true; writeHash(); });
    window.addEventListener('hashchange', function () {
      state.detail = null;
      readHash();
      syncControls();
      render();
      if (state.detail) showDetail(state.detail);
    });
  }

  function syncControls() {
    $('view').value = state.view;
    $('cat').value = state.cat;
    $('sort').value = state.sort;
    $('q').value = state.q;
  }

  readHash();
  fillCategories();
  syncControls();
  bind();
  render();
  if (state.detail) showDetail(state.detail);
})();
