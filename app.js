google.charts.load('current', { packages: ['corechart', 'geochart'] });
google.charts.setOnLoadCallback(init);

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRY_FIXES = { UK: 'GB', EL: 'GR' };

let rawRows = [];

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value || 0);
}

function pct(value) {
  return `${(value || 0).toFixed(2)}%`;
}

function parseNumber(value) {
  const num = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(num) ? num : 0;
}

function normalizeCountry(input) {
  const raw = String(input || '').trim().toUpperCase();
  const fixed = COUNTRY_FIXES[raw] || raw;
  if (!fixed) return { code: 'ZZ', name: 'Unknown' };
  if (fixed.length === 2) return { code: fixed, name: COUNTRY_NAMES.of(fixed) || fixed };
  return { code: 'ZZ', name: raw };
}

function parseBridgerPay(rows) {
  return rows
    .filter(row => String(row.status || '').toLowerCase() === 'approved')
    .map(row => {
      const country = normalizeCountry(row.country || row.cardCountry);
      return { source: 'bridgerpay', psp: row.pspName || 'BridgerPay', country: country.name, code: country.code, revenue: parseNumber(row.amount) };
    })
    .filter(row => row.revenue > 0);
}

function parseZen(rows) {
  return rows
    .filter(row => String(row.transaction_type || '').toLowerCase() === 'purchase')
    .map(row => {
      const country = normalizeCountry(row.customer_country || row.card_country);
      return { source: 'zen', psp: 'ZEN', country: country.name, code: country.code, revenue: parseNumber(row.stl_amount || row.transaction_amount) };
    })
    .filter(row => row.revenue > 0);
}

function parsePayProcc(rows) {
  return rows
    .filter(row => String(row.Status || '').toLowerCase() === 'success')
    .filter(row => String(row.Type || '').toLowerCase() === 'sale')
    .map(row => {
      const country = normalizeCountry(row['Payer Country'] || row['Issuer Country']);
      return { source: 'payprocc', psp: 'PayProcc', country: country.name, code: country.code, revenue: parseNumber(row['Applied Amount']) || parseNumber(row.Amount) };
    })
    .filter(row => row.revenue > 0);
}

function aggregateByCountry(rows, totalRevenue) {
  const map = new Map();
  rows.forEach(row => {
    const current = map.get(row.country) || { country: row.country, code: row.code, revenue: 0, transactions: 0, psps: new Set() };
    current.revenue += row.revenue;
    current.transactions += 1;
    current.psps.add(row.psp);
    map.set(row.country, current);
  });
  return Array.from(map.values()).map(item => ({
    ...item,
    pspCount: item.psps.size,
    pspList: Array.from(item.psps).join(', '),
    revenueShare: totalRevenue ? (item.revenue / totalRevenue) * 100 : 0,
  }));
}

function aggregateByPsp(rows, totalRevenue) {
  const map = new Map();
  rows.forEach(row => {
    const current = map.get(row.psp) || { psp: row.psp, revenue: 0, transactions: 0 };
    current.revenue += row.revenue;
    current.transactions += 1;
    map.set(row.psp, current);
  });
  return Array.from(map.values()).map(item => ({ ...item, revenueShare: totalRevenue ? (item.revenue / totalRevenue) * 100 : 0 }));
}

function aggregateByPspCountry(rows, totalRevenue) {
  const map = new Map();
  rows.forEach(row => {
    const key = `${row.psp}__${row.country}`;
    const current = map.get(key) || { psp: row.psp, country: row.country, revenue: 0, transactions: 0 };
    current.revenue += row.revenue;
    current.transactions += 1;
    map.set(key, current);
  });
  return Array.from(map.values()).map(item => ({ ...item, revenueShare: totalRevenue ? (item.revenue / totalRevenue) * 100 : 0 }));
}

