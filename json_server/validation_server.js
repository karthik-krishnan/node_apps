const express = require("express");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { getValidatorForFlow, ValidationError } = require("./validators");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

/* ============================
   In-memory model (no PII)
   ============================ */
/*
state = {
  sessions: {
    [sessionId]: {
      createdAt, endedAt|null,
      flows: {
        [flowId]: { name, createdAt, endedAt|null, events: [ ... ] }
      }
    }
  }
}
*/
const state = { sessions: {} };

// NEW (sticky): single active pointers
const current = { sessionId: null, flowId: null };       // NEW (sticky)

/* ============================
   Helpers
   ============================ */
function assertFlowId(str) {
  if (!/^[A-Za-z0-9_]+$/.test(str || "")) {
    const e = new Error("flowId must be alphanumeric or underscore");
    e.status = 400;
    throw e;
  }
}
function getSession(sessionId, mustExist = true) {
  const s = state.sessions[sessionId];
  if (!s && mustExist) {
    const e = new Error(`Unknown sessionId: ${sessionId}`);
    e.status = 404;
    throw e;
  }
  return s;
}
function getFlow(sessionId, flowId, mustExist = true) {
  const s = getSession(sessionId, mustExist);
  const f = s?.flows?.[flowId];
  if (!f && mustExist) {
    const e = new Error(`Unknown flowId: ${flowId} in session ${sessionId}`);
    e.status = 404;
    throw e;
  }
  return f;
}
function ensureFlow(sessionId, flowId, name) {
  const s = getSession(sessionId, true);
  if (!s.flows[flowId]) {
    s.flows[flowId] = {
      name: name || flowId,
      createdAt: new Date().toISOString(),
      endedAt: null,
      events: []
    };
  }
  return s.flows[flowId];
}

// Find BeaconId recursively (kept)
function findBeaconId(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(obj, "BeaconId")) return obj.BeaconId;
  if (Object.prototype.hasOwnProperty.call(obj, "beaconId")) return obj.beaconId;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const found = findBeaconId(v);
      if (found != null) return found;
    }
  }
  return null;
}

// Numbered-sentence formatter (kept)
function formatErrorsAsSentences(errors = []) {
  const rmSlash = (p) => (p || "").replace(/^\/+/, "");
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  return errors.map((e, idx) => {
    const inst = e.instancePath || "";
    const missing = e.params && e.params.missingProperty ? e.params.missingProperty : null;
    const combinedPath = inst + (missing ? `/${missing}` : "");
    const path = rmSlash(combinedPath);
    const atPath = path ? `${path} ` : "";
    switch (e.keyword) {
      case "required":
        return `${idx + 1}. ${inst ? `${rmSlash(inst)} is missing required property '${missing}'.` : `Missing required property '${missing}'.`}`;
      case "additionalProperties":
        return `${idx + 1}. ${inst ? `${rmSlash(inst)} has unexpected property '${e.params.additionalProperty}'.` : `Unexpected property '${e.params.additionalProperty}' found.`}`;
      case "type":
        return `${idx + 1}. ${atPath}must be of type '${e.params.type}'.`;
      case "format":
        return `${idx + 1}. ${atPath}must match format '${e.params.format}'.`;
      case "enum":
        return `${idx + 1}. ${atPath}must be one of: ${e.params.allowedValues.join(", ")}.`;
      case "minLength":
        return `${idx + 1}. ${atPath}must have at least ${e.params.limit} characters.`;
      case "maxLength":
        return `${idx + 1}. ${atPath}must have at most ${e.params.limit} characters.`;
      case "minimum":
        return `${idx + 1}. ${atPath}must be >= ${e.params.limit}.`;
      case "maximum":
        return `${idx + 1}. ${atPath}must be <= ${e.params.limit}.`;
      case "minItems":
        return `${idx + 1}. ${atPath}must have at least ${e.params.limit} items.`;
      case "maxItems":
        return `${idx + 1}. ${atPath}must have at most ${e.params.limit} items.`;
      case "pattern":
        return `${idx + 1}. ${atPath}must match pattern ${e.params.pattern}.`;
      default:
        return `${idx + 1}. ${path ? `${path} ${e.message}.` : `${cap(e.message || "validation error")}.`}`;
    }
  });
}

/* ============================
   Health
   ============================ */
app.get("/test", (req, res) => {
  res.send("Validator OK");
});

/* =====================================================
   SESSIONS (single active)
   ===================================================== */

