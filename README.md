# Validation Events Server & Dashboard

A lightweight Node.js service and browser dashboard to **capture, validate, and review JSON events** produced by black‑box mobile apps (iOS/Android). It solves the problem of validating event streams **without modifying the client app**:

* The server manages a **single active Session** and **single active Flow** (a "sticky" model).
  Start a new session/flow via API; every `POST /` event is automatically assigned to the current session/flow.
  Starting a new one **auto‑ends** the previous.
* Validation is **per‑flow** using JSON Schema (AJV) with optional **custom JavaScript validators**.
* Supports **multiple schemas per flow** and **cross‑event rules** (e.g., “payment must follow order”).
* A **live dashboard** (no hard refresh) shows Sessions → Flows → Events with pass/fail status.

---

## Features

* **Sticky orchestration:** exactly one active session and one active flow at any time; no headers needed on client events.
* **Per‑flow schema resolution:** flow‑local schemas or shared **common** schemas; try‑all, single‑file, or `selectSchema()` logic.
* **Custom validation hooks:** add business rules and cross‑event checks in `validators/flows/<flowId>/index.js`.
* **Cross‑event lookups:** query prior events in current session (same or different flows).
* **Live dashboard:** auto‑refresh via JSON polling and preserves expanded sections.
* **Hot reload friendly:** schemas and validators reload on the next request (see Hot Reload).

---

## Folder Structure

```
validation_server/
  validation_server.js            # Express app + sticky session/flow + routes
  validators/
    index.js                      # Core validator engine (schema resolution + AJV cache)
    common/
      schemas/                    # Shared/reusable JSON Schemas (e.g., payment.schema.json)
    flows/
      checkout/                   # Example flow (your flow id)
        order.schema.json
        payment.schema.json
        index.js                  # (optional) selectSchema() + validate()
  views/
    dashboard.ejs                 # Unified Sessions→Flows→Events view
  public/
    state.css                     # Styles for the dashboard
```

> Data is stored **in‑memory** (single process). Clearing the state or restarting the process removes all data.

---

## Quick Start

### Prerequisites

* Node.js 18+ recommended

### Install & Run

```bash
npm install
node validation_server.js
# open the dashboard in your browser:
open http://localhost:8000/dashboard/html
```

### (Optional) Auto‑restart during development

```bash
npm i -D nodemon
npx nodemon --ext js,json,ejs,css --watch validation_server.js --watch validators --watch views --watch public validation_server.js
```

---

## Traffic Capture with mitmproxy (Mirror Mode)

> Capture live mobile app traffic and mirror specific requests to this validator **without** interrupting the original flow.

