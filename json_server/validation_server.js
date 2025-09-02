const express = require("express");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const path = require("path");

// Load schema from file
const userSchema = require("./schemas/user.schema.json");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));  

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const state = {
  records: [] // each item: { timestamp, BeaconId, ValidationStatus, formattedErrorList }
};

let validateUser = ajv.compile(userSchema);

function formatErrors(errors = []) {
  return errors.map(e => ({
    path: e.instancePath || "(root)",
    message: e.message || "validation error",
    keyword: e.keyword,
    params: e.params
  }));
}

// ---- Numbered-sentence error formatter (clean paths, no "(root)") ----
function formatErrorsAsSentences(errors = []) {
  const rmSlash = (p) => (p || "").replace(/^\/+/, ""); // strip leading '/'
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  return errors.map((e, idx) => {
    const inst = e.instancePath || "";
    const missing = e.params && e.params.missingProperty ? e.params.missingProperty : null;

    // Build a display path (without leading slash); may be "" at root
    const combinedPath = inst + (missing ? `/${missing}` : "");
    const path = rmSlash(combinedPath);
    const atPath = path ? `${path} ` : ""; // prefix used when we *have* a path

    switch (e.keyword) {
      case "required":
        // If we're at root, don't show "(root)" — use a plain message
        return `${idx + 1}. ${
          inst ? `${rmSlash(inst)} is missing required property '${missing}'.`
               : `Missing required property '${missing}'.`
        }`;

      case "additionalProperties":
        // Root → "Unexpected property 'x' found."
        // Nested → "user.settings has unexpected property 'x'."
        return `${idx + 1}. ${
          inst
            ? `${rmSlash(inst)} has unexpected property '${e.params.additionalProperty}'.`
            : `Unexpected property '${e.params.additionalProperty}' found.`
        }`;

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
        // Generic fallback; if no path, just show the message capitalized.
        return `${idx + 1}. ${
          path ? `${path} ${e.message}.` : `${cap(e.message || "validation error")}.`
        }`;
    }
  });
}

app.get("/test", (req,res) => {
  console.log("Received GET");
  res.send("Validator OK");
});

app.post("/", (req, res) => {
  console.log("Received JSON:", req.body);
  const valid = validateUser(req.body);  
  const formattedErrorList = valid ? [] : formatErrorsAsSentences(validateUser.errors);
  const record = {
    timestamp: new Date().toISOString(),
    BeaconId: findBeaconId(req.body),              // NEW
    ValidationStatus: valid ? "Valid" : "Invalid", // NEW
    formattedErrorList                              // NEW
  };
  state.records.push(record);                       // NEW

  if (valid) {
    console.log("Request is Valid");
    return res.json({ ok: true }); 
  } else {
    console.log("Request is Invalid");
    console.log(formatErrorsAsSentences(validateUser.errors));
    return res.status(400).json({ ok: false, errors: formatErrorsAsSentences(validateUser.errors) });
  } 
});

// NEW: optional helper to find BeaconId anywhere in the request body
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

app.get("/state", (req, res) => {
  res.json({ count: state.records.length, records: state.records });
});

app.delete("/state", (req, res) => {
  state.records.length = 0; // clear in place
  res.json({ ok: true, cleared: true });
});

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// pretty HTML view of the current state
app.get("/state/html", (req, res) => {
  res.render("state", {
    count: state.records.length,                    
    records: state.records                          
  });                                                     
});         

app.listen(8000, () => console.log("Listening on http://localhost:8000"));