// CHANGED (sticky): Start session — auto-end previous, set current.sessionId
app.post("/sessions", (req, res) => {                    // CHANGED (sticky)
  if (current.sessionId) {
    // auto end current session
    const s = getSession(current.sessionId);
    if (!s.endedAt) s.endedAt = new Date().toISOString();
  }
  const sessionId = uuidv4();
  state.sessions[sessionId] = {
    createdAt: new Date().toISOString(),
    endedAt: null,
    flows: {}
  };
  current.sessionId = sessionId;                         // NEW (sticky)
  current.flowId = null;                                 // NEW (sticky)
  res.json({ ok: true, sessionId, note: "Previous session auto-ended (if any)" });
});

// NEW (sticky): explicit end of current session
app.post("/sessions/end", (req, res) => {                // NEW (sticky)
  if (!current.sessionId) return res.status(409).json({ ok: false, error: "No active session" });
  const s = getSession(current.sessionId);
  s.endedAt = new Date().toISOString();
  current.sessionId = null;
  current.flowId = null;
  res.json({ ok: true });
});

// Keep JSON list (unchanged)
app.get("/sessions", (req, res) => {
  const out = Object.entries(state.sessions).map(([id, s]) => ({
    sessionId: id,
    createdAt: s.createdAt,
    endedAt: s.endedAt,
    flowCount: Object.keys(s.flows).length,
    eventCount: Object.values(s.flows).reduce((n, f) => n + f.events.length, 0)
  }));
  res.json({ ok: true, sessions: out, current });
});

// Delete a session by id (unchanged)
app.delete("/sessions/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  if (state.sessions[sessionId]) delete state.sessions[sessionId];
  if (current.sessionId === sessionId) {                 // NEW (sticky)
    current.sessionId = null;
    current.flowId = null;
  }
  res.json({ ok: true, deleted: true });
});

/* =====================================================
   FLOWS (single active per current session)
   ===================================================== */

// CHANGED (sticky): Start flow — requires active session; auto-end previous flow; sets current.flowId
app.post("/flows", (req, res) => {                       // CHANGED (sticky)
  const { flowId, name } = req.body || {};
  if (!current.sessionId) return res.status(409).json({ ok: false, error: "No active session. Start a session first." });
  if (!flowId) return res.status(400).json({ ok: false, error: "flowId required" });
  assertFlowId(flowId);

  // auto end previous flow in the current session
  if (current.flowId) {
    const prev = getFlow(current.sessionId, current.flowId);
    if (!prev.endedAt) prev.endedAt = new Date().toISOString();
  }

  ensureFlow(current.sessionId, flowId, name);
  current.flowId = flowId;                               // NEW (sticky)

  res.json({ ok: true, sessionId: current.sessionId, flowId, note: "Previous flow auto-ended (if any)" });
});

// NEW (sticky): End current flow in current session
app.post("/flows/end", (req, res) => {                   // NEW (sticky)
  if (!current.sessionId) return res.status(409).json({ ok: false, error: "No active session" });
  if (!current.flowId) return res.status(409).json({ ok: false, error: "No active flow" });
  const f = getFlow(current.sessionId, current.flowId);
  f.endedAt = new Date().toISOString();
  current.flowId = null;
  res.json({ ok: true });
});

// Flow detail (JSON, unchanged except uses explicit ids)
app.get("/sessions/:sessionId/flows/:flowId", (req, res) => {
  const { sessionId, flowId } = req.params;
  const f = getFlow(sessionId, flowId);
  res.json({ ok: true, sessionId, flowId, ...f });
});

/* =====================================================
   EVENT INGEST (POST /) — now uses sticky current session/flow
   ===================================================== */
