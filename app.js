// Mini Gantt v2: groups, deps, modal editing, local save/load
const $ = (id) => document.getElementById(id);

const elBody = $("taskBody");
const elSvg = $("ganttSvg");
const elScroll = $("ganttScroll");

const elZoom = $("zoom");
const elRange = $("range");

const btnAddTask = $("btnAddTask");
const btnAddGroup = $("btnAddGroup");
const btnJumpToday = $("btnJumpToday");

const btnOpen = $("btnOpen");
const btnSave = $("btnSave");
const btnSaveAs = $("btnSaveAs");

const overlay = $("modalOverlay");
const btnCloseModal = $("btnCloseModal");
const btnCancel = $("btnCancel");
const btnApply = $("btnApply");
const btnDelete = $("btnDelete");

const fName = $("fName");
const fType = $("fType");
const fParent = $("fParent");
const fDeps = $("fDeps");
const fNotes = $("fNotes");

const rangeValue = $("rangeValue");
const btnClearRange = $("btnClearRange");
const btnThisMonth = $("btnThisMonth");

const calPrev = $("calPrev");
const calNext = $("calNext");
const calMonthLabel = $("calMonthLabel");
const calGrid = $("calGrid");

const modalTitle = $("modalTitle");
const modalKicker = $("modalKicker");

// ---------- Date utils (UTC, to avoid timezone gremlins) ----------
const iso = (d) => d.toISOString().slice(0, 10);
const parseISO = (s) => {
  const [y, m, dd] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function normalizeRange(start, end) {
  if (!start || !end) return { start, end };
  const s = parseISO(start);
  const e = parseISO(end);
  if (e < s) return { start: iso(e), end: iso(s) };
  return { start, end };
}

function todayISO() {
  return iso(new Date());
}

// ---------- Data model ----------
/**
 * Task:
 * {
 *  id, name,
 *  type: "task" | "group",
 *  parentId: string|null,
 *  start: "YYYY-MM-DD"|null,
 *  end: "YYYY-MM-DD"|null,
 *  deps: string[], // predecessor IDs
 *  notes: string,
 *  collapsed: boolean
 * }
 */

let state = {
  version: 2,
  tasks: [],
};

function newTask({ type = "task", parentId = null } = {}) {
  const t = todayISO();
  return {
    id: crypto.randomUUID(),
    name: type === "group" ? "New Group" : "New Task",
    type,
    parentId,
    start: type === "group" ? null : t,
    end: type === "group" ? null : t,
    deps: [],
    notes: "",
    collapsed: false,
  };
}

// Demo-ish initial data (or load from localStorage autosave)
function seed() {
  const base = parseISO(todayISO());
  const g = newTask({ type: "group" });
  g.name = "Release v1";

  const a = newTask({ parentId: g.id });
  a.name = "Define scope";
  a.start = iso(addDays(base, 0));
  a.end = iso(addDays(base, 2));

  const b = newTask({ parentId: g.id });
  b.name = "Build MVP";
  b.start = iso(addDays(base, 3));
  b.end = iso(addDays(base, 12));
  b.deps = [a.id];

  const c = newTask({ parentId: g.id });
  c.name = "Test & polish";
  c.start = iso(addDays(base, 10));
  c.end = iso(addDays(base, 15));
  c.deps = [b.id];

  state.tasks = [g, a, b, c];
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem("mini_gantt_autosave_v2");
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.tasks)) return false;
    state = sanitizeData(data);
    return true;
  } catch {
    return false;
  }
}

function autosave() {
  localStorage.setItem("mini_gantt_autosave_v2", JSON.stringify(state));
}

function sanitizeData(data) {
  const tasks = (data.tasks || []).map((t) => ({
    id: String(t.id || crypto.randomUUID()),
    name: String(t.name ?? ""),
    type: t.type === "group" ? "group" : "task",
    parentId: t.parentId ? String(t.parentId) : null,
    start: t.start ? String(t.start) : null,
    end: t.end ? String(t.end) : null,
    deps: Array.isArray(t.deps) ? t.deps.map(String) : [],
    notes: String(t.notes ?? ""),
    collapsed: Boolean(t.collapsed),
  }));

  // normalize ranges
  for (const t of tasks) {
    if (t.type === "task" && t.start && t.end) {
      const nr = normalizeRange(t.start, t.end);
      t.start = nr.start;
      t.end = nr.end;
    }
    if (t.type === "group") {
      t.start = null;
      t.end = null;
    }
  }

  return { version: 2, tasks };
}

