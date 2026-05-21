// ─────────────────────────────────────────────────────────────────────────────
// Final Project Frontend — app.js v2
// Vanilla JS, no framework. Mirrors lab4/app.js structure exactly.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:3004";

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const setText  = (id, t) => { const e=$(id); if(e) e.textContent = t; };
const setHtml  = (id, h) => { const e=$(id); if(e) e.innerHTML  = h; };
const show     = id => { const e=$(id); if(e) e.classList.remove("hidden"); };
const hide     = id => { const e=$(id); if(e) e.classList.add("hidden"); };

// ── Current session state ─────────────────────────────────────────────────────
let currentRole    = { roleLabel: "Patient", isAdmin: false, isDoctor: false, isNurse: false, canRegister: false, canViewAll: false };
let currentAddress = "";
let cachedAccounts = []; // populated by loadAccounts; shared with populateAddressSelects
let selectedPatientAddress = "";

// ── SHA-256 (browser-side, file never leaves) ─────────────────────────────────
async function computeFileHash(file) {
  const buf  = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return "0x" + Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,"0")).join("");
}

async function hashFileWithProgress(file, barId) {
  const bar = $(barId);
  if (bar) { bar.style.width = "30%"; await new Promise(r => setTimeout(r,80)); bar.style.width = "70%"; }
  const hash = await computeFileHash(file);
  if (bar) { bar.style.width = "100%"; setTimeout(() => { bar.style.width = "0%"; }, 600); }
  return hash;
}

// ── API helpers ────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res  = await fetch(API_BASE + path, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}
const apiGet  = path       => apiFetch(path);
const apiPost = (path, body) => apiFetch(path, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });

// ── Formatters ─────────────────────────────────────────────────────────────────
const fmt  = iso  => iso ? new Date(iso).toLocaleString() : "—";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const hiddenIdText = text => String(text || "").replace(/0x[a-fA-F0-9]{8,}/g, "[hidden blockchain id]");
const friendlyMessage = text => hiddenIdText(text).replace(/fileHash|newHash|previousHash/g, "record fingerprint");
const byAddress = address => cachedAccounts.find(a => a.address?.toLowerCase() === address?.toLowerCase()) || null;
const accountName = address => {
  if (!address || address === ZERO_ADDRESS) return "Unassigned";
  const a = byAddress(address);
  return a?.name || (a?.roleLabel ? `${a.roleLabel} account` : "Known account");
};
const accountDisplay = account => {
  if (!account) return "Known account";
  return account.name ? `${account.name} — ${account.roleLabel}` : account.roleLabel;
};
const patientDisplay = address => accountName(address);
const recordDisplay = (record, index) => {
  const cleanLabel = hiddenIdText(record?.label || "").trim();
  const title = cleanLabel && cleanLabel !== "[hidden blockchain id]" ? cleanLabel : "";
  return title ? `Record #${index + 1} — ${title}` : `Record #${index + 1}`;
};
const isPatientRole = role =>
  role?.roleLabel?.toLowerCase() === "patient" &&
  !role.isAdmin &&
  !role.isDoctor &&
  !role.isNurse &&
  !role.isHospital;

// ── Role UI ────────────────────────────────────────────────────────────────────
function applyRoleUI(role, address) {
  currentRole    = role;
  currentAddress = address;

  // Update badge
  const badge = $("roleBadge");
  if (badge) {
    const cls = role.roleLabel.toLowerCase();
    badge.className = `role-badge ${cls}`;
    badge.textContent = role.roleLabel;
  }

  // Capability pills
  const patientOnly = isPatientRole(role);
  const caps = [
    { label: "Register records",  ok: role.canRegister },
    { label: "Revoke own records",ok: role.canRegister },
    { label: "View all records",  ok: role.canViewAll  },
    { label: "Grant roles",       ok: role.isAdmin     },
    { label: "View own records",  ok: patientOnly      },
  ];
  setHtml("roleCaps", caps.map(c =>
    `<span class="cap-pill ${c.ok?"allowed":"denied"}">${c.label}</span>`
  ).join(""));

  // Show/hide panels by adding classes to shell
  const shell = $("mainShell");
  if (!shell) return;
  shell.classList.remove(
    "show-doctor-panels","show-staff-panels","show-patient-panel",
    "show-explorer-panel","show-nurse-panel"
  );
  if (role.canRegister)                    shell.classList.add("show-doctor-panels");
  if (role.canViewAll)                     shell.classList.add("show-staff-panels");
  // show-nurse-panel: pure nurses only (not doctors/admins who also canViewAll)
  if (role.isNurse && !role.canRegister)   shell.classList.add("show-nurse-panel");
  // Patient ownership panel: only patient accounts see their own assigned records.
  if (patientOnly)                         shell.classList.add("show-patient-panel");
  if (role.isAdmin)                        { shell.classList.add("show-explorer-panel"); loadExplorerBlocks(); }

  if (patientOnly) loadMyRecords(address);
}

// ── Render helpers ─────────────────────────────────────────────────────────────
function renderConceptCards(cards) {
  if (!cards?.length) return;
  setHtml("conceptCards", cards.map(c =>
    `<article class="card"><p class="mini-label">${c.title}</p><p>${c.detail}</p></article>`
  ).join(""));
}

function renderRuleList(rules) {
  if (!rules?.length) return;
  setHtml("ruleList", rules.map(r => `<li>${r}</li>`).join(""));
}

function renderHeroMetrics(health, registry) {
  if (health?.chainId)    setText("networkLabel", `Hardhat (chainId ${health.chainId})`);
  if (health?.blockNumber !== undefined) setText("blockLabel", `#${health.blockNumber}`);
  if (registry?.recordCount !== undefined) setText("recordCountLabel", registry.recordCount);
  if (registry?.contractAddress) {
    const el = $("contractLabel");
    if (el) { el.textContent = "Deployed"; el.removeAttribute("title"); }
  }
}

