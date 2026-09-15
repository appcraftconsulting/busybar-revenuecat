#!/usr/bin/env node
// revbar — RevenueCat metrics on a BUSY Bar.
// Cycles "users today / revenue today / MRR" on the front LED display and
// plays a sound (+ green LED blink) whenever today's revenue ticks up.
//
// Usage:
//   node revbar.mjs                 run the dashboard
//   node revbar.mjs sounds          list .snd files available on the bar
//   node revbar.mjs test-sound      play the configured/discovered sound
//   node revbar.mjs test-display    draw a sample screen
//
// Config via env or a .env file next to this script — see .env.example.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- config

loadDotEnv(join(dirname(fileURLToPath(import.meta.url)), '.env'));

const cfg = {
  rcProjectId: process.env.RC_PROJECT_ID,
  rcApiKey: process.env.RC_API_KEY,
  rcCurrency: process.env.RC_CURRENCY || 'USD',
  rcUsersChart: process.env.RC_USERS_CHART || 'customers_new',
  busyAddr: process.env.BUSY_ADDR || '10.0.4.20',
  busyPassword: process.env.BUSY_PASSWORD || '',
  busyToken: process.env.BUSY_TOKEN || '',
  busySound: process.env.BUSY_SOUND || '', // stock_path, e.g. shared/sounds/alert.snd
  appName: process.env.BUSY_APP_NAME || 'revenuecat',
  priority: Number(process.env.BUSY_PRIORITY || 30), // >=10 beats built-in apps, <90 yields to focus sessions
  eventsUrl: process.env.RC_EVENTS_URL || '', // RTDB .json path streamed over SSE (RevenueCat webhook relay)
  cycleSeconds: Number(process.env.CYCLE_SECONDS || 6),
  revenuePollSeconds: Number(process.env.REVENUE_POLL_SECONDS || 60),
  slowPollSeconds: Number(process.env.SLOW_POLL_SECONDS || 120),
  flashSeconds: Number(process.env.FLASH_SECONDS || 6),
  debug: process.env.RB_DEBUG === '1',
};

