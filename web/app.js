const $ = (id) => document.getElementById(id);

const state = {
  selected: null,
};

const els = {
  health: $("health"),
  loadForm: $("load-form"),
  responseId: $("response-id"),
  selectedId: $("selected-id"),
  copyId: $("copy-id"),
  summary: $("summary"),
  forkFrom: $("fork-from"),
  model: $("model"),
  instructions: $("instructions"),
  message: $("message"),
  store: $("store"),
  overrides: $("overrides"),
  copyConfig: $("copy-config"),
  continueForm: $("continue-form"),
  continueButton: $("continue-button"),
  result: $("result"),
  toast: $("toast"),
};

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden", "error");
  if (isError) els.toast.classList.add("error");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.add("hidden"), 5000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error || data?.message || JSON.stringify(data);
    throw new Error(detail);
  }
  return data;
}

function fmtDate(unixSeconds) {
  if (!unixSeconds) return "-";
  try { return new Date(unixSeconds * 1000).toLocaleString(); }
  catch { return String(unixSeconds); }
}

function pretty(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function setLoading(loading) {
  const btn = els.loadForm.querySelector("button[type=submit]");
  btn.disabled = loading;
  btn.textContent = loading ? "Cargando..." : "Cargar";
}

function addSummaryCard(key, value) {
  const card = document.createElement("div");
  card.className = "summary-card";
  const k = document.createElement("div");
  k.className = "k";
  k.textContent = key;
  const v = document.createElement("div");
  v.className = "v";
  v.textContent = value ?? "-";
  card.append(k, v);
  els.summary.appendChild(card);
}

function selectNode(node) {
  state.selected = node;
  const r = node.response;
  activeView = "trace";
  expansion = "default";
  $("search").value = "";
  for (const id of ["collapse-all", "download-json", "open-composer"]) $(id).disabled = false;
  $("source-note").textContent = node.local ? "Archivo local: puedes inspeccionarlo sin consultar la API. Continuar requiere que el ID siga disponible en OpenAI." : "Respuesta recuperada por ID.";

  els.selectedId.textContent = r.id;
  els.copyId.disabled = false;
  els.copyConfig.disabled = false;
  els.continueButton.disabled = false;
  els.forkFrom.textContent = r.id;
  els.model.value = r.model || "";
  els.instructions.value = typeof r.instructions === "string" ? r.instructions : (r.instructions ? pretty(r.instructions) : "");

  els.summary.innerHTML = "";
  addSummaryCard("status", r.status || "-");
  addSummaryCard("model", r.model || "-");
  addSummaryCard("created", fmtDate(r.created_at));
  addSummaryCard("previous", r.previous_response_id || "-");
  addSummaryCard("input tokens", r.usage?.input_tokens ?? "-");
  addSummaryCard("output tokens", r.usage?.output_tokens ?? "-");

  $("inspector-empty").classList.add("hidden");
  $("inspector-content").classList.remove("hidden");
  renderInspector();
  els.result.classList.add("hidden");
}

function likelyConfig(response) {
  const keys = [
    "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p",
    "max_output_tokens", "max_tool_calls", "reasoning", "text", "truncation",
    "metadata", "service_tier"
  ];
  const result = {};
  for (const key of keys) {
    if (response?.[key] !== undefined && response?.[key] !== null) result[key] = response[key];
  }
  return result;
}

async function loadResponse(responseId) {
  const id = responseId.trim();
  if (!id) return;
  setLoading(true);
  try {
    const data = await api(`/api/chain?response_id=${encodeURIComponent(id)}&limit=1`);
    const node = data.chain?.[0];
    if (!node?.response) throw new Error("No se ha recibido una respuesta válida.");
    selectNode(node);
    toast("Respuesta cargada.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setLoading(false);
  }
}

els.loadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadResponse(els.responseId.value);
});

els.copyId.addEventListener("click", async () => {
  if (!state.selected) return;
  try {
    await navigator.clipboard.writeText(state.selected.response.id);
    toast("Response ID copiado.");
  } catch { toast("No se pudo acceder al portapapeles.", true); }
});

els.copyConfig.addEventListener("click", () => {
  if (!state.selected) return;
  els.overrides.value = pretty(likelyConfig(state.selected.response));
  toast("Configuración recuperable copiada a Overrides.");
});