**Guide & scripts:** [https://github.com/karthik-krishnan/mitmproxy\_scripts](https://github.com/karthik-krishnan/mitmproxy_scripts)

**How it fits:**

* Point the device to mitmproxy as its system proxy and trust the mitmproxy CA (for HTTPS).
* Use the simplified “mirror” addon from the repo to forward only selected URL patterns to this server’s `POST /` while the original request still goes to its real destination.
* In this validator, start a **Session** and then a **Flow** before running your test so mirrored events land in the right context (sticky model).

---

## Using the Sticky Session/Flow Model

In this model, **you do not add headers** to client event requests. The server routes all `POST /` events to the **current** session/flow.

### Start/End a Session

```bash
# Start a new session (auto‑ends any existing)
curl -s -X POST http://localhost:8000/sessions | jq .

# End the current session
curl -s -X POST http://localhost:8000/sessions/end | jq .
```

### Start/End a Flow

```bash
# Start a flow (requires an active session). Auto‑ends the previous flow.
curl -s -X POST http://localhost:8000/flows \
  -H 'Content-Type: application/json' \
  -d '{"flowId":"checkout","name":"Checkout Flow"}' | jq .

# End the current flow
curl -s -X POST http://localhost:8000/flows/end | jq .
```

### Ingest Events

```bash
# Send any JSON payload to POST /
curl -s -X POST http://localhost:8000/ \
  -H 'Content-Type: application/json' \
  -d '{"event":"orderCreated","orderId":"o-001","items":[{"sku":"A1","qty":1}]}' | jq .

# Another event (validated under the same active flow)
curl -s -X POST http://localhost:8000/ \
  -H 'Content-Type: application/json' \
  -d '{"event":"paymentAuth","paymentId":"p-001","amount":1999}' | jq .
```

### Dashboard

* Open **`/dashboard/html`** to view Sessions → Flows → Events.
* Toggle **Auto‑refresh**; expanded flow sections remain open across refreshes.

#### Dashboard (Screenshot)

> Live hierarchical view of **Sessions → Flows → Events** with pass/fail status, totals, and quick controls.

![Dashboard](docs/dashboard.png)

*Tip: add an image at `docs/dashboard.png` (or update the path above) so it renders on GitHub.*

---

## Creating a New Flow

Create a folder under `validators/flows/` using your **flow id** (alphanumeric + underscore):

```
validators/
  flows/
    checkout/
      order.schema.json
      payment.schema.json
      index.js           # optional, for schema selection and custom rules
```

### Add JSON Schemas

* Place one or more schema files in the flow folder, e.g., `order.schema.json`, `payment.schema.json`.
* Or reuse shared schemas from `validators/common/schemas/`.

### Optional: Flow Plugin (`index.js`)

```js
// validators/flows/checkout/index.js
module.exports = {
  // Choose schema(s) for a given payload.
  // Return a filename in this folder (e.g., 'order.schema.json'),
  // an @common reference (e.g., '@common/payment.schema.json'),
  // an absolute path, an array of any of the above, or null to use heuristics.
  selectSchema(payload /*, ctx */) {
    if (payload?.event === 'orderCreated' || 'orderId' in (payload||{})) return 'order.schema.json';
    if (payload?.event === 'paymentAuth' || 'paymentId' in (payload||{})) return '@common/payment.schema.json';
    return null; // fallback to engine: type.json, single-file, or try-all
  },

  // Add business rules and cross-event checks (return [] if OK)
  validate(payload, ctx) {
    const errs = [];

    // Simple attribute/value checks
    if (payload?.channel !== 'ios') errs.push("channel must equal 'ios'.");

    // Cross-event example: payment must follow an order in this flow
    function kind(p){
      if (!p || typeof p !== 'object') return 'unknown';
      if ('orderId' in p) return 'order';
      if ('paymentId' in p) return 'payment';
      return 'unknown';
    }
    if (kind(payload) === 'payment') {
      const priorOrder = ctx.findEvents({
        flowId: ctx.flowId,
        where: (e) => kind(e.payload) === 'order'
      }).length > 0;
      if (!priorOrder) errs.push('Payment event arrived before any order event in this flow.');
    }

    return errs;
  }
};
```

> You can omit `index.js` entirely if schemas alone are sufficient.

---

## Schema Resolution Logic

When validating an event for flow `<flowId>`, the engine resolves schemas in this order:

1. **Flow plugin** `selectSchema(payload, ctx)` (if present) — may return a string or array:

   * Relative to the flow folder, e.g., `"order.schema.json"`
   * **Shared reference** via `@common/<file>.json`, e.g., `"@common/payment.schema.json"`
   * Absolute path (advanced)
2. **Heuristic:** if `payload.type` exists → `<type>.schema.json` in the flow folder, else in common.
3. **Single file:** if the flow folder has exactly one schema file, use that (else if the common folder has exactly one, use that).
4. **Try‑all:** if multiple schemas exist, try all in the **flow** folder; pass if **any** validates. If none exist in the flow folder, try all in **common**.
5. **If no schema anywhere:** validation fails with `"No schema found in flow or common schema directories"`.

> Schemas are compiled and cached with AJV. Edits are picked up automatically on subsequent requests (see Hot Reload).

---

## Custom Validation API

A flow plugin can export two optional functions:

* `selectSchema(payload, ctx)` → `string | string[] | null`
  Return one or more schema refs (flow‑relative, `@common/...`, or absolute). Return `null` to use the default heuristics.

* `validate(payload, ctx)` → `string[]`
  Return an **array of error strings**; return `[]` (or nothing) for success.

`ctx` provides helpers for cross‑event lookups within the **current session**:

```js
ctx.sessionId   // current session id
ctx.flowId      // current flow id
ctx.findEvents({ flowId?, where? }) // search prior events
ctx.getFlow(flowId)                 // read flow model (events, timestamps)
ctx.getSession()                    // read session model
```

**Example: simple attribute checks**

```js
if (payload?.meta?.env && !['prod','stage'].includes(payload.meta.env)) {
  errs.push('meta.env must be one of: prod, stage.');
}
const amt = payload?.order?.amount;
if (typeof amt === 'number' && (amt <= 0 || amt > 100000)) {
  errs.push('order.amount must be within (0, 100000].');
}
```

---

## Hot Reload (Schemas & Validators)

This project is designed to minimize restarts while you iterate:

* **Schemas (`.json`)**: the validator engine recompiles when file timestamps change; **new files** are discovered automatically.
* **Flow plugins (`index.js`/`custom.js`)**: module cache is cleared before each require, so **code changes apply on next request**.
* **Views/CSS**: Express view cache is disabled in dev; changes apply on refresh.

For a zero‑thinking dev loop, run with **nodemon** to auto‑restart on any change:

```bash
npx nodemon --ext js,json,ejs,css --watch validation_server.js --watch validators --watch views --watch public validation_server.js
```

---

## API Reference

### Health

* `GET /test` → `"Validator OK"`

### Sessions (sticky)

* `POST /sessions` → start a new session; **auto‑ends** any existing.
  **Response:** `{ ok, sessionId }`
* `POST /sessions/end` → end the current session.
* `GET /sessions` → JSON list `{ sessions: [...], current: {sessionId, flowId} }`
* `DELETE /sessions/:sessionId` → delete a session by ID (also clears current if it matches).

### Flows (sticky)

* `POST /flows` → body `{ flowId, name? }`; requires active session; **auto‑ends** previous flow.
  **Response:** `{ ok, sessionId, flowId }`
* `POST /flows/end` → end the current flow.
* `GET /sessions/:sessionId/flows/:flowId` → flow detail (JSON).

### Events

* `POST /` → ingest a JSON event assigned to the **current** session/flow.
  **Response:**

  * `200 { ok: true, eventId }` when valid
  * `400 { ok: false, eventId, errors: [...] }` when invalid (schema + custom messages)

### State & Dashboard

* `GET /state` → flattened JSON of all events across sessions/flows (with current pointers)
* `DELETE /state` → clear everything; resets current session/flow
* `GET /dashboard/html` → live hierarchical dashboard
* `GET /dashboard/data` → JSON model consumed by the dashboard

---

## Troubleshooting

* **Dashboard shows old “Current Session/Flow”:** ensure you’re on `/dashboard/html`. The header updates with the poller; you can toggle Auto‑refresh.
* **Events rejected with “No active session/flow”:** call `POST /sessions` and then `POST /flows` before sending events.
* **“No schema found…” errors:** add at least one schema to the flow folder or to `validators/common/schemas/`, or implement `selectSchema()`.
* **Cross‑event rule not triggering:** confirm your classifier matches real payloads; use `ctx.findEvents({ where })` to debug.
* **Hot reload not reflecting:** if not using nodemon, ensure you saved files; the next request picks changes.

---

## Optional Client Utilities

* **SwiftUI test app:** a tiny iOS app with two buttons to POST different JSON payloads to the server. Use it to simulate event generation during dev.
* **Automation (Appium):** orchestrate end‑to‑end flows by calling the session/flow APIs from your test runner, then drive the app and review results on the dashboard.

---

## License

MIT