function renderRegistry(registry) {
  if (!registry) { setHtml("registryCard","<p class=\"muted\">Run the deployer first.</p>"); return; }
  setText("statTotal",   registry.recordCount);
  setText("statActive",  registry.activeCount);
  setText("statRevoked", registry.revokedCount);

  const sr = registry.sampleRecord;
  const sampleLabel = sr?.v2?.label || sr?.label || "Seeded sample record";
  setHtml("registryCard",
    `<div class="result-summary">
       <div><span class="mini-label">Contract</span><br><span>MedicalRecordIntegrity deployed</span></div>
       <div><span class="mini-label">Admin</span><br><span>${accountName(registry.admin)}</span></div>
       ${sampleLabel ? `<div class="sample-box"><p class="mini-label">Sample record (seeded — v2 latest)</p>
         <p>${hiddenIdText(sampleLabel)}</p></div>` : ""}
     </div>`
  );
}

function renderHistory(history) {
  if (!history?.length) { setHtml("historyList","<li class=\"history-item\"><p class=\"muted\">No records yet.</p></li>"); return; }
  setHtml("historyList", history.map(ev =>
    `<li class="history-item ${ev.type}">
       <div class="history-head">
         <span class="history-type ${ev.type}">${ev.type==="registered"?"✔ REGISTERED":"✖ REVOKED"}</span>
         <span class="small muted">${fmt(ev.timestampIso)}</span>
       </div>
       <p class="small"><strong>Label:</strong> ${hiddenIdText(ev.label || ev.reason || "—")}</p>

       <p class="small muted"><strong>Block</strong> #${ev.blockNumber} · <strong>Issuer</strong> ${accountName(ev.issuer)}</p>
     </li>`
  ).join(""));
}

function renderVerdict(record) {
  if (!record.exists) {
    setHtml("verifyResultCard",
      `<div class="result-summary">
         <div class="verdict-badge notfound">⚠ NOT FOUND</div>
         <p>No matching record was found. The file may have been modified or never registered.</p>
       </div>`);
    hide("versionChainDisplay");
    return;
  }
  const ok  = record.valid;
  const cls = ok ? "valid" : "invalid";
  const ic  = ok ? "✔" : "✖";
  const label = record.revoked ? "REVOKED" : (ok ? "VALID" : "INVALID");
  setHtml("verifyResultCard",
    `<div class="result-summary">
       <div class="verdict-badge ${cls}">${ic} ${label}</div>
       ${record.label     ? `<div><span class="mini-label">Label</span> ${hiddenIdText(record.label)}</div>` : ""}
       ${record.issuer    ? `<div><span class="mini-label">Issued by</span> ${accountName(record.issuer)}</div>` : ""}
       ${record.patientOwner && record.patientOwner !== ZERO_ADDRESS
          ? `<div><span class="mini-label">Patient</span> ${patientDisplay(record.patientOwner)}</div>` : ""}
       <div><span class="mini-label">Registered</span> ${fmt(record.issuedAtIso)}</div>
       ${record.revoked ? `<div><span class="mini-label" style="color:var(--danger)">Revoked</span> ${fmt(record.revokedAtIso)}</div>` : ""}
     </div>`);

  // Load and render version chain if this record has a predecessor
  if (record.previousVersionHash || record.exists) {
    loadAndRenderVersionChain(record.fileHash);
  }
}

async function loadAndRenderVersionChain(hash) {
  try {
    const { ok, data } = await apiGet(`/api/records/${hash}/versions`);
    if (!ok || !data.ok || data.versions.length <= 1) { hide("versionChainDisplay"); return; }

    const entries = data.versions.map((v, i) =>
      `<div class="version-entry ${i===0?"current":""} ${v.revoked?"revoked":""}">
         <span class="version-label">${hiddenIdText(v.label || "No label")}</span>
         <span class="small muted">${fmt(v.issuedAtIso)}</span>
         ${v.revoked ? '<span class="prc-status revoked">Revoked</span>' : (i===0?'<span class="prc-status valid">Latest</span>':'')}
       </div>
       ${i < data.versions.length-1 ? '<div class="version-arrow">↑ previous version</div>' : ""}`
    ).join("");

    setHtml("versionChainDisplay",
      `<p class="version-chain-title">Version history (${data.versionCount} entries, newest first)</p>
       <div class="version-track">${entries}</div>`
    );
    show("versionChainDisplay");
  } catch { hide("versionChainDisplay"); }
}

function renderRegisterResult(data) {
  setHtml("registerResultCard",
    `<div class="result-summary">
       <div class="verdict-badge valid">✔ REGISTERED</div>
       <div><span class="mini-label">Block</span> #${data.blockNumber}</div>
       <div><span class="mini-label">Label</span> ${hiddenIdText(data.record.label)}</div>
       <div><span class="mini-label">Issuer</span> ${accountName(currentAddress)}</div>
       <div><span class="mini-label">Registry total</span> ${data.registry?.recordCount} records</div>
     </div>`);
}

function renderVersionResult(data) {
  setHtml("versionResultCard",
    `<div class="result-summary">
       <div class="verdict-badge valid">✔ VERSION REGISTERED</div>
       <div><span class="mini-label">Label</span> ${hiddenIdText(data.record.label)}</div>
       <div><span class="mini-label">Block</span> #${data.blockNumber}</div>
     </div>`);
}

function renderRevokeResult(data) {
  setHtml("revokeResultCard",
    `<div class="result-summary">
       <div class="verdict-badge invalid">REVOKED</div>
       <div><span class="mini-label">Label</span> ${hiddenIdText(data.record.label)}</div>
       <div><span class="mini-label">Revoked at</span> ${fmt(data.record.revokedAtIso)}</div>
       <div><span class="mini-label">Block</span> #${data.blockNumber}</div>
     </div>`);
}

function renderPatientRecords(records, containerId) {
  if (!records?.length) {
    setHtml(containerId, `<p class="lookup-result-empty">No records found for this patient.</p>`);
    return;
  }
  setHtml(containerId, records.map(r => {
    const cls   = r.revoked ? "revoked" : (r.valid ? "valid" : "notfound");
    const stLbl = r.revoked ? "Revoked" : (r.valid ? "Valid"  : "Invalid");
    return `<div class="patient-record-card ${cls}">
      <span class="prc-status ${cls}">${stLbl}</span>
      <p class="prc-label">${hiddenIdText(r.label || "No label")}</p>
      <p class="prc-meta">Issued: ${fmt(r.issuedAtIso)}</p>
      <p class="prc-meta">Issuer: ${accountName(r.issuer)}</p>
      ${r.previousVersionHash
        ? `<span class="prc-version-link" onclick="showVersionChainFor('${r.fileHash}')">View version history →</span>`
        : ""}
    </div>`;
  }).join(""));
}

