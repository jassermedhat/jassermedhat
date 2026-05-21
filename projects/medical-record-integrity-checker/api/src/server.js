import express from "express";
import cors    from "cors";
import fs      from "node:fs";
import path    from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

// -----------------------------------------------------------------------------
// Final Project API — v2 (Bonus Expansion)
// -----------------------------------------------------------------------------
// All v1 endpoints are preserved exactly. New endpoints added below them.
//
// NEW endpoints:
//   GET  /api/roles/check?address=0x...          — role label + flags for any address
//   GET  /api/accounts                           — all Hardhat accounts with role labels
//   POST /api/roles/doctor/grant                 — admin grants doctor role
//   POST /api/roles/doctor/revoke                — admin revokes doctor role
//   POST /api/roles/nurse/grant                  — admin grants nurse role
//   POST /api/roles/nurse/revoke                 — admin revokes nurse role
//   GET  /api/patients/me/records?caller=0x...   — caller's own records
//   GET  /api/patients/:address/records?caller=0x... — same patient or staff lookup
//   POST /api/records/version                    — register a linked version
//   GET  /api/records/:hash/versions             — version chain newest→oldest
//
// CHANGED behaviour:
//   GET /api/records/:hash now also returns previousVersionHash.
//
// Privacy boundary unchanged:
//   No medical files reach this API. Only SHA-256 hashes are handled.
// -----------------------------------------------------------------------------

const app     = express();
const port    = Number(process.env.PORT    || 3004);
const rpcUrl  = process.env.RPC_URL        || "http://127.0.0.1:8545";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const labRoot = process.env.LAB_ROOT       || projectRoot;

const defaultAccountNames = [
  "Admin Alice",
  "Dr. Bob",
  "Carol",
  "Dave",
  "Emma",
  "Frank"
];

app.use(cors());
app.use(express.json());

// ── Static content ────────────────────────────────────────────────────────────

const conceptCards = [
  { title: "File Hash (SHA-256)",
    detail: "The browser computes a SHA-256 fingerprint locally. Only the 32-byte hash is sent to the blockchain. The actual medical file stays off-chain." },
  { title: "Immutable Proof",
    detail: "Once registered, the hash cannot be altered. Any modification to the file produces a completely different hash, making tampering instantly detectable." },
  { title: "Issuer Identity",
    detail: "The registering address (doctor or admin) is stored alongside the hash, proving who created the integrity proof and when." },
  { title: "Revocation",
    detail: "A record can be revoked by its original issuer or admin. The proof remains on-chain, but verification returns INVALID with a timestamp." },
  { title: "Version Chains",
    detail: "Updated files are registered as new hashes linked to their predecessor. The full history remains immutable — nothing is deleted." },
  { title: "Patient Ownership",
    detail: "Records can be assigned to a patient's wallet. Patients can view all their own records. Doctors and nurses can look up any patient's history." }
];

const systemRules = [
  "The browser computes the SHA-256 hash before sending anything to the API.",
  "Only the hash, a label, and an optional patient address are stored on-chain.",
  "Medical files remain off-chain at all times.",
  "Anyone can verify a hash without signing a transaction.",
  "Only doctors and admins can register or create new record versions.",
  "Only the original issuer or admin can revoke a record.",
  "Nurses can view all records but cannot write anything.",
  "Patients can view only records where their address is the patientOwner.",
  "Version chains are immutable: previous versions are never deleted."
];

// ── File system helpers ───────────────────────────────────────────────────────

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getDeployment() {
  return readJson(path.join(labRoot, "blockchain", "deployments", "localhost.json"));
}

function getDeploymentEntities(deployment) {
  if (!deployment?.entities) return [];
  return deployment.entities.map(e => ({
    ...e,
    address: typeof e.address === "string" ? e.address.toLowerCase() : e.address
  }));
}

function getEntityByAddress(deployment, address) {
  if (!deployment || !address) return null;
  const lookup = address.toLowerCase();
  return getDeploymentEntities(deployment).find(e => e.address === lookup) || null;
}

function getPatientEntities(deployment) {
  return getDeploymentEntities(deployment).filter(e => e.role === "Patient");
}

function getContractArtifact() {
  return readJson(path.join(labRoot, "blockchain", "artifacts", "contracts",
    "MedicalRecordIntegrity.sol", "MedicalRecordIntegrity.json"));
}