function loadDotEnv(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const debug = (...a) => { if (cfg.debug) log('[debug]', ...a); };

// ---------------------------------------------------------------- BUSY Bar client

// USB/LAN: http://<ip>/api/...   Cloud: https://api.busy.app/busybar/...
const busyBase = cfg.busyAddr.includes('api.busy.app')
  ? 'https://api.busy.app/busybar'
  : `http://${cfg.busyAddr.replace(/^https?:\/\//, '')}/api`;

function busyHeaders(json = false) {
  const h = {};
  if (json) h['content-type'] = 'application/json';
  if (cfg.busyToken) h['authorization'] = `bearer ${cfg.busyToken}`;
  else if (cfg.busyPassword) h['x-api-token'] = cfg.busyPassword;
  return h;
}

async function busy(method, path, body) {
  const res = await fetch(busyBase + path, {
    method,
    headers: busyHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`BUSY ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function draw(elements, ledColor) {
  const body = { application_name: cfg.appName, priority: cfg.priority, elements };
  if (ledColor) body.led_notification_color = ledColor;
  await busy('POST', '/display/draw', body);
}

// RevenueCat dashboard chart tokens (sampled from app.revenuecat.com):
// --rc-blue-primary (customers) / --rc-green-primary (revenue, MRR) /
// --rc-orange-primary (trials)
const RC_BLUE = '#576CDBFF';
const RC_GREEN = '#11D483FF';
const RC_ORANGE = '#E79462FF';
const RC_VIOLET = '#A987D1FF';

// Two-line screen on the 72×16 front display: 12×12 logo on the left, tiny
// colored title on top, value on the bottom edge — the tiny font is what buys
// the blank rows between the two lines (the panel is only 16px tall).
function screenElements(label, value, { labelColor = RC_BLUE, valueColor = '#FFFFFFFF', valueFont = 'normal', timeout } = {}) {
  const cx = state.logoUploaded ? 43 : 36;
  const textWidth = state.logoUploaded ? 58 : 72;
  const valueEl = { id: 'value', type: 'text', text: value, font: valueFont, align: 'bottom_mid', x: cx, y: 16, color: valueColor, timeout };
  if (value.length * 8 > textWidth) {
    // ~8px/glyph in the normal font: longer values overflow, marquee them
    Object.assign(valueEl, { width: textWidth, scroll_rate: 1000, scroll_start_delay: 800, scroll_repeat_delay: 2000 });
  }
  const elements = [
    { id: 'label', type: 'text', text: label, font: 'small', align: 'top_mid', x: cx, y: 0, color: labelColor, timeout },
    valueEl,
  ];
  if (state.logoUploaded) {
    elements.push({ id: 'logo', type: 'image', path: 'logo.png', align: 'mid_left', x: 2, y: 8, timeout });
  }
  return elements;
}

// Upload the project logo (logo.png next to this script) into the app's assets.
async function uploadLogo() {
  let png;
  try { png = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'logo.png')); } catch { return false; }
  const res = await fetch(`${busyBase}/assets/upload?application_name=${cfg.appName}&file=logo.png`, {
    method: 'POST',
    headers: { ...busyHeaders(), 'content-type': 'application/octet-stream' },
    body: png,
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

async function playSound() {
  if (!state.sound) return;
  try {
    await busy('POST', '/audio/play', { application_name: cfg.appName, stock_path: state.sound });
  } catch (e) {
    log(`sound failed (${e.message}) — falling back to LED blink only; run "node revbar.mjs sounds" to pick a valid BUSY_SOUND`);
    state.sound = '';
  }
}

// Walk the bar's storage for shared .snd files (stock_path must start with "shared/").
async function discoverSounds() {
  const found = [];
  async function walk(path, depth) {
    if (depth > 4) return;
    let listing;
    try { listing = await busy('GET', `/storage/list?path=${encodeURIComponent(path)}`); } catch { return; }
    const entries = listing?.list ?? listing?.files ?? listing?.entries ?? [];
    for (const e of entries) {
      const name = e.name ?? e.path ?? '';
      const full = name.startsWith('/') ? name : `${path}/${name}`;
      if (e.type === 'dir' || e.dir === true || e.is_dir === true) await walk(full, depth + 1);
      else if (full.endsWith('.snd')) found.push(full);
    }
  }
  await walk('/ext', 0);
  return found
    .filter((p) => p.includes('/shared/'))
    .map((p) => p.slice(p.indexOf('shared/')));
}

async function pickSound() {
  if (cfg.busySound) return cfg.busySound;
  const sounds = await discoverSounds();
  debug('sounds on device:', sounds);
  if (!sounds.length) {
    log('no shared .snd sounds found on the bar — purchases will blink the LED only (set BUSY_SOUND to override)');
    return '';
  }
  for (const re of [/coin|cash|kaching|purchase|money/i, /success|win|reward/i, /alert|notif/i, /beep/i]) {
    const hit = sounds.find((s) => re.test(s));
    if (hit) return hit;
  }
  return sounds[0];
}

// ---------------------------------------------------------------- RevenueCat client

const rcBase = `https://api.revenuecat.com/v2/projects/${cfg.rcProjectId}`;

async function rc(path) {
  const res = await fetch(rcBase + path, {
    headers: { authorization: `Bearer ${cfg.rcApiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RevenueCat GET ${path} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const todayUTC = () => new Date().toISOString().slice(0, 10); // chart data is UTC-only

async function fetchRevenueToday() {
  const d = todayUTC();
  const data = await rc(`/metrics/revenue?start_date=${d}&end_date=${d}&currency=${cfg.rcCurrency}`);
  debug('revenue today:', JSON.stringify(data));
  return { date: d, value: Number(data.value ?? 0), currency: data.currency ?? cfg.rcCurrency };
}

async function fetchMRR() {
  const data = await rc(`/metrics/overview?currency=${cfg.rcCurrency}`);
  const metrics = data.metrics ?? [];
  const mrr = metrics.find((m) => m.id === 'mrr');
  debug('overview mrr:', JSON.stringify(mrr));
  return Number(mrr?.value ?? 0);
}

async function fetchUsersToday() {
  const d = todayUTC();
  const data = await rc(`/charts/${cfg.rcUsersChart}?start_date=${d}&end_date=${d}&resolution=day`);
  debug('users chart:', JSON.stringify(data).slice(0, 800));
  // rows look like {cohort: <epoch>, incomplete: true, measure: 0, value: 320}
  const rows = data.values ?? [];
  const last = rows[rows.length - 1];
  if (last && typeof last.value === 'number') return last.value;
  if (typeof last === 'number') return last;
  return 0;
}

// ---------------------------------------------------------------- formatting

function money(v, currency) {
  const compact = Math.abs(v) >= 10_000;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : v % 1 ? 2 : 0,
  }).format(v);
}

// ---------------------------------------------------------------- main loop

const state = {
  usersToday: null,
  revenueToday: null, // { date, value, currency }
  mrr: null,
  sound: '',
  screenIndex: 0,
  flashUntil: 0,
  logoUploaded: false,
};

function screens() {
  const cur = state.revenueToday?.currency ?? cfg.rcCurrency;
  return [
    ['USERS TODAY', state.usersToday === null ? '...' : String(state.usersToday), RC_BLUE],
    ['REV TODAY', state.revenueToday === null ? '...' : money(state.revenueToday.value, cur), RC_GREEN],
    ['MRR', state.mrr === null ? '...' : money(state.mrr, cur), RC_GREEN],
  ];
}

async function cycleTick() {
  if (Date.now() < state.flashUntil) return; // don't stomp on a purchase flash
  const list = screens();
  const [label, value, labelColor] = list[state.screenIndex % list.length];
  state.screenIndex++;
  try {
    await draw(screenElements(label, value, { labelColor, timeout: cfg.cycleSeconds + 5 }));
  } catch (e) {
    log('draw failed:', e.message);
  }
}

// Display-only refresh: purchase detection now comes from the webhook stream,
// so aggregate jitter (FX re-rating moves the total by ±$0.01) can't ring the bar.
async function revenueTick() {
  try { state.revenueToday = await fetchRevenueToday(); } catch (e) { log('revenue poll failed:', e.message); }
}

// ---------------------------------------------------------------- purchase events (webhook → RTDB → SSE)

// Which webhook events ring the bar, and the label shown above the amount.
// Plain renewals and family-share purchases stay silent by design.
function classifyEvent(event) {
  if (event.is_family_share === true) return null;
  switch (event.type) {
    case 'TEST': return 'TEST';
    case 'INITIAL_PURCHASE': return event.period_type === 'TRIAL' ? 'TRIAL' : 'NEW SUB';
    case 'NON_RENEWING_PURCHASE': return 'ONE TIME';
    case 'RENEWAL': return event.is_trial_conversion === true ? 'CONVERSION' : null;
    default: return null;
  }
}

async function announcePurchase(event, label) {
  // zero-price events (trial starts, mainly) read as FREE rather than a fake count
  const amount = typeof event.price === 'number' && event.price > 0
    ? `+${money(event.price, event.currency || cfg.rcCurrency)}`
    : 'FREE';
  log(`💰 ${label} (${event.type}) ${amount} (${event.product_id ?? 'unknown product'})`);
  state.flashUntil = Date.now() + cfg.flashSeconds * 1000;
  playSound().catch(() => {});
  // title + LED follow the RevenueCat app's transaction badge colors
  // (TRIAL orange, NEW SUB blue, ONE TIME violet, CONVERSION green); amount is white bold
  const color = { TRIAL: RC_ORANGE, 'NEW SUB': RC_BLUE, 'ONE TIME': RC_VIOLET }[label] ?? RC_GREEN;
  try {
    await draw(
      screenElements(label, amount, { labelColor: color, valueColor: '#FFFFFFFF', valueFont: 'bold', timeout: cfg.flashSeconds }),
      color,
    );
  } catch (e) {
    log('flash draw failed:', e.message);
  }
  // pull the fresh totals shortly after the event lands
  setTimeout(() => { revenueTick(); slowTick(); }, 15_000);
}

// Server-sent-events stream over the RTDB path the webhook function writes to.
// The first `put` is the existing state (replayed on every reconnect) — skip
// anything already seen by id, then announce each new purchase-type event.
async function listenForPurchases() {
  if (!cfg.eventsUrl) {
    log('RC_EVENTS_URL not set — purchase sounds disabled (metrics still cycle)');
    return;
  }
  let lastSeenId;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(cfg.eventsUrl, { headers: { accept: 'text/event-stream' } });
      if (!res.ok) throw new Error(`stream → ${res.status}`);
      log('purchase event stream connected');
      attempt = 0;
      let primed = false; // first `put` per connection is the existing snapshot, not a fresh event
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const type = frame.match(/^event: (.*)$/m)?.[1];
          const data = frame.match(/^data: (.*)$/m)?.[1];
          if (type === 'auth_revoked' || type === 'cancel') throw new Error(`stream ${type}`);
          if (type !== 'put' || !data) continue;
          const event = JSON.parse(data)?.data;
          if (!primed) {
            primed = true;
            if (event?.id) lastSeenId = event.id;
            continue;
          }
          if (!event?.type) continue;
          if (event.id && event.id === lastSeenId) continue; // duplicate delivery
          if (event.id) lastSeenId = event.id;
          const label = classifyEvent(event);
          if (!label) { debug('ignoring event', event.type); continue; }
          if (event.environment === 'SANDBOX' && event.type !== 'TEST') { debug('ignoring sandbox event'); continue; }
          announcePurchase(event, label).catch(() => {});
        }
      }
      throw new Error('stream ended');
    } catch (e) {
      const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
      log(`event stream disconnected (${e.message}) — reconnecting in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function slowTick() {
  try { state.mrr = await fetchMRR(); } catch (e) { log('MRR poll failed:', e.message); }
  try { state.usersToday = await fetchUsersToday(); } catch (e) { log('users poll failed:', e.message); }
}

function requireConfig(keys) {
  const missing = keys.filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(`Missing config: ${missing.join(', ')} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'run';

  if (cmd === 'sounds') {
    const sounds = await discoverSounds();
    console.log(sounds.length ? sounds.join('\n') : 'no shared .snd files found under /ext');
    return;
  }
  if (cmd === 'test-sound') {
    state.sound = cfg.busySound || (await pickSound());
    if (!state.sound) { console.error('no sound configured or discovered'); process.exit(1); }
    console.log('playing', state.sound);
    await busy('POST', '/audio/play', { application_name: cfg.appName, stock_path: state.sound });
    return;
  }
  if (cmd === 'test-display') {
    state.logoUploaded = await uploadLogo().catch(() => false);
    await draw(screenElements('REVBAR', 'it works!', { timeout: 10 }), '#00FF00FF');
    console.log('drew a test screen (10s)');
    return;
  }
  if (cmd === 'capture') {
    // /screen returns base64 of raw 72×16 pixels in BGR order — swap to RGB and wrap as PNG
    const raw = Buffer.from(String(await busy('GET', '/screen?display=0')), 'base64');
    const W = 72, H = 16, S = 10;
    const rows = [];
    for (let y = 0; y < H; y++) {
      const line = Buffer.alloc(1 + W * S * 3);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        for (let s = 0; s < S; s++) {
          const o = 1 + (x * S + s) * 3;
          line[o] = raw[i + 2]; line[o + 1] = raw[i + 1]; line[o + 2] = raw[i];
        }
      }
      for (let s = 0; s < S; s++) rows.push(line);
    }
    const chunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
      let crc = 0xffffffff;
      for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([len, body, crcBuf]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W * S, 0); ihdr.writeUInt32BE(H * S, 4); ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const out = process.argv[3] ?? 'screen.png';
    writeFileSync(out, png);
    console.log(`saved ${out}`);
    return;
  }
  if (cmd !== 'run') {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }

  requireConfig(['rcProjectId', 'rcApiKey']);

  // wait for the bar rather than exiting, so a launchd-managed run survives unplugs
  for (;;) {
    try {
      const status = await busy('GET', '/status');
      log(`connected to BUSY Bar via ${busyBase}`, cfg.debug ? JSON.stringify(status) : '');
      break;
    } catch (e) {
      log(`BUSY Bar not reachable (${e.message}) — retrying in 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }

  state.sound = await pickSound();
  if (state.sound) log(`purchase sound: ${state.sound}`);

  state.logoUploaded = await uploadLogo().catch(() => false);
  log(state.logoUploaded ? 'project logo uploaded' : 'no logo.png found — running without logo');

  await slowTick();
  await revenueTick();
  await cycleTick();
  log(`dashboard running — users today: ${state.usersToday}, revenue today: ${state.revenueToday?.value}, MRR: ${state.mrr}`);

  setInterval(cycleTick, cfg.cycleSeconds * 1000);
  setInterval(revenueTick, cfg.revenuePollSeconds * 1000);
  setInterval(slowTick, cfg.slowPollSeconds * 1000);
  listenForPurchases();

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      try { await busy('DELETE', '/display/draw', { application_name: cfg.appName }); } catch {}
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