app.post("/", async (req, res) => {                      // CHANGED (sticky)
  console.log("Received JSON:", req.body);
  // No headers needed; we route to current pointers
  if (!current.sessionId) return res.status(409).json({ ok: false, error: "No active session. Start a session." });
  if (!current.flowId) return res.status(409).json({ ok: false, error: "No active flow. Start a flow." });

  const sessionId = current.sessionId;
  const flowId = current.flowId;
  const payload = req.body;

  const s = getSession(sessionId);
  const f = getFlow(sessionId, flowId);

  // Build cross-event context (kept)
  const ctx = {
    sessionId, flowId, state,
    findEvents: ({ flowId: fid, where } = {}) => {
      const flows = fid ? [getFlow(sessionId, fid)] : Object.values(s.flows);
      const out = [];
      for (const fl of flows) {
        for (const ev of fl.events) {
          if (!where || where(ev)) out.push(ev);
        }
      }
      return out;
    },
    getFlow: (fid) => getFlow(sessionId, fid),
    getSession: () => getSession(sessionId)
  };

  // Resolve validator for current flow (per-flow schemas + optional custom)
  const validator = await getValidatorForFlow(flowId, {
    ajv,
    baseDir: path.join(__dirname, "validators")
  }); 

  // Execute validations
  let schemaErrors = [];
  let customErrors = [];
  let valid = true;
  try {
    const result = await validator.validate(payload, ctx);
    valid = result.valid;
    schemaErrors = result.schemaErrors || [];
    customErrors = result.customErrors || [];
  } catch (err) {
    if (err instanceof ValidationError) {
      valid = false;
      customErrors = [err.message];
    } else {
      console.error("Validator error", err);
      valid = false;
      customErrors = ["Internal validator error"];
    }
  }

  const formattedErrorList = valid
    ? []
    : [
        ...formatErrorsAsSentences(schemaErrors),
        ...customErrors.map((m, i) => `${i + 1 + schemaErrors.length}. ${m}`)
      ];

  // Persist event
  const record = {
    eventId: uuidv4(),
    timestamp: new Date().toISOString(),
    BeaconId: findBeaconId(payload),
    ValidationStatus: valid ? "Valid" : "Invalid",
    formattedErrorList,
    payload
  };
  f.events.push(record);

  // Respond
  if (valid) return res.json({ ok: true, eventId: record.eventId });
  return res.status(400).json({ ok: false, eventId: record.eventId, errors: formattedErrorList });
});

/* =====================================================
   Global rollup & clearing (kept)
   ===================================================== */
app.get("/state", (req, res) => {
  const records = [];
  for (const [sid, s] of Object.entries(state.sessions)) {
    for (const [fid, f] of Object.entries(s.flows)) {
      for (const ev of f.events) {
        records.push({ sessionId: sid, flowId: fid, ...ev });
      }
    }
  }
  res.json({ count: records.length, current, records });
});

app.delete("/state", (req, res) => {
  state.sessions = {};
  current.sessionId = null;                               // NEW (sticky)
  current.flowId = null;                                  // NEW (sticky)
  res.json({ ok: true, cleared: true });
});

/* =====================================================
   HTML Views (mark current)
   ===================================================== */

// Build hierarchical sessions → flows → events, plus totals
function buildDashboardModel() {
  const sessions = Object.entries(state.sessions).map(([sid, s]) => {
    const flows = Object.entries(s.flows).map(([fid, f]) => {
      const count = f.events.length;
      const validCount = f.events.filter(e => e.ValidationStatus === "Valid").length;
      const invalidCount = count - validCount;
      return {
        sessionId: sid,
        flowId: fid,
        name: f.name,
        createdAt: f.createdAt,
        endedAt: f.endedAt,
        isCurrent: current.sessionId === sid && current.flowId === fid,
        count, validCount, invalidCount,
        events: f.events
      };
    });
    const flowCount = flows.length;
    const eventCount = flows.reduce((n, fl) => n + fl.count, 0);
    const validCount = flows.reduce((n, fl) => n + fl.validCount, 0);
    const invalidCount = eventCount - validCount;
    return {
      sessionId: sid,
      createdAt: s.createdAt,
      endedAt: s.endedAt,
      isCurrent: current.sessionId === sid,
      flowCount, eventCount, validCount, invalidCount,
      flows
    };
  });

  const totals = {
    sessions: sessions.length,
    flows: sessions.reduce((n, s) => n + s.flowCount, 0),
    events: sessions.reduce((n, s) => n + s.eventCount, 0),
    valid:  sessions.reduce((n, s) => n + s.validCount, 0),
    invalid: sessions.reduce((n, s) => n + s.invalidCount, 0)
  };

  return { sessions, current, totals };
}

// Render initial HTML (no meta refresh anymore)
app.get("/dashboard/html", (req, res) => {
  res.render("dashboard", buildDashboardModel());
});

// NEW: JSON data endpoint used by the page for live updates
app.get("/dashboard/data", (req, res) => {
  res.json(buildDashboardModel());
});

// Basic error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ ok: false, error: err.message || "Server error" });
});

app.listen(8000, () => console.log("Listening on http://localhost:8000"));
