// npm i express http-proxy-middleware axios
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const axios = require("axios");

const VALIDATOR_URL = "http://192.168.86.62:8000";
const TARGET_ORIGIN = "http://192.168.86.62:2000";

const app = express();
app.use(express.json({ type: "*/*" })); // capture any content-type

app.use(async (req, res, next) => {
  // Fire-and-forget copy to validator
  const copy = {
    direction: "request",
    url: TARGET_ORIGIN + req.originalUrl,
    method: req.method,
    headers: req.headers,
    body: req.body
  };
  axios.post(VALIDATOR_URL, copy, { timeout: 2000 }).catch(() => {});
  next();
});

app.use("/", createProxyMiddleware({
  target: TARGET_ORIGIN,
  changeOrigin: true,
  selfHandleResponse: false,
  onProxyRes(proxyRes, req, res) {
    // Optionally, you can tap the response stream here and post to validator
  }
}));

app.listen(9001, "192.168.86.62", () => console.log("tee-proxy on http://192.168.86.62:9001 ->", TARGET_ORIGIN));