// ── Chain helpers ─────────────────────────────────────────────────────────────

function buildProvider() {
  return new ethers.JsonRpcProvider(rpcUrl);
}

function normalizeError(error) {
  return error?.shortMessage || error?.info?.error?.message || error?.reason || error?.message || "Unknown error.";
}

async function getFreshBlockNumber(provider) {
  const hex = await provider.send("eth_blockNumber", []);
  return Number(BigInt(hex));
}

// ── Contract loader ───────────────────────────────────────────────────────────

async function getContract(withSigner = false, signerAddress = null) {
  const deployment = getDeployment();
  const artifact   = getContractArtifact();

  if (!deployment || !artifact || !deployment.contracts?.MedicalRecordIntegrity) {
    return { ok: false, status: 404,
      message: "Contract not deployed. Run: docker compose run --rm final-deployer" };
  }

  const addr = deployment.contracts.MedicalRecordIntegrity;
  if (!ethers.isAddress(addr)) {
    return { ok: false, status: 500, message: "Deployment file is invalid. Re-run the deployer." };
  }

  const provider = buildProvider();
  const code     = await provider.getCode(addr);
  if (!code || code === "0x") {
    return { ok: false, status: 409,
      message: "Contract not on chain. Run: docker compose run --rm final-deployer" };
  }

  if (!withSigner) {
    return { ok: true, provider, deployment,
      contract: new ethers.Contract(addr, artifact.abi, provider) };
  }

  const checkedSigner = requireAddress(signerAddress, "caller");
  if (!checkedSigner.ok) {
    return { ok: false, status: checkedSigner.status, message: checkedSigner.message };
  }

  const signer = await provider.getSigner(checkedSigner.address);
  return { ok: true, provider, deployment, signer,
    contract: new ethers.Contract(addr, artifact.abi, signer) };
}

// ── Data builders ─────────────────────────────────────────────────────────────

async function getRegistrySummary(contract, deployment) {
  const [admin, recordCount, revokedCount] = await Promise.all([
    contract.admin(), contract.recordCount(), contract.revokedCount()
  ]);
  return {
    contractAddress: deployment.contracts.MedicalRecordIntegrity,
    admin,
    recordCount:  Number(recordCount),
    revokedCount: Number(revokedCount),
    activeCount:  Number(recordCount) - Number(revokedCount),
    sampleRecord: deployment.sampleRecord || null
  };
}

// Build full record details from verifyRecord + getRecord.
// Returns previousVersionHash so the frontend can render version chains.
async function getRecordDetails(contract, fileHash) {
  const v = await contract.verifyRecord(fileHash);
  const base = {
    fileHash,
    exists:       v[0],
    valid:        v[1],
    revoked:      v[2],
    issuedAt:     Number(v[3]),
    revokedAt:    Number(v[4]),
    issuedAtIso:  v[3] ? new Date(Number(v[3]) * 1000).toISOString() : null,
    revokedAtIso: v[4] ? new Date(Number(v[4]) * 1000).toISOString() : null
  };
  if (!base.exists) return base;
  const r = await contract.getRecord(fileHash);
  return {
    ...base,
    issuer:              r[0],
    patientOwner:        r[1],
    label:               r[2],
    previousVersionHash: r[6] !== "0x0000000000000000000000000000000000000000000000000000000000000000" ? r[6] : null
  };
}

async function getRecordHistory(contract, deployment, provider) {
  const from = deployment.deployedBlock || 0;
  const [registered, revoked] = await Promise.all([
    contract.queryFilter(contract.filters.RecordRegistered(), from),
    contract.queryFilter(contract.filters.RecordRevoked(),    from)
  ]);

  const items = registered.map(e => ({
    type: "registered", fileHash: e.args.fileHash, issuer: e.args.issuer,
    patientOwner: e.args.patientOwner, label: e.args.label,
    blockNumber: e.blockNumber, txHash: e.transactionHash, order: e.index || 0
  })).concat(revoked.map(e => ({
    type: "revoked", fileHash: e.args.fileHash, issuer: e.args.issuer,
    reason: e.args.reason, blockNumber: e.blockNumber,
    txHash: e.transactionHash, order: e.index || 0
  }))).sort((a, b) => b.blockNumber - a.blockNumber || b.order - a.order).slice(0, 20);

  return Promise.all(items.map(async ev => {
    const block = await provider.getBlock(ev.blockNumber);
    return { ...ev, timestampIso: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null };
  }));
}

