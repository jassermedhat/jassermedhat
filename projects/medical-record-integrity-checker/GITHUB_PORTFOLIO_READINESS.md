# GitHub Portfolio Readiness

## What Was Fixed

- Rewrote README and explanation docs to describe the project as an educational local Hardhat demo, not a production healthcare system.
- Added a clear security limitations section covering simulated accounts, trusted caller fields, and lack of production authentication.
- Changed API protected routes so missing `caller` returns `400` and unauthorized callers return `403`.
- Updated patient record routes so a patient can read only their own records unless the caller is staff/admin.
- Changed API writes to use the selected local Hardhat caller as the transaction signer, keeping API role checks aligned with contract `msg.sender`.
- Added `POST /api/records/revoke`.
- Added frontend revocation support for Doctor/Admin demo users.
- Standardized deploy samples and tests on SHA-256 with Node `crypto`.
- Reworked Docker Compose so the project runs standalone from the repository root.
- Added root `.gitignore` for generated Hardhat files, deployment JSON, node_modules, env files, and logs.
- Added portfolio screenshots under `docs/screenshots/` and embedded them in `README.md`.
- Added root npm convenience scripts.
- Polished `README.md` into the final public GitHub landing page.

## Remaining Limitations

- This is not production authentication. The API trusts a `caller` address and uses unlocked local Hardhat accounts.
- It must not be used with real medical data.
- On-chain labels, patient addresses, issuer addresses, hashes, and timestamps are visible to anyone with chain access.
- The local Hardhat deployment is ephemeral and should be redeployed after a node reset.
- The first Hardhat compile may need internet access to download Solidity 0.8.24.

## How To Run

Docker:

```bash
docker compose up --build
```

Manual:

```bash
cd blockchain
npm install
npm run node
```

In another terminal:

```bash
cd blockchain
npm run deploy:local
```

In another terminal:

```bash
cd api
npm install
$env:RPC_URL="http://127.0.0.1:8545"
$env:LAB_ROOT=".."
npm start
```

Serve `frontend/` on port `8084`, for example:

```bash
cd frontend
python -m http.server 8084
```

## Screenshots

Screenshots have been added under `docs/screenshots/` and linked from `README.md`:

- `dashboard.png`
- `register-record.png`
- `verify-valid.png`
- `verify-not-found.png`
- `patient-records.png`
- `staff-patient-viewer.png`
- `version-history.png`
- `revoke-record.png`

A short demo video can be added later as an optional portfolio improvement.

## Readiness

The code and documentation are ready to publish as a GitHub portfolio project for an educational local blockchain demo.

## Validation Performed

- `npm install` in `blockchain/`
- `npm install` in `api/`
- `npm test` in `blockchain/`: 16 passing tests
- `node --check api/src/server.js`
- `node --check frontend/app.js`
- `docker compose config`
- Local integration smoke test covering API health, accounts, missing caller `400`, patient privacy `403`, nurse patient lookup, doctor registration, and doctor revocation
- Generated local folders/files such as `node_modules`, Hardhat artifacts/cache, and `blockchain/deployments/localhost.json` are ignored and should not be committed
- Documentation validation confirmed README links and screenshot paths exist

## Validation Blocked Locally

- Full `docker compose up --build` could not be completed in this environment because the Docker Desktop Linux engine was not reachable (`dockerDesktopLinuxEngine` pipe not found). The compose file itself validated with `docker compose config`; full startup should be run on a machine with Docker Desktop running.
