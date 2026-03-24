google.charts.load('current', { packages: ['corechart', 'geochart'] });
google.charts.setOnLoadCallback(init);

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const COUNTRY_FIXES = { UK: 'GB', EL: 'GR' };
const APPROVED_STATUSES = new Set(['approved', 'captured', 'successful']);

let rawRows = [];
let bridgerpayApprovalRows = [];

function money(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function pct(value) {
  return `${(value || 0).toFixed(2)}%`;
}

function parseNumber(value) {
  const num = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(num) ? num : 0;
}

function formatDateKeyFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseUtcLikeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }

  const text = String(value).trim();
  if (!text) return null;

  const payProccMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i);
  if (payProccMatch) {
    let [, year, month, day, hour, minute, second, meridiem] = payProccMatch;
    hour = Number(hour);
    if (meridiem.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (meridiem.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, Number(minute), Number(second)));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toGmt6DateKey(value) {
  const parsed = parseUtcLikeDate(value);
  if (!parsed) return '';
  const shifted = parsed.getTime() + (6 * 60 * 60 * 1000);
  return formatDateKeyFromMs(shifted);
}

function inDateRange(dateKey, startDate, endDate) {
  if (!dateKey) return true;
  if (startDate && dateKey < startDate) return false;
  if (endDate && dateKey > endDate) return false;
  return true;
}

function refreshGlobalDateBounds() {
  const allDates = [...rawRows.map(row => row.localDate), ...bridgerpayApprovalRows.map(row => row.localDate)].filter(Boolean).sort();
  const startEl = document.getElementById('globalStartDate');
  const endEl = document.getElementById('globalEndDate');

  if (!allDates.length) {
    startEl.value = '';
    endEl.value = '';
    startEl.min = '';
    startEl.max = '';
    endEl.min = '';
    endEl.max = '';
    return;
  }

  const minDate = allDates[0];
  const maxDate = allDates[allDates.length - 1];

  startEl.min = minDate;
  startEl.max = maxDate;
  endEl.min = minDate;
  endEl.max = maxDate;

  if (!startEl.value || startEl.value < minDate || startEl.value > maxDate) startEl.value = minDate;
  if (!endEl.value || endEl.value < minDate || endEl.value > maxDate) endEl.value = maxDate;

  if (startEl.value > endEl.value) {
    endEl.value = startEl.value;
  }
}

function normalizeCountry(input) {
  const raw = String(input || '').trim().toUpperCase();
  const fixed = COUNTRY_FIXES[raw] || raw;
  if (!fixed) return { code: 'ZZ', name: 'Unknown' };
  if (fixed.length === 2) return { code: fixed, name: COUNTRY_NAMES.of(fixed) || fixed };
  return { code: 'ZZ', name: input || 'Unknown' };
}

function normalizeText(value, fallback = 'Unknown') {
  const text = String(value || '').trim();
  return text || fallback;
}

function getPspType(pspName) {
  const key = String(pspName || '').trim().toLowerCase();
  if (key.includes('confirmo')) return 'Crypto';
  if (key.includes('paypal')) return 'P2P';
  return 'Card';
}

function approvalStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  return APPROVED_STATUSES.has(value);
}

function getOrderKey(row) {
  return normalizeText(row.merchantOrderId || row.merchant_order_id || row.order_id || row.transactionId || row.id, 'Unknown Order');
}

function parseBridgerPayRevenue(rows) {
  return rows
    .filter(row => approvalStatus(row.status))
    .map(row => {
      const country = normalizeCountry(row.country || row.cardCountry);
      return {
        source: 'bridgerpay',
        psp: normalizeText(row.pspName, 'BridgerPay'),
        country: country.name,
        code: country.code,
        revenue: parseNumber(row.amount),
        localDate: toGmt6DateKey(row.processing_date || row.completionDate || row.processingDate),
      };
    })
    .filter(row => row.revenue > 0);
}