async function getLatestBlockSummary(provider, blockNumber = null) {
  const n = blockNumber === null ? await getFreshBlockNumber(provider) : blockNumber;
  const b = await provider.getBlock(n);
  return { blockNumber: n, timestampIso: b ? new Date(Number(b.timestamp) * 1000).toISOString() : null,
    transactionCount: b ? b.transactions.length : 0 };
}

// Validate a required 32-byte hex hash.
function validateFileHash(h) {
  if (typeof h !== "string" || !ethers.isHexString(h, 32))
    throw new Error("fileHash must be a 32-byte hex string (0x + 64 hex chars).");
  return h;
}

function requireText(v, name) {
  if (typeof v !== "string" || !v.trim())
    throw new Error(`${name} is required.`);
  return v.trim();
}

function requireAddress(v, name) {
  if (typeof v !== "string" || !v.trim()) {
    return { ok: false, status: 400, message: `${name} is required.` };
  }
  if (!ethers.isAddress(v)) {
    return { ok: false, status: 400, message: `${name} must be a valid address.` };
  }
  return { ok: true, address: ethers.getAddress(v) };
}

// ── Build role info for an address ────────────────────────────────────────────
async function buildRoleInfo(contract, address) {
  const [DOCTOR_ROLE, NURSE_ROLE, HOSPITAL_ROLE] = await Promise.all([
    contract.DOCTOR_ROLE(), contract.NURSE_ROLE(), contract.HOSPITAL_ROLE()
  ]);
  const admin = await contract.admin();
  const [isDoctor, isNurse, isHospital] = await Promise.all([
    contract.hasRole(DOCTOR_ROLE,   address),
    contract.hasRole(NURSE_ROLE,    address),
    contract.hasRole(HOSPITAL_ROLE, address)
  ]);
  return {
    address,
    isAdmin:    address.toLowerCase() === admin.toLowerCase(),
    isDoctor,
    isNurse,
    isHospital,
    roleLabel:  address.toLowerCase() === admin.toLowerCase() ? "Admin"
                : isDoctor   ? "Doctor"
                : isNurse    ? "Nurse"
                : isHospital ? "Hospital"
                : "Patient",
    canRegister: address.toLowerCase() === admin.toLowerCase() || isDoctor || isHospital,
    canRevoke:   false, // depends on which record — handled at record level
    canViewAll:  address.toLowerCase() === admin.toLowerCase() || isDoctor || isNurse || isHospital
  };
}

async function getPatientRecordsForCaller(r, caller, patientAddress) {
  const callerInfo = await buildRoleInfo(r.contract, caller);
  const samePatient = caller.toLowerCase() === patientAddress.toLowerCase();

  if (!samePatient && !callerInfo.canViewAll) {
    return {
      ok: false,
      status: 403,
      message: "Only the patient themself or Doctor/Nurse/Admin demo accounts can view these records.",
      role: callerInfo.roleLabel
    };
  }

  const hashes = samePatient
    ? await r.contract.getMyRecords()
    : await r.contract.getPatientRecords(patientAddress);
  const records = await Promise.all(hashes.map(h => getRecordDetails(r.contract, h)));
  return { ok: true, hashes, records, role: callerInfo };
}

// =============================================================================
// HTTP ENDPOINTS — v1 (preserved exactly)
// =============================================================================

