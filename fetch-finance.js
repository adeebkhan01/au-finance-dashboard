#!/usr/bin/env node

/**
 * Australian Economy Dashboard — Data Fetcher (v2)
 *
 * Fetches data for all 12 dashboard slides:
 *   1. AUD & FX          — AUDUSD/EUR/CNY/JPY with 30d history
 *   2. Interest Rates    — RBA cash rate + bond yields
 *   3. Inflation & CPI   — static (ABS, updated quarterly)
 *   4. Iron Ore & Steel  — SGX futures + FMG/RIO proxy
 *   5. Energy            — WTI, Brent, Natural Gas, Coal
 *   6. Trade Balance     — static (ABS, updated monthly)
 *   7. ASX 200           — ^AXJO with sectors
 *   8. Big 4 Banks       — CBA, NAB, ANZ, WBC with 30d history
 *   9. Commodity Stocks  — BHP, RIO, FMG, WDS with 30d history
 *  10. Property Market   — static (CoreLogic, updated monthly)
 *  11. Consumer & Retail — static (Westpac/ABS)
 *  12. Labour Market     — static (ABS, updated monthly)
 *
 * Run: node fetch-finance.js
 * Output: finance-data.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');

// ── Helpers ──────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AUFinanceDashboard/2.0)' },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
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
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  return JSON.parse(res.body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function round2(n) { return Math.round(n * 100) / 100; }

// ── Yahoo Finance ────────────────────────────────────────

/** Fetch quote + full 1-month daily history */
async function getYahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
    const data = await fetchJSON(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    const history = timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString().split('T')[0],
      close: closes[i] != null ? round2(closes[i]) : null
    })).filter(p => p.close != null);

    const current = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const change = current - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    return {
      value: round2(current),
      change: round2(change),
      changePercent: round2(changePct),
      previousClose: round2(prevClose),
      asOf: new Date().toISOString().split('T')[0],
      history
    };
  } catch (e) {
    console.error(`  Yahoo error [${symbol}]:`, e.message);
    return null;
  }
}

/** Lightweight quote — price + changePercent only */
async function getStockQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const data = await fetchJSON(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const current = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const changePct = prevClose ? ((current - prevClose) / prevClose) * 100 : 0;
    return { price: round2(current), changePercent: round2(changePct) };
  } catch (e) {
    console.error(`  Stock quote error [${symbol}]:`, e.message);
    return null;
  }
}

// ── RSS Feed Parser ──────────────────────────────────────

function parseRSSItems(xml) {
  const items = [];
  const rssItems = xml.split('<item>').slice(1);
  for (const raw of rssItems) {
    const tag = name => {
      const m = raw.match(new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${name}>|<${name}[^>]*>([\\s\\S]*?)</${name}>`));
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    const title = tag('title');
    const link = tag('link') || tag('guid');
    const desc = tag('description').replace(/<[^>]+>/g, '').slice(0, 300);
    const pubDate = tag('pubDate') || tag('dc:date') || tag('published');
    if (title) items.push({ title, link, snippet: desc, pubDate });
  }
  if (!items.length) {
    const entries = xml.split('<entry>').slice(1);
    for (const raw of entries) {
      const tag = name => {
        const m = raw.match(new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${name}>|<${name}[^>]*>([\\s\\S]*?)</${name}>`));
        return m ? (m[1] || m[2] || '').trim() : '';
      };
      const title = tag('title');
      const linkM = raw.match(/<link[^>]+href=["']([^"']+)["']/);
      const link = linkM ? linkM[1] : tag('link');
      const desc = (tag('summary') || tag('content')).replace(/<[^>]+>/g, '').slice(0, 300);
      const pubDate = tag('published') || tag('updated');
      if (title) items.push({ title, link, snippet: desc, pubDate });
    }
  }
  return items;
}

async function fetchRSSFeed(url, sourceName) {
  try {
    const res = await httpGet(url);
    if (res.status !== 200) return [];
    return parseRSSItems(res.body).slice(0, 10).map(item => ({ ...item, source: sourceName }));
  } catch (e) {
    console.error(`  RSS error (${sourceName}):`, e.message);
    return [];
  }
}

// ── Sector definitions ───────────────────────────────────

