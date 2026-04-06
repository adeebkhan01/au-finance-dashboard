#!/usr/bin/env node

/**
 * Bangladesh Economy Dashboard — Data Fetcher (v1)
 *
 * 8 consolidated slides:
 *   1. FX Rates         — 4 pairs, 4 time ranges (1M/3M/6M/3Y)
 *   2. Bangladesh Bank  — Repo rate + bond yields + 10 decisions
 *   3. Inflation & GDP  — static (BBS, quarterly)
 *   4. RMG & Exports   — static (BGMEA, monthly)
 *   5. Trade Balance    — static (NBR, monthly)
 *   6. Dhaka Stock Mkt  — DSEX + indices + sectors + top stocks
 *   7. Remittances & FX — static (Bangladesh Bank), quarterly
 *   8. Labour & Dev     — static (BBS/World Bank), annual
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BDFinanceDashboard/1.0)' },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve, reject);
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchJSON(url) {
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function round2(n) { return Math.round(n * 100) / 100; }

// ── Yahoo Finance ─────────────────────────────────────────────────────────────

/** Full quote + history for a given range/interval */
async function getYahooQuote(symbol, range = '1mo', interval = '1d') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const data = await fetchJSON(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta   = result.meta;
    const ts     = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    const history = ts.map((t, i) => ({
      date:  new Date(t * 1000).toISOString().split('T')[0],
      close: closes[i] != null ? round2(closes[i]) : null,
    })).filter(p => p.close != null);

    const current   = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const change    = current - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    return {
      value:         round2(current),
      change:        round2(change),
      changePercent: round2(changePct),
      previousClose: round2(prevClose),
      asOf:          new Date().toISOString().split('T')[0],
      history,
    };
  } catch (e) {
    console.error(`  Yahoo error [${symbol} ${range}]:`, e.message);
    return null;
  }
}

/** History-only fetch (no quote metadata needed) */
async function getHistory(symbol, range, interval) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const data = await fetchJSON(url);
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    const ts     = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    return ts.map((t, i) => ({
      date:  new Date(t * 1000).toISOString().split('T')[0],
      close: closes[i] != null ? round2(closes[i]) : null,
    })).filter(p => p.close != null);
  } catch (e) {
    console.error(`  History error [${symbol} ${range}]:`, e.message);
    return [];
  }
}

/** Price + changePercent only */
async function getQuickQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const data = await fetchJSON(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta      = result.meta;
    const current   = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const changePct = prevClose ? ((current - prevClose) / prevClose) * 100 : 0;
    return { price: round2(current), changePercent: round2(changePct) };
  } catch (e) {
    console.error(`  Quick quote error [${symbol}]:`, e.message);
    return null;
  }
}

// ── RSS ───────────────────────────────────────────────────────────────────────

function parseRSS(xml) {
  const items = [];
  for (const raw of xml.split('<item>').slice(1)) {
    const tag = n => { const m = raw.match(new RegExp(`<${n}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${n}>|<${n}[^>]*>([\\s\\S]*?)</${n}>`)); return m ? (m[1]||m[2]||'').trim() : ''; };
    const title = tag('title');
    if (title) items.push({ title, link: tag('link')||tag('guid'), snippet: tag('description').replace(/<[^>]+>/g,'').slice(0,250), pubDate: tag('pubDate')||tag('dc:date') });
  }
  return items;
}

