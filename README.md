# RevenueCat × BUSY Bar

Live [RevenueCat](https://www.revenuecat.com) metrics on a [BUSY Bar](https://busy.app) desk display, with a sound and a color-coded flash for every purchase. Runs entirely in the cloud (Firebase Functions + the BUSY cloud API) — no computer needs to stay on.

The 72×16 front LED cycles three screens (~20s each), titles colored with RevenueCat's own dashboard tokens:

```
[logo] USERS TODAY    [logo] REV TODAY    [logo]  MRR
          1828                $399.87            $2,861
```

Purchases flash a typed announcement matching the RevenueCat app's transaction badges, blink the status LED in the same color, and play a sound:

| Event | Label | Color |
|---|---|---|
| Trial started | `TRIAL FREE` | orange `#E79462` |
| New paid subscription | `NEW SUB +$4.99` | blue `#576CDB` |
| One-time purchase | `ONE TIME +$59.99` | violet `#A987D1` |
| Trial converted | `CONVERSION +$34.99` | green `#11D483` |

Plain renewals and family-share purchases are deliberately silent (tune this in `busyClassifyEvent`).

## How it works

```
    purchase                                                     every minute
        │                                                             │
        ▼                                                             ▼
  ┌────────────┐              ┌──────────────────────────┐    ┌───────────────────────┐
  │ RevenueCat │ ────────────▶│ busybarRevenueCatWebhook │    │ busybarMetricsRefresh │
  └────────────┘   webhook    │      Cloud Function      │    │     Cloud Function    │
                              └───┬──────────────────┬───┘    └───┬───────────────┬───┘
                                  │                  │            │               │
                   mirror, retry- │        announce  │            │     draw the  │
                   dedupe by id   ▼                  │  fetch v3  │    3 screens  │
                  ┌─────────────┐                    │  metrics   ▼               │
                  │ Realtime DB │                    │     ┌─────────────────┐    │
                  └─────────────┘                    │     │ RevenueCat      │    │
                                                     │     │ Charts API (v3) │    │
                                                     │     └─────────────────┘    │
                                                     ▼                            ▼
                                           ┌───────────────────────────────────────────┐
                                           │                api.busy.app               │
                                           └─────────────────────┬─────────────────────┘
                                                                 │
                                                                 ▼
                                               ┌────────────────────────────────────┐
                                               │  ▓▓░   NEW SUB                     │  + LED blink
                                               │  ▓▓▓         +$4.99                │  + sound
                                               └────────────────────────────────────┘
                                                               BUSY Bar
```

- **`busybarRevenueCatWebhook`** verifies the webhook's Authorization header, dedupes RevenueCat's retries via a tiny Realtime Database mirror (a single `latest` node — the database never grows), classifies the event, and draws/plays on the bar through the BUSY cloud API.
- **`busybarMetricsRefresh`** runs every minute, fetches users-today / revenue-today / MRR from the [Charts API](https://www.revenuecat.com/docs/api-v2) (the Charts **v3** engine via `realtime=true`; `/metrics/overview` is legacy-only, avoid it), and draws all three screens in one call. Each screen carries its own `display_until`, so the bar cycles them by itself — no standing connection, and a dead function leaves a blank display within a minute instead of stale numbers.
- The 12×12 logo uploads itself to the bar on first use (`functions/logo.png` — swap the file for your own).

## Setup

Prerequisites: a Firebase project on the Blaze plan, the `firebase` CLI, a BUSY Bar on Wi-Fi, and a RevenueCat project.

**1. BUSY Bar** — link the bar to your BUSY account (BUSY app, or cloud.busy.app → Connect device; the pairing code is also available over USB: `curl -X POST http://10.0.4.20/api/account/link`). Then create an API token at [cloud.busy.app/api-tokens](https://cloud.busy.app/api-tokens), scoped to the bar.

**2. RevenueCat** — in your project: API Keys → new **v2** secret key with *Charts metrics: Read only*. Note your project id from the dashboard URL (`app.revenuecat.com/projects/<id>/…`).

**3. Realtime Database** — create a default RTDB instance (Firebase console → Realtime Database), then:

```sh
cp database.rules.template.json database.rules.json
# replace __CHANNEL__ in database.rules.json with the channel id you generate below
firebase deploy --only database
```

**4. Secrets** — generate two random strings and store the four secrets:

```sh
openssl rand -hex 16   # → BUSYBAR_CHANNEL (also goes in database.rules.json)
openssl rand -hex 24   # → BUSYBAR_WEBHOOK_TOKEN

firebase functions:secrets:set BUSYBAR_CHANNEL
firebase functions:secrets:set BUSYBAR_WEBHOOK_TOKEN
firebase functions:secrets:set BUSYBAR_BUSY_TOKEN   # BUSY cloud API token
firebase functions:secrets:set BUSYBAR_RC_KEY       # RevenueCat v2 secret key
```

**5. Configure & deploy:**

```sh
cp functions/.env.example functions/.env   # set RC_PROJECT_ID etc.
cd functions && npm install && cd ..
firebase deploy --only functions
```

**6. RevenueCat webhook** — project → Integrations → Webhooks → new webhook: the `busybarRevenueCatWebhook` function URL, Authorization header `Bearer <BUSYBAR_WEBHOOK_TOKEN>`, environment *Production only*.

Test it end to end:

```sh
curl -X POST <function-url> -H "Authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"event":{"type":"INITIAL_PURCHASE","id":"test-1","price":0,"environment":"PRODUCTION","period_type":"TRIAL","product_id":"test"}}'
```

## Choosing the displayed project

RevenueCat secret keys are **project-scoped**, so the displayed project is the `RC_PROJECT_ID` / `BUSYBAR_RC_KEY` pair. To switch: create a charts-read key in the target project, update the secret and `functions/.env`, redeploy. The purchase webhook is also per-project — add one in the new project (same URL and token).

All knobs live in [`functions/.env`](functions/.env.example): currency, the chart behind "USERS TODAY" (`customers_active` or `customers_new`), the sound, display priority, and the app name used on the bar.

## Local dev tool (optional, USB)

`revbar.mjs` is a dependency-free Node 18+ utility for poking the bar over USB (`http://10.0.4.20`) — handy during setup:

```sh
node revbar.mjs test-display     # draw a sample screen
node revbar.mjs sounds           # list the bar's stock .snd sounds
node revbar.mjs test-sound       # play the configured sound
node revbar.mjs capture out.png  # save a PNG of what the bar shows right now
```

It can also run the whole dashboard locally over USB/SSE (`node revbar.mjs`, config via `.env` — see `.env.example`), which predates the cloud functions. Don't run it as a daemon alongside the deployed functions or purchases will announce twice.

## Notes & gotchas

- Chart data is **UTC**: "today" resets at midnight UTC.
- The bar's `GET /screen` endpoint returns raw **BGR** pixels despite claiming BMP — `revbar.mjs capture` handles the swap.
- On a text element, setting `width` defeats `align: center` — only add it (with `scroll_rate`) for marquee overflow.
- The RevenueCat logomark belongs to RevenueCat; it's used here as a friendly integration nod. Swap `functions/logo.png` (12×12 PNG, transparent background) for anything you like.

## License

[MIT](LICENSE)
