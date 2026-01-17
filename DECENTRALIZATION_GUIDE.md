# Decentralization Architecture Guide

## Overview

This guide explains how to decentralize your Veramo implementation by removing database dependency and moving towards a blockchain-first architecture.

---

## Current Architecture Issues (Original)

Your `server.js` relies on a **centralized SQLite database** for:

1. ✗ **Private Key Storage** - Keys stored in `PrivateKeyStore`
2. ✗ **DID Storage** - DIDs stored in `DIDStore`
3. ✗ **Credential Storage** - VCs stored in database
4. ✗ **Single point of failure** - Database down = service down

---

## Decentralized Architecture (New)

### What CAN be Decentralized

#### 1. **DID Creation & Resolution** ✅ FULLY DECENTRALIZED

- **did:ethr** - Fully blockchain-based
  - DIDs live on Ethereum/SKALE network
  - No database storage needed
  - Public and verifiable
  - Uses ERC1056 smart contract

- **did:key** - Self-issued, no blockchain needed
  - Pure cryptographic DIDs
  - No registry required
  - Instant creation
  - Not blockchain-backed but stateless

**Why it works without DB:**

- DID documents are resolved from blockchain state
- No need to persist DID metadata locally
- Resolution is on-demand query to blockchain

```
User → Create DID → Blockchain → Resolve DID ← Blockchain
       (no DB)                    (no DB)
```

#### 2. **Verifiable Credentials (VCs)** ✅ STATELESS

- VCs are **JWTs** - cryptographic tokens
- No database storage required
- Can be:
  - Generated on-demand
  - Stored client-side
  - Shared directly between parties
  - Verified without a database

**Why it works without DB:**

- Verification is purely cryptographic
- JWT signature proves authenticity
- No need to look up issuer in database
- Issuer identity resolved from blockchain

```
Issuer → Create VC (JWT) → Share with Holder → Verify Signature
         (no DB)                                 (no DB needed)
```

#### 3. **Verifiable Presentations** ✅ STATELESS

- PresentationsBundle credentials with holder proof
- Ephemeral, created for specific purpose
- No storage needed

### What REQUIRES Careful Handling

#### **Private Keys** ⚠️ CRITICAL

Keys must be stored SOMEWHERE securely. Options:

| Method                           | Best For                   | Trade-off                     |
| -------------------------------- | -------------------------- | ----------------------------- |
| **Environment Variables**        | Development, simple server | Exposed in logs, not scalable |
| **Hardware Wallets**             | Client-side, high security | Requires user setup           |
| **Key Management Service (KMS)** | Production                 | Adds external dependency      |
| **Encrypted Client Storage**     | Browser, mobile            | User responsible for backup   |
| **Custodial Service**            | Ease of use                | Trust third party             |

---

## Architecture Comparison

### Original (Centralized - server.js)

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
┌──────▼──────────────┐
│  Express Server     │
├─────────────────────┤
│  ┌───────────────┐  │
│  │  Veramo Agent │  │
│  └───────┬───────┘  │
│          │          │
│    ┌─────▼─────┐    │
│    │  SQLite   │    │
│    │ Database  │    │
│    └───────────┘    │
└─────────────────────┘
       │
┌──────▼──────────────┐
│  Blockchain (RPC)   │
│  (Only for DIDs)    │
└─────────────────────┘
```

### Decentralized (server-decentralized.js)

```
┌─────────────┐       ┌─────────────────┐
│   Client    │       │  Key Management │
└──────┬──────┘       │  (Encrypted)    │
       │              └─────────────────┘
       │                     ▲
┌──────▼──────────────┐      │
│  Express Server     │      │
├─────────────────────┤      │
│  ┌───────────────┐  │      │
│  │  Veramo Agent │──┼──────┘
│  └───────┬───────┘  │
│          │          │
│   In-Memory Cache   │  ← VCs stored temporarily
│   (ephemeral)       │    (pass to client)
│                     │
└─────────────┬───────┘
              │
    ┌─────────▼──────────┐
    │  Blockchain (RPC)  │
    │  ┌──────────────┐  │
    │  │ ERC1056 Reg. │  │
    │  └──────────────┘  │
    │   DIDs live here   │
    └────────────────────┘