// Global helper called by inline onclick in patient record cards
window.showVersionChainFor = async function(hash) {
  const { ok, data } = await apiGet(`/api/records/${hash}/versions`);
  if (!ok || !data.ok) return;
  alert("Version chain:\n" +
    data.versions.map((v,i) => `${i+1}. ${hiddenIdText(v.label || "No label")} — ${fmt(v.issuedAtIso)}${v.revoked?" [REVOKED]":""}`).join("\n"));
};

// ── Flow diagram ───────────────────────────────────────────────────────────────
const FLOW_NODES = ["flowBrowser","flowHash","flowApi","flowContract","flowResult"];
function animateFlow() {
  FLOW_NODES.forEach(id => { const e=$(id); if(e) e.classList.remove("active","pulse"); });
  FLOW_NODES.forEach((id,i) => setTimeout(() => {
    const e=$(id); if(!e) return;
    e.classList.add("active","pulse");
    e.addEventListener("animationend", () => e.classList.remove("pulse"), {once:true});
  }, i*240));
  const c = $("flowBubbles"); if(!c) return;
  c.innerHTML = "";
  const b = document.createElement("div");
  b.className = "flow-bubble"; b.style.cssText = "left:2%;top:50%;opacity:0.9;";
  c.appendChild(b);
  setTimeout(() => { b.style.left="98%"; },80);
  setTimeout(() => { b.style.opacity="0"; },1200);
  setTimeout(() => b.remove(), 1600);
}

// ── Event log ──────────────────────────────────────────────────────────────────
function logEvent(msg, type="default") {
  const feed = $("eventFeed"); if(!feed) return;
  const item = document.createElement("li");
  item.className = "event-item";
  const dot = {ok:"ok",error:"error",register:"register",revoke:"revoke"}[type]||"";
  item.innerHTML = `<span class="event-dot ${dot}"></span><span class="event-time">${new Date().toLocaleTimeString()}</span><span>${msg}</span>`;
  feed.insertBefore(item, feed.firstChild);
  while (feed.children.length > 12) feed.removeChild(feed.lastChild);
}

// ── File-to-hash binder ────────────────────────────────────────────────────────
function bindHasher(fileInputId, displayId, buttonId, barId) {
  const fi = $(fileInputId); if(!fi) return;
  fi.addEventListener("change", async () => {
    const file = fi.files[0];
    const d = $(displayId);
    const status = $(displayId + "Status");
    if (!file) {
      if (d) d.value = "";
      if (status) status.textContent = "No file selected.";
      if ($(buttonId)) $(buttonId).disabled = true;
      return;
    }
    if (d) d.value = "Computing...";
    if (status) status.textContent = "Computing fingerprint...";
    if ($(buttonId)) $(buttonId).disabled = true;
    try {
      const h = await hashFileWithProgress(file, barId);
      if (d) d.value = h;
      if (status) status.textContent = "Fingerprint ready.";
      if ($(buttonId)) $(buttonId).disabled = false;
      logEvent(`SHA-256 computed for "${file.name}"`, "ok");
    } catch(e) {
      if (d) d.value = "";
      if (status) status.textContent = "Failed to compute fingerprint.";
      logEvent("Hash computation failed: " + e.message, "error");
    }
  });
}

// ── Account selector ───────────────────────────────────────────────────────────
async function loadAccounts() {
  try {
    const { ok, data } = await apiGet("/api/accounts");
    if (!ok || !data.ok) return;
    cachedAccounts = data.accounts;

    const selected = renderAccountSelect(data.accounts);
    if (selected) onAccountChange(selected);
    populateAddressSelects(data.accounts);
  } catch(e) { logEvent("Could not load accounts", "error"); }
}

// Builds an <option> string for a single account object.
function accountOption(a) {
  return `<option value="${a.address}">${accountDisplay(a)}</option>`;
}

function patientOption(a) {
  return `<option value="${a.address}">${a.name || "Patient"}</option>`;
}

function renderAccountSelect(accounts) {
  const sel = $("accountSelect"); if(!sel) return "";
  const preferred = sel.value || currentAddress || accounts[0]?.address || "";
  sel.innerHTML = accounts.map(accountOption).join("");
  if (preferred && accounts.some(a => a.address?.toLowerCase() === preferred.toLowerCase())) {
    sel.value = preferred;
  }
  if (!sel.value && accounts.length) sel.value = accounts[0].address;
  // Guard: attach the change listener ONLY ONCE across account refreshes.
  if (!sel.dataset.listenerAttached) {
    sel.addEventListener("change", () => onAccountChange(sel.value));
    sel.dataset.listenerAttached = "1";
  }
  return sel.value;
}