function init() {
  bindUpload('bridgerpayUpload', 'bridgerpay', parseBridgerPay, 'bridgerpayStatus');
  bindUpload('zenUpload', 'zen', parseZen, 'zenStatus');
  bindUpload('payproccUpload', 'payprocc', parsePayProcc, 'payproccStatus');

  ['searchInput', 'pspFilter', 'sourceFilter', 'sortFilter'].forEach(id => {
    document.getElementById(id).addEventListener('input', render);
    document.getElementById(id).addEventListener('change', render);
  });

  populatePspFilter();
}

function bindUpload(inputId, sourceKey, parser, statusId) {
  document.getElementById(inputId).addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsed = parser(results.data || []);
        rawRows = [...rawRows.filter(row => row.source !== sourceKey), ...parsed];
        updateFileStatus(statusId, file.name, parsed.length);
        populatePspFilter();
        render();
      }
    });
  });
}

function updateFileStatus(statusId, fileName, rowCount) {
  const el = document.getElementById(statusId);
  el.textContent = `${fileName} • ${rowCount.toLocaleString()} qualifying rows`;
  el.classList.add('loaded');
}

function populatePspFilter() {
  const select = document.getElementById('pspFilter');
  const current = select.value || 'All';
  const psps = ['All', ...Array.from(new Set(rawRows.map(row => row.psp))).sort()];
  select.innerHTML = psps.map(psp => `<option value="${psp}">${psp}</option>`).join('');
  select.value = psps.includes(current) ? current : 'All';
}

function render() {
  const hasData = rawRows.length > 0;
  document.getElementById('emptyState').style.display = hasData ? 'none' : 'block';
  document.getElementById('dashboard').style.display = hasData ? 'block' : 'none';
  if (!hasData) return;

  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const selectedPsp = document.getElementById('pspFilter').value;
  const selectedSource = document.getElementById('sourceFilter').value;
  const sortBy = document.getElementById('sortFilter').value;

  const filtered = rawRows.filter(row => {
    const searchOk = !search || row.country.toLowerCase().includes(search) || row.psp.toLowerCase().includes(search);
    const pspOk = selectedPsp === 'All' || row.psp === selectedPsp;
    const sourceOk = selectedSource === 'All' || row.source === selectedSource;
    return searchOk && pspOk && sourceOk;
  });

  const totalRevenue = filtered.reduce((sum, row) => sum + row.revenue, 0);
  const totalTransactions = filtered.length;
  let countryData = aggregateByCountry(filtered, totalRevenue);
  let pspData = aggregateByPsp(filtered, totalRevenue);
  let pspCountryData = aggregateByPspCountry(filtered, totalRevenue);

  countryData.sort((a, b) => sortBy === 'share' ? b.revenueShare - a.revenueShare : b.revenue - a.revenue);
  pspData.sort((a, b) => b.revenue - a.revenue);
  pspCountryData.sort((a, b) => b.revenue - a.revenue);

  updateMetrics(totalRevenue, totalTransactions, countryData, pspData, pspCountryData);
  drawCountryBar(countryData.slice(0, 10));
  drawPspPie(pspData);
  drawGeoChart(countryData);
  drawPspCountryBar(pspCountryData.slice(0, 10));
  fillCountryTable(countryData);
  fillPspCountryTable(pspCountryData);
}

function updateMetrics(totalRevenue, totalTransactions, countryData, pspData, pspCountryData) {
  const topCountry = countryData[0];
  const topPsp = pspData[0];

  document.getElementById('totalRevenue').textContent = money(totalRevenue);
  document.getElementById('totalTransactions').textContent = totalTransactions.toLocaleString();
  document.getElementById('topCountry').textContent = topCountry ? topCountry.country : '-';
  document.getElementById('topCountrySub').textContent = topCountry ? `${money(topCountry.revenue)} • ${pct(topCountry.revenueShare)}` : 'No data';
  document.getElementById('topPsp').textContent = topPsp ? topPsp.psp : '-';
  document.getElementById('topPspSub').textContent = topPsp ? `${money(topPsp.revenue)} • ${pct(topPsp.revenueShare)}` : 'No data';
  document.getElementById('avgRevenue').textContent = money(totalTransactions ? totalRevenue / totalTransactions : 0);
  document.getElementById('countryCount').textContent = countryData.length.toLocaleString();
  document.getElementById('pairCount').textContent = pspCountryData.length.toLocaleString();
}