```

---

## Implementation Patterns

### Pattern 1: DIDs on Blockchain (did:ethr)

```javascript
// Create DID directly from Ethereum address
POST /did/create
{
  "provider": "did:ethr",
  "walletAddress": "0x...",
  "network": "skale-titan"
}

// Response:
{
  "identifier": {
    "did": "did:ethr:skale-titan:0x...",
    "provider": "did:ethr"
  },
  "stored": "blockchain (no central database)"
}

// Resolve DID directly from blockchain
GET /did/did:ethr:skale-titan:0x.../resolve
// No database lookup, pure blockchain query
```

### Pattern 2: Self-Issued DIDs (did:key)

```javascript
// Create ephemeral DID, valid only in this session
POST /did/create
{
  "provider": "did:key"
}

// Response:
{
  "identifier": {
    "did": "did:key:z6MkhaXgBZDvotzL...",
    "provider": "did:key"
  },
  "stored": "in-memory (ephemeral)"
}
// Recreate on client as needed (no backend persistence)
```

### Pattern 3: VCs as JWTs (Client-Managed)

```javascript
// Issue credential
POST /credential/create
{
  "issuerDid": "did:ethr:...",
  "subjectDid": "did:key:...",
  "credentialSubject": {
    "degree": "Bachelor of Science",
    "university": "MIT"
  }
}

// Response: JWT credential
{
  "credential": "eyJhbGc...",  // JWT as string
  "credentialId": "cred-123",
  "storage": "in-memory (temporary, pass to client for persistence)"
}

// Client stores JWT and passes it for verification
POST /credential/verify
{
  "credential": "eyJhbGc..."  // JWT can come from anywhere
}

// Verification is stateless: just cryptographic validation
```

### Pattern 4: Presentations for Authentication

```javascript
// Client creates presentation with credentials
POST /presentation/create
{
  "holderDid": "did:key:...",
  "verifiableCredentials": [
    "eyJhbGc...",  // JWT credentials
    "eyJhbGc..."
  ]
}

// Response: Presentation JWT
{
  "presentation": "eyJhbGc...",
  "presentationId": "pres-123",
  "storage": "in-memory (temporary)"
}

// Verifier receives JWT and verifies cryptographically
POST /presentation/verify
{
  "presentation": "eyJhbGc...",
  "domain": "example.com",
  "challenge": "123abc"
}
```

---

## Key Management Solutions

### Option 1: Environment Variables (Development)

```bash
# .env
KEY_ISSUER=0xprivatekey...
KEY_HOLDER=0xprivatekey...
```

```javascript
// Retrieve from process.env
async get(kid) {
  return process.env[`KEY_${kid}`];
}
```

**Pros:** Simple, works quickly  
**Cons:** Not production-ready, security risk, logging exposure

---

### Option 2: Hardware Wallets (Client-Side)

```javascript
// Client-side with ethers.js + Metamask
const signer = await ethers.getSigner();
const did = `did:ethr:${network}:${await signer.getAddress()}`;

// Server never sees the key
// Client signs credentials and presentations
```

**Pros:** Maximum security, user-controlled  
**Cons:** Requires user setup, browser-only

---

### Option 3: External Key Management Service

```javascript
// Replace with your KMS (AWS KMS, Azure Key Vault, etc.)
class ExternalKMS extends Map {
  async get(kid) {
    return await kmsService.getKey(kid);
  }

  async import(key) {
    return await kmsService.storeKey(key);
  }
}
```

**Pros:** Production-grade, enterprise support  
**Cons:** External dependency, added complexity

---

### Option 4: Client-Side Wallet Management

```javascript
// Client manages its own DIDs and credentials
const wallet = new ethers.Wallet(privateKey);
const did = `did:ethr:${network}:${wallet.address}`;

