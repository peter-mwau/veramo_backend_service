# Veramo Backend Service Examples

This document provides example API calls for the Veramo backend service.

## Prerequisites

1. Start the server: `npm start` or `npm run dev`
2. The server will be running on `http://localhost:3000`

## API Examples

### 1. Health Check

```bash
curl -X GET http://localhost:3000/health
```

### 2. Get Agent Information

```bash
curl -X GET http://localhost:3000/agent/info
```

### 3. Create a DID

There are three ways to create a DID depending on your use case:

#### Option A: Wallet-Based DID (Recommended for thirdweb) ⭐

This is the best approach for thirdweb integration. The DID is created from the user's existing wallet address. **The user's wallet private key controls the DID.**

```bash
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "did:ethr",
    "walletAddress": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "network": "skale-titan"
  }'
```

**Response:**

```json
{
  "success": true,
  "identifier": {
    "did": "did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "provider": "did:ethr",
    "walletAddress": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "network": "skale-titan"
  },
  "type": "wallet-based",
  "note": "This DID is linked to your wallet address. You control it with your wallet private key."
}
```

**Thirdweb Integration Pattern:**

```javascript
// In your frontend (thirdweb connected wallet)
const address = await signer.getAddress(); // Get user's address

// Call your backend
const response = await fetch("http://localhost:3000/did/create", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    provider: "did:ethr",
    walletAddress: address, // Pass the wallet address
    network: "skale-titan",
  }),
});

const { identifier } = await response.json();
const userDID = identifier.did; // did:ethr:skale-titan:0x...
```

#### Option B: Generated-Key DID (Veramo Controls Key)

Veramo generates a new key pair and stores it. **Veramo manages the private key**, not the user's wallet.

```bash
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "did:ethr"
  }'
```

**Response:**

```json
{
  "success": true,
  "identifier": {
    "did": "did:ethr:0x02eb2d6d726c01dd816cfa09823a946a28bb71ab072893db3a7a65545eec321fb4",
    "controllerKeyId": "04eb2d6d726c01dd816cfa09823a946a28bb71ab...",
    "keys": [...],
    "provider": "did:ethr"
  },
  "type": "generated-key",
  "note": "This DID uses a generated key. Veramo stores the private key.",
  "recommendation": "For production with thirdweb, use wallet-based DIDs"
}
```

**Note:** ⚠️ This creates a new public key and Veramo manages it. Not recommended for thirdweb integration unless you need Veramo to manage the keys.

#### Option C: Self-Issued DID (did:key)

Creates a decentralized identifier that doesn't require blockchain. Good for testing.

```bash
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "did:key",
    "alias": "my-test-did"
  }'
```

**Response:**

```json
{
  "success": true,
  "identifier": {
    "did": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "provider": "did:key"
  },
  "type": "self-issued",
  "note": "Self-issued DID using did:key method. No blockchain required."
}
```

### 4. List All DIDs

```bash
curl -X GET http://localhost:3000/did/list
```

### 5. Get Specific DID

```bash
curl -X GET http://localhost:3000/did/did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72
```

### 6. Resolve DID Document

Resolves the DID document from the blockchain:

```bash
curl -X GET http://localhost:3000/did/did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72/resolve
```

### 7. Create a Verifiable Credential

⚠️ **Important:** The issuer DID must be one that Veramo can sign with (has the private key). Use generated-key or did:key DIDs as issuers.

**Option A: Generated-Key DID as Issuer (Recommended)**

```bash
# First, create an issuer DID that Veramo manages
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "did:ethr",
    "alias": "credential-issuer"
  }'

# This returns a generated-key DID like: did:ethr:0x02eb2d6d...
# Now use it to create credentials

curl -X POST http://localhost:3000/credential/create \
  -H "Content-Type: application/json" \
  -d '{
    "issuerDid": "did:ethr:0x02eb2d6d726c01dd816cfa09823a946a28bb71ab072893db3a7a65545eec321fb4",
    "subjectDid": "did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "credentialSubject": {
      "name": "John Doe",
      "degree": "Bachelor of Science",
      "university": "Example University"
    },
    "type": ["VerifiableCredential", "UniversityDegreeCredential"]
  }'
```

**Option B: did:key as Issuer**

```bash
# Create a did:key issuer
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{"provider": "did:key"}'

# Use it to create credentials
curl -X POST http://localhost:3000/credential/create \
  -H "Content-Type: application/json" \
  -d '{
    "issuerDid": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "subjectDid": "did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "credentialSubject": {
      "name": "John Doe",
      "degree": "Bachelor of Science",
      "university": "Example University"
    },
    "type": ["VerifiableCredential", "UniversityDegreeCredential"]
  }'
```

**Note:** Wallet-based DIDs (did:ethr:network:0x...) cannot be used as issuers because Veramo doesn't have the private key. The user's wallet controls that key.

### 8. Verify a Verifiable Credential

Verification is **stateless** - no database lookup needed:

```bash
curl -X POST http://localhost:3000/credential/verify \
  -H "Content-Type: application/json" \
  -d '{
    "credential": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NksifQ..."
  }'
```

### 9. List All Credentials

```bash
curl -X GET http://localhost:3000/credential/list
```

**Note:** Only credentials created in the current session are listed (in-memory storage).

### 10. Create a Verifiable Presentation

⚠️ **Important:** The holder DID must be one that Veramo can sign with (has the private key). Use generated-key or did:key DIDs as holders.

```bash
# First, create a holder DID (or reuse an existing one)
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{"provider": "did:key"}'

# Get the credential JWT from the previous step
# Then create the presentation

curl -X POST http://localhost:3000/presentation/create \
  -H "Content-Type: application/json" \
  -d '{
    "holderDid": "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
    "verifiableCredentials": [
      "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ.eyJ2YyI6eyJAY29udGV4dCI6..."
    ],
    "type": ["VerifiablePresentation"],
    "domain": "example.com",
    "challenge": "random-challenge-string"
  }'
```