// ---------- Hierarchy + visibility ----------
function childrenOf(id) {
  return state.tasks.filter((t) => t.parentId === id);
}

function getTask(id) {
  return state.tasks.find((t) => t.id === id) || null;
}

function buildTreeOrder() {
  // stable order: groups/tasks in insertion order under each parent
  const roots = state.tasks.filter((t) => !t.parentId);
  const order = [];
  const depthMap = new Map();

  function walk(node, depth) {
    order.push(node);
    depthMap.set(node.id, depth);

    if (node.type === "group" && node.collapsed) return;
    for (const ch of childrenOf(node.id)) walk(ch, depth + 1);
  }

  for (const r of roots) walk(r, 0);
  return { order, depthMap };
}

function computeGroupRollups() {
  // group dates = min/max of visible descendant tasks (including collapsed children? usually yes)
  const groups = state.tasks.filter((t) => t.type === "group");
  for (const g of groups) {
    const desc = getDescendants(g.id).filter((t) => t.type === "task" && t.start && t.end);
    if (!desc.length) {
      g.start = null; g.end = null;
      continue;
    }
    let min = parseISO(desc[0].start);
    let max = parseISO(desc[0].end);
    for (const t of desc) {
      const s = parseISO(t.start), e = parseISO(t.end);
      if (s < min) min = s;
      if (e > max) max = e;
    }
    g.start = iso(min);
    g.end = iso(max);
  }
}

function getDescendants(groupId) {
  const out = [];
  const stack = [groupId];
  while (stack.length) {
    const cur = stack.pop();
    for (const ch of childrenOf(cur)) {
      out.push(ch);
      stack.push(ch.id);
    }
  }
  return out;
}

// ---------- Dependencies (Finish-to-Start) ----------
function enforceDependencies() {
  // simple propagation loop
  // For each task, ensure start >= max(pred.end + 1)
  // If changed, push task and keep duration.
  const tasks = state.tasks.filter((t) => t.type === "task" && t.start && t.end);

  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  const maxIter = tasks.length * 3 + 10;

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    for (const t of tasks) {
      if (!t.deps?.length) continue;
      const preds = t.deps.map((id) => idToTask.get(id)).filter(Boolean);
      if (!preds.length) continue;

      const minStart = preds
        .map((p) => addDays(parseISO(p.end), 1))
        .reduce((a, b) => (b > a ? b : a));

      const curStart = parseISO(t.start);
      if (curStart < minStart) {
        const dur = daysBetween(parseISO(t.start), parseISO(t.end));
        t.start = iso(minStart);
        t.end = iso(addDays(minStart, dur));
        changed = true;
      }
    }

    if (!changed) break;
  }
}

// ---------- Range for timeline ----------
function getTimelineRange(orderedTasks) {
  const today = parseISO(todayISO());
  const mode = elRange.value;

  const dated = orderedTasks
    .filter((t) => t.start && t.end)
    .map((t) => ({ s: parseISO(t.start), e: parseISO(t.end) }));

  let min = dated.length ? dated[0].s : today;
  let max = dated.length ? dated[0].e : today;

  for (const d of dated) {
    if (d.s < min) min = d.s;
    if (d.e > max) max = d.e;
  }

  if (mode === "auto") {
    min = addDays(min, -3);
    max = addDays(max, 7);
  } else {
    const days = Number(mode);
    min = addDays(today, -Math.floor(days * 0.25));
    max = addDays(min, days);
  }

  const totalDays = Math.max(1, daysBetween(min, max) + 1);
  return { min, max, totalDays, today };
}

// ---------- Render table ----------
function renderTable() {
  const { order, depthMap } = buildTreeOrder();
  elBody.innerHTML = "";

  for (const t of order) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => openModal(t.id));

    // Name cell with indent + collapse toggle for groups
    const tdName = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "nameCell";

    const depth = depthMap.get(t.id) || 0;
    const indent = document.createElement("div");
    indent.style.width = `${depth * 16}px`;
    wrap.appendChild(indent);

    if (t.type === "group") {
      const twist = document.createElement("button");
      twist.className = "twisty";
      twist.textContent = t.collapsed ? "▶" : "▼";
      twist.addEventListener("click", (e) => {
        e.stopPropagation();
        t.collapsed = !t.collapsed;
        autosave();
        renderAll();
      });
      wrap.appendChild(twist);
    } else {
      const spacer = document.createElement("div");
      spacer.style.width = "22px";
      wrap.appendChild(spacer);
    }

    const name = document.createElement("div");
    name.textContent = t.name || "(unnamed)";
    wrap.appendChild(name);

    tdName.appendChild(wrap);

    const tdType = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = "typePill";
    pill.textContent = t.type;
    tdType.appendChild(pill);

    const tdS = document.createElement("td");
    tdS.textContent = t.start ?? "—";

    const tdE = document.createElement("td");
    tdE.textContent = t.end ?? "—";

    tr.appendChild(tdName);
    tr.appendChild(tdType);
    tr.appendChild(tdS);
    tr.appendChild(tdE);

    elBody.appendChild(tr);
  }
}