async function fetchRSS(url, source) {
  try {
    const res = await httpGet(url);
    if (res.status !== 200) return [];
    return parseRSS(res.body).slice(0, 8).map(i => ({ ...i, source }));
  } catch (e) { console.error(`  RSS error (${source}):`, e.message); return []; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching Bangladesh economy data (v1)...\n');
  const data = { fetchedAt: new Date().toISOString() };

  // ── SLIDE 1: FX Rates (4 pairs × 4 ranges) ────────────────────────────────
  console.log('Slide 1: FX Rates (multi-range)');
  const fxPairs = [
    { key: 'usdbdt', symbol: 'USDBDT=X', label: 'USD/BDT', dec: 2 },
    { key: 'eurbdt', symbol: 'EURBDT=X', label: 'EUR/BDT', dec: 2 },
    { key: 'gbpbdt', symbol: 'GBPBDT=X', label: 'GBP/BDT', dec: 2 },
    { key: 'inrbdt', symbol: 'INRBDT=X', label: 'INR/BDT', dec: 4 },
  ];
  data.fx = {};
  for (const p of fxPairs) {
    console.log(`  ${p.label}...`);
    const base = await getYahooQuote(p.symbol, '1mo', '1d');
    await sleep(350);
    const h3m = await getHistory(p.symbol, '3mo', '1d');
    await sleep(350);
    const h6m = await getHistory(p.symbol, '6mo', '1wk');
    await sleep(350);
    const h3y = await getHistory(p.symbol, '3y',  '1wk');
    await sleep(350);
    data.fx[p.key] = base
      ? { ...base, label: p.label, symbol: p.symbol, dec: p.dec, h3m, h6m, h3y }
      : null;
    console.log(`    1M:${base?.history?.length||0} 3M:${h3m.length} 6M:${h6m.length} 3Y:${h3y.length} pts`);
  }
  data.usdbdt = data.fx.usdbdt; // backward compat

  // ── SLIDE 2: Bangladesh Bank Rates ────────────────────────────────────────
  console.log('\nSlide 2: Bangladesh Bank Rates');
  data.bbRate = { value: 10.00, change: 0, asOf: 'Jan 2026', nextMeeting: 'Mar 2026' };
  data.bonds   = { repo: 10.00, reverseRepo: 8.50, specialRepo: 9.00, tbill91: 11.25, tbill182: 11.50, tbill364: 11.75, lending: 13.50, deposit: 9.80, asOf: 'Jan 2026' };
  data.bbHistory = [
    { date: 'Oct 2024', rate: 10.00, change: 0.50, note: 'Hiked to contain persistent food inflation; IMF programme target' },
    { date: 'Aug 2024', rate: 9.50, change: 0.50, note: 'Further hike following interim government\'s economic stabilisation plan' },
    { date: 'Jun 2024', rate: 8.50, change: 0.50, note: 'Continuing monetary tightening; crawling peg introduced for BDT' },
    { date: 'Mar 2024', rate: 8.00, change: 0.50, note: 'Repo rate raised; IMF programme condition to transition to market rate' },
    { date: 'Jan 2024', rate: 7.75, change: 0.25, note: 'Tightened as BDT depreciation accelerated; reserves declining' },
    { date: 'Nov 2023', rate: 7.50, change: 0.50, note: 'Historic shift from administered 9% lending cap to market-based rate' },
    { date: 'Jun 2023', rate: 6.50, change: 0.50, note: 'Start of tightening cycle — headline inflation at 9%+' },
    { date: 'Jan 2023', rate: 6.00, change: 0.25, note: 'First rate hike in nearly a decade; cost-push inflation emerging' },
    { date: 'Jun 2022', rate: 5.75, change: 0.25, note: 'Post-COVID policy normalisation begins' },
    { date: 'Jan 2020', rate: 5.50, change: 0, note: 'Rate held — pre-pandemic price stability' },
  ];

  // ── SLIDE 3: Inflation & GDP ───────────────────────────────────────────────
  console.log('\nSlide 3: Inflation & GDP');
  data.cpi = { headline: 8.58, food: 10.82, nonFood: 7.41, target: 7.0, change: -0.18, period: 'Jan 2026' };
  data.cpiHistory = [
    { period: 'Q1 2023', headline: 8.78, food: 9.05, nonFood: 8.38 },
    { period: 'Q2 2023', headline: 9.65, food: 11.25, nonFood: 8.12 },
    { period: 'Q3 2023', headline: 9.94, food: 12.54, nonFood: 8.22 },
    { period: 'Q4 2023', headline: 9.41, food: 11.90, nonFood: 8.16 },
    { period: 'Q1 2024', headline: 9.81, food: 12.32, nonFood: 8.37 },
    { period: 'Q2 2024', headline: 9.72, food: 12.11, nonFood: 8.29 },
    { period: 'Q3 2024', headline: 10.43, food: 13.47, nonFood: 8.66 },
    { period: 'Q4 2024', headline: 9.35, food: 11.60, nonFood: 8.22 },
    { period: 'Jan 2026', headline: 8.58, food: 10.82, nonFood: 7.41 },
  ];
  data.gdp        = { value: 3.97,  change: -1.85,  period: 'FY2025' };
  data.gdpHistory = [
    { year: 'FY2018', value: 7.86 },
    { year: 'FY2019', value: 8.15 },
    { year: 'FY2020', value: 3.51 },
    { year: 'FY2021', value: 5.43 },
    { year: 'FY2022', value: 7.10 },
    { year: 'FY2023', value: 6.03 },
    { year: 'FY2024', value: 5.82 },
    { year: 'FY2025', value: 3.97 },
  ];
  data.wageGrowth = { value: 6.8, change: -0.4, period: 'FY2025' };
  data.perCapitaIncome = { value: 2734, change: -31, period: 'FY2025', unit: 'USD' };

  // ── SLIDE 4: RMG & Exports ────────────────────────────────────────────────
  console.log('\nSlide 4: RMG & Exports');
  data.exports = { total: 47.2, rmg: 39.35, nonRmg: 7.85, change: 8.84, period: 'FY2024-25', unit: 'USD Billion' };
  data.rmg = { total: 39.35, knitwear: 20.86, woven: 18.49, shareOfExports: 83.4, change: 8.84, period: 'FY2024-25' };
  data.exportHistory = [
    { month: 'Jul 2023', total: 3.82, rmg: 3.18, nonRmg: 0.64 },
    { month: 'Aug 2023', total: 3.95, rmg: 3.28, nonRmg: 0.67 },
    { month: 'Sep 2023', total: 4.12, rmg: 3.42, nonRmg: 0.70 },
    { month: 'Oct 2023', total: 4.28, rmg: 3.56, nonRmg: 0.72 },
    { month: 'Nov 2023', total: 4.15, rmg: 3.45, nonRmg: 0.70 },
    { month: 'Dec 2023', total: 4.35, rmg: 3.62, nonRmg: 0.73 },
    { month: 'Jan 2024', total: 4.08, rmg: 3.39, nonRmg: 0.69 },
    { month: 'Feb 2024', total: 3.98, rmg: 3.31, nonRmg: 0.67 },
    { month: 'Mar 2024', total: 4.22, rmg: 3.51, nonRmg: 0.71 },
    { month: 'Apr 2024', total: 4.05, rmg: 3.37, nonRmg: 0.68 },
    { month: 'May 2024', total: 4.18, rmg: 3.48, nonRmg: 0.70 },
    { month: 'Jun 2024', total: 4.25, rmg: 3.54, nonRmg: 0.71 },
  ];
  data.exportDestinations = [
    { country: 'EU', share: 50.1 },
    { country: 'USA', share: 19.18 },
    { country: 'UK', share: 11.05 },
    { country: 'Canada', share: 3.31 },
    { country: 'Other', share: 16.36 },
  ];
  data.topProducts = [
    { name: 'Knitwear', value: 20.86, unit: 'USD Billion', shareOfExports: 44.2 },
    { name: 'Woven garments', value: 18.49, unit: 'USD Billion', shareOfExports: 39.2 },
    { name: 'Leather/footwear', value: 0.98, unit: 'USD Billion', shareOfExports: 2.1 },
    { name: 'Jute goods', value: 0.76, unit: 'USD Billion', shareOfExports: 1.6 },
    { name: 'Frozen shrimp', value: 0.42, unit: 'USD Billion', shareOfExports: 0.9 },
    { name: 'Pharmaceuticals', value: 0.28, unit: 'USD Billion', shareOfExports: 0.6 },
    { name: 'Other', value: 5.51, unit: 'USD Billion', shareOfExports: 11.7 },
  ];

  // ── SLIDE 5: Trade Balance ────────────────────────────────────────────────
  console.log('\nSlide 5: Trade Balance');
  data.trade = {
    balance: -12.0, exports: 47.2, imports: 59.2, period: 'FY2024-25', unit: 'USD Billion',
    partners: [
      { name: 'China', importShare: 31 },
      { name: 'India', importShare: 15 },
      { name: 'EU', exportShare: 50 },
      { name: 'USA', exportShare: 19 },
      { name: 'ASEAN', importShare: 12 },
      { name: 'Other', shareBlend: 37 },
    ],
    history: [
      { month: 'Jul 2023', balance: -1.05, exports: 3.82, imports: 4.87 },
      { month: 'Aug 2023', balance: -1.12, exports: 3.95, imports: 5.07 },
      { month: 'Sep 2023', balance: -0.98, exports: 4.12, imports: 5.10 },
      { month: 'Oct 2023', balance: -0.92, exports: 4.28, imports: 5.20 },
      { month: 'Nov 2023', balance: -1.05, exports: 4.15, imports: 5.20 },
      { month: 'Dec 2023', balance: -0.95, exports: 4.35, imports: 5.30 },
      { month: 'Jan 2024', balance: -1.08, exports: 4.08, imports: 5.16 },
      { month: 'Feb 2024', balance: -1.02, exports: 3.98, imports: 5.00 },
      { month: 'Mar 2024', balance: -0.98, exports: 4.22, imports: 5.20 },
      { month: 'Apr 2024', balance: -1.10, exports: 4.05, imports: 5.15 },
      { month: 'May 2024', balance: -1.00, exports: 4.18, imports: 5.18 },
      { month: 'Jun 2024', balance: -1.02, exports: 4.25, imports: 5.27 },
    ],
  };

  // ── SLIDE 6: Dhaka Stock Market (DSEX) ─────────────────────────────────────
  console.log('\nSlide 6: Dhaka Stock Market');
  data.dsex = { value: 5600.27, change: 18.40, changePercent: 0.33, asOf: new Date().toISOString().split('T')[0], history: [] };
  data.indices = [
    { name: 'DSEX (Broad)', value: 5600.27, changePercent: 0.33 },
    { name: 'DS30 (Blue Chip)', value: 2019.71, changePercent: 0.41 },
    { name: 'DSES (Shariah)', value: 1059.58, changePercent: 0.28 },
  ];
  data.sectors = [
    { name: 'Bank', changePercent: 0.45 },
    { name: 'Textile & Apparel', changePercent: 0.38 },
    { name: 'Pharma', changePercent: 0.52 },
    { name: 'Food & Beverage', changePercent: 0.25 },
    { name: 'Fuel & Power', changePercent: 0.18 },
    { name: 'Insurance', changePercent: 0.32 },
    { name: 'Ceramics', changePercent: 0.22 },
    { name: 'Eng. & Metal', changePercent: 0.28 },
    { name: 'Miscellaneous', changePercent: 0.35 },
    { name: 'Real Estate', changePercent: 0.40 },
    { name: 'Telecommunication', changePercent: 0.33 },
  ];
  data.topStocks = [
    { name: 'Grameenphone (GP)', ticker: 'GP', price: 580.5, changePercent: 0.52, currency: 'BDT' },
    { name: 'Square Pharma', ticker: 'SQPH', price: 285.0, changePercent: 0.65, currency: 'BDT' },
    { name: 'BRAC Bank', ticker: 'BRACBANK', price: 48.2, changePercent: 0.38, currency: 'BDT' },
    { name: 'Dutch-Bangla Bank', ticker: 'DUTCHBANGL', price: 185.5, changePercent: 0.42, currency: 'BDT' },
    { name: 'Renata', ticker: 'RENATA', price: 925.0, changePercent: 0.58, currency: 'BDT' },
    { name: 'Berger Paints', ticker: 'BERGERPAINT', price: 675.5, changePercent: 0.35, currency: 'BDT' },
    { name: 'Bata Shoe Company', ticker: 'BATA', price: 1225.0, changePercent: 0.48, currency: 'BDT' },
    { name: 'Olympic Industries', ticker: 'OLYMPIC', price: 298.5, changePercent: 0.41, currency: 'BDT' },
  ];

  // ── SLIDE 7: Remittances & FX Reserves ─────────────────────────────────────
  console.log('\nSlide 7: Remittances & FX Reserves');
  data.remittances = { monthly: 2.53, annual: 30.32, change: 26.81, period: 'FY2024-25', unit: 'USD Billion' };
  data.remittanceHistory = [
    { month: 'Jul 2023', value: 1.35 },
    { month: 'Aug 2023', value: 1.42 },
    { month: 'Sep 2023', value: 1.58 },
    { month: 'Oct 2023', value: 1.72 },
    { month: 'Nov 2023', value: 1.88 },
    { month: 'Dec 2023', value: 2.05 },
    { month: 'Jan 2024', value: 2.15 },
    { month: 'Feb 2024', value: 2.28 },
    { month: 'Mar 2024', value: 2.38 },
    { month: 'Apr 2024', value: 2.42 },
    { month: 'May 2024', value: 2.50 },
    { month: 'Jun 2024', value: 2.53 },
    { month: 'Jul 2024', value: 2.65 },
    { month: 'Aug 2024', value: 2.78 },
    { month: 'Sep 2024', value: 2.88 },
    { month: 'Oct 2025', value: 3.29 },
  ];
  data.remittanceSources = [
    { country: 'Saudi Arabia', share: 28 },
    { country: 'USA', share: 16 },
    { country: 'UAE', share: 14 },
    { country: 'Qatar', share: 8 },
    { country: 'UK', share: 7 },
    { country: 'Oman', share: 6 },
    { country: 'Kuwait', share: 5 },
    { country: 'Malaysia', share: 5 },
    { country: 'Other', share: 11 },
  ];
  data.fxReserves = { gross: 33.19, net: 28.51, months: 5.5, change: 11.14, period: 'Dec 2025', unit: 'USD Billion', note: 'BB Gross · IMF BPM6 Net' };
  data.fxHistory = [
    { month: 'Jan 2023', value: 32.97 },
    { month: 'Apr 2023', value: 32.51 },
    { month: 'Jul 2023', value: 29.43 },
    { month: 'Oct 2023', value: 26.18 },
    { month: 'Jan 2024', value: 24.05 },
    { month: 'Apr 2024', value: 23.41 },
    { month: 'Jul 2024', value: 21.78 },
    { month: 'Oct 2024', value: 29.85 },
    { month: 'Dec 2025', value: 33.19 },
  ];

  // ── SLIDE 8: Labour & Development ──────────────────────────────────────────
  console.log('\nSlide 8: Labour & Development');
  data.labour = { unemployment: 4.70, underemployment: 22.1, participation: 49.5, garmentWorkers: 4.2, change: 0.50, period: 'FY2025' };
  data.poverty = { rate: 18.7, extreme: 7.0, period: '2024', note: 'World Bank / BBS National Poverty Line' };
  data.hdi = { value: 0.670, rank: 129, change: 0.009, period: '2023', note: 'UNDP Human Development Report' };
  data.literacy = { rate: 74.7, male: 77.4, female: 72.0, period: '2022' };
  data.labourHistory = [
    { year: 'FY2018', unemployment: 4.20, participation: 48.8 },
    { year: 'FY2019', unemployment: 4.15, participation: 49.0 },
    { year: 'FY2020', unemployment: 5.25, participation: 47.2 },
    { year: 'FY2021', unemployment: 5.12, participation: 47.8 },
    { year: 'FY2022', unemployment: 4.95, participation: 48.5 },
    { year: 'FY2023', unemployment: 4.82, participation: 49.1 },
    { year: 'FY2024', unemployment: 4.76, participation: 49.3 },
    { year: 'FY2025', unemployment: 4.70, participation: 49.5 },
  ];

  // ── Indicators table ───────────────────────────────────────────────────────
  data.indicators = [
    { name: 'GDP Growth (Annual)', value: '3.97%', previous: '5.82%', change: -1.85, unit: '%', period: 'FY2025', category: 'growth' },
    { name: 'CPI (Headline)', value: '8.58%', previous: '8.76%', change: -0.18, unit: '%', period: 'Jan 2026', category: 'prices' },
    { name: 'CPI (Food)', value: '10.82%', previous: '11.00%', change: -0.18, unit: '%', period: 'Jan 2026', category: 'prices' },
    { name: 'Repo Rate', value: '10.00%', previous: '10.00%', change: 0, unit: '%', period: 'Jan 2026', category: 'prices' },
    { name: 'Unemployment Rate', value: '4.70%', previous: '4.76%', change: -0.06, unit: '%', period: 'FY2025', category: 'labour' },
    { name: 'Underemployment', value: '22.1%', previous: '22.6%', change: -0.5, unit: '%', period: 'FY2025', category: 'labour' },
    { name: 'Labour Participation', value: '49.5%', previous: '49.3%', change: 0.2, unit: '%', period: 'FY2025', category: 'labour' },
    { name: 'Per Capita Income', value: '2734', previous: '2765', change: -31, unit: 'USD', period: 'FY2025', category: 'growth' },
    { name: 'Exports (Total)', value: '47.2', previous: '43.4', change: 3.8, unit: 'USD B', period: 'FY2024-25', category: 'trade' },
    { name: 'FX Reserves (Gross)', value: '33.19', previous: '29.90', change: 3.29, unit: 'USD B', period: 'Dec 2025', category: 'trade' },
    { name: 'Remittances (Annual)', value: '30.32', previous: '23.90', change: 6.42, unit: 'USD B', period: 'FY2024-25', category: 'trade' },
    { name: 'DSEX Index', value: '5600.27', previous: '5582', change: 18.27, unit: 'pts', period: new Date().toISOString().split('T')[0], category: 'markets' },
  ];

  // ── News ───────────────────────────────────────────────────────────────────
  console.log('\nNews...');

  // Keywords that boost relevance to BD economy / business / markets
  const NEWS_BOOST = [
    'taka','bdt','bangladesh bank','dsex','rmg','garment','garments','apparel','textile',
    'remittance','reserves','bgmea','bkmea','nbr','epz','imf','crawling peg','hundi','ldc',
    'export','import','trade','tka','inflation','gdp','growth','interest rate','repo','monetary','fiscal',
    'economy','economic','business','market','stock','grameen','brac','grameenphone','dutchbangl','square pharma',
    'dollar','currency','exchange rate','devaluation','depreciation','power','energy','electricity',
    'agriculture','rice','paddy','food security','poverty','employment','job','labour','worker','factory','production',
    'chittagong','dhaka','sez',
  ];

  // Keywords that reduce relevance (off-topic for a finance dashboard)
  const NEWS_PENALISE = [
    'cricket','football','soccer','sports','ipl','bpl','premier league',
    'celebrity','actor','actress','bollywood','movie','film','tv show','television','entertainment',
    'recipe','cooking','fashion','beauty','horoscope',
  ];

  function newsRelevanceScore(item) {
    const text = ((item.title || '') + ' ' + (item.snippet || '')).toLowerCase();
    let score = 0;
    for (const kw of NEWS_BOOST)    { if (text.includes(kw)) score += 2; }
    for (const kw of NEWS_PENALISE) { if (text.includes(kw)) score -= 4; }
    return score;
  }

  let allNews = [];
  for (const f of [
    { url: 'https://www.thedailystar.net/frontpage/rss.xml', name: 'Daily Star' },
    { url: 'https://www.tbsnews.net/tbs-rss', name: 'TBS News' },
    { url: 'https://thefinancialexpress.com.bd/economy/rss', name: 'Financial Express' },
    { url: 'https://www.newagebd.net/rss/economy', name: 'New Age' },
  ]) {
    allNews = allNews.concat(await fetchRSS(f.url, f.name));
    await sleep(300);
  }

  // Deduplicate by title prefix
  const seen = new Set();
  allNews = allNews.filter(n => {
    const k = n.title.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Score each article; drop anything with a negative score (clearly off-topic)
  allNews = allNews
    .map(n => ({ ...n, _score: newsRelevanceScore(n) }))
    .filter(n => n._score >= 0);

  // Sort: relevance-first, break ties by recency
  allNews.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0);
  });

  // Keep top 12; strip internal score field
  data.news = allNews.slice(0, 12).map(({ _score, ...rest }) => rest);
  console.log(`  Relevant articles kept: ${data.news.length} (from ${allNews.length + (allNews.length - data.news.length)} total after dedup)`);

  // ── Write ──────────────────────────────────────────────────────────────────
  const out = __dirname+'/bd-finance-data.json';
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  console.log('\nDone!');
  console.log(`  USD/BDT 1M:${data.fx.usdbdt?.history?.length||0} 3M:${data.fx.usdbdt?.h3m?.length||0} 6M:${data.fx.usdbdt?.h6m?.length||0} 3Y:${data.fx.usdbdt?.h3y?.length||0}`);
  console.log(`  DSEX: ${data.dsex?.value??'N/A'}`);
  console.log(`  Top Stocks: ${data.topStocks.length}`);
  console.log(`  News: ${data.news.length}`);
  console.log(`  Written: ${out}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
