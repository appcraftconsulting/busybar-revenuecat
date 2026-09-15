//
//  index.js — RevenueCat × BUSY Bar
//
//  Two Cloud Functions drive a BUSY Bar desk display entirely from the cloud:
//
//  - busybarRevenueCatWebhook: RevenueCat posts every purchase event here;
//    qualifying ones (trial / new sub / one-time / trial conversion) flash a
//    typed announcement on the bar with the RevenueCat badge colors, blink
//    the status LED and play a sound. Plain renewals and family-share
//    purchases stay silent.
//  - busybarMetricsRefresh: every minute, fetches users-today / revenue-today
//    / MRR from the RevenueCat Charts API (v3 engine via realtime=true) and
//    draws all three screens in one call, stacked with staggered
//    display_until timestamps so the bar cycles them by itself (~20s each).
//
//  Configuration lives in functions/.env (see .env.example) — most notably
//  RC_PROJECT_ID, which selects the RevenueCat project being displayed.
//  Secrets (API keys/tokens) live in Secret Manager, see the README.
//

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const crypto = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

initializeApp();

// --- configuration (functions/.env) ----------------------------------------

// The RevenueCat project to display. Note: RevenueCat v2 secret keys are
// project-scoped, so BUSYBAR_RC_KEY must be a key created inside this project.
const rcProjectId = defineString("RC_PROJECT_ID");
const rcCurrency = defineString("RC_CURRENCY", { default: "USD" });
// Chart behind the "USERS TODAY" screen: customers_active (DAU) or customers_new.
const rcUsersChart = defineString("RC_USERS_CHART", { default: "customers_active" });
const busyAppName = defineString("BUSY_APP_NAME", { default: "revenuecat" });
// 10+ overrides the bar's built-in apps, <90 yields to an active focus session.
const busyPriority = defineInt("BUSY_PRIORITY", { default: 30 });
// Stock sound played on each announced purchase.
const busySound = defineString("BUSY_SOUND", { default: "shared/sounds/calendar_event_starts.snd" });

// --- secrets (Secret Manager) -----------------------------------------------

// Value RevenueCat sends in the webhook Authorization header ("Bearer <token>").
const busybarWebhookToken = defineSecret("BUSYBAR_WEBHOOK_TOKEN");
// Unguessable id for the RTDB mirror path (dedupe + optional local tooling).
const busybarChannel = defineSecret("BUSYBAR_CHANNEL");
// BUSY cloud API token (cloud.busy.app → API tokens, scoped to the bar).
const busybarBusyToken = defineSecret("BUSYBAR_BUSY_TOKEN");
// RevenueCat v2 secret key with Charts metrics: Read only, from RC_PROJECT_ID.
const busybarRcKey = defineSecret("BUSYBAR_RC_KEY");

const BUSY_API = "https://api.busy.app/busybar";

// RevenueCat dashboard/app badge colors (sampled from app.revenuecat.com tokens)
const RC_BLUE = "#576CDBFF"; // --rc-blue-primary (customers)
const RC_GREEN = "#11D483FF"; // --rc-green-primary (revenue, MRR)
const RC_ORANGE = "#E79462FF"; // --rc-orange-primary (trials)
const RC_VIOLET = "#A987D1FF"; // --rc-violet-primary (one-time purchases)

// --- BUSY Bar cloud API -----------------------------------------------------