// Populates every address-picker <select> from the accounts array.
// Called after loadAccounts() and refreshAccounts() so dropdowns stay current.
function populateAddressSelects(accounts) {
  const patients    = accounts.filter(a => !a.isAdmin && !a.isDoctor && !a.isNurse);
  const nonAdmin    = accounts.filter(a => !a.isAdmin);

  // Patient pickers
  const registerBlank = `<option value="">None — no patient assigned</option>`;
  const patientOpts   = patients.map(patientOption).join("");
  const rps = $("registerPatientSelect"); if (rps) rps.innerHTML = registerBlank + patientOpts;
  const rvps = $("revokePatientSelect");
  if (rvps) {
    rvps.innerHTML = patients.length
      ? patients.map(patientOption).join("")
      : `<option value="">No patient accounts found</option>`;
    if (selectedPatientAddress) rvps.value = selectedPatientAddress;
  }

  // Patient lookup picker (doctor panel)
  const pls = $("patientLookupSelect");
  if (pls) {
    pls.innerHTML = patients.length
      ? patients.map(patientOption).join("")
      : `<option value="">No patient accounts found</option>`;
    if (!selectedPatientAddress && patients.length) setSelectedPatient(patients[0].address);
    if (selectedPatientAddress) pls.value = selectedPatientAddress;
  }

  // Nurse clinical viewer patient picker
  const nps = $("nursePatientSelect");
  if (nps) {
    nps.innerHTML = patients.length
      ? patients.map(patientOption).join("")
      : `<option value="">No patient accounts found</option>`;
  }

  // Role management pickers (non-admin accounts only)
  const roleBlank    = `<option value="">Select account…</option>`;
  const nonAdminOpts = nonAdmin.map(accountOption).join("");
  const nonAdminHas = value => value && nonAdmin.some(a => a.address?.toLowerCase() === value.toLowerCase());
  const gds = $("grantDoctorSelect");
  if (gds) {
    const previous = gds.value;
    gds.innerHTML = roleBlank + nonAdminOpts;
    if (nonAdminHas(previous)) gds.value = previous;
  }
  const gns = $("grantNurseSelect");
  if (gns) {
    const previous = gns.value;
    gns.innerHTML = roleBlank + nonAdminOpts;
    if (nonAdminHas(previous)) gns.value = previous;
  }
}

function setSelectedPatient(address) {
  selectedPatientAddress = address || "";
  const label = $("versionSelectedPatient");
  if (label) label.textContent = selectedPatientAddress
    ? patientDisplay(selectedPatientAddress)
    : "Select a patient in the patient lookup section.";
  const revokeLabel = $("revokeSelectedPatient");
  if (revokeLabel) revokeLabel.textContent = selectedPatientAddress
    ? patientDisplay(selectedPatientAddress)
    : "Select a patient in the patient lookup section.";
  const revokePatientSelect = $("revokePatientSelect");
  if (revokePatientSelect && selectedPatientAddress) revokePatientSelect.value = selectedPatientAddress;
  const patientLookupSelect = $("patientLookupSelect");
  if (patientLookupSelect && selectedPatientAddress) patientLookupSelect.value = selectedPatientAddress;
  loadVersionRecordsForPatient(selectedPatientAddress);
}

async function loadVersionRecordsForPatient(address) {
  const select = $("versionRecordSelect");
  const revokeSelect = $("revokeRecordSelect");
  const revokeButton = $("revokeButton");
  const hint   = $("versionRecordHint");
  if (!select && !revokeSelect) return;

  if (select) {
    select.innerHTML = `<option value="">Select a patient first</option>`;
    select.disabled = true;
  }
  if (revokeSelect) {
    revokeSelect.innerHTML = `<option value="">Select a patient first</option>`;
    revokeSelect.disabled = true;
  }
  if (revokeButton) revokeButton.disabled = true;
  if (hint) hint.textContent = "Choose a patient in the patient lookup section to load records.";
  if (!address) return;
  if (!currentAddress) {
    if (hint) hint.textContent = "Select an active account before loading patient records.";
    return;
  }

  if (hint) hint.textContent = "Loading records for selected patient…";
  try {
    const { ok, data } = await apiGet(`/api/patients/${address}/records?caller=${currentAddress}`);
    if (!ok || !data.ok || !data.records?.length) {
      if (select) select.innerHTML = `<option value="">No records available</option>`;
      if (revokeSelect) revokeSelect.innerHTML = `<option value="">No records available</option>`;
      if (hint) hint.textContent = friendlyMessage(data.message || "No records found for this patient.");
      return;
    }

    if (select) {
      select.disabled = false;
      select.innerHTML = `<option value="">Select a previous record</option>` +
        data.records.map((r, i) =>
          `<option value="${r.fileHash}">${recordDisplay(r, i)}${r.revoked?" (revoked)":""}</option>`
        ).join("");
    }
    if (revokeSelect) {
      const active = data.records.filter(r => !r.revoked);
      revokeSelect.disabled = active.length === 0;
      revokeSelect.innerHTML = active.length
        ? `<option value="">Select a record to revoke</option>` +
          active.map((r, i) => `<option value="${r.fileHash}">${recordDisplay(r, i)}</option>`).join("")
        : `<option value="">No active records available</option>`;
      if (revokeButton) revokeButton.disabled = active.length === 0;
    }
    if (hint) hint.textContent = "Choose the record to version.";
  } catch (e) {
    if (select) select.innerHTML = `<option value="">Failed to load records</option>`;
    if (revokeSelect) revokeSelect.innerHTML = `<option value="">Failed to load records</option>`;
    if (hint) hint.textContent = "Unable to load patient records.";
  }
}

async function onAccountChange(address) {
  if (!address) return;
  try {
    const { ok, data } = await apiGet(`/api/roles/check?address=${address}`);
    if (ok && data.ok) {
      applyRoleUI(data.role, address);
      if (selectedPatientAddress) loadVersionRecordsForPatient(selectedPatientAddress);
      logEvent(`Switched to ${accountName(address)} (${data.role.roleLabel})`, "ok");
    }
  } catch(e) { logEvent("Role check failed", "error"); }
}

// ── Patient records ────────────────────────────────────────────────────────────
async function loadMyRecords(address) {
  if (!address) return;
  try {
    const { ok, data } = await apiGet(`/api/patients/me/records?caller=${address}`);
    if (ok && data.ok) renderPatientRecords(data.records, "myRecordsGrid");
  } catch { /* silent */ }
}

// ── Role safety guard ──────────────────────────────────────────────────────────
// Re-validates currentAddress against the blockchain before any write action.
// Returns true if the caller is authorised to register/version; false otherwise.
// This ensures that even if the frontend state drifts, the blockchain is the
// authoritative source of truth — consistent with API-side buildRoleInfo().
async function guardCanRegister(statusId) {
  if (!currentAddress) {
    if (statusId) setText(statusId, "No account selected.");
    return false;
  }
  try {
    const { ok, data } = await apiGet(`/api/roles/check?address=${currentAddress}`);
    if (!ok || !data.ok) { if (statusId) setText(statusId, "Role check failed."); return false; }
    // Sync local state with blockchain truth
    applyRoleUI(data.role, currentAddress);
    if (!data.role.canRegister) {
      if (statusId) setText(statusId,
        `${data.role.roleLabel} cannot register records. Switch to a Doctor or Admin account.`);
      return false;
    }
    return true;
  } catch {
    if (statusId) setText(statusId, "Network error during role check.");
    return false;
  }
}