// ---------- Render gantt (SVG) ----------
function svgEl(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}
function rect(x, y, w, h, r, fill, stroke) {
  const e = svgEl("rect");
  e.setAttribute("x", x); e.setAttribute("y", y);
  e.setAttribute("width", w); e.setAttribute("height", h);
  e.setAttribute("rx", r); e.setAttribute("ry", r);
  e.setAttribute("fill", fill);
  e.setAttribute("stroke", stroke);
  return e;
}
function linePath(d, stroke, width) {
  const e = svgEl("path");
  e.setAttribute("d", d);
  e.setAttribute("fill", "none");
  e.setAttribute("stroke", stroke);
  e.setAttribute("stroke-width", width);
  return e;
}
function textEl(x, y, str, anchor, size, fill, weight = "400") {
  const e = svgEl("text");
  e.setAttribute("x", x); e.setAttribute("y", y);
  e.setAttribute("text-anchor", anchor);
  e.setAttribute("font-size", size);
  e.setAttribute("fill", fill);
  e.setAttribute("font-weight", weight);
  e.textContent = str;
  return e;
}

function renderGantt() {
  computeGroupRollups();

  const { order } = buildTreeOrder();
  const rowH = Number(getComputedStyle(document.documentElement).getPropertyValue("--rowH").replace("px", "")) || 44;
  const dayW = Number(elZoom.value);

  const { min, totalDays, today } = getTimelineRange(order);

  const headerH = 34;
  const leftPad = 10;
  const topPad = 10;

  const width = leftPad + totalDays * dayW + 20;
  const height = topPad + headerH + order.length * rowH + 20;

  elSvg.setAttribute("width", width);
  elSvg.setAttribute("height", height);
  elSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  elSvg.innerHTML = "";

  elSvg.appendChild(rect(0, 0, width, height, 16, "rgba(0,0,0,.06)", "rgba(255,255,255,.08)"));

  // vertical grid + day numbers (sparse when zoom is small)
  for (let i = 0; i < totalDays; i++) {
    const x = leftPad + i * dayW;
    elSvg.appendChild(rect(x, topPad, dayW, headerH + order.length * rowH, 0, "transparent", "rgba(255,255,255,.06)"));

    const date = addDays(min, i);
    const d = date.getUTCDate();
    const isMonday = date.getUTCDay() === 1;

    if (dayW >= 22 || isMonday) {
      elSvg.appendChild(textEl(x + dayW / 2, topPad + 22, (dayW >= 22 ? String(d) : "•"), "middle", "12", "rgba(231,236,255,.85)"));
    }

    // month boundary
    if (date.getUTCDate() === 1) {
      elSvg.appendChild(linePath(`M ${x} ${topPad} L ${x} ${topPad + headerH + order.length * rowH}`, "rgba(122,162,255,.28)", 2));
      const m = date.toLocaleString(undefined, { month: "short" });
      elSvg.appendChild(textEl(x + 6, topPad + 12, m, "start", "11", "rgba(169,179,214,.95)", "600"));
    }
  }

  // horizontal lines
  for (let r = 0; r <= order.length; r++) {
    const y = topPad + headerH + r * rowH;
    elSvg.appendChild(linePath(`M ${leftPad} ${y} L ${leftPad + totalDays * dayW} ${y}`, "rgba(255,255,255,.06)", 1));
  }

  // today line
  const todayX = leftPad + clamp(daysBetween(min, today), 0, totalDays - 1) * dayW + dayW / 2;
  elSvg.appendChild(linePath(`M ${todayX} ${topPad} L ${todayX} ${topPad + headerH + order.length * rowH}`, "rgba(45,212,191,.55)", 2));
  elSvg.appendChild(textEl(todayX + 6, topPad + headerH + 12, "Today", "start", "11", "rgba(45,212,191,.92)"));

  // bars (name-only display)
  order.forEach((t, idx) => {
    if (!t.start || !t.end) return;

    const y = topPad + headerH + idx * rowH + 10;
    const s = parseISO(t.start);
    const e = parseISO(t.end);
    const startIdx = clamp(daysBetween(min, s), 0, totalDays - 1);
    const endIdx = clamp(daysBetween(min, e), 0, totalDays - 1);
    const x = leftPad + startIdx * dayW + 2;
    const w = Math.max(6, (endIdx - startIdx + 1) * dayW - 4);

    const fill = t.type === "group" ? "rgba(169,179,214,.18)" : "rgba(122,162,255,.35)";
    const stroke = t.type === "group" ? "rgba(169,179,214,.35)" : "rgba(122,162,255,.65)";

    const bar = rect(x, y, w, rowH - 20, 10, fill, stroke);
    bar.style.cursor = "pointer";
    bar.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openModal(t.id);
    });
    elSvg.appendChild(bar);

    const label = textEl(x + 10, y + (rowH - 20) / 2 + 4, t.name || "(unnamed)", "start", "12", "rgba(231,236,255,.95)", "600");
    label.style.pointerEvents = "none"; // click hits bar
    elSvg.appendChild(label);
  });

  // dependency arrows (simple)
  drawDependencyArrows(order, min, dayW, topPad + headerH, rowH, leftPad);
}