// All key operations happen on client
// Server only verifies signatures
```

**Pros:** True decentralization  
**Cons:** User responsibility for key backup

---

## Migration Path

### Step 1: Remove Database Dependency

✅ Use provided `server-decentralized.js`

- In-memory stores replace database
- DIDs resolve from blockchain
- VCs are stateless JWTs

### Step 2: Move to Client-Side Key Management

```javascript
// Client signs all operations
// Server only verifies
POST /credential/verify
{
  "credential": "jwt-from-client",
  "issuerAddress": "0x...",
  "signature": "signature-from-client"
}
```

### Step 3: Full Decentralization (Optional)

```javascript
// Server becomes just an RPC aggregator
// All logic moves to client
// Server is replaceable/redundant
```

---

## Data Flow Examples

### Creating and Verifying a Credential (Decentralized)

```
┌───────┐
│Client │
└───┬───┘
    │
    ├─1. POST /did/create (from Ethereum address)
    │   ↓ (No DB needed)
    │   Create DID from wallet
    │
    ├─2. POST /credential/create (JWT)
    │   ↓ (No DB needed)
    │   Returns JWT credential
    │
    ├─3. Client stores credential (localStorage, file, etc.)
    │
    ├─4. POST /credential/verify (with JWT)
    │   ↓ (No DB needed, pure crypto verification)
    │   Verify signature cryptographically
    │   └─ Resolve issuer DID from blockchain
    │
    └─5. Response: Verified ✅

// Result: No centralized database ever touched!
```

---

## What You Lose vs Gain

### You Lose:

- ❌ Persistent credential history in database
- ❌ Searchable credentials by owner
- ❌ Backup of DIDs per server
- ❌ Query credentials with complex filters

### You Gain:

- ✅ No single point of failure
- ✅ No database security liability
- ✅ Scalability (no DB bottleneck)
- ✅ True user ownership (keys on client)
- ✅ Compliance-friendly (no data storage)
- ✅ Censorship-resistant
- ✅ Sovereignty (users control their data)
- ✅ Interoperability (open protocols, no lock-in)

---

## Recommended Setup for Production

```javascript
// Hybrid approach: Best of both worlds

// 1. Blockchain for DIDs (permanent, public)
// 2. Client-side for VCs (user-managed, encrypted)
// 3. Server as stateless verifier only
// 4. Optional: Database for analytics (not credentials)

app.post("/credential/verify", async (req, res) => {
  // 1. Verify credential signature (stateless)
  const verified = await agent.verifyCredential({ credential });

  // 2. Optional: Log to analytics database (not PII)
  await analyticsDB.log({
    timestamp: new Date(),
    credentialType: verified.vc.type,
    // DON'T store: actual credentials, personal data
  });

  return res.json({ verified });
});
```

---

## Testing the Decentralized Setup

```bash
# 1. Start server
npm start # uses server-decentralized.js

# 2. Create DID from wallet
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "did:ethr",
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
    "network": "skale-titan"
  }'

# 3. Create credential
curl -X POST http://localhost:3000/credential/create \
  -H "Content-Type: application/json" \
  -d '{
    "issuerDid": "did:ethr:skale-titan:0x742d...",
    "subjectDid": "did:key:z6MkhaXgBZDvotzL...",
    "credentialSubject": {"skill": "blockchain"}
  }'

# 4. Verify credential (no DB lookup)
curl -X POST http://localhost:3000/credential/verify \
  -H "Content-Type: application/json" \
  -d '{
    "credential": "eyJhbGc..."
  }'

# No database touched! ✅
```

---

## Summary

Your can achieve true decentralization by:

1. **DIDs**: Use blockchain (did:ethr) for everything that needs persistence
2. **Credentials**: Keep as JWTs, store on client, verify stateless
3. **Keys**: Manage client-side or with external KMS
4. **Server**: Pure API layer, stateless, replaceable

This gives you scalability, security, and user sovereignty without sacrificing functionality.