function parseBridgerPayApproval(rows) {
  return rows
    .filter(row => String(row.type || '').trim().toLowerCase() !== 'refund')
    .map(row => {
      const country = normalizeCountry(row.country || row.cardCountry);
      const psp = normalizeText(row.pspName, 'Unknown PSP');
      return {
        orderKey: getOrderKey(row),
        attemptId: normalizeText(row.id || row.transactionId || `${getOrderKey(row)}-${Math.random()}`),
        psp,
        pspType: getPspType(psp),
        country: country.name,
        code: country.code,
        mid: normalizeText(row.midAlias, 'Unknown MID'),
        status: normalizeText(row.status, 'unknown'),
        approved: approvalStatus(row.status),
        declineReason: normalizeText(row.declineReason, 'Unknown'),
        amount: parseNumber(row.amount),
        processingDate: normalizeText(row.processing_date || row.processingDate || row.completionDate, ''),
        localDate: toGmt6DateKey(row.processing_date || row.completionDate || row.processingDate),
      };
    })
    .filter(row => row.orderKey !== 'Unknown Order');
}

function parseZen(rows) {
  return rows
    .filter(row => String(row.transaction_type || '').toLowerCase() === 'purchase')
    .map(row => {
      const country = normalizeCountry(row.customer_country || row.card_country);
      return {
        source: 'zen',
        psp: 'ZEN',
        country: country.name,
        code: country.code,
        revenue: parseNumber(row.stl_amount || row.transaction_amount),
        localDate: toGmt6DateKey(row.stl_date || row.accepted_at || row.created_at),
      };
    })
    .filter(row => row.revenue > 0);
}

function parsePayProcc(rows) {
  return rows
    .filter(row => String(row.Status || '').toLowerCase() === 'success')
    .filter(row => String(row.Type || '').toLowerCase() === 'sale')
    .map(row => {
      const country = normalizeCountry(row['Payer Country'] || row['Issuer Country']);
      return {
        source: 'payprocc',
        psp: 'PayProcc',
        country: country.name,
        code: country.code,
        revenue: parseNumber(row['Applied Amount']) || parseNumber(row.Amount),
        localDate: toGmt6DateKey(row['Transaction Date']),
      };
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

function summarizeApproval(rows) {
  const orders = new Map();
  const declineReasons = new Map();
  let totalAttempts = 0;

  rows.forEach(row => {
    totalAttempts += 1;
    const key = row.orderKey;
    const current = orders.get(key) || {
      approved: false,
      attempts: 0,
      totalAmount: 0,
      latestDate: '',
    };
    current.approved = current.approved || row.approved;
    current.attempts += 1;
    current.totalAmount += row.amount || 0;
    current.latestDate = row.processingDate > current.latestDate ? row.processingDate : current.latestDate;
    orders.set(key, current);

    if (!row.approved) {
      const reason = row.declineReason || 'Unknown';
      declineReasons.set(reason, (declineReasons.get(reason) || 0) + 1);
    }
  });

  const total = orders.size;
  const approved = Array.from(orders.values()).filter(item => item.approved).length;
  const declined = total - approved;
  const retried = Array.from(orders.values()).filter(item => item.attempts > 1).length;
  const retryRate = total ? (retried / total) * 100 : 0;
  const ratio = total ? (approved / total) * 100 : 0;
  const avgAttempts = total ? totalAttempts / total : 0;

  return {
    total,
    approved,
    declined,
    retried,
    totalAttempts,
    retryRate,
    ratio,
    avgAttempts,
    declineReasons,
  };
}

function buildApprovalGroups(rows, keyBuilder, labelBuilder, extraBuilder = () => ({})) {
  const grouped = new Map();
  rows.forEach(row => {
    const key = keyBuilder(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  });

  return Array.from(grouped.entries()).map(([key, groupRows]) => {
    const summary = summarizeApproval(groupRows);
    return {
      key,
      label: labelBuilder(groupRows[0]),
      ...extraBuilder(groupRows[0]),
      ...summary,
    };
  });
}

function getTopItems(rows, count = 10) {
  return [...rows].sort((a, b) => b.total - a.total || b.ratio - a.ratio).slice(0, count);
}

function populateSelectOptions(selectId, values) {
  const select = document.getElementById(selectId);
  const current = select.value || 'All';
  const options = ['All', ...Array.from(new Set(values)).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)))];
  select.innerHTML = options.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  select.value = options.includes(current) ? current : 'All';
}

function init() {
  bindUpload('bridgerpayUpload', 'bridgerpay', handleBridgerPayUpload, 'bridgerpayStatus');
  bindUpload('zenUpload', 'zen', handleZenUpload, 'zenStatus');
  bindUpload('payproccUpload', 'payprocc', handlePayProccUpload, 'payproccStatus');

  ['searchInput', 'pspFilter', 'sourceFilter', 'sortFilter', 'globalStartDate', 'globalEndDate'].forEach(id => {
    document.getElementById(id).addEventListener('input', render);
    document.getElementById(id).addEventListener('change', render);
  });

  ['approvalPspTypeFilter', 'approvalPspFilter', 'approvalCountryFilter', 'approvalMidFilter', 'approvalSearchInput'].forEach(id => {
    document.getElementById(id).addEventListener('input', render);
    document.getElementById(id).addEventListener('change', render);
  });

  populatePspFilter();
  populateApprovalFilters();
  refreshGlobalDateBounds();
}

function bindUpload(inputId, sourceKey, handler, statusId) {
  document.getElementById(inputId).addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        handler(results.data || []);
        updateFileStatus(statusId, file.name, results.data.length);
        populatePspFilter();
        populateApprovalFilters();
        refreshGlobalDateBounds();
        render();
      },
      error: () => {
        document.getElementById(statusId).textContent = `Could not parse ${file.name}`;
      }
    });
  });
}