function drawDependencyArrows(order, min, dayW, y0, rowH, x0) {
  const indexById = new Map(order.map((t, i) => [t.id, i]));

  for (const t of order) {
    if (t.type !== "task" || !t.deps?.length || !t.start || !t.end) continue;
    for (const predId of t.deps) {
      const p = getTask(predId);
      if (!p || !p.start || !p.end) continue;

      const pi = indexById.get(p.id);
      const ti = indexById.get(t.id);
      if (pi == null || ti == null) continue;

      const pEndX = x0 + (daysBetween(min, parseISO(p.end)) + 1) * dayW; // right edge-ish
      const pY = y0 + pi * rowH + rowH / 2;

      const tStartX = x0 + (daysBetween(min, parseISO(t.start))) * dayW; // left edge-ish
      const tY = y0 + ti * rowH + rowH / 2;

      const midX = Math.max(pEndX + 10, (pEndX + tStartX) / 2);

      const d = `M ${pEndX} ${pY}
                 C ${midX} ${pY}, ${midX} ${tY}, ${tStartX} ${tY}`;
      const path = linePath(d, "rgba(255,255,255,.18)", 2);
      elSvg.appendChild(path);

      // arrow head
      const ah = svgEl("path");
      const ax = tStartX, ay = tY;
      ah.setAttribute("d", `M ${ax} ${ay} l -6 -4 l 0 8 Z`);
      ah.setAttribute("fill", "rgba(255,255,255,.22)");
      elSvg.appendChild(ah);
    }
  }
}

// ---------- Modal + calendar range picker ----------
let editingId = null;

// calendar state
let calCursor = parseISO(todayISO()); // month shown
let pickStart = null; // "YYYY-MM-DD"|null
let pickEnd = null;   // "YYYY-MM-DD"|null

function openModal(id) {
  editingId = id;
  const t = getTask(id);
  if (!t) return;

  modalKicker.textContent = t.type === "group" ? "Group" : "Task";
  modalTitle.textContent = `Edit: ${t.name || "(unnamed)"}`;

  fName.value = t.name ?? "";
  fType.value = t.type;
  fNotes.value = t.notes ?? "";

  // parent options = groups (excluding self and descendants to prevent cycles)
  const groups = state.tasks.filter((x) => x.type === "group");
  fParent.innerHTML = "";
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "(no parent)";
  fParent.appendChild(optNone);

  const forbidden = new Set([t.id, ...getDescendants(t.id).map((x) => x.id)]);
  for (const g of groups) {
    if (forbidden.has(g.id)) continue;
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name || "(unnamed group)";
    fParent.appendChild(opt);
  }
  fParent.value = t.parentId ?? "";

  // deps options = tasks only (excluding self)
  fDeps.innerHTML = "";
  const tasksOnly = state.tasks.filter((x) => x.type === "task" && x.id !== t.id);
  for (const x of tasksOnly) {
    const opt = document.createElement("option");
    opt.value = x.id;
    opt.textContent = x.name || x.id.slice(0, 8);
    opt.selected = (t.deps || []).includes(x.id);
    fDeps.appendChild(opt);
  }

  // range picker set
  pickStart = t.start ?? null;
  pickEnd = t.end ?? null;
  updateRangeLabel();

  // show month around start or today
  calCursor = parseISO(pickStart || todayISO());
  calCursor = new Date(Date.UTC(calCursor.getUTCFullYear(), calCursor.getUTCMonth(), 1));
  renderCalendar();

  // delete allowed always
  btnDelete.style.display = "inline-flex";

  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
}