app.get("/api/health", async (_req, res) => {
  try {
    const provider = buildProvider();
    const [network, blockNumber] = await Promise.all([
      provider.getNetwork(), getFreshBlockNumber(provider)
    ]);
    res.json({ ok: true, rpcUrl, chainId: Number(network.chainId), blockNumber,
      contractDeploymentFound: Boolean(getDeployment()?.contracts?.MedicalRecordIntegrity) });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

app.get("/api/foundation", (_req, res) => {
  res.json({ ok: true, title: "Final Project: Medical Record Integrity Checker",
    description: "Blockchain-based medical file integrity verification. Only SHA-256 hashes are stored on-chain.",
    cards: conceptCards, rules: systemRules });
});

app.get("/api/registry", async (_req, res) => {
  try {
    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });
    const [registry, latestBlock] = await Promise.all([
      getRegistrySummary(r.contract, r.deployment), getLatestBlockSummary(r.provider)
    ]);
    res.json({ ok: true, registry, latestBlock });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

app.get("/api/records/history", async (_req, res) => {
  try {
    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });
    const history = await getRecordHistory(r.contract, r.deployment, r.provider);
    res.json({ ok: true, history });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

app.post("/api/records/register", async (req, res) => {
  try {
    const callerCheck  = requireAddress(req.body.caller, "caller");
    if (!callerCheck.ok) return res.status(callerCheck.status).json({ ok: false, message: callerCheck.message });
    const caller       = callerCheck.address;
    const fileHash     = validateFileHash(req.body.fileHash);
    const label        = requireText(req.body.label, "label");
    const patientOwner = req.body.patientOwner || ethers.ZeroAddress;
    if (patientOwner !== ethers.ZeroAddress && !ethers.isAddress(patientOwner))
      return res.status(400).json({ ok: false, message: "patientOwner must be a valid address." });

    const r = await getContract(true, caller);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });
    const { provider, contract, deployment, signer } = r;

    // ── Caller role guard (blockchain-authoritative) ──────────────────────────
    // The local Hardhat demo signer is selected from the required caller address,
    // so the contract also sees the same caller in msg.sender.
    const callerInfo = await buildRoleInfo(contract, caller);
    if (!callerInfo.canRegister) {
      return res.status(403).json({
        ok: false,
        message: "Only Doctor/Admin demo accounts can register records.",
        role: callerInfo.roleLabel
      });
    }
    const existing = await contract.verifyRecord(fileHash);
    if (existing[0]) return res.status(400).json({ ok: false, message: "Hash already registered.", fileHash });

    const beforeBlock = await getFreshBlockNumber(provider);
    const [summaryBefore, nonceBefore] = await Promise.all([
      getRegistrySummary(contract, deployment),
      provider.getTransactionCount(signer.address, beforeBlock)
    ]);

    const tx      = await contract.registerRecord(fileHash, label, patientOwner);
    const receipt = await tx.wait();

    const [registry, record, latestBlock, nonceAfter] = await Promise.all([
      getRegistrySummary(contract, deployment),
      getRecordDetails(contract, fileHash),
      getLatestBlockSummary(provider, receipt.blockNumber),
      provider.getTransactionCount(signer.address, receipt.blockNumber)
    ]);

    res.json({ ok: true, txHash: tx.hash, blockNumber: receipt.blockNumber,
      record, registryBefore: summaryBefore, registry,
      issuer: { address: signer.address, nonceBefore, nonceAfter }, latestBlock });
  } catch (e) {
    res.status(400).json({ ok: false, message: normalizeError(e) });
  }
});

app.post("/api/records/verify", async (req, res) => {
  try {
    const fileHash = validateFileHash(req.body.fileHash);
    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });
    const [record, latestBlock] = await Promise.all([
      getRecordDetails(r.contract, fileHash), getLatestBlockSummary(r.provider)
    ]);
    res.json({ ok: true, record, latestBlock });
  } catch (e) {
    res.status(400).json({ ok: false, message: normalizeError(e) });
  }
});

app.get("/api/records/:hash", async (req, res) => {
  try {
    const fileHash = validateFileHash(req.params.hash);
    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });
    const record = await getRecordDetails(r.contract, fileHash);
    if (!record.exists) return res.status(404).json({ ok: false, message: "No record for this hash.", fileHash });
    res.json({ ok: true, record });
  } catch (e) {
    res.status(400).json({ ok: false, message: normalizeError(e) });
  }
});

// =============================================================================
// HTTP ENDPOINTS — v2 NEW
// =============================================================================

