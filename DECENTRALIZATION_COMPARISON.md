# Quick Comparison: Centralized vs Decentralized

## Feature Comparison Table

| Feature                     | Original (server.js)       | Decentralized (server-decentralized.js)      |
| --------------------------- | -------------------------- | -------------------------------------------- |
| **DID Creation**            | SQLite + Blockchain        | Blockchain only                              |
| **DID Resolution**          | SQLite lookup              | Blockchain query                             |
| **DID Persistence**         | Database                   | Blockchain (did:ethr) or ephemeral (did:key) |
| **VC Storage**              | SQLite database            | In-memory cache (temporary)                  |
| **VC Format**               | JWT (stored in DB)         | JWT (client-managed)                         |
| **VC Verification**         | DB query + crypto check    | Crypto check only (stateless)                |
| **Key Storage**             | Database (PrivateKeyStore) | External KMS / Environment / Client          |
| **Single Point of Failure** | Database                   | None (can run multiple instances)            |
| **Scalability**             | DB-bound                   | Unlimited horizontal scaling                 |
| **Privacy**                 | Server knows all data      | Server knows nothing (client-side keys)      |
| **Compliance**              | May violate privacy laws   | GDPR-friendly (no data storage)              |
| **Session Persistence**     | Across restarts            | Lost on restart (as intended)                |
| **Credential History**      | Searchable in DB           | Client manages (off-chain)                   |

---

## Use Case Recommendations

### ✅ Use **Original (server.js)** When:

- You need persistent credential history
- You want server-managed key storage
- Users need account-like functionality
- You're comfortable with centralization
- Regulatory compliance requires audit trails

### ✅ Use **Decentralized (server-decentralized.js)** When:

- You want true user sovereignty
- DIDs need blockchain persistence
- Credentials should be portable
- Scalability is critical
- Privacy is a requirement
- You want to avoid GDPR issues
- Multi-tenant or SaaS platform

---

## Migration: Original → Decentralized

If you want to gradually migrate:

### Phase 1: Hybrid Mode (Best Option)

```javascript
// Keep original database for backward compatibility
// But add decentralized endpoints alongside

// Old endpoints (database-backed)
app.post("/did/create", async (req, res) => {
  /* ... */
});

// New endpoints (blockchain-only)
app.post("/did/create/blockchain", async (req, res) => {
  /* ... */
});

// Users can choose which to use
```

### Phase 2: Migrate Credentials

```javascript
// Old: Store VCs in database
POST /credential/create → JWT stored in SQLite

// New: Return JWT only, client stores it
POST /credential/create → JWT returned to client

// Both endpoints coexist
```

### Phase 3: Optional: Database Become Analytics Only

```javascript
// Database no longer stores sensitive data
// Only logs analytics:
{
  timestamp,
  credentialType,
  verificationResult,
  // NOT: actual credentials, personal data
}
```

---

## Code Changes Required

### Minimal Changes (Use server-decentralized.js)

Just swap the server file:

```bash
mv server.js server-centralized.js
mv server-decentralized.js server.js
npm start
```

### To Enable Both (server.js + decentralized features)

```javascript
// In your server.js, add:

// In-memory VC store
const VCStore = {
  credentials: new Map(),
  saveCredential(id, cred) {
    /* ... */
  },
  getCredential(id) {
    /* ... */
  },
};

// Optional: Make both work
app.get("/mode", (req, res) => {
  res.json({
    mode: "hybrid",
    features: {
      database_storage: true,
      blockchain_did: true,
      stateless_vc: true,
      in_memory_cache: true,
    },
  });
});
```

---

## Key Management: Implementation Examples

### Example 1: Environment-Based (Development)

```javascript
// .env
ISSUER_KEY=0x123456...
HOLDER_KEY=0x789abc...

// Code
class KeyStore {
  async get(kid) {
    return process.env[`${kid.toUpperCase()}_KEY`];
  }
}
```

### Example 2: External KMS (Production)

```javascript
import AWS from "aws-sdk";

class AWSKMSStore {
  async get(kid) {
    const result = await kms
      .decrypt({
        CiphertextBlob: Buffer.from(kid, "base64"),
      })
      .promise();
    return result.Plaintext.toString();
  }
}
```

### Example 3: Hardware Wallet (Client-Side)

```javascript
// Browser code (client-side)
const provider = new ethers.BrowserSigner(window.ethereum);
const signer = provider.getSigner();

// Never expose key to server!
POST /credential/create {
  issuerAddress: await signer.getAddress(),
  // Sign credential client-side
  signature: await signer.signMessage(credentialJSON)
}
```

