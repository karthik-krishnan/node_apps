// validators/index.js
const fs = require("fs");
const path = require("path");

class ValidationError extends Error {}
exports.ValidationError = ValidationError;

const CACHE = new Map(); // key: abs schema path -> compiled ajv function

function listSchemaFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(dir, f));
}

function compileSchema(ajv, schemaPath) {
  if (CACHE.has(schemaPath)) return CACHE.get(schemaPath);
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const validate = ajv.compile(schema);
  CACHE.set(schemaPath, validate);
  return validate;
}

function tryValidate(ajv, payload, schemaPaths) {
  const results = [];
  for (const sp of schemaPaths) {
    const validate = compileSchema(ajv, sp);
    const ok = validate(payload);
    results.push({ schemaPath: sp, ok, errors: ok ? [] : (validate.errors || []) });
  }
  return results;
}

async function loadFlowModule(flowDir) {
  const candidates = ["index.js", "custom.js"].map(f => path.join(flowDir, f));
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod = require(p);
      return mod && typeof mod === "object" ? mod : {};
    }
  }
  return {};
}

// Resolve a reference returned by selectSchema:
// - "@common/<name>.json" -> under commonDir
// - relative file -> under flowDir (or fallback to common if not found)
// - absolute path -> use as-is
function resolveRefToPath(ref, flowDir, commonDir) {
  if (!ref) return null;
  if (path.isAbsolute(ref)) return ref;
  if (ref.startsWith("@common/")) {
    return path.join(commonDir, ref.replace("@common/", ""));
  }
  const flowPath = path.join(flowDir, ref);
  if (fs.existsSync(flowPath)) return flowPath;
  const commonPath = path.join(commonDir, ref);
  if (fs.existsSync(commonPath)) return commonPath;
  return null;
}

async function resolveSchemaPaths(flowDir, commonDir, payload, ctx, mod) {
  // 1) Flow module pick
  if (mod && typeof mod.selectSchema === "function") {
    const chosen = await Promise.resolve(mod.selectSchema(payload, ctx));
    if (chosen) {
      const arr = Array.isArray(chosen) ? chosen : [chosen];
      const paths = arr
        .map(r => resolveRefToPath(r, flowDir, commonDir))
        .filter(Boolean);
      if (paths.length > 0) return paths;
    }
  }

  // 2) Heuristic: payload.type
  if (payload && payload.type) {
    const name = `${payload.type}.schema.json`;
    const f = path.join(flowDir, name);
    if (fs.existsSync(f)) return [f];
    const c = path.join(commonDir, name);
    if (fs.existsSync(c)) return [c];
  }

  // 3) One-file shortcut
  const flowFiles = listSchemaFiles(flowDir);
  if (flowFiles.length === 1) return [flowFiles[0]];

  const commonFiles = listSchemaFiles(commonDir);
  if (flowFiles.length === 0 && commonFiles.length === 1) return [commonFiles[0]];

  // 4) Try all in flow, else all in common
  if (flowFiles.length > 0) return flowFiles;
  if (commonFiles.length > 0) return commonFiles;

  // 5) Nothing to use → signal “no schema found”
  throw new ValidationError("No schema found in flow or common schema directories");
}

exports.getValidatorForFlow = async function getValidatorForFlow(flowId, opts) {
  const { ajv, baseDir } = opts;
  const flowsBase = path.join(baseDir, "flows");
  const commonBase = path.join(baseDir, "common", "schemas");

  const flowDir = path.join(flowsBase, flowId);
  const mod = await loadFlowModule(flowDir);

  return {
    /**
     * Validate payload with schema(s) + optional custom validator
     * Returns { valid, schemaErrors[], customErrors[] }
     */
    validate: async (payload, ctx) => {
      let schemaErrors = [];
      let customErrors = [];

      // Resolve schema list (may throw ValidationError if none exist)
      let schemaPaths;
      try {
        schemaPaths = await resolveSchemaPaths(flowDir, commonBase, payload, ctx, mod);
      } catch (e) {
        if (e instanceof ValidationError) {
          // No schema → treat as validation failure with a clear message
          return { valid: false, schemaErrors: [], customErrors: [e.message] };
        }
        throw e;
      }
      
      // Try the schemas (pass if ANY validates)
      const results = tryValidate(ajv, payload, schemaPaths);
      const okAny = results.some(r => r.ok);
      if (!okAny) {
        const sorted = results.slice().sort((a, b) => (a.errors?.length || 0) - (b.errors?.length || 0));
        schemaErrors = sorted[0].errors || [];
      }

      // Optional custom checks
      if (mod.validate) {
        const out = await Promise.resolve(mod.validate(payload, ctx));
        if (Array.isArray(out)) customErrors = out.map(String);
        else if (typeof out === "string") customErrors = [out];
      }

      const valid = (schemaErrors.length === 0) && (customErrors.length === 0);
      return { valid, schemaErrors, customErrors };
    }
  };
};