function handleBridgerPayUpload(rows) {
  const revenueRows = parseBridgerPayRevenue(rows);
  rawRows = [...rawRows.filter(row => row.source !== 'bridgerpay'), ...revenueRows];
  bridgerpayApprovalRows = parseBridgerPayApproval(rows);
}

function handleZenUpload(rows) {
  const parsed = parseZen(rows);
  rawRows = [...rawRows.filter(row => row.source !== 'zen'), ...parsed];
}

function handlePayProccUpload(rows) {
  const parsed = parsePayProcc(rows);
  rawRows = [...rawRows.filter(row => row.source !== 'payprocc'), ...parsed];
}

function updateFileStatus(statusId, fileName, rowCount) {
  const el = document.getElementById(statusId);
  el.textContent = `${fileName} • ${Number(rowCount || 0).toLocaleString()} rows loaded`;
  el.classList.add('loaded');
}

function populatePspFilter() {
  populateSelectOptions('pspFilter', rawRows.map(row => row.psp));
}

function populateApprovalFilters() {
  populateSelectOptions('approvalPspFilter', bridgerpayApprovalRows.map(row => row.psp));
  populateSelectOptions('approvalCountryFilter', bridgerpayApprovalRows.map(row => row.country));
  populateSelectOptions('approvalMidFilter', bridgerpayApprovalRows.map(row => row.mid));
}

function render() {
  const hasRevenueData = rawRows.length > 0;
  const hasApprovalData = bridgerpayApprovalRows.length > 0;
  const hasAnyData = hasRevenueData || hasApprovalData;

  document.getElementById('emptyState').style.display = hasAnyData ? 'none' : 'block';
  document.getElementById('dashboard').style.display = hasAnyData ? 'block' : 'none';
  document.getElementById('approvalSection').style.display = hasApprovalData ? 'block' : 'none';

  if (hasRevenueData) {
    renderRevenue();
  } else {
    resetRevenueState();
  }

  if (hasApprovalData) {
    renderApproval();
  }
}

