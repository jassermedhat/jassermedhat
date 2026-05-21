const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

// -----------------------------------------------------------------------------
// Final Project Deploy Script — v2
// -----------------------------------------------------------------------------
// Seeds a richer demo state:
//   account[0] = admin/deployer
//   account[1] = doctor (granted DOCTOR_ROLE)
//   account[2] = nurse  (granted NURSE_ROLE)
//   account[3] = Dave (receives sample records)
//   account[4] = Emma
//   account[5] = Frank
//
// Version chain seeded:
//   sampleHashV1  (original record, patient = account[3])
//   sampleHashV2  (updated version linked to V1, same patient)
// -----------------------------------------------------------------------------

function sha256Hex(text) {
  return "0x" + crypto.createHash("sha256").update(text).digest("hex");
}

async function main() {
  const [admin, doctor, nurse, patientDave, patientEmma, patientFrank] = await ethers.getSigners();

  // Deploy the contract. Admin becomes the default registrar.
  const Factory  = await ethers.getContractFactory("MedicalRecordIntegrity");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  // Grant roles to the seeded accounts.
  const grantDoctorTx = await contract.grantDoctorRole(doctor.address);
  await grantDoctorTx.wait();

  const grantNurseTx = await contract.grantNurseRole(nurse.address);
  await grantNurseTx.wait();

  // Build two sample hashes that represent a version chain.
  const v1Content = "DEMO|PatientID:P-1001|RecordType:BloodTest|Date:2025-01-15|Version:1";
  const v2Content = "DEMO|PatientID:P-1001|RecordType:BloodTest|Date:2025-06-10|Version:2";

  const sampleHashV1 = sha256Hex(v1Content);
  const sampleHashV2 = sha256Hex(v2Content);

  // Register V1 (original record, assigned to patient account[3]).
  const regV1Tx = await contract.registerRecord(
    sampleHashV1,
    "BloodTest_P1001_2025-01-15_v1",
    patientDave.address
  );
  const regV1Receipt = await regV1Tx.wait();

  // Register V2 (updated version linked to V1, same patient).
  const regV2Tx = await contract.registerVersion(
    sampleHashV2,
    sampleHashV1,
    "BloodTest_P1001_2025-06-10_v2",
    patientDave.address
  );
  const regV2Receipt = await regV2Tx.wait();

  // Capture deployment block.
  const deployTx      = contract.deploymentTransaction();
  const deployReceipt = deployTx ? await deployTx.wait() : null;

  const deployment = {
    network:       network.name,
    deployedAt:    new Date().toISOString(),
    deployedBlock: deployReceipt ? deployReceipt.blockNumber : null,
    admin:         admin.address,
    doctor:        doctor.address,
    nurse:         nurse.address,
    patient:       patientDave.address,
    entities: [
      { role: "Admin",  name: "Alice",   address: admin.address },
      { role: "Doctor", name: "Bob",       address: doctor.address },
      { role: "Nurse",  name: "Carol",   address: nurse.address },
      { role: "Patient",name: "Dave",  address: patientDave.address },
      { role: "Patient",name: "Emma",  address: patientEmma.address },
      { role: "Patient",name: "Frank", address: patientFrank.address }
    ],
    patients: [
      { id: "P-1001", name: "Dave",  address: patientDave.address },
      { id: "P-1002", name: "Emma",  address: patientEmma.address },
      { id: "P-1003", name: "Frank", address: patientFrank.address }
    ],
    sampleRecord: {
      v1: {
        fileHash:        sampleHashV1,
        label:           "BloodTest_P1001_2025-01-15_v1",
        sourceString:    v1Content,
        patientOwner:    patientDave.address,
        registeredBlock: regV1Receipt ? regV1Receipt.blockNumber : null
      },
      v2: {
        fileHash:        sampleHashV2,
        label:           "BloodTest_P1001_2025-06-10_v2",
        sourceString:    v2Content,
        patientOwner:    patientDave.address,
        previousHash:    sampleHashV1,
        registeredBlock: regV2Receipt ? regV2Receipt.blockNumber : null
      }
    },
    contracts: {
      MedicalRecordIntegrity: await contract.getAddress()
    }
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, `${network.name}.json`),
    JSON.stringify(deployment, null, 2)
  );

  console.log("Final project v2 deployment saved:", JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