async function busyCall(method, apiPath, body) {
  const response = await fetch(BUSY_API + apiPath, {
    method,
    headers: {
      authorization: `bearer ${busybarBusyToken.value()}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`BUSY ${method} ${apiPath} → ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  return response.json().catch(() => ({}));
}

// The 12×12 logo shown on the left of every screen. Uploaded lazily, once per
// function instance, so fresh deployments need no USB setup step.
let logoUploaded = null;
async function ensureLogo() {
  if (!logoUploaded) {
    logoUploaded = (async () => {
      const png = readFileSync(path.join(__dirname, "logo.png"));
      const response = await fetch(
        `${BUSY_API}/assets/upload?application_name=${busyAppName.value()}&file=logo.png`,
        {
          method: "POST",
          headers: {
            authorization: `bearer ${busybarBusyToken.value()}`,
            "content-type": "application/octet-stream",
          },
          body: png,
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!response.ok) throw new Error(`logo upload → ${response.status}`);
    })().catch((error) => {
      logoUploaded = null; // retry on the next draw
      throw error;
    });
  }
  return logoUploaded;
}

function busyMoney(value, currency) {
  const compact = Math.abs(value) >= 10000;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : value % 1 ? 2 : 0,
  }).format(value);
}

/** One metric "screen" on the 72×16 front display: opaque backdrop over the
 *  text zone (x≥14, so the shared logo stays visible), small colored title on
 *  top, white value on the bottom edge. Suffix keeps element ids unique; z
 *  stacks screens; until/timeout controls lifetime. */
function busyScreen(suffix, label, value, { labelColor, valueFont = "normal", z, until, timeout }) {
  const life = until ? { display_until: String(until) } : { timeout };
  return [
    { id: `bg${suffix}`, type: "rectangle", x: 14, y: 0, width: 58, height: 16,
      fill: "solid", fill_colors: ["#000000FF"], border_width: 0, z_index: z, ...life },
    { id: `label${suffix}`, type: "text", text: label, font: "small", align: "top_mid",
      x: 43, y: 0, color: labelColor, z_index: z + 1, ...life },
    { id: `value${suffix}`, type: "text", text: value, font: valueFont, align: "bottom_mid",
      x: 43, y: 16, color: "#FFFFFFFF", z_index: z + 2, ...life },
  ];
}

function busyLogoElement(lifetimeSeconds) {
  return { id: "logo", type: "image", path: "logo.png", align: "mid_left", x: 2, y: 8,
    z_index: 5, timeout: lifetimeSeconds };
}

// --- purchase announcements --------------------------------------------------

// Which webhook events ring the bar, and the badge color they announce with
// (mirrors the RevenueCat app's transaction badges). Plain renewals and
// family-share purchases are deliberately silent.
function busyClassifyEvent(event) {
  if (event.is_family_share === true) return null;
  switch (event.type) {
    case "TEST": return { label: "TEST", color: RC_GREEN };
    case "INITIAL_PURCHASE":
      return event.period_type === "TRIAL"
        ? { label: "TRIAL", color: RC_ORANGE }
        : { label: "NEW SUB", color: RC_BLUE };
    case "NON_RENEWING_PURCHASE": return { label: "ONE TIME", color: RC_VIOLET };
    case "RENEWAL":
      return event.is_trial_conversion === true ? { label: "CONVERSION", color: RC_GREEN } : null;
    default: return null;
  }
}

/** RevenueCat webhook receiver. Verifies the configured Authorization header,
 *  mirrors the event to RTDB (dedupe + optional local tooling), and flashes
 *  qualifying purchases on the BUSY Bar via the cloud API. */
exports.busybarRevenueCatWebhook = onRequest(
  { secrets: [busybarWebhookToken, busybarChannel, busybarBusyToken] },
  async (request, response) => {
    const got = Buffer.from(request.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${busybarWebhookToken.value()}`);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const event = request.body?.event;
    if (!event?.type) {
      response.status(400).json({ error: "missing event" });
      return;
    }

    // RevenueCat retries on non-2xx: dedupe by event id via the RTDB mirror.
    const ref = getDatabase().ref(`busybar/${busybarChannel.value()}/latest`);
    const previous = (await ref.get()).val();
    const duplicate = Boolean(event.id) && previous?.id === event.id;
    await ref.set({
      id: event.id || null,
      type: event.type,
      price: event.price ?? null,
      currency: event.currency || null,
      product_id: event.product_id || null,
      store: event.store || null,
      environment: event.environment || null,
      period_type: event.period_type || null,
      is_trial_conversion: event.is_trial_conversion ?? null,
      is_family_share: event.is_family_share ?? null,
      event_timestamp_ms: event.event_timestamp_ms || null,
      received_at: Date.now(),
    });

    const kind = busyClassifyEvent(event);
    const sandbox = event.environment === "SANDBOX" && event.type !== "TEST";
    if (kind && !duplicate && !sandbox) {
      // zero-price events (trial starts, mainly) read as FREE
      const amount = typeof event.price === "number" && event.price > 0
        ? `+${busyMoney(event.price, event.currency || rcCurrency.value())}`
        : "FREE";
      try {
        await ensureLogo();
        await busyCall("POST", "/display/draw", {
          application_name: busyAppName.value(),
          priority: busyPriority.value(),
          led_notification_color: kind.color,
          elements: [
            busyLogoElement(70),
            ...busyScreen("A", kind.label, amount, { labelColor: kind.color, valueFont: "bold", z: 90, timeout: 6 }),
          ],
        });
        await busyCall("POST", "/audio/play", { application_name: busyAppName.value(), stock_path: busySound.value() });
        console.log(`busybar announce: ${kind.label} ${amount} (${event.product_id ?? "?"})`);
      } catch (error) {
        // The bar being offline must never make RevenueCat retry the webhook.
        console.warn("busybar announce failed", error);
      }
    }
    response.json({ ok: true });
  }
);

// --- metrics display ----------------------------------------------------------

async function rcGet(apiPath) {
  const response = await fetch(`https://api.revenuecat.com/v2/projects/${rcProjectId.value()}${apiPath}`, {
    headers: { authorization: `Bearer ${busybarRcKey.value()}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RevenueCat ${apiPath} → ${response.status}`);
  return response.json();
}

/** Redraws the three metric screens once a minute. Each screen carries its own
 *  display_until so the bar cycles users → revenue → MRR (~20s each) on its
 *  own; if this function ever stops, the display simply goes blank a minute
 *  later instead of showing stale numbers. */
exports.busybarMetricsRefresh = onSchedule(
  { schedule: "every 1 minutes", secrets: [busybarBusyToken, busybarRcKey] },
  async () => {
    // realtime=true selects the Charts v3 engine — the numbers the dashboard
    // shows. /metrics/revenue is already v3; /metrics/overview is legacy-only
    // (per RC support), hence MRR comes from the mrr chart instead.
    const today = new Date().toISOString().slice(0, 10); // RC chart data is UTC
    const currency = rcCurrency.value();
    const chartValue = (chart) => {
      const lastRow = (chart.values ?? []).at(-1);
      return typeof lastRow?.value === "number" ? lastRow.value : 0;
    };
    const [mrrChart, revenue, actives] = await Promise.all([
      rcGet(`/charts/mrr?start_date=${today}&end_date=${today}&resolution=day&realtime=true`),
      rcGet(`/metrics/revenue?start_date=${today}&end_date=${today}&currency=${currency}`),
      rcGet(`/charts/${rcUsersChart.value()}?start_date=${today}&end_date=${today}&resolution=day&realtime=true`),
    ]);
    const revenueToday = Number(revenue.value ?? 0);

    const now = Math.floor(Date.now() / 1000);
    const screens = [
      ["USERS TODAY", String(chartValue(actives)), RC_BLUE],
      ["REV TODAY", busyMoney(revenueToday, revenue.currency || currency), RC_GREEN],
      // whole dollars: v3 MRR carries cents, which overflow the 58px text zone
      ["MRR", busyMoney(Math.round(chartValue(mrrChart)), currency), RC_GREEN],
    ];
    await ensureLogo();
    await busyCall("POST", "/display/draw", {
      application_name: busyAppName.value(),
      priority: busyPriority.value(),
      elements: [
        busyLogoElement(70),
        ...screens.flatMap(([label, value, color], index) =>
          busyScreen(String(index), label, value, {
            labelColor: color,
            z: 30 - index * 10, // top screen expires first, revealing the next
            until: now + 21 * (index + 1) + 2,
          })),
      ],
    });
  }
);