**Note:** If you want the user to control their presentations (true decentralization), you need to implement client-side signing where the user's wallet creates and signs the presentation. Server-side presentations require Veramo to have the private key.

### 11. Verify a Verifiable Presentation

```bash
curl -X POST http://localhost:3000/presentation/verify \
  -H "Content-Type: application/json" \
  -d '{
    "presentation": "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NksifQ...",
    "domain": "example.com",
    "challenge": "random-challenge-string"
  }'
```

### 12. List All Presentations

```bash
curl -X GET http://localhost:3000/presentation/list
```

## Recommended Workflow: Thirdweb Integration

1. **User connects wallet via thirdweb**

   ```javascript
   const { address } = useContract();
   ```

2. **Create wallet-based DID for user**

   ```bash
   POST /did/create
   {
     "provider": "did:ethr",
     "walletAddress": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
     "network": "skale-titan"
   }
   ```

   Result: `did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72` (user's identity)

3. **Create issuer DID** (for your service to sign credentials)

   ```bash
   POST /did/create
   {
     "provider": "did:ethr",
     "alias": "my-issuer-did"
   }
   ```

   Result: `did:ethr:0x02eb2d...` (issuer identity, Veramo manages key)

4. **Issue credential** (signed by issuer, about the user)

   ```bash
   POST /credential/create
   {
     "issuerDid": "did:ethr:0x02eb2d...",
     "subjectDid": "did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72",
     "credentialSubject": { ... }
   }
   ```

5. **Verification (stateless, no DB needed)**

   ```bash
   POST /credential/verify
   {
     "credential": "jwt-credential"
   }
   ```

6. **Store credentials client-side**
   - JWTs can be stored in localStorage, IndexedDB, or server database
   - Veramo doesn't need to store them

## Key Points

- **Wallet-based DIDs** (`did:ethr:network:0x...`) = User's blockchain identity (they control the key)
- **Generated-key DIDs** (`did:ethr:0x...`) = Service identity (Veramo controls the key)
- **did:key DIDs** = Ephemeral identities (no blockchain, good for testing)

**For issuing credentials:** Use generated-key or did:key DIDs because Veramo must have the private key to sign.
**For user identity:** Use wallet-based DIDs so users control their identity with their wallet private key.

## Architecture

- **DIDs**: Blockchain-based (did:ethr) or self-issued (did:key)
- **Credentials**: JWT tokens (JWTs), stored on client-side
- **Keys**: User controls wallet keys (for did:ethr with walletAddress)
- **Storage**: In-memory, ephemeral (no SQLite database)

## Response Format

All responses follow this format:

```json
{
  "success": true/false,
  "identifier": { ... },  // or "credential", "presentation", etc.
  "error": "error message if success is false"
}
```

## Complete Example Workflow

Here's a complete end-to-end example:

```bash
# 1. Create issuer DID (service/organization)
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{"provider": "did:key", "alias": "university-issuer"}'
# Response: {"identifier": {"did": "did:key:z6Mkf1aB..."}}

# 2. Create user wallet-based DID (subject)
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "did:ethr",
    "walletAddress": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "network": "skale-titan"
  }'
# Response: {"identifier": {"did": "did:ethr:skale-titan:0x8ba1f..."}}

# 3. Create holder DID (for presentations, if needed)
curl -X POST http://localhost:3000/did/create \
  -H "Content-Type: application/json" \
  -d '{"provider": "did:key", "alias": "credential-holder"}'
# Response: {"identifier": {"did": "did:key:z6MkiT..."}}

# 4. Issue credential
curl -X POST http://localhost:3000/credential/create \
  -H "Content-Type: application/json" \
  -d '{
    "issuerDid": "did:key:z6Mkf1aB...",
    "subjectDid": "did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "credentialSubject": {
      "name": "Alice Smith",
      "degree": "Bachelor of Science",
      "university": "Tech University"
    }
  }'
# Response: {"credential": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."}

# 5. Verify credential
curl -X POST http://localhost:3000/credential/verify \
  -H "Content-Type: application/json" \
  -d '{"credential": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."}'
# Response: {"verification": {"verified": true}}

# 6. Create presentation
curl -X POST http://localhost:3000/presentation/create \
  -H "Content-Type: application/json" \
  -d '{
    "holderDid": "did:key:z6MkiT...",
    "verifiableCredentials": ["eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."]
  }'
# Response: {"presentation": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."}

# 7. Verify presentation
curl -X POST http://localhost:3000/presentation/verify \
  -H "Content-Type: application/json" \
  -d '{"presentation": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."}'
# Response: {"verification": {"verified": true}}
```

## Summary: Which DID Type to Use

| Use Case                          | DID Type                 | Example                                 | Key Control |
| --------------------------------- | ------------------------ | --------------------------------------- | ----------- |
| **Issuer** (signs credentials)    | Generated-key or did:key | `did:ethr:0x02...` or `did:key:z6Mk...` | Veramo      |
| **Subject** (credential about)    | Wallet-based or any      | `did:ethr:skale-titan:0x8ba1f...`       | User        |
| **Holder** (presents credentials) | Generated-key or did:key | `did:key:z6Mk...`                       | Veramo      |

**The Pattern:**

- **Wallet-based DIDs** = User's blockchain identity (they control via wallet)
- **Generated-key/did:key DIDs** = Service-managed identity (Veramo controls)

For true user sovereignty, implement **client-side signing** where the user's wallet signs credentials and presentations.