els.continueForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selected) return;

  let overrides;
  try {
    overrides = JSON.parse(els.overrides.value || "{}");
    if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") throw new Error("Debe ser un objeto JSON.");
  } catch (error) {
    toast(`Overrides JSON inválido: ${error.message}`, true);
    return;
  }

  const message = els.message.value.trim();
  if (!message) {
    toast("Escribe un input para continuar.", true);
    return;
  }

  els.continueButton.disabled = true;
  els.continueButton.textContent = "Enviando...";
  els.result.classList.add("hidden");

  try {
    const payload = {
      previous_response_id: state.selected.response.id,
      input: message,
      model: els.model.value.trim() || undefined,
      instructions: els.instructions.value,
      store: els.store.checked,
      overrides,
    };
    const data = await api("/api/continue", { method: "POST", body: JSON.stringify(payload) });
    const r = data.response;
    els.result.textContent = `Creada ${r.id} · ${r.status || "?"}`;
    els.result.classList.remove("hidden");
    els.responseId.value = r.id;
    els.message.value = "";
    toast(`Nueva respuesta creada: ${r.id}`);

    $("composer-dialog").close();
    if (els.store.checked) await loadResponse(r.id);
    else {
      const node = { response: r, input_items: [{ role: "user", content: message }] };
      selectNode(node);
      toast("Respuesta visible en esta sesión. store=false: no se podrá recuperar por ID.");
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    els.continueButton.disabled = !state.selected;
    els.continueButton.textContent = "Enviar y cargar nueva rama";
  }
});

async function health() {
  try {
    const data = await api("/api/health");
    if (data.api_key_configured) {
      els.health.textContent = `Backend ${data.runtime} · API key OK`;
      els.health.classList.add("ok");
    } else {
      els.health.textContent = `Backend ${data.runtime} · falta OPENAI_API_KEY`;
      els.health.classList.add("bad");
    }
  } catch (error) {
    els.health.textContent = "Backend no disponible";
    els.health.classList.add("bad");
  }
}

health();