// ── Register form ──────────────────────────────────────────────────────────────────────────────
function setupRegisterForm() {
  bindHasher("registerFileInput","registerHashDisplay","registerButton","registerHashBar");
  const form = $("registerForm"); if(!form) return;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fileHash     = $("registerHashDisplay")?.value?.trim();
    const label        = $("registerLabelInput")?.value?.trim();
    const patientOwner = $("registerPatientSelect")?.value || undefined;
    if (!fileHash || fileHash==="Computing...") { setText("registerStatus","Wait for hash."); return; }

    // Pre-flight: re-check role from blockchain before submitting
    const allowed = await guardCanRegister("registerStatus");
    if (!allowed) return;

    setText("registerStatus","Sending to blockchain..."); $("registerButton").disabled=true; hide("registerNotice");
    try {
      const { ok, data } = await apiPost("/api/records/register",
        { caller: currentAddress, fileHash, label, patientOwner });
      if (ok && data.ok) {
        renderRegisterResult(data);
        setText("registerStatus","");
        logEvent(`Registered ${hiddenIdText(label || "record")} (block #${data.blockNumber})`, "register");
        animateFlow(); refreshRegistry(); refreshHistory();
        if (currentAddress) loadMyRecords(currentAddress);
      } else {
        setText("registerStatus", friendlyMessage(data.message||"Failed."));
        const n=$("registerNotice"); if(n){ n.textContent=friendlyMessage(data.message||"Failed."); show("registerNotice"); }
        logEvent("Register failed: "+friendlyMessage(data.message||"unknown"), "error");
      }
    } catch(err) { setText("registerStatus","Network error: "+err.message); }
    finally { $("registerButton").disabled=false; }
  });
}

// ── Version form ───────────────────────────────────────────────────────────────
function setupVersionForm() {
  bindHasher("versionFileInput","versionNewHashDisplay","versionButton","versionHashBar");
  const form = $("versionForm"); if(!form) return;

  $("versionRecordSelect")?.addEventListener("change", () => {
    const hint = $("versionRecordHint");
    const selected = $("versionRecordSelect")?.value;
    if (hint) hint.textContent = selected
      ? "Selected existing record to update."
      : "Choose a previous record.";
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const newHash      = $("versionNewHashDisplay")?.value?.trim();
    const previousHash = $("versionRecordSelect")?.value;
    const label        = $("versionLabel")?.value?.trim();
    const patientOwner = selectedPatientAddress || undefined;
    if (!newHash||newHash==="Computing...") { setText("versionStatus","Wait for fingerprint."); return; }
    if (!patientOwner) { setText("versionStatus","Select a patient in the patient lookup section."); return; }
    if (!previousHash) { setText("versionStatus","Select a record to version."); return; }
    if (!label) { setText("versionStatus","Version label is required."); return; }

    // Pre-flight: re-check role from blockchain before submitting
    const allowed = await guardCanRegister("versionStatus");
    if (!allowed) return;

    setText("versionStatus","Registering version..."); $("versionButton").disabled=true;
    try {
      const { ok, data } = await apiPost("/api/records/version",
        { caller: currentAddress, newHash, previousHash, label, patientOwner });
      if (ok && data.ok) {
        renderVersionResult(data);
        setText("versionStatus","Version registered successfully.");
        logEvent(`Version registered for ${patientDisplay(patientOwner)}`, "register");
        animateFlow(); refreshRegistry(); refreshHistory();
        loadVersionRecordsForPatient(patientOwner);
        if (currentAddress) loadMyRecords(currentAddress);
      } else {
        setText("versionStatus", friendlyMessage(data.message||"Failed."));
        logEvent("Version failed: "+friendlyMessage(data.message||"unknown"), "error");
      }
    } catch(err) { setText("versionStatus","Network error: "+err.message); }
    finally { $("versionButton").disabled=false; }
  });
}

// ── Verify form ────────────────────────────────────────────────────────────────
function setupRevokeForm() {
  const form = $("revokeForm"); if(!form) return;
  $("revokePatientSelect")?.addEventListener("change", () => {
    setSelectedPatient($("revokePatientSelect")?.value || "");
  });
  $("revokeRecordSelect")?.addEventListener("change", () => {
    const btn = $("revokeButton");
    if (btn) btn.disabled = !$("revokeRecordSelect")?.value;
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fileHash = $("revokeRecordSelect")?.value;
    const reason = $("revokeReasonInput")?.value?.trim();
    if (!fileHash) { setText("revokeStatus", "Select a record to revoke."); return; }
    if (!reason) { setText("revokeStatus", "Revocation reason is required."); return; }

    const allowed = await guardCanRegister("revokeStatus");
    if (!allowed) return;

    setText("revokeStatus", "Revoking record...");
    $("revokeButton").disabled = true;
    try {
      const { ok, data } = await apiPost("/api/records/revoke", { caller: currentAddress, fileHash, reason });
      if (ok && data.ok) {
        renderRevokeResult(data);
        setText("revokeStatus", "Record revoked.");
        logEvent("Record revoked", "revoke");
        animateFlow(); refreshRegistry(); refreshHistory();
        loadVersionRecordsForPatient(selectedPatientAddress);
        if (currentAddress) loadMyRecords(currentAddress);
      } else {
        setText("revokeStatus", friendlyMessage(data.message || "Failed."));
        logEvent("Revoke failed: " + friendlyMessage(data.message || "unknown"), "error");
      }
    } catch(err) {
      setText("revokeStatus", "Network error: " + err.message);
    } finally {
      $("revokeButton").disabled = !$("revokeRecordSelect")?.value;
    }
  });
}