// ── Role check ────────────────────────────────────────────────────────────────
// GET /api/roles/check?address=0x...
// Returns role flags and label for any address. Used by the frontend role badge.
app.get("/api/roles/check", async (req, res) => {
  try {
    const address = req.query.address;
    if (!ethers.isAddress(address))
      return res.status(400).json({ ok: false, message: "Invalid address." });

    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });

    const info = await buildRoleInfo(r.contract, address);
    res.json({ ok: true, role: info });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

// ── Accounts list (all Hardhat accounts with role labels) ────────────────────
// GET /api/accounts
// Returns all unlocked Hardhat accounts with balances and role labels.
// Mirrors the lab4 /api/accounts pattern.
app.get("/api/accounts", async (req, res) => {
  try {
    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });
    const { provider, contract } = r;

    const deployment = getDeployment();
    const addresses = await provider.send("eth_accounts", []);
    const blockTag  = await getFreshBlockNumber(provider);

    const accounts = await Promise.all(addresses.slice(0, 6).map(async (addr, index) => {
      const [balanceWei, nonce, info] = await Promise.all([
        provider.getBalance(addr, blockTag),
        provider.getTransactionCount(addr, blockTag),
        buildRoleInfo(contract, addr)
      ]);
      const entity = getEntityByAddress(deployment, addr);
      const name = entity?.name || defaultAccountNames[index] || null;
      return {
        address:    addr,
        name,
        roleLabel:  info.roleLabel,
        displayLabel: name ? `${name} - ${info.roleLabel}` : info.roleLabel,
        isAdmin:    info.isAdmin,
        isDoctor:   info.isDoctor,
        isNurse:    info.isNurse,
        canRegister: info.canRegister,
        canViewAll:  info.canViewAll,
        balanceEth: Number(ethers.formatEther(balanceWei)).toFixed(4),
        nonce
      };
    }));

    res.json({ ok: true, accounts });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

// ── Patient list for UI dropdowns ───────────────────────────────────────────────
// GET /api/patients
// Returns readable patient ids and names for dropdowns.
app.get("/api/patients", async (_req, res) => {
  try {
    const deployment = getDeployment();
    if (!deployment) return res.status(404).json({ ok: false, message: "Deployment not found." });
    const patients = getPatientEntities(deployment).map(p => ({
      id: p.address,
      name: p.name || `Patient ${p.address.slice(0, 8)}`
    }));
    res.json({ ok: true, patients });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

// ── Role management endpoints ─────────────────────────────────────────────────
// POST /api/roles/doctor/grant  { caller, address }
// POST /api/roles/doctor/revoke { caller, address }
// POST /api/roles/nurse/grant   { caller, address }
// POST /api/roles/nurse/revoke  { caller, address }
//
// `caller` = the wallet address initiating the HTTP request.
// The local Hardhat demo signer is selected from the required caller address.
// This keeps the API guard and the contract msg.sender aligned for role changes.

const roleActions = {
  grantDoctorRole:  { action: "granted", roleName: "Doctor" },
  revokeDoctorRole: { action: "revoked", roleName: "Doctor" },
  grantNurseRole:   { action: "granted", roleName: "Nurse" },
  revokeNurseRole:  { action: "revoked", roleName: "Nurse" }
};

async function handleRoleChange(req, res, contractMethod) {
  try {
    const callerCheck = requireAddress(req.body.caller, "caller");
    if (!callerCheck.ok) return res.status(callerCheck.status).json({ ok: false, success: false, message: callerCheck.message });
    const caller  = callerCheck.address;
    const addressCheck = requireAddress(req.body.address, "address");
    if (!addressCheck.ok) return res.status(addressCheck.status).json({ ok: false, success: false, message: addressCheck.message });
    const address = addressCheck.address;
    const actionInfo = roleActions[contractMethod];

    const r = await getContract(true, caller);
    if (!r.ok) return res.status(r.status).json({ ok: false, success: false, message: r.message });

    // ── Caller must be Admin on-chain (blockchain-authoritative) ─────────────
    const callerInfo = await buildRoleInfo(r.contract, caller);
    if (!callerInfo.isAdmin) {
      return res.status(403).json({
        ok:      false,
        success: false,
        message: "Only Admin can manage roles.",
        role: callerInfo.roleLabel
      });
    }
    const tx = await r.contract[contractMethod](address);
    await tx.wait();

    const info = await buildRoleInfo(r.contract, address);
    const target = getEntityByAddress(r.deployment, address);
    const targetLabel = target?.name || `${info.roleLabel} account`;
    res.json({
      ok: true,
      success: true,
      txHash: tx.hash,
      address,
      targetAddress: address,
      targetLabel,
      action: actionInfo?.action || contractMethod,
      roleName: actionInfo?.roleName || info.roleLabel,
      role: info
    });
  } catch (e) {
    res.status(400).json({ ok: false, success: false, message: normalizeError(e) });
  }
}

app.post("/api/roles/doctor/grant",  (req, res) => handleRoleChange(req, res, "grantDoctorRole"));
app.post("/api/roles/doctor/revoke", (req, res) => handleRoleChange(req, res, "revokeDoctorRole"));
app.post("/api/roles/nurse/grant",   (req, res) => handleRoleChange(req, res, "grantNurseRole"));
app.post("/api/roles/nurse/revoke",  (req, res) => handleRoleChange(req, res, "revokeNurseRole"));

// ── Patient records — self (ownership view) ───────────────────────────────────
// GET /api/patients/me/records?caller=0x...
// Patients can read only their own records. Staff/admin callers can read a
// selected patient's records after the caller role is checked on-chain.
app.get("/api/patients/me/records", async (req, res) => {
  try {
    const callerCheck = requireAddress(req.query.caller, "caller");
    if (!callerCheck.ok) return res.status(callerCheck.status).json({ ok: false, message: callerCheck.message });
    const caller = callerCheck.address;

    const addressCheck = requireAddress(req.query.address || caller, "address");
    if (!addressCheck.ok) return res.status(addressCheck.status).json({ ok: false, message: addressCheck.message });
    const address = addressCheck.address;

    const r = await getContract(true, caller);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });

    const result = await getPatientRecordsForCaller(r, caller, address);
    if (!result.ok) return res.status(result.status).json({ ok: false, message: result.message, role: result.role });
    const patient = getEntityByAddress(r.deployment, address);

    res.json({ ok: true, address, patientName: patient?.name || null, records: result.records });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

// ── Patient records — staff lookup ────────────────────────────────────────────
// GET /api/patients/:address/records
// Same implementation but semantically: staff looking up a specific patient.
app.get("/api/patients/:address/records", async (req, res) => {
  try {
    const addressCheck = requireAddress(req.params.address, "patient address");
    if (!addressCheck.ok) return res.status(addressCheck.status).json({ ok: false, message: addressCheck.message });
    const address = addressCheck.address;

    const callerCheck = requireAddress(req.query.caller, "caller");
    if (!callerCheck.ok) return res.status(callerCheck.status).json({ ok: false, message: callerCheck.message });
    const caller = callerCheck.address;

    const r = await getContract(true, caller);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });

    const result = await getPatientRecordsForCaller(r, caller, address);
    if (!result.ok) return res.status(result.status).json({ ok: false, message: result.message, role: result.role });
    const patient = getEntityByAddress(r.deployment, address);

    res.json({ ok: true, patient: address, patientName: patient?.name || null, records: result.records });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

// ── Register a new version ────────────────────────────────────────────────────
// POST /api/records/version  { caller, newHash, previousHash, label, patientOwner? }
app.post("/api/records/version", async (req, res) => {
  try {
    const callerCheck  = requireAddress(req.body.caller, "caller");
    if (!callerCheck.ok) return res.status(callerCheck.status).json({ ok: false, message: callerCheck.message });
    const caller       = callerCheck.address;
    const newHash      = validateFileHash(req.body.newHash);
    const previousHash = validateFileHash(req.body.previousHash);
    const label        = requireText(req.body.label, "label");
    const patientOwner = req.body.patientOwner || ethers.ZeroAddress;
    if (patientOwner !== ethers.ZeroAddress && !ethers.isAddress(patientOwner))
      return res.status(400).json({ ok: false, message: "patientOwner must be a valid address." });

    const r = await getContract(true, caller);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });
    const { provider, contract, deployment } = r;

    // ── Caller role guard (blockchain-authoritative) ──────────────────────────
    const callerInfo = await buildRoleInfo(contract, caller);
    if (!callerInfo.canRegister) {
      return res.status(403).json({
        ok: false,
        message: "Only Doctor/Admin demo accounts can create record versions.",
        role: callerInfo.roleLabel
      });
    }

    const prevExists = await contract.verifyRecord(previousHash);
    if (!prevExists[0])
      return res.status(400).json({ ok: false, message: "previousHash not found in registry." });

    const newExists = await contract.verifyRecord(newHash);
    if (newExists[0])
      return res.status(400).json({ ok: false, message: "newHash already registered." });

    const tx      = await contract.registerVersion(newHash, previousHash, label, patientOwner);
    const receipt = await tx.wait();

    const [registry, record, latestBlock] = await Promise.all([
      getRegistrySummary(contract, deployment),
      getRecordDetails(contract, newHash),
      getLatestBlockSummary(provider, receipt.blockNumber)
    ]);

    res.json({ ok: true, txHash: tx.hash, blockNumber: receipt.blockNumber,
      record, registry, latestBlock });
  } catch (e) {
    res.status(400).json({ ok: false, message: normalizeError(e) });
  }
});

// ── Version chain ─────────────────────────────────────────────────────────────
// GET /api/records/:hash/versions
// Returns the full version chain from newest to oldest with record details.
app.post("/api/records/revoke", async (req, res) => {
  try {
    const callerCheck = requireAddress(req.body.caller, "caller");
    if (!callerCheck.ok) return res.status(callerCheck.status).json({ ok: false, message: callerCheck.message });
    const caller = callerCheck.address;
    const fileHash = validateFileHash(req.body.fileHash);
    const reason = requireText(req.body.reason, "reason");

    const r = await getContract(true, caller);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });
    const { provider, contract, deployment } = r;

    const callerInfo = await buildRoleInfo(contract, caller);
    if (!callerInfo.isAdmin && !callerInfo.canRegister) {
      return res.status(403).json({
        ok: false,
        message: "Only Admin or Doctor demo accounts can revoke records.",
        role: callerInfo.roleLabel
      });
    }

    const record = await getRecordDetails(contract, fileHash);
    if (!record.exists) {
      return res.status(404).json({ ok: false, message: "Record not found.", fileHash });
    }
    if (record.revoked) {
      return res.status(400).json({ ok: false, message: "Record is already revoked.", fileHash });
    }
    if (!callerInfo.isAdmin && record.issuer.toLowerCase() !== caller.toLowerCase()) {
      return res.status(403).json({
        ok: false,
        message: "Only Admin or the original issuer can revoke this record."
      });
    }

    const tx = await contract.revokeRecord(fileHash, reason);
    const receipt = await tx.wait();

    const [registry, revokedRecord, latestBlock] = await Promise.all([
      getRegistrySummary(contract, deployment),
      getRecordDetails(contract, fileHash),
      getLatestBlockSummary(provider, receipt.blockNumber)
    ]);

    res.json({ ok: true, txHash: tx.hash, blockNumber: receipt.blockNumber,
      record: revokedRecord, registry, latestBlock });
  } catch (e) {
    res.status(400).json({ ok: false, message: normalizeError(e) });
  }
});

app.get("/api/records/:hash/versions", async (req, res) => {
  try {
    const fileHash = validateFileHash(req.params.hash);
    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });

    const chain = await r.contract.getRecordVersionChain(fileHash);
    const versions = await Promise.all(chain.map(h => getRecordDetails(r.contract, h)));

    res.json({ ok: true, fileHash, versionCount: versions.length, versions });
  } catch (e) {
    res.status(400).json({ ok: false, message: normalizeError(e) });
  }
});

// =============================================================================
// HTTP ENDPOINTS — v3 BLOCKCHAIN EXPLORER (admin only)
// =============================================================================
//
// All three endpoints accept ?caller=0x... and reject if caller is not admin.
// This reuses the existing buildRoleInfo helper — no new role system needed.
//
// GET /api/chain/blocks?limit=10&caller=0x...       — latest blocks descending
// GET /api/chain/blocks/:number?caller=0x...        — full block by number
// GET /api/chain/tx/:hash?caller=0x...              — transaction details
// =============================================================================

// Shared admin guard — reuses buildRoleInfo, returns error object or null.
async function requireAdmin(contract, callerAddress) {
  if (!ethers.isAddress(callerAddress)) {
    return { status: 400, message: "caller query param must be a valid address." };
  }
  const info = await buildRoleInfo(contract, callerAddress);
  if (!info.isAdmin) {
    return { status: 403, message: "Blockchain explorer is restricted to Admin role only." };
  }
  return null;
}

// Normalize a raw ethers Block into a clean JSON-safe object.
function serializeBlock(block) {
  return {
    blockNumber:      Number(block.number),
    hash:             block.hash,
    parentHash:       block.parentHash,
    nonce:            block.nonce,
    timestamp:        Number(block.timestamp),
    timestampIso:     new Date(Number(block.timestamp) * 1000).toISOString(),
    miner:            block.miner,
    gasUsed:          block.gasUsed   ? block.gasUsed.toString()   : "0",
    gasLimit:         block.gasLimit  ? block.gasLimit.toString()  : "0",
    baseFeePerGas:    block.baseFeePerGas ? block.baseFeePerGas.toString() : null,
    transactionCount: block.transactions.length,
    transactions:     block.transactions,   // array of tx hashes
    difficulty:       block.difficulty ? block.difficulty.toString() : "0",
    extraData:        block.extraData  || "0x"
  };
}

// Normalize a raw ethers TransactionResponse into a clean JSON-safe object.
function serializeTx(tx, receipt) {
  return {
    hash:             tx.hash,
    from:             tx.from,
    to:               tx.to || null,
    value:            ethers.formatEther(tx.value || 0n) + " ETH",
    valueWei:         tx.value ? tx.value.toString() : "0",
    gas:              tx.gasLimit ? tx.gasLimit.toString() : "0",
    gasPrice:         tx.gasPrice ? ethers.formatUnits(tx.gasPrice, "gwei") + " gwei" : null,
    nonce:            tx.nonce,
    blockNumber:      tx.blockNumber,
    blockHash:        tx.blockHash,
    data:             tx.data || "0x",
    dataLength:       tx.data ? (tx.data.length - 2) / 2 : 0,  // bytes
    // receipt fields
    status:           receipt ? (receipt.status === 1 ? "success" : "reverted") : null,
    gasUsed:          receipt ? receipt.gasUsed.toString() : null,
    confirmations:    receipt ? receipt.confirmations : null,
    contractCreated:  receipt?.contractAddress || null
  };
}

// ── GET /api/chain/blocks ─────────────────────────────────────────────────────
// Returns up to `limit` latest blocks in descending order.
// Educational note: each block's parentHash links it to the previous block,
// forming the immutable chain.
app.get("/api/chain/blocks", async (req, res) => {
  try {
    const caller = req.query.caller || "";
    const limit  = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);

    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });

    const denied = await requireAdmin(r.contract, caller);
    if (denied) return res.status(denied.status).json({ ok: false, message: denied.message });

    const latestNumber = await getFreshBlockNumber(r.provider);
    const blockNumbers = [];
    for (let i = 0; i < limit && latestNumber - i >= 0; i++) {
      blockNumbers.push(latestNumber - i);
    }

    const blocks = await Promise.all(
      blockNumbers.map(n => r.provider.getBlock(n, false))
        // false = don't fetch full transactions — just hashes for the list view
    );

    res.json({
      ok: true,
      latestBlock: latestNumber,
      count: blocks.length,
      blocks: blocks.filter(Boolean).map(serializeBlock)
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

// ── GET /api/chain/blocks/:number ─────────────────────────────────────────────
// Returns full details for one block including all transaction hashes.
app.get("/api/chain/blocks/:number", async (req, res) => {
  try {
    const caller      = req.query.caller || "";
    const blockNumber = Number(req.params.number);
    if (isNaN(blockNumber) || blockNumber < 0)
      return res.status(400).json({ ok: false, message: "Block number must be a non-negative integer." });

    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });

    const denied = await requireAdmin(r.contract, caller);
    if (denied) return res.status(denied.status).json({ ok: false, message: denied.message });

    const block = await r.provider.getBlock(blockNumber, false);
    if (!block) return res.status(404).json({ ok: false, message: `Block ${blockNumber} not found.` });

    res.json({ ok: true, block: serializeBlock(block) });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

// ── GET /api/chain/tx/:hash ───────────────────────────────────────────────────
// Returns full transaction details and receipt for a known tx hash.
app.get("/api/chain/tx/:hash", async (req, res) => {
  try {
    const caller = req.query.caller || "";
    const txHash = req.params.hash;
    if (!ethers.isHexString(txHash, 32))
      return res.status(400).json({ ok: false, message: "tx hash must be a 32-byte hex string." });

    const r = await getContract(false);
    if (!r.ok) return res.status(r.status).json({ ok: false, message: r.message });

    const denied = await requireAdmin(r.contract, caller);
    if (denied) return res.status(denied.status).json({ ok: false, message: denied.message });

    const [tx, receipt] = await Promise.all([
      r.provider.getTransaction(txHash),
      r.provider.getTransactionReceipt(txHash)
    ]);

    if (!tx) return res.status(404).json({ ok: false, message: "Transaction not found." });

    res.json({ ok: true, tx: serializeTx(tx, receipt) });
  } catch (e) {
    res.status(500).json({ ok: false, message: normalizeError(e) });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Final project API v2 listening on port ${port}`);
});