const SECTOR_STOCKS = {
  'Financials':             ['CBA.AX', 'WBC.AX', 'ANZ.AX', 'NAB.AX'],
  'Materials':              ['BHP.AX', 'RIO.AX', 'FMG.AX', 'MIN.AX'],
  'Health Care':            ['CSL.AX', 'COH.AX', 'RMD.AX', 'SHL.AX'],
  'Consumer Discretionary': ['WES.AX', 'HVN.AX', 'JBH.AX', 'ALL.AX'],
  'Industrials':            ['TCL.AX', 'BXB.AX', 'SYD.AX', 'QAN.AX'],
  'Real Estate':            ['GMG.AX', 'SGP.AX', 'GPT.AX', 'MGR.AX'],
  'Consumer Staples':       ['WOW.AX', 'COL.AX', 'TWE.AX', 'A2M.AX'],
  'Energy':                 ['WDS.AX', 'STO.AX', 'ORG.AX', 'WHC.AX'],
  'Information Technology': ['XRO.AX', 'WTC.AX', 'CPU.AX', 'APX.AX'],
  'Communication Services': ['TLS.AX', 'REA.AX', 'CAR.AX', 'NWS.AX'],
  'Utilities':              ['AGL.AX', 'APA.AX', 'ORG.AX', 'MEZ.AX']
};

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log('Fetching Australian economy data (v2)...\n');
  const data = { fetchedAt: new Date().toISOString() };

  // ── SLIDE 1: AUD & FX ───────────────────────────────
  console.log('Slide 1: AUD & FX');
  const fxPairs = [
    { key: 'audusd', symbol: 'AUDUSD=X', label: 'AUD/USD' },
    { key: 'audeur', symbol: 'AUDEUR=X', label: 'AUD/EUR' },
    { key: 'audcny', symbol: 'AUDCNY=X', label: 'AUD/CNY' },
    { key: 'audjpy', symbol: 'AUDJPY=X', label: 'AUD/JPY' },
  ];
  data.fx = {};
  for (const pair of fxPairs) {
    console.log(`  ${pair.label}...`);
    const q = await getYahooQuote(pair.symbol);
    data.fx[pair.key] = q ? { ...q, label: pair.label, symbol: pair.symbol } : null;
    await sleep(400);
  }
  data.audusd = data.fx.audusd; // backward-compat

  // ── SLIDE 2: Interest Rates & RBA ───────────────────
  console.log('\nSlide 2: Interest Rates & RBA');
  data.rbaRate = {
    value: 4.10, change: -0.25,
    asOf: 'Feb 2025', nextMeeting: 'Apr 2025',
    note: 'RBA Official Cash Rate Target'
  };
  data.bonds = {
    cash: 4.10, twoYear: 3.85, fiveYear: 4.05,
    tenYear: 4.25, thirtyYear: 4.60, usTenYear: 4.45,
    spread10v2: 0.40, asOf: 'Apr 2025',
    note: 'Australian Commonwealth Government Securities'
  };
  data.rbaHistory = [
    { date: 'Feb 2025', rate: 4.10, change: -0.25, note: 'First cut since Nov 2020 — CPI back in 2-3% band' },
    { date: 'Dec 2024', rate: 4.35, change:  0,    note: 'Held; disinflation progressing' },
    { date: 'Nov 2024', rate: 4.35, change:  0,    note: 'Held; trimmed mean CPI still above target' },
    { date: 'Sep 2024', rate: 4.35, change:  0,    note: 'Held; watching services inflation' },
    { date: 'Aug 2024', rate: 4.35, change:  0,    note: 'Held; acknowledged slowing growth' },
    { date: 'Jun 2024', rate: 4.35, change:  0,    note: 'Held; hike ruled out' },
    { date: 'May 2024', rate: 4.35, change:  0,    note: 'Held; Q1 CPI surprised to upside' },
    { date: 'Mar 2024', rate: 4.35, change:  0,    note: 'Held; easing bias introduced' },
    { date: 'Feb 2024', rate: 4.35, change:  0,    note: 'Held; inflation still too high' },
    { date: 'Nov 2023', rate: 4.35, change: 0.25,  note: 'Final hike of cycle' },
  ];

  // ── SLIDE 3: Inflation & CPI ─────────────────────────
  console.log('\nSlide 3: Inflation & CPI');
  data.cpi = {
    headline: 2.4, trimmedMean: 3.2,
    targetLow: 2.0, targetHigh: 3.0,
    change: -0.5, period: 'Q4 2024',
    note: 'ABS Consumer Price Index'
  };
  data.cpiHistory = [
    { period: 'Q1 2023', headline: 7.0, trimmedMean: 6.6 },
    { period: 'Q2 2023', headline: 6.0, trimmedMean: 5.9 },
    { period: 'Q3 2023', headline: 5.4, trimmedMean: 5.2 },
    { period: 'Q4 2023', headline: 4.1, trimmedMean: 4.2 },
    { period: 'Q1 2024', headline: 3.6, trimmedMean: 4.0 },
    { period: 'Q2 2024', headline: 3.8, trimmedMean: 3.9 },
    { period: 'Q3 2024', headline: 2.8, trimmedMean: 3.5 },
    { period: 'Q4 2024', headline: 2.4, trimmedMean: 3.2 },
  ];
  data.gdp = { value: 1.5, change: 0.3, period: 'Q3 2024', note: 'ABS GDP annual growth' };
  data.wageGrowth = { value: 3.5, change: -0.6, period: 'Q3 2024', note: 'Wage Price Index, annual' };

  // ── SLIDE 4: Iron Ore & Steel ────────────────────────
  console.log('\nSlide 4: Iron Ore & Steel');
  data.ironOre = {
    price: 98.5, changePercent: -0.8, unit: 'USD/t',
    source: 'TSI/SGX CFR China 62% Fe', asOf: 'Apr 2025',
    note: 'Updated periodically'
  };
  try {
    const sgx = await getStockQuote('TIOF.SI');
    if (sgx && sgx.price > 50 && sgx.price < 250) {
      data.ironOre = { price: sgx.price, changePercent: sgx.changePercent, unit: 'USD/t', source: 'SGX Iron Ore 62% Fe', asOf: new Date().toISOString().split('T')[0] };
      console.log(`  Iron ore (SGX): $${sgx.price}`);
    } else { console.log('  Iron ore: using static value'); }
  } catch(e) { console.log('  Iron ore: using static value'); }
  data.ironOreHistory = [
    { month: 'Jul 24', price: 103.2 }, { month: 'Aug 24', price: 97.8 },
    { month: 'Sep 24', price: 93.5  }, { month: 'Oct 24', price: 101.4 },
    { month: 'Nov 24', price: 105.2 }, { month: 'Dec 24', price: 102.8 },
    { month: 'Jan 25', price: 99.6  }, { month: 'Feb 25', price: 97.1  },
    { month: 'Mar 25', price: 96.4  }, { month: 'Apr 25', price: 98.5  },
  ];
  data.steelPrice = { price: 3280, unit: 'CNY/t', note: 'Chinese HRC Steel', asOf: 'Apr 2025' };

  // ── SLIDE 5: Energy Dashboard ────────────────────────
  console.log('\nSlide 5: Energy');
  const energyDefs = [
    { key: 'wti',   symbol: 'CL=F', name: 'WTI Crude',   unit: 'USD/bbl',   icon: 'oil'  },
    { key: 'brent', symbol: 'BZ=F', name: 'Brent Crude', unit: 'USD/bbl',   icon: 'oil'  },
    { key: 'gas',   symbol: 'NG=F', name: 'Natural Gas', unit: 'USD/MMBtu', icon: 'gas'  },
  ];
  data.energy = {};
  for (const e of energyDefs) {
    console.log(`  ${e.name}...`);
    const q = await getYahooQuote(e.symbol);
    data.energy[e.key] = q ? { ...q, name: e.name, unit: e.unit, icon: e.icon } : { name: e.name, unit: e.unit, icon: e.icon, value: null };
    await sleep(400);
  }
  data.energy.coal = {
    name: 'Thermal Coal (Newcastle)', unit: 'USD/t', icon: 'coal',
    value: 112.5, changePercent: -1.2,
    note: 'ICE Newcastle futures — updated periodically', asOf: 'Apr 2025'
  };

  // ── SLIDE 6: Trade Balance ───────────────────────────
  console.log('\nSlide 6: Trade Balance');
  data.trade = {
    balance: 5900, exports: 47800, imports: 41900,
    period: 'Dec 2024', note: 'ABS International Trade in Goods and Services',
    partners: [
      { name: 'China',       exportShare: 33 },
      { name: 'Japan',       exportShare: 14 },
      { name: 'South Korea', exportShare:  7 },
      { name: 'India',       exportShare:  6 },
      { name: 'USA',         exportShare:  5 },
      { name: 'Other',       exportShare: 35 },
    ],
    history: [
      { month: 'Jul 24', balance: 4100, exports: 44200, imports: 40100 },
      { month: 'Aug 24', balance: 4800, exports: 45000, imports: 40200 },
      { month: 'Sep 24', balance: 4400, exports: 44600, imports: 40200 },
      { month: 'Oct 24', balance: 5200, exports: 46100, imports: 40900 },
      { month: 'Nov 24', balance: 4600, exports: 45800, imports: 41200 },
      { month: 'Dec 24', balance: 5900, exports: 47800, imports: 41900 },
    ]
  };

  // ── SLIDE 7: ASX 200 ─────────────────────────────────
  console.log('\nSlide 7: ASX 200');
  data.asx200 = await getYahooQuote('^AXJO');
  await sleep(500);

  console.log('  Sectors...');
  data.sectors = [];
  for (const [sectorName, symbols] of Object.entries(SECTOR_STOCKS)) {
    const stocks = [];
    for (const sym of symbols) {
      const q = await getStockQuote(sym);
      const ticker = sym.replace('.AX', '');
      stocks.push(q ? { name: ticker, price: q.price, changePercent: q.changePercent } : { name: ticker, price: 0, changePercent: 0 });
      await sleep(150);
    }
    const avgChange = round2(stocks.reduce((s, st) => s + st.changePercent, 0) / stocks.length);
    data.sectors.push({ name: sectorName, changePercent: avgChange, stocks });
    console.log(`  ${sectorName}: ${avgChange >= 0 ? '+' : ''}${avgChange}%`);
  }

  // ── SLIDE 8: Big 4 Banks ─────────────────────────────
  console.log('\nSlide 8: Big 4 Banks');
  const bankDefs = [
    { symbol: 'CBA.AX', name: 'Commonwealth Bank', ticker: 'CBA', color: '#f59e0b' },
    { symbol: 'NAB.AX', name: 'NAB',                ticker: 'NAB', color: '#1a7a4a' },
    { symbol: 'ANZ.AX', name: 'ANZ',                ticker: 'ANZ', color: '#2563eb' },
    { symbol: 'WBC.AX', name: 'Westpac',            ticker: 'WBC', color: '#c23a3a' },
  ];
  data.banks = [];
  for (const b of bankDefs) {
    console.log(`  ${b.ticker}...`);
    const q = await getYahooQuote(b.symbol);
    data.banks.push(q
      ? { ...b, price: q.value, change: q.change, changePercent: q.changePercent, previousClose: q.previousClose, history: q.history }
      : { ...b, price: null, change: null, changePercent: null, history: [] }
    );
    await sleep(400);
  }

  // ── SLIDE 9: Commodity Stocks ────────────────────────
  console.log('\nSlide 9: Commodity Stocks');
  const commStockDefs = [
    { symbol: 'BHP.AX', name: 'BHP Group', ticker: 'BHP', color: '#1a7a4a' },
    { symbol: 'RIO.AX', name: 'Rio Tinto', ticker: 'RIO', color: '#2563eb' },
    { symbol: 'FMG.AX', name: 'Fortescue', ticker: 'FMG', color: '#f59e0b' },
    { symbol: 'WDS.AX', name: 'Woodside',  ticker: 'WDS', color: '#7c3aed' },
  ];
  data.commodityStocks = [];
  for (const s of commStockDefs) {
    console.log(`  ${s.ticker}...`);
    const q = await getYahooQuote(s.symbol);
    data.commodityStocks.push(q
      ? { ...s, price: q.value, change: q.change, changePercent: q.changePercent, previousClose: q.previousClose, history: q.history }
      : { ...s, price: null, change: null, changePercent: null, history: [] }
    );
    await sleep(400);
  }

  // Legacy commodity cards (backward-compat)
  const legacyComms = [
    { symbol: 'GC=F', name: 'Gold',   icon: 'gold',   iconBg: '#fef9ee' },
    { symbol: 'SI=F', name: 'Silver', icon: 'silver', iconBg: '#f8f9fa' },
    { symbol: 'HG=F', name: 'Copper', icon: 'copper', iconBg: '#fef0e6' },
  ];
  data.commodities = [];
  for (const c of legacyComms) {
    const q = await getYahooQuote(c.symbol);
    if (q) data.commodities.push({ name: c.name, icon: c.icon, iconBg: c.iconBg, price: q.value, change: q.change, changePercent: q.changePercent });
    await sleep(300);
  }

  // ── SLIDE 10: Property Market ────────────────────────
  console.log('\nSlide 10: Property Market');
  data.housing = {
    medianPrice: 1182000, changePercent: 4.7,
    city: 'Sydney', note: 'CoreLogic Home Value Index',
    mortgageRate: 6.28, auctionNational: 65, asOf: 'Feb 2025',
    cities: [
      { city: 'Sydney',    median: 1182000, changePercent:  4.7, rentalYield: 2.8, auctionClearance: 68, daysOnMarket: 28 },
      { city: 'Melbourne', median:  935000, changePercent:  1.2, rentalYield: 3.1, auctionClearance: 62, daysOnMarket: 33 },
      { city: 'Brisbane',  median:  872000, changePercent: 11.8, rentalYield: 3.6, auctionClearance: 55, daysOnMarket: 22 },
      { city: 'Perth',     median:  785000, changePercent: 18.4, rentalYield: 4.2, auctionClearance: 48, daysOnMarket: 18 },
      { city: 'Adelaide',  median:  762000, changePercent: 14.3, rentalYield: 3.8, auctionClearance: 72, daysOnMarket: 24 },
      { city: 'Hobart',    median:  668000, changePercent: -0.8, rentalYield: 4.0, auctionClearance: 45, daysOnMarket: 38 },
      { city: 'Canberra',  median:  955000, changePercent:  1.5, rentalYield: 3.4, auctionClearance: 58, daysOnMarket: 31 },
      { city: 'Darwin',    median:  530000, changePercent:  2.1, rentalYield: 5.8, auctionClearance: 38, daysOnMarket: 42 },
    ]
  };

  // ── SLIDE 11: Consumer & Retail ──────────────────────
  console.log('\nSlide 11: Consumer & Retail');
  data.consumerConfidence = { value: 92.2, change: 1.0,  period: 'Feb 2025', note: 'Westpac-Melbourne Institute Consumer Sentiment' };
  data.businessConfidence = { value: 4,    change: 2,    period: 'Jan 2025', note: 'NAB Business Confidence Index' };
  data.retailSales        = { value: 0.1,  change: -0.4, period: 'Dec 2024', note: 'ABS Retail Trade, monthly change' };
  data.consumerHistory = [
    { period: 'Mar 24', confidence: 82.4, retail:  0.8 },
    { period: 'Jun 24', confidence: 83.6, retail:  0.5 },
    { period: 'Sep 24', confidence: 84.6, retail:  0.1 },
    { period: 'Oct 24', confidence: 89.8, retail:  0.6 },
    { period: 'Nov 24', confidence: 94.6, retail: -0.1 },
    { period: 'Dec 24', confidence: 91.2, retail:  0.5 },
    { period: 'Jan 25', confidence: 92.2, retail:  0.1 },
    { period: 'Feb 25', confidence: 92.2, retail: null  },
  ];

  // ── SLIDE 12: Labour Market ──────────────────────────
  console.log('\nSlide 12: Labour Market');
  data.unemployment      = { value: 4.1,    change:   0.1, period: 'Jan 2025', note: 'ABS Labour Force' };
  data.underemployment   = { value: 6.5,    change:  -0.2, period: 'Jan 2025', note: 'ABS Labour Force' };
  data.participationRate = { value: 67.2,   change:   0.1, period: 'Jan 2025', note: 'ABS Labour Force' };
  data.jobVacancies      = { value: 333000, change: -12000, period: 'Nov 2024', note: 'ABS Job Vacancies' };
  data.labourHistory = [
    { period: 'Jan 23', unemployment: 3.5, participation: 66.6 },
    { period: 'Apr 23', unemployment: 3.7, participation: 66.8 },
    { period: 'Jul 23', unemployment: 3.7, participation: 67.0 },
    { period: 'Oct 23', unemployment: 3.9, participation: 67.0 },
    { period: 'Jan 24', unemployment: 4.1, participation: 66.8 },
    { period: 'Apr 24', unemployment: 4.1, participation: 66.9 },
    { period: 'Jul 24', unemployment: 4.2, participation: 67.1 },
    { period: 'Oct 24', unemployment: 4.1, participation: 67.2 },
    { period: 'Jan 25', unemployment: 4.1, participation: 67.2 },
  ];

  // ── Indicators table ─────────────────────────────────
  data.indicators = [
    { name: 'GDP Growth (Annual)',       value: '1.5%',   previous: '1.2%',   change:  0.3,  unit: '%', period: 'Q3 2024',  category: 'growth'  },
    { name: 'GDP Growth (Quarterly)',    value: '0.3%',   previous: '0.2%',   change:  0.1,  unit: '%', period: 'Q3 2024',  category: 'growth'  },
    { name: 'CPI Inflation (Annual)',    value: '2.4%',   previous: '2.9%',   change: -0.5,  unit: '%', period: 'Q4 2024',  category: 'prices'  },
    { name: 'Trimmed Mean CPI',          value: '3.2%',   previous: '3.5%',   change: -0.3,  unit: '%', period: 'Q4 2024',  category: 'prices'  },
    { name: 'RBA Cash Rate',             value: '4.10%',  previous: '4.35%',  change: -0.25, unit: '%', period: 'Feb 2025', category: 'prices'  },
    { name: 'Unemployment Rate',         value: '4.1%',   previous: '4.0%',   change:  0.1,  unit: '%', period: 'Jan 2025', category: 'labour'  },
    { name: 'Underemployment Rate',      value: '6.5%',   previous: '6.7%',   change: -0.2,  unit: '%', period: 'Jan 2025', category: 'labour'  },
    { name: 'Participation Rate',        value: '67.2%',  previous: '67.1%',  change:  0.1,  unit: '%', period: 'Jan 2025', category: 'labour'  },
    { name: 'Wage Price Index (Annual)', value: '3.5%',   previous: '4.1%',   change: -0.6,  unit: '%', period: 'Q3 2024',  category: 'labour'  },
    { name: 'Trade Balance',             value: 'A$5.9B', previous: 'A$4.6B', change:  1.3,  unit: 'B', period: 'Dec 2024', category: 'trade'   },
    { name: 'Retail Sales (Monthly)',    value: '0.1%',   previous: '0.5%',   change: -0.4,  unit: '%', period: 'Dec 2024', category: 'growth'  },
    { name: 'Building Approvals',        value: '-0.3%',  previous: '5.0%',   change: -5.3,  unit: '%', period: 'Dec 2024', category: 'growth'  },
    { name: 'Consumer Sentiment',        value: '92.2',   previous: '91.2',   change:  1.0,  unit: '',  period: 'Feb 2025', category: 'growth'  },
    { name: 'Business Confidence (NAB)', value: '4',      previous: '2',      change:  2.0,  unit: '',  period: 'Jan 2025', category: 'growth'  },
    { name: 'PMI Manufacturing',         value: '50.2',   previous: '49.4',   change:  0.8,  unit: '',  period: 'Feb 2025', category: 'growth'  },
  ];

  // ── Financial News ───────────────────────────────────
  console.log('\nFinancial News...');
  const newsFeeds = [
    { url: 'https://www.afr.com/rss/markets',                            name: 'AFR'         },
    { url: 'https://www.abc.net.au/news/feed/2942460/rss.xml',           name: 'ABC News'    },
    { url: 'https://www.smh.com.au/rss/business.xml',                    name: 'SMH'         },
    { url: 'https://www.news.com.au/content-feeds/latest-news-finance/', name: 'News.com.au' },
  ];
  let allNews = [];
  for (const feed of newsFeeds) {
    const items = await fetchRSSFeed(feed.url, feed.name);
    allNews = allNews.concat(items);
    await sleep(300);
  }
  allNews.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
  const seen = new Set();
  data.news = allNews.filter(n => {
    const key = n.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);

  // ── Write output ─────────────────────────────────────
  const outPath = __dirname + '/finance-data.json';
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  console.log('\nDone!');
  console.log(`  ASX 200:        ${data.asx200?.value ?? 'N/A'}`);
  console.log(`  AUD/USD:        ${data.fx?.audusd?.value ?? 'N/A'}`);
  console.log(`  AUD/EUR:        ${data.fx?.audeur?.value ?? 'N/A'}`);
  console.log(`  AUD/CNY:        ${data.fx?.audcny?.value ?? 'N/A'}`);
  console.log(`  AUD/JPY:        ${data.fx?.audjpy?.value ?? 'N/A'}`);
  console.log(`  Banks fetched:  ${data.banks.filter(b => b.price).length}/4`);
  console.log(`  Comm. stocks:   ${data.commodityStocks.filter(s => s.price).length}/4`);
  console.log(`  Energy items:   ${Object.keys(data.energy).length}`);
  console.log(`  Sectors:        ${data.sectors.length}`);
  console.log(`  News:           ${data.news.length}`);
  console.log(`  Written to:     ${outPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