// All API content is rendered as text, including strings that contain HTML.
let activeView = "trace";
let expansion = "default";
let matches = [];
let matchIndex = -1;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function parsedString(value) {
  if (typeof value !== "string" || !/^[\s]*[\[{]/.test(value)) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function highlighted(node, value) {
  const text = String(value);
  const query = $("search").value.trim().toLocaleLowerCase();
  if (!query) { node.textContent = text; return; }
  const lower = text.toLocaleLowerCase();
  let start = 0;
  let index;
  while ((index = lower.indexOf(query, start)) !== -1) {
    node.append(document.createTextNode(text.slice(start, index)));
    const mark = element("mark", "", text.slice(index, index + query.length));
    node.append(mark);
    matches.push(mark);
    start = index + query.length;
  }
  node.append(document.createTextNode(text.slice(start)));
}
function jsonNode(key, original, depth = 0, path = "$") {
  const parsed = $("decode-json").checked ? parsedString(original) : null;
  const value = parsed ?? original;
  const compound = value !== null && typeof value === "object";
  const longText = typeof value === "string" && (value.length > 180 || value.includes("\n"));
  const label = element("span", "json-key");
  highlighted(label, key);
  label.title = path;
  if (!compound && !longText) {
    const row = element("div", "json-leaf");
    const content = element("span", `json-value type-${value === null ? "null" : typeof value}`);
    highlighted(content, typeof value === "string" ? JSON.stringify(value) : String(value));
    row.append(label, document.createTextNode(": "), content);
    return row;
  }
  const details = element("details", "json-node");
  const summary = element("summary");
  summary.append(label, element("span", "node-meta", compound
    ? ` ${Array.isArray(value) ? "[ ]" : "{ }"} ${Object.keys(value).length} ${Array.isArray(value) ? "elementos" : "campos"}${parsed !== null ? " · JSON en texto" : ""}`
    : ` texto · ${value.length.toLocaleString("es")} caracteres`));
  const children = element("div", "json-children");
  let mounted = false;
  function mount() {
    if (mounted) return;
    mounted = true;
    if (compound) {
      for (const [childKey, child] of Object.entries(value)) {
        children.append(jsonNode(childKey, child, depth + 1, `${path}[${JSON.stringify(childKey)}]`));
      }
    } else {
      const pre = element("pre", "readable-text");
      highlighted(pre, value);
      children.append(pre);
    }
  }
  details.append(summary, children);
  details.addEventListener("toggle", () => { if (details.open) mount(); });
  details.open = Boolean($("search").value.trim()) || expansion === "all" || (expansion === "default" && depth < 3);
  if (details.open) mount();
  return details;
}
function traceItem(item, index) {
  const card = element("details", "trace-card");
  card.open = expansion === "all" || (expansion === "default" && item?.type === "message") || Boolean($("search").value.trim());
  const heading = element("summary");
  heading.append(element("span", "step-number", String(index + 1).padStart(2, "0")));
  const title = element("span");
  highlighted(title, [item?.type || "message", item?.name || item?.role, item?.status].filter(Boolean).join(" · "));
  heading.append(title);
  card.append(heading);
  const body = element("div", "trace-body");
  // Preserve every field, while giving message text and tool arguments a readable view.
  for (const [key, value] of Object.entries(item && typeof item === "object" ? item : { value: item })) {
    body.append(jsonNode(key, value, 0, `$[${index}][${JSON.stringify(key)}]`));
  }
  card.append(body);
  return card;
}
function renderInspector() {
  if (!state.selected) return;
  const viewer = $("viewer");
  viewer.replaceChildren();
  matches = [];
  matchIndex = -1;
  const { response, input_items, input_items_error } = state.selected;
  document.querySelectorAll("[data-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === activeView)));
  const notes = {
    trace: "Pasos de salida en orden: mensajes, razonamiento disponible y herramientas. Cada paso conserva todos sus campos.",
    input: "Elementos de entrada recuperados para esta respuesta. El backend actual recupera hasta 100 elementos por respuesta.",
    config: "Instrucciones y configuración devueltas por la API. El objeto original está en JSON completo.",
    json: "Objeto Response completo, sin recortes. Copiar y descargar conservan los valores originales, incluidos los textos JSON."
  };
  $("view-note").textContent = notes[activeView];
  if (activeView === "trace" || activeView === "input") {
    if (activeView === "input" && input_items_error) {
      viewer.append(element("p", "warning", "No se pudieron recuperar los elementos de entrada."), jsonNode("error", input_items_error));
    }
    const items = activeView === "trace" ? response.output : input_items;
    if (!items?.length) viewer.append(element("p", "empty-state", "No hay elementos disponibles en esta vista."));
    else items.forEach((item, index) => viewer.append(traceItem(item, index)));
    if (activeView === "trace" && (response.error || response.incomplete_details)) {
      viewer.prepend(jsonNode("Diagnóstico", { error: response.error, incomplete_details: response.incomplete_details }));
    }
  } else {
    const value = activeView === "json" ? response : { instructions: response.instructions ?? null, ...likelyConfig(response) };
    viewer.append(jsonNode(activeView === "json" ? "Response" : "Configuración", value));
  }
  $("search-count").textContent = $("search").value.trim() ? `${matches.length} coincidencias` : "";
  $("previous-match").disabled = $("next-match").disabled = matches.length === 0;
}
function moveMatch(delta) {
  if (!matches.length) return;
  matches[matchIndex]?.classList.remove("current-match");
  matchIndex = (matchIndex + delta + matches.length) % matches.length;
  const match = matches[matchIndex];
  for (let parent = match.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "DETAILS") parent.open = true;
  }
  match.classList.add("current-match");
  match.scrollIntoView({ block: "center", behavior: "smooth" });
  $("search-count").textContent = `${matchIndex + 1} / ${matches.length}`;
}
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
  activeView = button.dataset.view;
  renderInspector();
}));
$("expand-all").addEventListener("click", () => { expansion = "all"; renderInspector(); });
$("collapse-all").addEventListener("click", () => {
  expansion = "none";
  $("search").value = "";
  renderInspector();
  $("inspector-content").scrollIntoView({ block: "start" });
});
$("decode-json").addEventListener("change", renderInspector);
let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderInspector, 180);
});
$("search").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
});
$("previous-match").addEventListener("click", () => moveMatch(-1));
$("next-match").addEventListener("click", () => moveMatch(1));
$("copy-json").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(pretty(state.selected.response)); toast("Response JSON completo copiado."); }
  catch { toast("No se pudo acceder al portapapeles. Puedes descargar el JSON.", true); }
});
$("download-json").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([pretty(state.selected.response)], { type: "application/json" }));
  const link = element("a");
  link.href = url;
  link.download = `${state.selected.response.id || "response"}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("open-composer").addEventListener("click", () => {
  $("composer-dialog").showModal();
  els.message.focus();
});
$("close-composer").addEventListener("click", () => $("composer-dialog").close());
$("import-json").addEventListener("click", () => $("json-file").click());
$("json-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const response = JSON.parse(await file.text());
    if (!response || typeof response !== "object" || typeof response.id !== "string" || !response.id.startsWith("resp_") || !Array.isArray(response.output)) {
      throw new Error("El archivo debe contener un objeto Response con id resp_ y un array output.");
    }
    selectNode({ response, local: true, input_items_error: { message: "Los input items se recuperan por separado y no forman parte del objeto Response exportado." } });
    els.responseId.value = response.id;
    toast("JSON abierto localmente.");
  } catch (error) { toast(`No se pudo abrir el JSON: ${error.message}`, true); }
  finally { event.target.value = ""; }
});
