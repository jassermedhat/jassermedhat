"""
Final Project — Medical Record Integrity: Python Hash Demo
==========================================================

This script demonstrates the core concept behind the Medical Record Integrity
Checker. It mirrors the hash-chain demonstration pattern used in Lab 1.

Key concepts demonstrated:
  1. SHA-256 produces a fixed-size fingerprint regardless of file size.
  2. Any modification — even a single byte — produces a completely different hash.
  3. The hash comparison is the basis of the on-chain integrity verification.
  4. Medical files stay off-chain; only the hash reaches the blockchain.

Run this script inside the Docker container:
  docker compose exec final-pythonlab python demo.py
"""

import hashlib
import json
import os
import tempfile

DIVIDER = "-" * 64


def sha256_of_bytes(data: bytes) -> str:
    """Compute the SHA-256 hash of raw bytes and return a 0x-prefixed hex string.

    This mirrors what the browser does with the Web Crypto API:
      crypto.subtle.digest("SHA-256", arrayBuffer)
    The 0x prefix matches Solidity's bytes32 type convention.
    """
    digest = hashlib.sha256(data).hexdigest()
    return "0x" + digest


def sha256_of_string(text: str) -> str:
    """Convenience wrapper for hashing a UTF-8 string."""
    return sha256_of_bytes(text.encode("utf-8"))


def print_section(title: str) -> None:
    print(f"\n{DIVIDER}")
    print(f"  {title}")
    print(DIVIDER)


# ── Demo 1: Basic hash properties ─────────────────────────────────────────────

print_section("Demo 1: SHA-256 always produces a fixed-length output")

examples = [
    "a",
    "Hello, patient!",
    "MEDICAL_RECORD|PatientID:P-1001|Type:BloodTest|Date:2025-01-15|Result:Normal",
    "X" * 10_000,  # A string of 10,000 characters.
]

for text in examples:
    h = sha256_of_string(text)
    print(f"  Input length : {len(text):>6} chars")
    print(f"  SHA-256 hash : {h}")
    print(f"  Hash length  : {len(h)} chars (always 66 including 0x prefix)")
    print()


# ── Demo 2: Avalanche effect — tiny change, massive hash difference ────────────

print_section("Demo 2: One-character change → completely different hash")

original  = "MEDICAL_RECORD|PatientID:P-1001|Diagnosis:Healthy"
modified  = "MEDICAL_RECORD|PatientID:P-1001|Diagnosis:Healthy!"  # Only ! added.

hash_orig = sha256_of_string(original)
hash_mod  = sha256_of_string(modified)

print(f"  Original  : {original}")
print(f"  Hash      : {hash_orig}")
print()
print(f"  Modified  : {modified}")
print(f"  Hash      : {hash_mod}")
print()
print(f"  Hashes match? {hash_orig == hash_mod}")
print(f"  This is the avalanche effect. Any change makes the hash unrecognizable.")


# ── Demo 3: Simulated file integrity check ─────────────────────────────────────

print_section("Demo 3: Simulated file integrity workflow")

# Create a temporary file representing a medical record.
with tempfile.NamedTemporaryFile(delete=False, suffix=".txt", mode="wb") as f:
    tmp_path = f.name
    f.write(b"PATIENT: Jane Doe\nDOB: 1990-04-22\nDIAGNOSIS: Healthy\nDOCTOR: Dr. Ahmed")

print(f"  Created demo file: {tmp_path}")

# Step 1: Hash the original file (simulates hospital registration).
with open(tmp_path, "rb") as f:
    original_bytes = f.read()

registered_hash = sha256_of_bytes(original_bytes)
print(f"\n  Step 1 — Hospital registers the file hash on-chain:")
print(f"    Hash: {registered_hash}")
print(f"    (Only this hash goes to the blockchain — the file stays here)")

# Step 2: Simulate a legitimate read — hash should match.
with open(tmp_path, "rb") as f:
    verify_bytes = f.read()

verify_hash = sha256_of_bytes(verify_bytes)
match = verify_hash == registered_hash
print(f"\n  Step 2 — Later, someone verifies the unmodified file:")
print(f"    Hash: {verify_hash}")
print(f"    Match: {match}  ← VALID: file has not been tampered with")

# Step 3: Simulate tampering — modify the file.
with open(tmp_path, "rb+") as f:
    content = f.read()
    f.seek(0)
    # Change "Healthy" to "Sick    " (same byte count, different content).
    f.write(content.replace(b"Healthy", b"Sick   "))

print(f"\n  Step 3 — An adversary modifies the file (changes 'Healthy' to 'Sick'):")

with open(tmp_path, "rb") as f:
    tampered_bytes = f.read()

tampered_hash = sha256_of_bytes(tampered_bytes)
tampered_match = tampered_hash == registered_hash
print(f"    Hash of tampered file: {tampered_hash}")
print(f"    Match: {tampered_match}  ← INVALID: tampering detected!")

# Clean up.
os.unlink(tmp_path)


# ── Demo 4: What the blockchain stores ────────────────────────────────────────

print_section("Demo 4: What is actually stored on-chain")

on_chain_record = {
    "fileHash":     registered_hash,
    "issuer":       "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "patientOwner": "0x0000000000000000000000000000000000000000",
    "label":        "BloodTest_Jane_2025-01-15",
    "issuedAt":     1736956800,
    "revoked":      False
}

print()
print("  On-chain record (this is ALL that is stored in the smart contract):")
print(json.dumps(on_chain_record, indent=4))
print()
print("  The actual medical file content is NEVER stored on the blockchain.")
print("  Privacy is preserved. Integrity is still provable.")


# ── Summary ────────────────────────────────────────────────────────────────────

print_section("Summary")
print("""
  The Medical Record Integrity Checker works because:

  1. SHA-256 is a one-way function: you cannot recover the file from the hash.
  2. SHA-256 is collision-resistant: two different files cannot produce the same hash.
  3. The blockchain is immutable: once a hash is registered, it cannot be changed.
  4. Combining these properties: if the hash matches, the file is authentic.
     If the hash does not match, the file has been modified.

  This is the foundation of the blockchain-based integrity verification system.
""")