function closeModal() {
  overlay.classList.remove("show");
  overlay.setAttribute("aria-hidden", "true");
  editingId = null;
}

function updateRangeLabel() {
  if (pickStart && pickEnd) rangeValue.textContent = `${pickStart} → ${pickEnd}`;
  else if (pickStart) rangeValue.textContent = `${pickStart} → (pick end)`;
  else rangeValue.textContent = "—";
}

function renderCalendar() {
  const y = calCursor.getUTCFullYear();
  const m = calCursor.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0));
  const startDow = first.getUTCDay(); // 0..6
  const daysInMonth = last.getUTCDate();

  calMonthLabel.textContent = first.toLocaleString(undefined, { month: "long", year: "numeric" });

  calGrid.innerHTML = "";

  // weekday header row (small labels)
  const wds = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const wd of wds) {
    const h = document.createElement("div");
    h.className = "calCell muted";
    h.style.cursor = "default";
    h.textContent = wd;
    calGrid.appendChild(h);
  }

  // cells: 6 weeks view
  const totalCells = 42; // 6*7
  const startIndex = startDow; // where day 1 begins
  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement("div");
    cell.className = "calCell";

    const dayNum = i - startIndex + 1;
    if (dayNum < 1 || dayNum > daysInMonth) {
      cell.classList.add("muted");
      cell.textContent = "";
      cell.style.cursor = "default";
      calGrid.appendChild(cell);
      continue;
    }

    const date = iso(new Date(Date.UTC(y, m, dayNum)));
    cell.textContent = String(dayNum);

    // selection styling
    if (pickStart && date === pickStart) cell.classList.add("selStart");
    if (pickEnd && date === pickEnd) cell.classList.add("selEnd");
    if (pickStart && pickEnd) {
      const ds = parseISO(pickStart);
      const de = parseISO(pickEnd);
      const d = parseISO(date);
      if (d > ds && d < de) cell.classList.add("inRange");
    }

    cell.addEventListener("click", () => {
      // first click start, second click end, third click reset start
      if (!pickStart || (pickStart && pickEnd)) {
        pickStart = date;
        pickEnd = null;
      } else {
        pickEnd = date;
        const nr = normalizeRange(pickStart, pickEnd);
        pickStart = nr.start;
        pickEnd = nr.end;
      }
      updateRangeLabel();
      renderCalendar();
    });

    calGrid.appendChild(cell);
  }
}

// ---------- Save/Load local file ----------
let fileHandle = null;

async function openFromFile() {
  // File System Access API (Chrome/Edge). If not available, fallback to input.
  if ("showOpenFilePicker" in window) {
    const [h] = await window.showOpenFilePicker({
      types: [{ description: "Gantt JSON", accept: { "application/json": [".json", ".gantt.json"] } }],
      multiple: false,
    });
    const file = await h.getFile();
    const text = await file.text();
    const data = JSON.parse(text);
    state = sanitizeData(data);
    fileHandle = h;
    autosave();
    renderAll();
    return;
  }

  // fallback: create input
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json,.gantt.json,application/json";
  inp.onchange = async () => {
    const file = inp.files?.[0];
    if (!file) return;
    const text = await file.text();
    const data = JSON.parse(text);
    state = sanitizeData(data);
    autosave();
    renderAll();
  };
  inp.click();
}

async function saveToFile({ saveAs = false } = {}) {
  const data = JSON.stringify(state, null, 2);

  if ("showSaveFilePicker" in window) {
    if (!fileHandle || saveAs) {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: "project.gantt.json",
        types: [{ description: "Gantt JSON", accept: { "application/json": [".gantt.json", ".json"] } }],
      });
    }
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    autosave();
    return;
  }

  // fallback: download blob
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "project.gantt.json";
  a.click();
  URL.revokeObjectURL(a.href);
  autosave();
}