function setupVerifyForm() {
  bindHasher("verifyFileInput","verifyHashDisplay",null,"verifyHashBar");

  $("sampleHashButton")?.addEventListener("click", async () => {
    try {
      const { ok, data } = await apiGet("/api/registry");
      if (ok && data.ok) {
        const h = data.registry?.sampleRecord?.v2?.fileHash || data.registry?.sampleRecord?.fileHash || "";
        if (h) {
          $("verifyHashDisplay").value = h;
          const status = $("verifyHashDisplayStatus");
          if (status) status.textContent = "Sample fingerprint loaded privately.";
          logEvent("Loaded sample record fingerprint","ok");
        }
      }
    } catch { logEvent("Could not fetch sample hash","error"); }
  });

  const form = $("verifyForm"); if(!form) return;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const manual = $("verifyManualHash")?.value?.trim();
    const file   = $("verifyHashDisplay")?.value?.trim();
    const hash   = manual || file;
    if (!hash||hash.length<10) { setText("verifyStatus","Enter or compute a record fingerprint."); return; }
    setText("verifyStatus","Checking blockchain..."); $("verifyButton").disabled=true;
    try {
      const { ok, data } = await apiPost("/api/records/verify", { fileHash: hash });
      if (ok && data.ok) {
        renderVerdict(data.record);
        setText("verifyStatus","");
        const v = data.record.exists ? (data.record.valid?"VALID":"INVALID") : "NOT FOUND";
        logEvent(`Verification result: ${v}`, v==="VALID"?"ok":"error");
        animateFlow();
      } else {
        setText("verifyStatus", friendlyMessage(data.message||"Failed."));
      }
    } catch(err) { setText("verifyStatus","Network error: "+err.message); }
    finally { $("verifyButton").disabled=false; }
  });
}

// ── Patient lookup (doctor panel) ──────────────────────────────────────────────
function setupPatientLookup() {
  $("patientLookupSelect")?.addEventListener("change", () => {
    setSelectedPatient($("patientLookupSelect")?.value || "");
  });

  $("patientLookupButton")?.addEventListener("click", async () => {
    const address = $("patientLookupSelect")?.value;
    if (!address) { setHtml("patientLookupResult",`<p class="lookup-result-empty">Select a patient from the dropdown.</p>`); return; }
    setHtml("patientLookupResult","<p class=\"lookup-result-empty\">Loading...</p>");
    try {
      const { ok, data } = await apiGet(`/api/patients/${address}/records?caller=${currentAddress}`);
      if (ok && data.ok) renderPatientRecords(data.records, "patientLookupResult");
      else setHtml("patientLookupResult",`<p class="lookup-result-empty">${friendlyMessage(data.message)}</p>`);
    } catch(e) { setHtml("patientLookupResult",`<p class="lookup-result-empty">Network error.</p>`); }
  });
}

// ── Nurse: clinical patient record viewer ──────────────────────────────────────
// Distinct from the patient "My records" panel (which filters by wallet ownership).
// Nurses select any patient from the dropdown; records fetched from API read-only.
function setupNursePatientViewer() {
  $("nurseLoadRecordsBtn")?.addEventListener("click", async () => {
    const address = $("nursePatientSelect")?.value;
    if (!address) {
      setHtml("nursePatientRecords",
        `<p class="lookup-result-empty">Select a patient from the dropdown first.</p>`);
      return;
    }
    setHtml("nursePatientRecords", `<p class="lookup-result-empty">Loading…</p>`);
    try {
      const { ok, data } = await apiGet(`/api/patients/${address}/records?caller=${currentAddress}`);
      if (ok && data.ok) renderPatientRecords(data.records, "nursePatientRecords");
      else setHtml("nursePatientRecords",
        `<p class="lookup-result-empty">${friendlyMessage(data.message || "No records found.")}</p>`);
    } catch {
      setHtml("nursePatientRecords", `<p class="lookup-result-empty">Network error.</p>`);
    }
  });
}

// ── Role management buttons ────────────────────────────────────────────────────
// guardIsAdmin() re-validates currentAddress as Admin from the blockchain.
// Called before every role grant/revoke to prevent UI-bypass attacks.
async function guardIsAdmin(statusId) {
  if (!currentAddress) { if (statusId) setText(statusId, "No account selected."); return false; }
  try {
    const { ok, data } = await apiGet(`/api/roles/check?address=${currentAddress}`);
    if (!ok || !data.ok) { if (statusId) setText(statusId, "Role check failed."); return false; }
    applyRoleUI(data.role, currentAddress);   // sync UI with blockchain truth
    if (!data.role.isAdmin) {
      if (statusId) setText(statusId, "Only Admin can manage roles.");
      return false;
    }
    return true;
  } catch { if (statusId) setText(statusId, "Network error during role check."); return false; }
}

