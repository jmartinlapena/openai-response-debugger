#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB_DIR = path.join(ROOT, "web");

function loadDotEnv(filename) {
  if (!fs.existsSync(filename)) return;
  const text = fs.readFileSync(filename, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, ".env"));

const API_BASE = (process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/$/, "");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);

function openAIHeaders() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error("Falta OPENAI_API_KEY en .env o en el entorno.");
    error.status = 500;
    error.payload = { error: { message: error.message } };
    throw error;
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (process.env.OPENAI_PROJECT) headers["OpenAI-Project"] = process.env.OPENAI_PROJECT;
  if (process.env.OPENAI_ORGANIZATION) headers["OpenAI-Organization"] = process.env.OPENAI_ORGANIZATION;
  return headers;
}

async function openAIRequest(method, apiPath, body) {
  let response;
  try {
    response = await fetch(`${API_BASE}${apiPath}`, {
      method,
      headers: openAIHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (cause) {
    const error = new Error(`No se pudo conectar con OpenAI: ${cause.message}`);
    error.status = 502;
    error.payload = { error: { message: error.message } };
    throw error;
  }

  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { error: { message: text || `HTTP ${response.status}` } }; }

  if (!response.ok) {
    const error = new Error(payload?.error?.message || `OpenAI API error ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

const retrieveResponse = (id) => openAIRequest("GET", `/responses/${encodeURIComponent(id)}?include%5B%5D=file_search_call.results`);
const retrieveInputItems = (id) => openAIRequest("GET", `/responses/${encodeURIComponent(id)}/input_items?limit=100&order=asc`);

async function buildChain(responseId, limit) {
  const nodes = [];
  const seen = new Set();
  let current = responseId;
  let truncated = false;

  while (current && nodes.length < limit) {
    if (seen.has(current)) {
      const error = new Error(`Bucle detectado en previous_response_id: ${current}`);
      error.status = 409;
      error.payload = { error: { message: error.message } };
      throw error;
    }
    seen.add(current);

    const response = await retrieveResponse(current);
    let inputItems = [];
    let inputItemsError = null;
    try {
      inputItems = (await retrieveInputItems(current)).data || [];
    } catch (error) {
      inputItemsError = error.payload || { error: { message: error.message } };
    }
    nodes.push({ response, input_items: inputItems, input_items_error: inputItemsError });
    current = response.previous_response_id;
  }

  if (current) truncated = true;
  nodes.reverse();
  return { chain: nodes, truncated, limit };
}

function sendJson(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Body demasiado grande");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(reqPath, res) {
  const relative = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const candidate = path.resolve(WEB_DIR, relative);
  if (candidate !== WEB_DIR && !candidate.startsWith(`${WEB_DIR}${path.sep}`)) {
    return sendJson(res, 403, { error: { message: "Forbidden" } });
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return sendJson(res, 404, { error: { message: "Not found" } });
  }
  const data = fs.readFileSync(candidate);
  res.writeHead(200, {
    "Content-Type": mime[path.extname(candidate)] || "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        runtime: "node",
        api_key_configured: Boolean(process.env.OPENAI_API_KEY),
        api_base: API_BASE,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/chain") {
      const responseId = (url.searchParams.get("response_id") || "").trim();
      if (!responseId) return sendJson(res, 400, { error: { message: "Falta response_id" } });
      const requestedLimit = Number(url.searchParams.get("limit") || 30);
      const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 30));
      return sendJson(res, 200, await buildChain(responseId, limit));
    }

    if (req.method === "GET" && url.pathname === "/api/response") {
      const responseId = (url.searchParams.get("response_id") || "").trim();
      if (!responseId) return sendJson(res, 400, { error: { message: "Falta response_id" } });
      const [response, items] = await Promise.all([retrieveResponse(responseId), retrieveInputItems(responseId)]);
      return sendJson(res, 200, { response, input_items: items.data || [] });
    }

    if (req.method === "POST" && url.pathname === "/api/continue") {
      const payload = await readJson(req);
      const previousId = String(payload.previous_response_id || "").trim();
      const userInput = payload.input;
      let model = String(payload.model || "").trim();
      const instructions = payload.instructions;
      const store = payload.store !== false;
      const overrides = payload.overrides || {};

      if (!previousId) return sendJson(res, 400, { error: { message: "Falta previous_response_id" } });
      if (typeof userInput !== "string" || !userInput.trim()) return sendJson(res, 400, { error: { message: "input debe ser texto no vacío" } });
      if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") return sendJson(res, 400, { error: { message: "overrides debe ser un objeto JSON" } });

      if (!model) {
        const parent = await retrieveResponse(previousId);
        model = parent.model || "gpt-5.6";
      }

      const protectedKeys = new Set(["previous_response_id", "input", "model", "instructions", "store", "conversation"]);
      const body = Object.fromEntries(Object.entries(overrides).filter(([key]) => !protectedKeys.has(key)));
      Object.assign(body, {
        model,
        previous_response_id: previousId,
        input: userInput,
        store,
      });
      if (typeof instructions === "string" && instructions.trim()) body.instructions = instructions;

      const response = await openAIRequest("POST", "/responses", body);
      return sendJson(res, 200, { response, request_body: body });
    }

    if (req.method === "GET") return serveStatic(url.pathname, res);
    return sendJson(res, 404, { error: { message: "Not found" } });
  } catch (error) {
    if (error instanceof SyntaxError) return sendJson(res, 400, { error: { message: "JSON inválido" } });
    return sendJson(res, error.status || 500, error.payload || { error: { message: error.message || String(error) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpenAI Response Debugger (Node) -> http://${HOST}:${PORT}`);
  console.log(`API base: ${API_BASE}`);
  console.log("Ctrl+C para detener.");
});
