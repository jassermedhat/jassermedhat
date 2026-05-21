# Project Explanation

## Idea

The Medical Record Integrity Checker demonstrates how a blockchain can store immutable proofs of off-chain files. A doctor or admin hashes a medical record file with SHA-256 in the browser and registers the 32-byte fingerprint on a local Hardhat blockchain. Later, the same file can be hashed again and compared with the on-chain record.

The system stores hashes and metadata only. It does not store medical files.

## Components

- `blockchain/contracts/MedicalRecordIntegrity.sol`: Solidity contract that stores records, role mappings, patient ownership, version links, and revocation state.
- `blockchain/scripts/deploy.js`: deploys the contract, grants demo Doctor/Nurse roles, and seeds SHA-256 sample records.
- `blockchain/test/MedicalRecordIntegrity.test.js`: Hardhat tests for the contract behavior.
- `api/src/server.js`: Express API that validates caller fields, checks roles against the contract, and sends local Hardhat transactions.
- `frontend/`: static HTML/CSS/JS UI that hashes files locally and provides role-aware panels.
- `python/demo.py`: small SHA-256 demonstration script.
- `docker-compose.yml`: standalone local stack.

## Contract Model

The contract is `MedicalRecordIntegrity.sol`. It uses:

- `admin`: immutable deployer address.
- `DOCTOR_ROLE`, `NURSE_ROLE`, and `HOSPITAL_ROLE`: role identifiers stored in custom mappings.
- `records`: maps `bytes32 fileHash` to record metadata.
- `patientRecords`: maps patient addresses to their record hashes.
- `recordCount` and `revokedCount`: simple registry counters.

The project uses custom role mappings instead of an imported access-control framework. The role model is intentionally small for course readability.

## Record Lifecycle

1. The browser computes a SHA-256 hash of the selected file.
2. The frontend sends the hash, label, patient owner, and selected demo caller to the API.
3. The API validates the caller and uses that unlocked local Hardhat account as the signer.
4. The contract checks `msg.sender` through its own role rules.
5. The contract stores the hash and metadata, then emits an event.
6. Verification re-computes the hash and checks whether that hash exists and is not revoked.

## Roles

| Role | Meaning |
| --- | --- |
| Admin | Contract deployer; can grant/revoke roles, register/version records, revoke any record, and use the explorer |
| Doctor | Can register records, create versions, view patients, and revoke records they originally issued |
| Nurse | Read-only staff role; can view patient records but cannot write |
| Patient | Default account with no staff role; can view only records owned by the same address |
| Hospital | Backward-compatible registrar alias treated like Doctor in the contract |

## API Security Model

This project is a local demo. The API requires a `caller` address for protected actions and checks that address against the contract. For writes, the API uses the selected local Hardhat account as the JSON-RPC signer so the contract sees the same address as `msg.sender`.

This is useful for education because role rules are visible in both the API and contract. It is not production authentication. A real system would require wallet signatures, sessions, consent, key custody, and privacy controls.

## Patient Privacy Behavior

- `GET /api/patients/me/records?caller=0x...` returns records owned by the caller.
- `GET /api/patients/:address/records?caller=0x...` returns records only if the caller is the same patient or a Doctor/Nurse/Admin-style staff account.
- Missing caller values return `400`.
- Unauthorized patient lookups return `403`.

## Hashing

Medical file fingerprints are SHA-256 hashes:

```js
const crypto = require("crypto");

function sha256Hex(text) {
  return "0x" + crypto.createHash("sha256").update(text).digest("hex");
}
```

The frontend uses `crypto.subtle.digest("SHA-256", fileBytes)`. Solidity role constants still use `keccak256(...)` internally because that is the normal EVM way to derive role IDs.

## Revocation

The contract supports `revokeRecord(bytes32 fileHash, string reason)`. The API exposes `POST /api/records/revoke`, and the frontend includes a simple revoke form for Doctor/Admin demo users. The contract allows Admin or the original issuer to revoke.

Revoked records remain on-chain. Verification returns the record as invalid/revoked rather than deleting it.

## Limitations

- Local Hardhat accounts are simulated and unlocked.
- The API `caller` value is not cryptographically authenticated.
- No real medical files or sensitive patient data should be used.
- On-chain labels and addresses are public metadata in the demo chain.
- The local deployment resets when Hardhat restarts.
- First Hardhat compile may need internet access to download Solidity 0.8.24.