function setupRoleManagement() {
  const roleButtons = [
    "grantDoctorBtn", "revokeDoctorBtn", "grantNurseBtn", "revokeNurseBtn"
  ];
  const setRoleButtonsDisabled = disabled => {
    roleButtons.forEach(id => {
      const btn = $(id);
      if (btn) btn.disabled = disabled;
    });
  };

  async function doRole({ inputId, statusId, endpoint, roleName, action }) {
    const address = $(inputId)?.value;
    if (!address) { setText(statusId, "Select an account first."); return; }
    const targetLabel = accountName(address);

    // Pre-flight: re-check Admin role from blockchain before submitting.
    // This ensures even a DevTools-triggered click cannot bypass RBAC.
    const allowed = await guardIsAdmin(statusId);
    if (!allowed) return;

    setText(statusId, `${action === "grant" ? "Granting" : "Revoking"} ${roleName} role for ${targetLabel}...`);
    setRoleButtonsDisabled(true);
    try {
      const { ok, data } = await apiPost(endpoint, { caller: currentAddress, address });
      if (ok && data.ok) {
        const responseRole = data.roleName || roleName;
        const responseAction = data.action || (action === "grant" ? "granted" : "revoked");
        const responseTarget = data.targetLabel || targetLabel;
        const preposition = responseAction === "revoked" ? "from" : "to";
        setText(statusId, `${responseRole} role ${responseAction} ${preposition} ${responseTarget}.`);
        logEvent(`${responseRole} role ${responseAction} ${preposition} ${responseTarget}`, "ok");
        await refreshAccounts();
      } else if (statusId) {
        const message = data?.message || "Role change failed.";
        setText(statusId, ok ? friendlyMessage(message) : (data?.message === "Only Admin can manage roles." ? data.message : friendlyMessage(message)));
      }
    } catch(e) {
      setText(statusId, "Role change failed: network error.");
    } finally {
      setRoleButtonsDisabled(false);
    }
  }

  $("grantDoctorBtn")?.addEventListener("click", () => doRole({
    inputId: "grantDoctorSelect", statusId: "doctorRoleStatus",
    endpoint: "/api/roles/doctor/grant", roleName: "Doctor", action: "grant"
  }));
  $("revokeDoctorBtn")?.addEventListener("click", () => doRole({
    inputId: "grantDoctorSelect", statusId: "doctorRoleStatus",
    endpoint: "/api/roles/doctor/revoke", roleName: "Doctor", action: "revoke"
  }));
  $("grantNurseBtn")?.addEventListener("click", () => doRole({
    inputId: "grantNurseSelect", statusId: "nurseRoleStatus",
    endpoint: "/api/roles/nurse/grant", roleName: "Nurse", action: "grant"
  }));
  $("revokeNurseBtn")?.addEventListener("click", () => doRole({
    inputId: "grantNurseSelect", statusId: "nurseRoleStatus",
    endpoint: "/api/roles/nurse/revoke", roleName: "Nurse", action: "revoke"
  }));
}

// ── Refresh helpers ────────────────────────────────────────────────────────────
async function refreshHealth() {
  try {
    const { ok, data } = await apiGet("/api/health");
    const badge = $("healthBadge"); if(!badge) return;
    if (ok && data.ok) {
      badge.textContent = `Chain OK — block #${data.blockNumber}`;
      badge.className   = "status ok";
      renderHeroMetrics(data, null);
    } else { badge.textContent="Chain unreachable"; badge.className="status error"; }
  } catch { const b=$("healthBadge"); if(b){ b.textContent="API unreachable"; b.className="status error"; } }
}

async function refreshRegistry() {
  try {
    const { ok, data } = await apiGet("/api/registry");
    if (ok && data.ok) {
      renderRegistry(data.registry);
      renderHeroMetrics(null, data.registry);
      hide("registryNotice");
    } else {
      const n=$("registryNotice"); if(n){ n.textContent=friendlyMessage(data.message||"Not ready."); show("registryNotice"); }
    }
  } catch { const n=$("registryNotice"); if(n){ n.textContent="Cannot reach API."; show("registryNotice"); } }
}

async function refreshHistory() {
  try {
    const { ok, data } = await apiGet("/api/records/history");
    if (ok && data.ok) renderHistory(data.history);
  } catch { /* silent */ }
}

async function refreshAccounts() {
  const { ok, data } = await apiGet("/api/accounts").catch(() => ({ ok: false }));
  if (ok && data.ok) {
    cachedAccounts = data.accounts;
    const selected = renderAccountSelect(data.accounts);
    populateAddressSelects(data.accounts);
    // Refresh the role badge and panels while keeping the current caller selected.
    if (selected) await onAccountChange(selected);
  }
}

// ── Blockchain Explorer (admin-only) ──────────────────────────────────────────

// State: track what the explorer is showing
const explorerState = { view: "list", currentBlock: null, currentTx: null };

function explorerBreadcrumb(parts) {
  // parts: [{label, onClick}] — last item is the current page
  const el = $("explorerBreadcrumb"); if(!el) return;
  el.innerHTML = parts.map((p, i) => {
    if (i === parts.length - 1) return `<span class="current">${p.label}</span>`;
    return `<span class="crumb" onclick="${p.onclick}">${p.label}</span><span class="sep">›</span>`;
  }).join("");
}

