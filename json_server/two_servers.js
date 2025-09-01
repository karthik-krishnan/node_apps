const express = require("express");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const app1 = express();


app1.use(express.json());
// Middleware to parse JSON body
app1.use(express.json());

app1.post("/", (req, res) => {
  console.log("Received JSON:", req.body);
  res.json({ ok: true });
});

app1.listen(7000, () => {
  console.log("Server listening on http://localhost:7000");
});


// Load schema from file
const userSchema = require("./schemas/user.schema.json");

const app2 = express();
app2.use(express.json({ limit: "1mb" }));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let validateUser = ajv.compile(userSchema);

function formatErrors(errors = []) {
  return errors.map(e => ({
    path: e.instancePath || "(root)",
    message: e.message || "validation error",
    keyword: e.keyword,
    params: e.params
  }));
}

app2.post("/", (req, res) => {
  const valid = validateUser(req.body);
  if (valid) return res.json({ ok: true });
  return res.status(400).json({ ok: false, errors: formatErrors(validateUser.errors) });
});

app2.listen(8000, () => console.log("Listening on http://localhost:8000"));

