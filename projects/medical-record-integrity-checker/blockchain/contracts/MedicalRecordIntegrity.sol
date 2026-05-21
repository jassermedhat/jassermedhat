// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// -----------------------------------------------------------------------------
// Final Project Contract — v2 (Bonus Expansion)
// -----------------------------------------------------------------------------
// 1. Roles:
//    - admin (deployer) — full control, grants/revokes all roles.
//    - DOCTOR_ROLE     — register records, revoke own records, create versions.
//    - NURSE_ROLE      — read-only healthcare staff.
//    - HOSPITAL_ROLE   — backward-compatibility alias treated like DOCTOR_ROLE.
//
// 2. Patient ownership:
//    - patientOwner field links a record to a wallet address.
//    - patientRecords mapping tracks all hashes per patient address.
//    - getMyRecords()         — patient calls, gets their own hashes.
//    - getPatientRecords(addr)— staff only, looks up any patient.
//
// 3. Version chaining:
//    - previousVersionHash in struct links to predecessor (bytes32(0) = first).
//    - registerVersion() creates an immutable chain entry.
//    - getRecordVersionChain() walks the chain newest → oldest.
//
// 4. Revocation rule change (v2):
//    - Only admin OR the original issuer of a record may revoke it.
//
// 5. Privacy guarantee:
//    - No medical files. Only SHA-256 hashes, addresses, labels, timestamps.
// -----------------------------------------------------------------------------