### Example 4: Encrypted Local Storage (Browser)

```javascript
// Client-side
const encryptedKey = encrypt(privateKey, userPassword);
localStorage.setItem('encryptedKey', encryptedKey);

// Never send to server
POST /credential/create {
  issuerDid: "did:key:...",  // Derived from local key
  // Signature created locally
}
```

---

## Testing Decentralized Mode

Create `test-decentralized.sh`:

```bash
#!/bin/bash

BASE_URL="http://localhost:3000"

echo "🧪 Testing Decentralized Veramo Setup"
echo ""

# Test 1: Health check
echo "1️⃣  Health Check"
curl -s $BASE_URL/health | jq .
echo ""

# Test 2: Create ethr DID
echo "2️⃣  Create did:ethr DID"
WALLET="0x742d35Cc6634C0532925a3b844Bc9e7595f42bE"
DID_RESPONSE=$(curl -s -X POST $BASE_URL/did/create \
  -H "Content-Type: application/json" \
  -d "{
    \"provider\": \"did:ethr\",
    \"walletAddress\": \"$WALLET\",
    \"network\": \"skale-titan\"
  }")
ISSUER_DID=$(echo $DID_RESPONSE | jq -r '.identifier.did')
echo $DID_RESPONSE | jq .
echo ""

# Test 3: Create did:key DID
echo "3️⃣  Create did:key DID"
KEY_RESPONSE=$(curl -s -X POST $BASE_URL/did/create \
  -H "Content-Type: application/json" \
  -d '{"provider": "did:key"}')
SUBJECT_DID=$(echo $KEY_RESPONSE | jq -r '.identifier.did')
echo $KEY_RESPONSE | jq .
echo ""

# Test 4: Create Credential
echo "4️⃣  Create Credential"
VC_RESPONSE=$(curl -s -X POST $BASE_URL/credential/create \
  -H "Content-Type: application/json" \
  -d "{
    \"issuerDid\": \"$ISSUER_DID\",
    \"subjectDid\": \"$SUBJECT_DID\",
    \"credentialSubject\": {
      \"skill\": \"blockchain\",
      \"level\": \"expert\"
    }
  }")
CREDENTIAL=$(echo $VC_RESPONSE | jq -r '.credential')
echo $VC_RESPONSE | jq .
echo ""

# Test 5: Verify Credential (Stateless!)
echo "5️⃣  Verify Credential (NO DATABASE)"
curl -s -X POST $BASE_URL/credential/verify \
  -H "Content-Type: application/json" \
  -d "{
    \"credential\": \"$CREDENTIAL\"
  }" | jq .
echo ""

# Test 6: Resolve DID
echo "6️⃣  Resolve DID from Blockchain"
curl -s -X GET "$BASE_URL/did/$ISSUER_DID/resolve" | jq .
echo ""

echo "✅ Decentralized tests complete!"
echo "✅ No database was touched!"
```

Run with:

```bash
chmod +x test-decentralized.sh
npm start  # In one terminal
./test-decentralized.sh  # In another
```

---

## Troubleshooting

### Issue: "DID not found in this session"

**Solution:** did:key DIDs are ephemeral. Use did:ethr for permanent DIDs:

```javascript
// Instead of did:key
{
  "provider": "did:ethr",
  "walletAddress": "0x..."
}
```

### Issue: Credentials not persisting after restart

**Solution:** This is intentional. For persistence:

```javascript
// Save credential to client (localStorage, file, etc.)
const credential = response.credential;
localStorage.setItem('myCredential', JSON.stringify(credential));

// Later, retrieve and verify
const credential = JSON.parse(localStorage.getItem('myCredential'));
POST /credential/verify { credential }
```

### Issue: "Key not found"

**Solution:** Implement key management. See examples above.

---

## Next Steps

1. **Review** [DECENTRALIZATION_GUIDE.md](DECENTRALIZATION_GUIDE.md) for architectural details
2. **Deploy** server-decentralized.js to test
3. **Implement** key management solution (KMS, env vars, or client-side)
4. **Migrate** client code to handle JWT credentials
5. **Monitor** blockchain RPC calls for rate limits

---

## Resources

- [Veramo Documentation](https://veramo.io/)
- [ERC-1056 Spec (ethr DIDs)](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1056.md)
- [DID Specification (W3C)](https://www.w3.org/TR/did-core/)
- [Verifiable Credentials (W3C)](https://www.w3.org/TR/vc-data-model/)
