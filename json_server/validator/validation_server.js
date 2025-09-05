const express = require("express");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const path = require("path");
const { getValidatorForFlow, ValidationError } = require("./validators");
const { randomUUID } = require("crypto");
const ExcelJS = require("exceljs");

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
        [flowId]: { name, createdAt, endedAt|null, messages: [ ... ] }
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
      messages: []
    };
  }
  return s.flows[flowId];
}

// Find a captured message anywhere by messageId
function findByMessageId(messageId) {
  if (state.sessions) {
    for (const [sid, s] of Object.entries(state.sessions)) {
      for (const [fid, f] of Object.entries(s.flows || {})) {
        const m = (f.messages || []).find(e => e.messageId === messageId);
        if (m) return { sessionId: sid, flowId: fid, message: m };
      }
    }
    return { sessionId: null, flowId: null, message: null };
  }
}

// Collect rows for export
function collectMessages(scope) {
  // returns array of {sessionId, flowId, messageId, timestamp, ValidationStatus, formattedErrorList, payload}
  const rows = [];
  if (!state.sessions) return rows;

  const pushMessage = (sid, fid, m) => rows.push({
    sessionId: sid,
    flowId: fid,
    messageId: m.messageId,
    timestamp: m.timestamp,
    status: m.ValidationStatus,
    errors: (m.formattedErrorList || []).join(" | "),
    payload: JSON.stringify(m.payload ?? {})
  });

  const { sessionId, flowId } = scope;
  if (sessionId && flowId) {
    const fl = state.sessions[sessionId]?.flows?.[flowId];
    if (fl) fl.messages.forEach(m => pushMessage(sessionId, flowId, m));
    return rows;
  }
  if (sessionId) {
    const s = state.sessions[sessionId];
    if (s) Object.entries(s.flows || {}).forEach(([fid, fl]) => fl.messages.forEach(m => pushMessage(sessionId, fid, m)));
    return rows;
  }
  // global
  Object.entries(state.sessions).forEach(([sid, s]) => {
    Object.entries(s.flows || {}).forEach(([fid, fl]) => {
      fl.messages.forEach(m => pushMessage(sid, fid, m));
    });
  });
  return rows;
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


app.post("/sessions", (req, res) => {                    
  if (current.sessionId) {
    // auto end current session
    const s = getSession(current.sessionId);
    if (!s.endedAt) s.endedAt = new Date().toISOString();
  }
  const sessionId = randomUUID();
  state.sessions[sessionId] = {
    createdAt: new Date().toISOString(),
    endedAt: null,
    flows: {}
  };
  current.sessionId = sessionId;                         
  current.flowId = null;                                 
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
    messageCount: Object.values(s.flows).reduce((n, f) => n + f.messages.length, 0)
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
   MESSAGE INGEST (POST /) — now uses sticky current session/flow
   ===================================================== */
   app.post("/", async (req, res) => {
    console.log("Received JSON:", req.body);
    // No headers needed; we route to current pointers
    if (!current.sessionId) return res.status(409).json({ ok: false, error: "No active session. Start a session." });
    if (!current.flowId)    return res.status(409).json({ ok: false, error: "No active flow. Start a flow." });
  
    const sessionId = current.sessionId;
    const flowId    = current.flowId;
    const payload   = req.body;
  
    const s = getSession(sessionId);
    const f = getFlow(sessionId, flowId);
  
    // Build cross-message context
    const ctx = {
      sessionId, flowId, state,
      findMessages: ({ flowId: fid, where } = {}) => {
        const flows = fid ? [getFlow(sessionId, fid)] : Object.values(s.flows);
        const out = [];
        for (const fl of flows) {
          for (const m of fl.messages) {
            if (!where || where(m)) out.push(m);
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
      valid         = result.valid;
      schemaErrors  = result.schemaErrors || [];
      customErrors  = result.customErrors || [];
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
  
    const record = {
      messageId: randomUUID(),                              
      timestamp: new Date().toISOString(),
      ValidationStatus: valid ? "Valid" : "Invalid",
      formattedErrorList,
      payload                                            
    };
    f.messages.push(record)
  
    // Respond with messageId
    if (valid) return res.json({ ok: true,  messageId: record.messageId });
    return res.status(400).json({ ok: false, messageId: record.messageId, errors: formattedErrorList });
  });
  

/* =====================================================
   Global rollup & clearing (kept)
   ===================================================== */
app.get("/state", (req, res) => {
  const records = [];
  for (const [sid, s] of Object.entries(state.sessions)) {
    for (const [fid, f] of Object.entries(s.flows)) {
      for (const m of f.messages) {
        records.push({ sessionId: sid, flowId: fid, ...m });
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

// ---------- Dashboard model builders (use messages in the JSON) ----------
function summarizeFlow(sessionId, flowId, fl, isCurrent) {
  const list = fl.messages || [];
  const validCount = list.filter(e => e.ValidationStatus === "Valid").length;
  const invalidCount = list.length - validCount;

  return {
    flowId,
    name: fl.name || flowId,
    createdAt: fl.createdAt,
    endedAt: fl.endedAt || null,
    isCurrent: !!isCurrent,
    messageCount: list.length,
    validCount,
    invalidCount,
    // What the dashboard renders as rows:
    messages: list.map(m => ({
      messageId: m.messageId,
      timestamp: m.timestamp,
      ValidationStatus: m.ValidationStatus,
      formattedErrorList: m.formattedErrorList || [],
    })),
  };
}

function summarizeSession(sessionId, s) {
  const flows = s.flows || {};
  const flowObjs = Object.entries(flows).map(([fid, fl]) =>
    summarizeFlow(sessionId, fid, fl, current.sessionId === sessionId && current.flowId === fid)
  );

  const messageCount = flowObjs.reduce((n, f) => n + (f.messageCount || 0), 0);
  const validCount   = flowObjs.reduce((n, f) => n + (f.validCount || 0), 0);
  const invalidCount = flowObjs.reduce((n, f) => n + (f.invalidCount || 0), 0);

  return {
    sessionId,
    createdAt: s.createdAt,
    endedAt: s.endedAt || null,
    isCurrent: current.sessionId === sessionId,
    flowCount: Object.keys(flows).length,
    messageCount,
    validCount,
    invalidCount,
    flows: flowObjs,
  };
}

function buildDashboardModel() {
  const sessions = state.sessions || {};
  const sessionObjs = Object.entries(sessions).map(([sid, s]) => summarizeSession(sid, s));

  const totals = sessionObjs.reduce(
    (acc, ss) => {
      acc.flows     += ss.flowCount;
      acc.messages  += ss.messageCount;
      acc.valid     += ss.validCount;
      acc.invalid   += ss.invalidCount;
      return acc;
    },
    { sessions: Object.keys(sessions).length, flows: 0, messages: 0, valid: 0, invalid: 0 }
  );

  return {
    current: { sessionId: current.sessionId || null, flowId: current.flowId || null },
    totals,
    sessions: sessionObjs.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")),
  };
}

async function exportXlsx(res, filename, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Messages");
  ws.columns = [
    { header: "Message ID", key: "messageId", width: 40 },
    { header: "Session ID", key: "sessionId", width: 38 },
    { header: "Flow ID",    key: "flowId",    width: 24 },
    { header: "Timestamp",  key: "timestamp", width: 24 },
    { header: "Status",     key: "status",    width: 10 },
    { header: "Errors",     key: "errors",    width: 60 },
    { header: "Payload (JSON)", key: "payload", width: 80 },
  ];
  ws.addRows(rows);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

// JSON detail
app.get("/messages/:messageId.json", (req, res) => {
  const { message, sessionId, flowId } = findByMessageId(req.params.messageId);
  if (!message) return res.status(404).json({ error: "Not found" });
  res.json({ sessionId, flowId, message });
});

// HTML detail
app.get("/messages/:messageId", (req, res) => {
  const { message, sessionId, flowId } = findByMessageId(req.params.messageId);
  if (!message) return res.status(404).send("Not found");
  const payloadPretty = JSON.stringify(message.payload ?? {}, null, 2);
  res.render("message", { message, sessionId, flowId, payloadPretty });
});

// Render initial HTML (no meta refresh anymore)
app.get("/dashboard/html", (req, res) => {
  res.render("dashboard", buildDashboardModel());
});

// NEW: JSON data endpoint used by the page for live updates
app.get("/dashboard/data", (req, res) => {
  res.json(buildDashboardModel());
});

app.get("/export/all.xlsx", async (req, res) => {
  const rows = collectMessages({});
  await exportXlsx(res, "validation-all.xlsx", rows);
});

app.get("/sessions/:sessionId/export.xlsx", async (req, res) => {
  const { sessionId } = req.params;
  if (!state.sessions?.[sessionId]) return res.status(404).send("Session not found");
  const rows = collectMessages({ sessionId });
  await exportXlsx(res, `validation-session-${sessionId}.xlsx`, rows);
});

app.get("/sessions/:sessionId/flows/:flowId/export.xlsx", async (req, res) => {
  const { sessionId, flowId } = req.params;
  if (!state.sessions?.[sessionId]?.flows?.[flowId]) return res.status(404).send("Flow not found");
  const rows = collectMessages({ sessionId, flowId });
  await exportXlsx(res, `validation-session-${sessionId}-flow-${flowId}.xlsx`, rows);
});

// Basic error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ ok: false, error: err.message || "Server error" });
});

app.listen(8000, () => console.log("Listening on http://localhost:8000"));