// ---------- Actions ----------
function addGroup() {
  const g = newTask({ type: "group" });
  state.tasks.push(g);
  autosave();
  renderAll();
  openModal(g.id);
}

function addTask() {
  // default parent = first group if exists, else none
  const firstGroup = state.tasks.find((t) => t.type === "group")?.id ?? null;
  const t = newTask({ type: "task", parentId: firstGroup });
  state.tasks.push(t);
  autosave();
  renderAll();
  openModal(t.id);
}

function deleteTask(id) {
  const t = getTask(id);
  if (!t) return;

  // deleting a group deletes descendants
  if (t.type === "group") {
    const desc = getDescendants(t.id).map((x) => x.id);
    const toRemove = new Set([t.id, ...desc]);
    state.tasks = state.tasks.filter((x) => !toRemove.has(x.id));
  } else {
    state.tasks = state.tasks.filter((x) => x.id !== id);
  }

  // remove deps pointing to deleted
  const alive = new Set(state.tasks.map((x) => x.id));
  for (const x of state.tasks) {
    x.deps = (x.deps || []).filter((d) => alive.has(d));
  }

  autosave();
  renderAll();
}

// ---------- Apply modal changes ----------
function applyModal() {
  const t = getTask(editingId);
  if (!t) return;

  t.name = fName.value.trim();
  t.type = fType.value === "group" ? "group" : "task";
  t.parentId = fParent.value ? fParent.value : null;
  t.notes = fNotes.value ?? "";

  // deps
  const selected = Array.from(fDeps.selectedOptions).map((o) => o.value);
  t.deps = selected;

  // range from picker
  if (t.type === "task") {
    t.start = pickStart;
    t.end = pickEnd;
    if (t.start && t.end) {
      const nr = normalizeRange(t.start, t.end);
      t.start = nr.start;
      t.end = nr.end;
    }
    // if user left only a start but not end, set end=start
    if (t.start && !t.end) t.end = t.start;
  } else {
    // groups don't have direct dates (roll-up)
    t.start = null; t.end = null;
  }

  // enforce deps after edit
  enforceDependencies();
  autosave();
  renderAll();
  closeModal();
}

// ---------- Render all ----------
function renderAll() {
  // enforce deps before draw (so UI stays consistent)
  enforceDependencies();
  renderTable();
  renderGantt();
}

// ---------- Wire up ----------
btnAddTask.addEventListener("click", addTask);
btnAddGroup.addEventListener("click", addGroup);

elZoom.addEventListener("change", () => { renderAll(); });
elRange.addEventListener("change", () => { renderAll(); });

btnJumpToday.addEventListener("click", () => {
  computeGroupRollups();
  const { order } = buildTreeOrder();
  const { min, today } = getTimelineRange(order);
  const dayW = Number(elZoom.value);
  const idx = clamp(daysBetween(min, today), 0, 99999);
  elScroll.scrollLeft = Math.max(0, idx * dayW - 200);
});

btnOpen.addEventListener("click", async () => {
  try { await openFromFile(); } catch (e) { alert("Open cancelled or failed."); }
});
btnSave.addEventListener("click", async () => {
  try { await saveToFile({ saveAs: false }); } catch (e) { alert("Save cancelled or failed."); }
});
btnSaveAs.addEventListener("click", async () => {
  try { await saveToFile({ saveAs: true }); } catch (e) { alert("Save cancelled or failed."); }
});

btnCloseModal.addEventListener("click", closeModal);
btnCancel.addEventListener("click", closeModal);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

btnApply.addEventListener("click", applyModal);
btnDelete.addEventListener("click", () => {
  if (!editingId) return;
  deleteTask(editingId);
  closeModal();
});

btnClearRange.addEventListener("click", () => {
  pickStart = null; pickEnd = null;
  updateRangeLabel();
  renderCalendar();
});

btnThisMonth.addEventListener("click", () => {
  const now = parseISO(todayISO());
  calCursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  renderCalendar();
});

calPrev.addEventListener("click", () => {
  calCursor = new Date(Date.UTC(calCursor.getUTCFullYear(), calCursor.getUTCMonth() - 1, 1));
  renderCalendar();
});
calNext.addEventListener("click", () => {
  calCursor = new Date(Date.UTC(calCursor.getUTCFullYear(), calCursor.getUTCMonth() + 1, 1));
  renderCalendar();
});

// ---------- Boot ----------
if (!loadAutosave()) seed();
renderAll();