function renderRevenue() {
  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const selectedPsp = document.getElementById('pspFilter').value;
  const selectedSource = document.getElementById('sourceFilter').value;
  const sortBy = document.getElementById('sortFilter').value;
  const startDate = document.getElementById('globalStartDate').value;
  const endDate = document.getElementById('globalEndDate').value;

  const filtered = rawRows.filter(row => {
    const searchOk = !search || row.country.toLowerCase().includes(search) || row.psp.toLowerCase().includes(search);
    const pspOk = selectedPsp === 'All' || row.psp === selectedPsp;
    const sourceOk = selectedSource === 'All' || row.source === selectedSource;
    const dateOk = inDateRange(row.localDate, startDate, endDate);
    return searchOk && pspOk && sourceOk && dateOk;
  });

  const totalRevenue = filtered.reduce((sum, row) => sum + row.revenue, 0);
  const totalTransactions = filtered.length;
  let countryData = aggregateByCountry(filtered, totalRevenue);
  let pspData = aggregateByPsp(filtered, totalRevenue);
  let pspCountryData = aggregateByPspCountry(filtered, totalRevenue);

  countryData.sort((a, b) => sortBy === 'share' ? b.revenueShare - a.revenueShare : b.revenue - a.revenue);
  pspData.sort((a, b) => b.revenue - a.revenue);
  pspCountryData.sort((a, b) => b.revenue - a.revenue);

  updateRevenueMetrics(totalRevenue, totalTransactions, countryData, pspData, pspCountryData);
  drawCountryBar(countryData.slice(0, 10));
  drawPspPie(pspData);
  drawGeoChart(countryData);
  drawPspCountryBar(pspCountryData.slice(0, 10));
  fillCountryTable(countryData);
  fillPspCountryTable(pspCountryData);
}

function renderApproval() {
  const pspType = document.getElementById('approvalPspTypeFilter').value;
  const psp = document.getElementById('approvalPspFilter').value;
  const country = document.getElementById('approvalCountryFilter').value;
  const mid = document.getElementById('approvalMidFilter').value;
  const search = document.getElementById('approvalSearchInput').value.trim().toLowerCase();
  const startDate = document.getElementById('globalStartDate').value;
  const endDate = document.getElementById('globalEndDate').value;

  const filtered = bridgerpayApprovalRows.filter(row => {
    const typeOk = pspType === 'All' || row.pspType === pspType;
    const pspOk = psp === 'All' || row.psp === psp;
    const countryOk = country === 'All' || row.country === country;
    const midOk = mid === 'All' || row.mid === mid;
    const searchOk = !search || row.psp.toLowerCase().includes(search) || row.country.toLowerCase().includes(search) || row.mid.toLowerCase().includes(search);
    const dateOk = inDateRange(row.localDate, startDate, endDate);
    return typeOk && pspOk && countryOk && midOk && searchOk && dateOk;
  });

  const overall = summarizeApproval(filtered);
  const byPsp = buildApprovalGroups(filtered, row => row.psp, row => row.psp, row => ({ pspType: row.pspType }));
  const byCountry = buildApprovalGroups(filtered, row => row.country, row => row.country);
  const byMid = buildApprovalGroups(filtered, row => row.mid, row => row.mid);
  const byPspCountry = buildApprovalGroups(filtered, row => `${row.psp}__${row.country}`, row => `${row.psp} • ${row.country}`, row => ({ psp: row.psp, country: row.country }));

  byPsp.sort((a, b) => b.total - a.total || b.ratio - a.ratio);
  byCountry.sort((a, b) => b.total - a.total || b.ratio - a.ratio);
  byMid.sort((a, b) => b.total - a.total || b.ratio - a.ratio);
  byPspCountry.sort((a, b) => b.total - a.total || b.ratio - a.ratio);

  updateApprovalMetrics(overall);
  updateExecutiveSummaryCards(filtered);
  drawApprovalBar('approvalPspChart', getTopItems(byPsp), 'label', '#4f8cff');
  drawApprovalBar('approvalCountryChart', getTopItems(byCountry), 'label', '#16c2a3');
  drawApprovalBar('approvalMidChart', getTopItems(byMid), 'label', '#8b5cf6');
  drawApprovalBar('approvalPspCountryChart', getTopItems(byPspCountry), 'label', '#f97316');

  fillApprovalPspTable(byPsp);
  fillApprovalCountryTable(byCountry);
  fillApprovalMidTable(byMid);
  fillApprovalPspCountryTable(byPspCountry);
  fillDeclineReasonTable(overall.declineReasons, overall.totalAttempts);
  fillInsights(generateInsights({ filtered, overall, byPsp, byCountry, byMid, byPspCountry }));
}