contract MedicalRecordIntegrity {

    // MedicalRecord stores the cryptographic fingerprint and ownership metadata.
    // previousVersionHash = bytes32(0) indicates this is the first version.
    struct MedicalRecord {
        bytes32 fileHash;
        bytes32 previousVersionHash;
        address issuer;
        address patientOwner;
        string  label;
        uint256 issuedAt;
        uint256 revokedAt;
        bool    exists;
        bool    revoked;
    }

    // ── Role constants ────────────────────────────────────────────────────────
    bytes32 public constant HOSPITAL_ROLE = keccak256("HOSPITAL_ROLE"); // kept for backward compat
    bytes32 public constant DOCTOR_ROLE   = keccak256("DOCTOR_ROLE");
    bytes32 public constant NURSE_ROLE    = keccak256("NURSE_ROLE");

    // ── State ─────────────────────────────────────────────────────────────────
    address public immutable admin;
    uint256 public recordCount;
    uint256 public revokedCount;

    mapping(bytes32 => MedicalRecord)            private records;
    mapping(bytes32 => mapping(address => bool)) private roles;
    mapping(address => bytes32[])                private patientRecords;

    // ── Events ────────────────────────────────────────────────────────────────
    event RecordRegistered(
        bytes32 indexed fileHash,
        address indexed issuer,
        address indexed patientOwner,
        string  label,
        uint256 issuedAt
    );
    event RecordRevoked(
        bytes32 indexed fileHash,
        address indexed issuer,
        string  reason,
        uint256 revokedAt
    );
    event RecordVersioned(
        bytes32 indexed previousHash,
        bytes32 indexed newHash,
        address indexed issuer
    );
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed grantedBy);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed revokedBy);

    // ── Access-control helpers ────────────────────────────────────────────────

    // Registrar = admin, doctor, or hospital (backward-compat).
    function _isRegistrar(address a) internal view returns (bool) {
        return a == admin
            || roles[DOCTOR_ROLE][a]
            || roles[HOSPITAL_ROLE][a];
    }

    // Healthcare staff = registrar + nurse.
    function _isStaff(address a) internal view returns (bool) {
        return _isRegistrar(a) || roles[NURSE_ROLE][a];
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "MedicalRecordIntegrity: not admin.");
        _;
    }

    modifier onlyRegistrar() {
        require(_isRegistrar(msg.sender), "MedicalRecordIntegrity: need doctor or admin role.");
        _;
    }

    modifier onlyStaff() {
        require(_isStaff(msg.sender), "MedicalRecordIntegrity: need healthcare staff role.");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor() {
        admin = msg.sender;
        // Admin automatically holds doctor and hospital roles.
        roles[DOCTOR_ROLE][msg.sender]   = true;
        roles[HOSPITAL_ROLE][msg.sender] = true;
        emit RoleGranted(DOCTOR_ROLE,   msg.sender, msg.sender);
        emit RoleGranted(HOSPITAL_ROLE, msg.sender, msg.sender);
    }

    // ── Internal role helpers ─────────────────────────────────────────────────
    function _grant(bytes32 role, address account) internal {
        require(account != address(0), "MedicalRecordIntegrity: zero address.");
        require(!roles[role][account],  "MedicalRecordIntegrity: already has role.");
        roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function _revoke(bytes32 role, address account) internal {
        require(roles[role][account], "MedicalRecordIntegrity: does not have role.");
        roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    // ── Role management (admin only) ─────────────────────────────────────────
    function grantDoctorRole(address account)   external onlyAdmin { _grant(DOCTOR_ROLE,   account); }
    function revokeDoctorRole(address account)  external onlyAdmin { _revoke(DOCTOR_ROLE,  account); }
    function grantNurseRole(address account)    external onlyAdmin { _grant(NURSE_ROLE,    account); }
    function revokeNurseRole(address account)   external onlyAdmin { _revoke(NURSE_ROLE,   account); }
    function grantHospitalRole(address account) external onlyAdmin { _grant(HOSPITAL_ROLE, account); }
    function revokeHospitalRole(address account)external onlyAdmin { _revoke(HOSPITAL_ROLE,account); }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return roles[role][account];
    }

    // Returns a human-readable role label for the frontend role badge.
    function getRoleLabel(address account) external view returns (string memory) {
        if (account == admin)                   return "Admin";
        if (roles[DOCTOR_ROLE][account])        return "Doctor";
        if (roles[NURSE_ROLE][account])         return "Nurse";
        if (roles[HOSPITAL_ROLE][account])      return "Hospital";
        return "Patient";
    }

    // ── Internal record store ─────────────────────────────────────────────────
    function _store(
        bytes32 fileHash,
        bytes32 previousVersionHash,
        string calldata label,
        address patientOwner
    ) internal {
        records[fileHash] = MedicalRecord({
            fileHash:            fileHash,
            previousVersionHash: previousVersionHash,
            issuer:              msg.sender,
            patientOwner:        patientOwner,
            label:               label,
            issuedAt:            block.timestamp,
            revokedAt:           0,
            exists:              true,
            revoked:             false
        });
        recordCount += 1;
        // Track ownership if a real patient address was provided.
        if (patientOwner != address(0)) {
            patientRecords[patientOwner].push(fileHash);
        }
    }

    // ── Write functions ───────────────────────────────────────────────────────

    // Register the first version of a record. No predecessor.
    function registerRecord(
        bytes32 fileHash,
        string calldata label,
        address patientOwner
    ) external onlyRegistrar {
        require(fileHash != bytes32(0),      "MedicalRecordIntegrity: hash required.");
        require(bytes(label).length > 0,     "MedicalRecordIntegrity: label required.");
        require(!records[fileHash].exists,   "MedicalRecordIntegrity: already registered.");

        _store(fileHash, bytes32(0), label, patientOwner);
        emit RecordRegistered(fileHash, msg.sender, patientOwner, label, block.timestamp);
    }

    // Register an updated version linked to a previous record.
    // The previous record is NOT automatically revoked — the issuer may choose to.
    function registerVersion(
        bytes32 newHash,
        bytes32 previousHash,
        string calldata label,
        address patientOwner
    ) external onlyRegistrar {
        require(newHash      != bytes32(0),  "MedicalRecordIntegrity: new hash required.");
        require(previousHash != bytes32(0),  "MedicalRecordIntegrity: previous hash required.");
        require(bytes(label).length > 0,     "MedicalRecordIntegrity: label required.");
        require(records[previousHash].exists,"MedicalRecordIntegrity: previous record not found.");
        require(!records[newHash].exists,    "MedicalRecordIntegrity: new hash already registered.");

        _store(newHash, previousHash, label, patientOwner);
        emit RecordVersioned(previousHash, newHash, msg.sender);
        emit RecordRegistered(newHash, msg.sender, patientOwner, label, block.timestamp);
    }

    // Revoke a record. Only admin or the original issuer of that record may revoke.
    function revokeRecord(
        bytes32 fileHash,
        string calldata reason
    ) external {
        MedicalRecord storage rec = records[fileHash];
        require(rec.exists,   "MedicalRecordIntegrity: record not found.");
        require(!rec.revoked, "MedicalRecordIntegrity: already revoked.");
        require(
            msg.sender == admin || msg.sender == rec.issuer,
            "MedicalRecordIntegrity: only admin or original issuer can revoke."
        );
        require(bytes(reason).length > 0, "MedicalRecordIntegrity: reason required.");

        rec.revoked   = true;
        rec.revokedAt = block.timestamp;
        revokedCount += 1;
        emit RecordRevoked(fileHash, msg.sender, reason, block.timestamp);
    }

    // ── Read functions (public) ───────────────────────────────────────────────

    // Verify whether a hash is registered, valid, or revoked. Never reverts.
    function verifyRecord(bytes32 fileHash)
        external view
        returns (bool exists, bool valid, bool revoked, uint256 issuedAt, uint256 revokedAt)
    {
        MedicalRecord storage rec = records[fileHash];
        if (!rec.exists) return (false, false, false, 0, 0);
        return (true, !rec.revoked, rec.revoked, rec.issuedAt, rec.revokedAt);
    }

    // Get full metadata for a registered record.
    function getRecord(bytes32 fileHash)
        external view
        returns (
            address issuer,
            address patientOwner,
            string  memory label,
            uint256 issuedAt,
            uint256 revokedAt,
            bool    revoked,
            bytes32 previousVersionHash
        )
    {
        MedicalRecord storage rec = records[fileHash];
        require(rec.exists, "MedicalRecordIntegrity: record not found.");
        return (rec.issuer, rec.patientOwner, rec.label, rec.issuedAt, rec.revokedAt, rec.revoked, rec.previousVersionHash);
    }

    // Patient calls this directly with their own wallet to see their records.
    function getMyRecords() external view returns (bytes32[] memory) {
        return patientRecords[msg.sender];
    }

    // Healthcare staff (doctor, nurse, admin) look up any patient's records.
    function getPatientRecords(address patient) external view onlyStaff returns (bytes32[] memory) {
        return patientRecords[patient];
    }

    // Walk the version chain from newHash backwards. Returns up to 32 entries.
    function getRecordVersionChain(bytes32 fileHash) external view returns (bytes32[] memory) {
        require(records[fileHash].exists, "MedicalRecordIntegrity: record not found.");

        bytes32[32] memory temp;
        uint256 count  = 0;
        bytes32 cursor = fileHash;

        while (count < 32 && records[cursor].exists) {
            temp[count] = cursor;
            count++;
            bytes32 prev = records[cursor].previousVersionHash;
            if (prev == bytes32(0)) break;
            cursor = prev;
        }

        bytes32[] memory chain = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            chain[i] = temp[i];
        }
        return chain;
    }
}
