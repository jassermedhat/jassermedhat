const assert = require("node:assert/strict");
const crypto = require("node:crypto");

// -----------------------------------------------------------------------------
// Final Project Tests — v2 (Bonus Expansion)
// -----------------------------------------------------------------------------
// Covers:
//   - constructor + auto-roles
//   - doctor role grant / unauthorized registration rejection
//   - nurse role grant / nurse read-only enforcement
//   - patient ownership queries + access restrictions
//   - version creation + chain correctness
//   - issuer-only revoke rule
//   - unknown-hash no-revert
// -----------------------------------------------------------------------------

function sha256Hex(text) {
  return "0x" + crypto.createHash("sha256").update(text).digest("hex");
}

describe("MedicalRecordIntegrity v2", function () {
  const content    = "DEMO|PatientID:P-9001|RecordType:MRI|Date:2025-06-01";
  const contentV2  = "DEMO|PatientID:P-9001|RecordType:MRI|Date:2025-12-01|updated";
  let   sampleHash, sampleHashV2;

  before(async function () {
    sampleHash   = sha256Hex(content);
    sampleHashV2 = sha256Hex(contentV2);
  });

  async function deploy() {
    const [admin, doctor, nurse, patient, stranger] = await ethers.getSigners();
    const Factory  = await ethers.getContractFactory("MedicalRecordIntegrity");
    const contract = await Factory.deploy();
    await contract.waitForDeployment();
    return { contract, admin, doctor, nurse, patient, stranger };
  }

  // ── Constructor ────────────────────────────────────────────────────────────
  it("stores deployer as admin and auto-grants doctor+hospital roles", async function () {
    const { contract, admin } = await deploy();
    const DOCTOR_ROLE = await contract.DOCTOR_ROLE();

    assert.equal(await contract.admin(), admin.address);
    assert.equal(await contract.hasRole(DOCTOR_ROLE, admin.address), true);
    assert.equal(await contract.recordCount(), 0n);
  });

  // ── Doctor role grant ──────────────────────────────────────────────────────
  it("admin can grant doctor role", async function () {
    const { contract, doctor } = await deploy();
    const DOCTOR_ROLE = await contract.DOCTOR_ROLE();

    await contract.grantDoctorRole(doctor.address);
    assert.equal(await contract.hasRole(DOCTOR_ROLE, doctor.address), true);
    assert.equal(await contract.getRoleLabel(doctor.address), "Doctor");
  });

  // ── Nurse role grant ───────────────────────────────────────────────────────
  it("admin can grant nurse role", async function () {
    const { contract, nurse } = await deploy();
    const NURSE_ROLE = await contract.NURSE_ROLE();

    await contract.grantNurseRole(nurse.address);
    assert.equal(await contract.hasRole(NURSE_ROLE, nurse.address), true);
    assert.equal(await contract.getRoleLabel(nurse.address), "Nurse");
  });

  // ── Registration — happy path (doctor) ────────────────────────────────────
  it("granted doctor can register a record", async function () {
    const { contract, doctor, patient } = await deploy();

    await contract.grantDoctorRole(doctor.address);
    await contract.connect(doctor).registerRecord(sampleHash, "MRI_2025", patient.address);

    const v = await contract.verifyRecord(sampleHash);
    assert.equal(v[0], true);  // exists
    assert.equal(v[1], true);  // valid
    assert.equal(await contract.recordCount(), 1n);
  });

  // ── Unauthorized registration rejection ────────────────────────────────────
  it("rejects registration from nurse (read-only role)", async function () {
    const { contract, nurse, patient } = await deploy();

    await contract.grantNurseRole(nurse.address);
    let failed = false;
    try {
      await contract.connect(nurse).registerRecord(sampleHash, "MRI_2025", patient.address);
    } catch (e) {
      failed = true;
      assert.match(e.message, /doctor or admin/i);
    }
    assert.equal(failed, true);
  });

  it("rejects registration from stranger (no role)", async function () {
    const { contract, stranger, patient } = await deploy();
    let failed = false;
    try {
      await contract.connect(stranger).registerRecord(sampleHash, "MRI_2025", patient.address);
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true);
  });

  // ── Patient ownership ──────────────────────────────────────────────────────
  it("getMyRecords returns only the caller's records", async function () {
    const { contract, doctor, patient, stranger } = await deploy();

    await contract.grantDoctorRole(doctor.address);
    await contract.connect(doctor).registerRecord(sampleHash, "MRI_2025", patient.address);

    const myRecords     = await contract.connect(patient).getMyRecords();
    const otherRecords  = await contract.connect(stranger).getMyRecords();

    assert.equal(myRecords.length, 1);
    assert.equal(myRecords[0], sampleHash);
    assert.equal(otherRecords.length, 0);
  });

  // ── Patient access restriction for getPatientRecords ──────────────────────
  it("patient cannot call getPatientRecords (staff only)", async function () {
    const { contract, doctor, patient } = await deploy();

    await contract.grantDoctorRole(doctor.address);
    await contract.connect(doctor).registerRecord(sampleHash, "MRI_2025", patient.address);

    let failed = false;
    try {
      await contract.connect(patient).getPatientRecords(patient.address);
    } catch (e) {
      failed = true;
      assert.match(e.message, /healthcare staff/i);
    }
    assert.equal(failed, true);
  });

  it("nurse can call getPatientRecords", async function () {
    const { contract, doctor, nurse, patient } = await deploy();

    await contract.grantDoctorRole(doctor.address);
    await contract.grantNurseRole(nurse.address);
    await contract.connect(doctor).registerRecord(sampleHash, "MRI_2025", patient.address);

    const hashes = await contract.connect(nurse).getPatientRecords(patient.address);
    assert.equal(hashes.length, 1);
    assert.equal(hashes[0], sampleHash);
  });

  // ── Version creation ───────────────────────────────────────────────────────
  it("doctor can create a new version linked to the original", async function () {
    const { contract, doctor, patient } = await deploy();

    await contract.grantDoctorRole(doctor.address);
    await contract.connect(doctor).registerRecord(sampleHash, "MRI_v1", patient.address);
    await contract.connect(doctor).registerVersion(sampleHashV2, sampleHash, "MRI_v2", patient.address);

    const v2 = await contract.getRecord(sampleHashV2);
    assert.equal(v2[6], sampleHash); // previousVersionHash field (index 6)
    assert.equal(await contract.recordCount(), 2n);
  });

  // ── Version chain correctness ──────────────────────────────────────────────
  it("getRecordVersionChain returns newest-first chain", async function () {
    const { contract, doctor, patient } = await deploy();

    await contract.grantDoctorRole(doctor.address);
    await contract.connect(doctor).registerRecord(sampleHash, "MRI_v1", patient.address);
    await contract.connect(doctor).registerVersion(sampleHashV2, sampleHash, "MRI_v2", patient.address);

    const chain = await contract.getRecordVersionChain(sampleHashV2);
    assert.equal(chain.length, 2);
    assert.equal(chain[0], sampleHashV2); // newest first
    assert.equal(chain[1], sampleHash);   // original
  });

  // ── Issuer-only revoke rule ────────────────────────────────────────────────
  it("original issuer (doctor) can revoke their own record", async function () {
    const { contract, doctor, patient } = await deploy();

    await contract.grantDoctorRole(doctor.address);
    await contract.connect(doctor).registerRecord(sampleHash, "MRI_v1", patient.address);
    await contract.connect(doctor).revokeRecord(sampleHash, "Superseded by v2.");

    const v = await contract.verifyRecord(sampleHash);
    assert.equal(v[1], false); // no longer valid
    assert.equal(v[2], true);  // revoked
  });

  it("stranger cannot revoke a record they did not issue", async function () {
    const { contract, doctor, stranger, patient } = await deploy();

    await contract.grantDoctorRole(doctor.address);
    await contract.connect(doctor).registerRecord(sampleHash, "MRI_v1", patient.address);

    let failed = false;
    try {
      await contract.connect(stranger).revokeRecord(sampleHash, "Attempt.");
    } catch (e) {
      failed = true;
      assert.match(e.message, /original issuer/i);
    }
    assert.equal(failed, true);
  });

  // ── Nurse read-only enforcement ────────────────────────────────────────────
  it("nurse cannot register records", async function () {
    const { contract, nurse, patient } = await deploy();
    await contract.grantNurseRole(nurse.address);

    let failed = false;
    try {
      await contract.connect(nurse).registerRecord(sampleHash, "MRI_2025", patient.address);
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true);
  });

  it("nurse cannot revoke records", async function () {
    const { contract, nurse } = await deploy();
    await contract.grantNurseRole(nurse.address);

    // First register as admin so a record exists.
    await contract.registerRecord(sampleHash, "MRI_2025", ethers.ZeroAddress);

    let failed = false;
    try {
      await contract.connect(nurse).revokeRecord(sampleHash, "Nurse attempt.");
    } catch (e) {
      failed = true;
    }
    assert.equal(failed, true);
  });

  // ── Unknown hash — no revert ───────────────────────────────────────────────
  it("verifyRecord returns not-found for an unknown hash without reverting", async function () {
    const { contract } = await deploy();
    const unknown = sha256Hex("nobody_registered_this");
    const result  = await contract.verifyRecord(unknown);
    assert.equal(result[0], false);
    assert.equal(result[1], false);
  });
});