function resetRevenueState() {
  updateRevenueMetrics(0, 0, [], [], []);
  fillCountryTable([]);
  fillPspCountryTable([]);
}

function updateRevenueMetrics(totalRevenue, totalTransactions, countryData, pspData, pspCountryData) {
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

function updateApprovalMetrics(overall) {
  document.getElementById('approvalRatio').textContent = pct(overall.ratio);
  document.getElementById('approvalUniqueOrders').textContent = overall.total.toLocaleString();
  document.getElementById('approvalApprovedOrders').textContent = overall.approved.toLocaleString();
  document.getElementById('approvalDeclinedOrders').textContent = overall.declined.toLocaleString();
  document.getElementById('approvalRetryRate').textContent = pct(overall.retryRate);
  document.getElementById('approvalRetrySub').textContent = `${overall.avgAttempts.toFixed(2)} avg attempts / order`;
}


function updateExecutiveSummaryCards(filtered) {
  const typeTargets = [
    { type: 'Card', ratioId: 'execCardRatio', subId: 'execCardSub' },
    { type: 'Crypto', ratioId: 'execCryptoRatio', subId: 'execCryptoSub' },
    { type: 'P2P', ratioId: 'execP2PRatio', subId: 'execP2PSub' },
  ];

  typeTargets.forEach(target => {
    const subset = filtered.filter(row => row.pspType === target.type);
    const summary = summarizeApproval(subset);
    document.getElementById(target.ratioId).textContent = pct(summary.ratio);
    document.getElementById(target.subId).textContent =
      `${summary.total.toLocaleString()} orders · ${pct(summary.retryRate)} retry`;
  });
}

function drawCountryBar(rows) {
  const data = new google.visualization.DataTable();
  data.addColumn('string', 'Country');
  data.addColumn('number', 'Revenue');
  rows.forEach(row => data.addRow([row.country, row.revenue]));

  const chart = new google.visualization.ColumnChart(document.getElementById('countryBarChart'));
  chart.draw(data, columnChartOptions('#4f8cff', true));
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
    colors: ['#4f8cff', '#16c2a3', '#8b5cf6', '#f97316', '#06b6d4', '#f43f5e'],
    legend: { textStyle: { color: '#dbeafe' } },
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
  chart.draw(data, horizontalBarOptions('#16c2a3', 160));
}

function drawApprovalBar(elementId, rows, labelKey, color) {
  const data = new google.visualization.DataTable();
  data.addColumn('string', 'Group');
  data.addColumn('number', 'Approval Ratio');
  rows.forEach(row => data.addRow([row[labelKey], Number(row.ratio.toFixed(2))]));

  const chart = new google.visualization.BarChart(document.getElementById(elementId));
  chart.draw(data, {
    legend: 'none',
    colors: [color],
    backgroundColor: 'transparent',
    chartArea: { left: 170, right: 30, top: 20, bottom: 20, width: '68%', height: '75%' },
    hAxis: {
      minValue: 0,
      maxValue: 100,
      format: "0'%'",
      textStyle: { color: '#dbeafe' },
      gridlines: { color: 'rgba(255,255,255,0.08)' },
    },
    vAxis: { textStyle: { color: '#dbeafe' } },
    annotations: { textStyle: { color: '#edf4ff', fontSize: 12 } },
  });
}

function columnChartOptions(color, slanted = false) {
  return {
    legend: 'none',
    colors: [color],
    backgroundColor: 'transparent',
    chartArea: { left: 60, right: 20, top: 20, bottom: 80, width: '100%', height: '70%' },
    hAxis: { slantedText: slanted, slantedTextAngle: 35, textStyle: { color: '#dbeafe' } },
    vAxis: { format: 'short', textStyle: { color: '#dbeafe' }, gridlines: { color: 'rgba(255,255,255,0.08)' } },
  };
}

function horizontalBarOptions(color, left) {
  return {
    legend: 'none',
    colors: [color],
    backgroundColor: 'transparent',
    chartArea: { left, right: 20, top: 20, bottom: 20, width: '70%', height: '75%' },
    hAxis: { format: 'short', textStyle: { color: '#dbeafe' }, gridlines: { color: 'rgba(255,255,255,0.08)' } },
    vAxis: { textStyle: { color: '#dbeafe' } },
  };
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

function fillApprovalPspTable(rows) {
  fillApprovalTable('#approvalPspTable tbody', rows, row => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td>${renderTypeBadge(row.pspType)}</td>
      <td class="right">${pct(row.ratio)}</td>
      <td class="right">${row.total.toLocaleString()}</td>
      <td class="right">${row.approved.toLocaleString()}</td>
      <td class="right">${row.declined.toLocaleString()}</td>
      <td class="right">${pct(row.retryRate)}</td>
    </tr>
  `, 7);
}

function fillApprovalCountryTable(rows) {
  fillApprovalTable('#approvalCountryTable tbody', rows, row => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td class="right">${pct(row.ratio)}</td>
      <td class="right">${row.total.toLocaleString()}</td>
      <td class="right">${row.approved.toLocaleString()}</td>
      <td class="right">${row.declined.toLocaleString()}</td>
      <td class="right">${pct(row.retryRate)}</td>
    </tr>
  `, 6);
}

function fillApprovalMidTable(rows) {
  fillApprovalTable('#approvalMidTable tbody', rows, row => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td class="right">${pct(row.ratio)}</td>
      <td class="right">${row.total.toLocaleString()}</td>
      <td class="right">${row.approved.toLocaleString()}</td>
      <td class="right">${row.declined.toLocaleString()}</td>
      <td class="right">${pct(row.retryRate)}</td>
    </tr>
  `, 6);
}

function fillApprovalPspCountryTable(rows) {
  fillApprovalTable('#approvalPspCountryTable tbody', rows, row => `
    <tr>
      <td>${escapeHtml(row.psp)}</td>
      <td>${escapeHtml(row.country)}</td>
      <td class="right">${pct(row.ratio)}</td>
      <td class="right">${row.total.toLocaleString()}</td>
      <td class="right">${row.approved.toLocaleString()}</td>
      <td class="right">${row.declined.toLocaleString()}</td>
      <td class="right">${pct(row.retryRate)}</td>
    </tr>
  `, 7);
}

function fillApprovalTable(selector, rows, rowRenderer, colspan) {
  const tbody = document.querySelector(selector);
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">No rows match the current filter.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(rowRenderer).join('');
}

function fillDeclineReasonTable(reasonMap, totalAttempts) {
  const tbody = document.querySelector('#declineReasonTable tbody');
  const allRows = Array.from(reasonMap.entries()).sort((a, b) => b[1] - a[1]);
  const rows = allRows.slice(0, 12);
  const declinedAttempts = allRows.reduce((sum, [, count]) => sum + count, 0);
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">No declined attempts in the current filter.</td></tr>';
    return;
  }
  const base = declinedAttempts || totalAttempts || 1;
  tbody.innerHTML = rows.map(([reason, count]) => `
    <tr>
      <td>${escapeHtml(reason)}</td>
      <td class="right">${count.toLocaleString()}</td>
      <td class="right">${pct((count / base) * 100)}</td>
    </tr>
  `).join('');
}

function renderTypeBadge(type) {
  const safeType = escapeHtml(type || 'Card');
  const className = String(type || 'card').toLowerCase();
  return `<span class="badge type-${className}">${safeType}</span>`;
}

function generateInsights({ filtered, overall, byPsp, byCountry, byMid, byPspCountry }) {
  const insights = [];
  const minVolume = 20;

  insights.push(`Overall approval ratio is ${pct(overall.ratio)} across ${overall.total.toLocaleString()} unique orders. Retry rate is ${pct(overall.retryRate)} with ${overall.avgAttempts.toFixed(2)} attempts per order.`);

  const typeSummary = buildApprovalGroups(filtered, row => row.pspType, row => row.pspType);
  typeSummary.sort((a, b) => b.total - a.total);
  if (typeSummary.length) {
    const typeLine = typeSummary
      .map(item => `${item.label}: ${pct(item.ratio)} on ${item.total.toLocaleString()} orders`)
      .join(' · ');
    insights.push(`PSP type split — ${typeLine}.`);

    const bestType = [...typeSummary].sort((a, b) => b.ratio - a.ratio || b.total - a.total)[0];
    const weakType = [...typeSummary].sort((a, b) => a.ratio - b.ratio || b.total - a.total)[0];
    if (bestType) {
      insights.push(`Best approval by PSP type is ${bestType.label} at ${pct(bestType.ratio)} across ${bestType.total.toLocaleString()} unique orders.`);
    }
    if (weakType && weakType.label !== bestType?.label) {
      insights.push(`PSP type needing attention is ${weakType.label} at ${pct(weakType.ratio)} with ${pct(weakType.retryRate)} retry rate.`);
    }
  }

  const weakPsp = byPsp.filter(item => item.total >= minVolume).sort((a, b) => a.ratio - b.ratio)[0];
  if (weakPsp) {
    insights.push(`Lowest PSP approval in the current filter is ${weakPsp.label} at ${pct(weakPsp.ratio)} on ${weakPsp.total.toLocaleString()} unique orders.`);
  }

  const weakCountry = byCountry.filter(item => item.total >= minVolume).sort((a, b) => a.ratio - b.ratio)[0];
  if (weakCountry) {
    insights.push(`Country to review first: ${weakCountry.label} at ${pct(weakCountry.ratio)} with ${weakCountry.declined.toLocaleString()} declined unique orders.`);
  }

  const weakMid = byMid.filter(item => item.total >= minVolume).sort((a, b) => a.ratio - b.ratio)[0];
  if (weakMid) {
    insights.push(`MID attention point: ${weakMid.label} is at ${pct(weakMid.ratio)} approval with ${pct(weakMid.retryRate)} retry rate.`);
  }

  const retryHotspot = [...byPspCountry].filter(item => item.total >= 10).sort((a, b) => b.retryRate - a.retryRate)[0];
  if (retryHotspot) {
    insights.push(`Highest retry pressure is ${retryHotspot.label} with ${pct(retryHotspot.retryRate)} retry rate across ${retryHotspot.total.toLocaleString()} unique orders.`);
  }

  const declineReasons = summarizeApproval(filtered).declineReasons;
  const topReason = Array.from(declineReasons.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topReason) {
    insights.push(`Top decline reason by attempts is “${topReason[0]}” with ${topReason[1].toLocaleString()} occurrences.`);
  }

  return insights.slice(0, 6);
}

function fillInsights(items) {
  const list = document.getElementById('insightsList');
  if (!items.length) {
    list.innerHTML = '<li>Upload BridgerPay data to generate insights.</li>';
    return;
  }
  list.innerHTML = items.map(item => `<li>${escapeHtml(item)}</li>`).join('');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

window.addEventListener('resize', () => {
  if (rawRows.length || bridgerpayApprovalRows.length) render();
});