function drawCountryBar(rows) {
  const data = new google.visualization.DataTable();
  data.addColumn('string', 'Country');
  data.addColumn('number', 'Revenue');
  rows.forEach(row => data.addRow([row.country, row.revenue]));

  const chart = new google.visualization.ColumnChart(document.getElementById('countryBarChart'));
  chart.draw(data, {
    legend: 'none',
    colors: ['#4f8cff'],
    backgroundColor: 'transparent',
    chartArea: { left: 60, right: 20, top: 20, bottom: 80, width: '100%', height: '70%' },
    hAxis: { slantedText: true, slantedTextAngle: 35, textStyle: { color: '#dbeafe' } },
    vAxis: { format: 'short', textStyle: { color: '#dbeafe' }, gridlines: { color: 'rgba(255,255,255,0.08)' } },
  });
}

function drawPspPie(rows) {
  const data = new google.visualization.DataTable();
  data.addColumn('string', 'PSP');
  data.addColumn('number', 'Revenue');
  rows.forEach(row => data.addRow([row.psp, row.revenue]));

  const chart = new google.visualization.PieChart(document.getElementById('pspPieChart'));
  chart.draw(data, {
    pieHole: 0.55,
    backgroundColor: 'transparent',
    chartArea: { left: 20, right: 20, top: 20, bottom: 20, width: '100%', height: '85%' },
    colors: ['#4f8cff', '#16c2a3', '#8b5cf6', '#f97316', '#06b6d4'],
    legend: { textStyle: { color: '#dbeafe' } }
  });
}

function drawGeoChart(rows) {
  const data = new google.visualization.DataTable();
  data.addColumn('string', 'Country');
  data.addColumn('number', 'Revenue');
  rows.forEach(row => {
    if (row.code && row.code !== 'ZZ') data.addRow([row.code, row.revenue]);
  });

  const chart = new google.visualization.GeoChart(document.getElementById('geoChart'));
  chart.draw(data, {
    backgroundColor: 'transparent',
    colorAxis: { colors: ['#11315f', '#4f8cff'] },
    datalessRegionColor: '#102238',
    defaultColor: '#102238',
    legend: 'none',
  });
}

function drawPspCountryBar(rows) {
  const data = new google.visualization.DataTable();
  data.addColumn('string', 'PSP-Country');
  data.addColumn('number', 'Revenue');
  rows.forEach(row => data.addRow([`${row.psp} • ${row.country}`, row.revenue]));

  const chart = new google.visualization.BarChart(document.getElementById('pspCountryChart'));
  chart.draw(data, {
    legend: 'none',
    colors: ['#16c2a3'],
    backgroundColor: 'transparent',
    chartArea: { left: 160, right: 20, top: 20, bottom: 20, width: '70%', height: '75%' },
    hAxis: { format: 'short', textStyle: { color: '#dbeafe' }, gridlines: { color: 'rgba(255,255,255,0.08)' } },
    vAxis: { textStyle: { color: '#dbeafe' } },
  });
}

function fillCountryTable(rows) {
  const tbody = document.querySelector('#countryTable tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No rows match the current filter.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${escapeHtml(row.country)}</td>
      <td class="right">${money(row.revenue)}</td>
      <td class="right">${pct(row.revenueShare)}</td>
      <td class="right">${row.transactions.toLocaleString()}</td>
      <td class="right">${row.pspCount}</td>
      <td>${escapeHtml(row.pspList)}</td>
    </tr>
  `).join('');
}

function fillPspCountryTable(rows) {
  const tbody = document.querySelector('#pspCountryTable tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No rows match the current filter.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${escapeHtml(row.psp)}</td>
      <td>${escapeHtml(row.country)}</td>
      <td class="right">${money(row.revenue)}</td>
      <td class="right">${pct(row.revenueShare)}</td>
      <td class="right">${row.transactions.toLocaleString()}</td>
    </tr>
  `).join('');
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

window.addEventListener('resize', () => {
  if (rawRows.length) render();
});