async function loadExplorerBlocks() {
  const listEl = $("explorerBlockList"); if(!listEl) return;
  hide("explorerBlockDetail"); hide("explorerTxDetail");
  explorerBreadcrumb([{label:"Latest blocks"}]);
  listEl.innerHTML = `<p class="muted small">Loading...</p>`;

  try {
    const { ok, data } = await apiGet(`/api/chain/blocks?limit=15&caller=${currentAddress}`);
    if (!ok || !data.ok) {
      listEl.innerHTML = `<p class="muted small">${friendlyMessage(data.message || "Could not load blocks.")}</p>`; return;
    }
    const rows = data.blocks.map(b =>
      `<tr onclick="loadExplorerBlock(${b.blockNumber})">
         <td class="block-num">#${b.blockNumber}</td>
         <td><span class="tx-count-badge">${b.transactionCount} tx</span></td>
         <td class="small muted">${fmt(b.timestampIso)}</td>
         <td class="small muted">${Number(b.gasUsed).toLocaleString()}</td>
       </tr>`
    ).join("");
    listEl.innerHTML = `
      <table class="explorer-table">
        <thead><tr>
          <th>Block</th><th>Transactions</th><th>Time</th><th>Gas used</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch(e) {
    listEl.innerHTML = `<p class="muted small">Network error loading blocks.</p>`;
  }
}
window.loadExplorerBlock = loadExplorerBlock;

async function loadExplorerBlock(blockNumber) {
  const detailEl = $("explorerBlockDetail"); if(!detailEl) return;
  hide("explorerTxDetail"); show("explorerBlockDetail");
  explorerBreadcrumb([
    {label:"Latest blocks", onclick:"loadExplorerBlocks()"},
    {label:`Block #${blockNumber}`}
  ]);
  detailEl.innerHTML = `<p class="muted small">Loading block #${blockNumber}...</p>`;

  try {
    const { ok, data } = await apiGet(`/api/chain/blocks/${blockNumber}?caller=${currentAddress}`);
    if (!ok || !data.ok) { detailEl.innerHTML = `<p class="muted small">${friendlyMessage(data.message)}</p>`; return; }
    const b = data.block;

    const txListHtml = b.transactions.length
      ? `<p class="mini-label" style="margin:12px 0 6px">Transactions (${b.transactionCount})</p>
         <ul class="tx-hash-list">${b.transactions.map((h, i) =>
           `<li class="tx-hash-item" onclick="loadExplorerTx('${h}',${blockNumber})">
              <span class="tx-icon">⬡</span>
              <span class="tx-hash-text">Transaction #${i + 1}</span>
              <span class="tx-click-hint">View →</span>
            </li>`
         ).join("")}</ul>`
      : `<p class="muted small" style="margin-top:10px">No transactions in this block.</p>`;

    const parentLink = blockNumber > 0
      ? `<div class="chain-link-arrow">Links to parent: <span class="crumb" onclick="loadExplorerBlock(${blockNumber-1})">#${blockNumber-1}</span></div>`
      : "";

    detailEl.innerHTML = `
      <div class="block-detail-card">
        <p class="block-detail-title">Block #${b.blockNumber}</p>
        <div class="block-detail-grid">
          <div class="block-field"><span class="field-label">Chain position</span><span class="field-value">Block #${b.blockNumber}</span></div>
          <div class="block-field"><span class="field-label">Parent block</span><span class="field-value">${blockNumber > 0 ? `#${blockNumber - 1}` : "Genesis"}</span></div>
          <div class="block-field"><span class="field-label">Timestamp</span><span class="field-value">${fmt(b.timestampIso)}</span></div>
          <div class="block-field"><span class="field-label">Producer</span><span class="field-value">${accountName(b.miner)}</span></div>
          <div class="block-field"><span class="field-label">Gas used</span><span class="field-value">${Number(b.gasUsed).toLocaleString()}</span></div>
          <div class="block-field"><span class="field-label">Gas limit</span><span class="field-value">${Number(b.gasLimit).toLocaleString()}</span></div>
          <div class="block-field"><span class="field-label">Transactions</span><span class="field-value">${b.transactionCount}</span></div>
          <div class="block-field"><span class="field-label">Difficulty</span><span class="field-value">${b.difficulty}</span></div>
        </div>
        ${parentLink}
        ${txListHtml}
      </div>
      <div class="edu-note">Each block points back to its parent block, forming an immutable ordered chain without exposing raw identifiers in this UI.</div>`;
  } catch(e) {
    detailEl.innerHTML = `<p class="muted small">Error loading block.</p>`;
  }
}
window.loadExplorerBlocks = loadExplorerBlocks;

async function loadExplorerTx(txHash, fromBlock) {
  const txEl = $("explorerTxDetail"); if(!txEl) return;
  show("explorerTxDetail");
  explorerBreadcrumb([
    {label:"Latest blocks",  onclick:"loadExplorerBlocks()"},
    {label:`Block #${fromBlock}`, onclick:`loadExplorerBlock(${fromBlock})`},
    {label:"Transaction"}
  ]);
  txEl.innerHTML = `<p class="muted small">Loading transaction...</p>`;

  try {
    const { ok, data } = await apiGet(`/api/chain/tx/${txHash}?caller=${currentAddress}`);
    if (!ok || !data.ok) { txEl.innerHTML = `<p class="muted small">${friendlyMessage(data.message)}</p>`; return; }
    const t = data.tx;
    const statusCls = t.status || "pending";
    const statusIcon = t.status === "success" ? "✔" : t.status === "reverted" ? "✖" : "⏳";

    txEl.innerHTML = `
      <div class="tx-detail-card">
        <p class="tx-detail-title">Transaction</p>
        <span class="tx-status-badge ${statusCls}">${statusIcon} ${(t.status||"pending").toUpperCase()}</span>
        <div class="block-detail-grid" style="margin-top:14px">
          <div class="block-field"><span class="field-label">Transaction</span><span class="field-value">Selected transaction</span></div>
          <div class="block-field"><span class="field-label">From</span><span class="field-value">${accountName(t.from)}</span></div>
          <div class="block-field"><span class="field-label">To</span><span class="field-value">${t.to ? "Smart contract" : "Contract creation"}</span></div>
          <div class="block-field"><span class="field-label">Value</span><span class="field-value">${t.value}</span></div>
          <div class="block-field"><span class="field-label">Gas limit</span><span class="field-value">${Number(t.gas).toLocaleString()}</span></div>
          <div class="block-field"><span class="field-label">Gas used</span><span class="field-value">${t.gasUsed ? Number(t.gasUsed).toLocaleString() : "—"}</span></div>
          <div class="block-field"><span class="field-label">Gas price</span><span class="field-value">${t.gasPrice||"—"}</span></div>
          <div class="block-field"><span class="field-label">Block</span><span class="field-value"><span class="crumb" onclick="loadExplorerBlock(${t.blockNumber})">#${t.blockNumber}</span></span></div>
          <div class="block-field"><span class="field-label">Input data</span><span class="field-value">${t.dataLength} bytes (hidden)</span></div>
        </div>
      </div>
      <div class="edu-note">Transactions are immutable once mined. The sender signed this action, and the encoded call data remains hidden in the UI.</div>`;
  } catch(e) {
    txEl.innerHTML = `<p class="muted small">Error loading transaction.</p>`;
  }
}
window.loadExplorerTx = loadExplorerTx;

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const { ok, data } = await apiGet("/api/foundation");
    if (ok && data.ok) { renderConceptCards(data.cards); renderRuleList(data.rules); }
  } catch { /* non-critical */ }

  await refreshHealth();
  await refreshRegistry();
  await refreshHistory();
  await loadAccounts();

  setupRegisterForm();
  setupVersionForm();
  setupRevokeForm();
  setupVerifyForm();
  setupPatientLookup();
  setupNursePatientViewer();
  setupRoleManagement();

  $("refreshButton")?.addEventListener("click", () => {
    refreshHealth(); refreshRegistry(); refreshHistory();
  });

  // Explorer refresh button (only matters when admin is selected)
  $("explorerRefreshBtn")?.addEventListener("click", () => loadExplorerBlocks());

  setInterval(() => { refreshHealth(); refreshRegistry(); refreshHistory(); }, 10_000);
  logEvent("Application v2 initialized", "ok");
}

document.addEventListener("DOMContentLoaded", init);
