# Client-Side Signing with Thirdweb

## The Problem with Server-Side Presentations

When you create a wallet-based DID:

```javascript
// User's DID (wallet-based)
const userDID =
  "did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72";
```

The **user's wallet controls the private key**, not Veramo. So Veramo **cannot** create presentations on behalf of the user.

## The Decentralized Solution

The user's wallet should create and sign presentations **client-side**. The server only:

1. Issues credentials (signed by service)
2. Verifies presentations (stateless)

---

## Architecture Comparison

### ❌ Current (Server-Side - Centralized)

```
┌─────────┐                    ┌─────────┐
│  User   │──── Request ────────│ Server  │
│         │                     │         │
│         │                     │ Creates │
│         │                     │ & Signs │
│         │◄── Presentation ────│   VP    │
└─────────┘                    └─────────┘
           Server controls presentations
```

### ✅ Better (Client-Side - Decentralized)

```
┌─────────┐                    ┌─────────┐
│  User   │──── Get VC ─────────│ Server  │
│ Wallet  │◄─── JWT VC ─────────│         │
│         │                     │         │
│ Signs   │                     │         │
│   VP    │──── Verify VP ──────│ Verifies│
│Locally  │◄─── Result ─────────│   Only  │
└─────────┘                    └─────────┘
      User controls presentations
```

---

## Implementation with Thirdweb

### Step 1: Install Dependencies

```bash
npm install @veramo/core @veramo/credential-w3c ethers @thirdweb-dev/sdk
```

### Step 2: Client-Side Code (React + Thirdweb)

```typescript
// ClientSideVeramo.tsx
import { useAddress, useSigner } from "@thirdweb-dev/react";
import { ethers } from "ethers";

export function useClientSideCredentials() {
  const address = useAddress();
  const signer = useSigner();

  // 1. Create user's DID (wallet-based)
  const createUserDID = async () => {
    const response = await fetch("http://localhost:3000/did/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "did:ethr",
        walletAddress: address,
        network: "skale-titan",
      }),
    });
    const { identifier } = await response.json();
    return identifier.did; // did:ethr:skale-titan:0x...
  };

  // 2. Request credential from server (server signs as issuer)
  const requestCredential = async (userDID: string, data: any) => {
    const response = await fetch("http://localhost:3000/credential/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issuerDid: "did:key:z6Mkf...", // Service's issuer DID
        subjectDid: userDID,
        credentialSubject: data,
      }),
    });
    const { credential } = await response.json();
    return credential; // JWT string
  };

  // 3. Create presentation CLIENT-SIDE (user signs with wallet)
  const createPresentation = async (
    credential: string,
    holderDID: string,
    challenge?: string,
    domain?: string,
  ) => {
    if (!signer) throw new Error("Wallet not connected");

    // Build presentation payload
    const presentation = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiablePresentation"],
      holder: holderDID,
      verifiableCredential: [credential],
      ...(challenge && { proof: { challenge } }),
      ...(domain && { domain }),
    };

    // Create a message to sign
    const message = JSON.stringify(presentation);

    // Sign with user's wallet
    const signature = await signer.signMessage(message);

    // Create JWT-like presentation
    const header = { alg: "ES256K-R", typ: "JWT" };
    const payload = {
      vp: presentation,
      iss: holderDID,
      aud: domain,
      nonce: challenge,
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
    };

    // Base64url encode
    const base64url = (data: any) =>
      Buffer.from(JSON.stringify(data))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

    const jwtHeader = base64url(header);
    const jwtPayload = base64url(payload);

    // Append signature
    const jwtSignature = signature.replace("0x", "");

    const presentationJWT = `${jwtHeader}.${jwtPayload}.${jwtSignature}`;

    return presentationJWT;
  };

  // 4. Verify presentation (send to server)
  const verifyPresentation = async (presentation: string) => {
    const response = await fetch("http://localhost:3000/presentation/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presentation }),
    });
    return await response.json();
  };

  return {
    createUserDID,
    requestCredential,
    createPresentation,
    verifyPresentation,
  };
}
```

### Step 3: Usage Example

```typescript
// App.tsx
import { useClientSideCredentials } from './ClientSideVeramo';

function CredentialFlow() {
  const { createUserDID, requestCredential, createPresentation, verifyPresentation } =
    useClientSideCredentials();

  const handleGetCredential = async () => {
    // 1. Create user's DID
    const userDID = await createUserDID();
    console.log("User DID:", userDID);
    // Output: did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72

    // 2. Request credential from server
    const credential = await requestCredential(userDID, {
      name: "Alice Smith",
      degree: "Bachelor of Science",
      university: "Tech University"
    });
    console.log("Credential JWT:", credential);

    // 3. Store credential locally
    localStorage.setItem('myCredential', credential);
  };

  const handlePresentCredential = async () => {
    // 1. Retrieve stored credential
    const credential = localStorage.getItem('myCredential');
    if (!credential) return;

    // 2. Get user's DID
    const userDID = "did:ethr:skale-titan:0x8ba1f109551bD432803012645Ac136ddd64DBA72";

    // 3. Create presentation CLIENT-SIDE (user signs)
    const presentation = await createPresentation(
      credential,
      userDID,
      'random-challenge-123',
      'https://verifier.example.com'
    );
    console.log("Presentation:", presentation);

    // 4. Send to verifier
    const verification = await verifyPresentation(presentation);
    console.log("Verified:", verification.verified);
  };

  return (
    <div>
      <button onClick={handleGetCredential}>
        Request Credential
      </button>
      <button onClick={handlePresentCredential}>
        Present Credential (Client-Side Signing)
      </button>
    </div>
  );
}
```

---

## Simpler Alternative: Use ethers.js Directly

If you don't need full Veramo presentation format, you can create a simpler signed message:

```typescript
import { ethers } from "ethers";

async function createSimplePresentation(
  signer: ethers.Signer,
  credential: string,
  challenge: string,
) {
  const address = await signer.getAddress();
  const holderDID = `did:ethr:skale-titan:${address}`;

  // Create presentation object
  const presentation = {
    holder: holderDID,
    verifiableCredential: [credential],
    challenge: challenge,
    timestamp: Date.now(),
  };

  // Sign the presentation
  const message = JSON.stringify(presentation);
  const signature = await signer.signMessage(message);

  // Return presentation with signature
  return {
    ...presentation,
    proof: {
      type: "EcdsaSecp256k1Signature2019",
      created: new Date().toISOString(),
      proofPurpose: "authentication",
      verificationMethod: `${holderDID}#controller`,
      signature: signature,
    },
  };
}

// Usage
const presentation = await createSimplePresentation(
  signer,
  credentialJWT,
  "challenge-123",
);
```

---

## Server-Side Verification (No Changes Needed)

Your server already handles verification. It just needs to verify the signature:

```javascript
// Server already has this endpoint - no changes needed
POST /credential/verify
{
  "credential": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."
}

POST /presentation/verify
{
  "presentation": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ..."
}
```

The server verifies:

1. Credential signature (from issuer)
2. Presentation signature (from holder's wallet)
3. All are cryptographically valid

---

## Benefits of Client-Side Signing

| Aspect               | Server-Side               | Client-Side                 |
| -------------------- | ------------------------- | --------------------------- |
| **User Control**     | ❌ Server controls        | ✅ User controls            |
| **Privacy**          | ❌ Server sees everything | ✅ Minimal server knowledge |
| **Security**         | ❌ Server has keys        | ✅ Keys never leave wallet  |
| **Decentralization** | ❌ Centralized            | ✅ Truly decentralized      |
| **Scalability**      | ❌ Server signs all       | ✅ Client does the work     |

---

## Migration Path

### Phase 1: Keep Server-Side (Current)

Use server-managed DIDs for holders (generated-key or did:key)

### Phase 2: Hybrid Approach

- Server issues credentials (service DID)
- Client creates presentations (wallet DID)
- Server verifies both

### Phase 3: Full Decentralization (Goal)

- Server only verifies
- All signing happens client-side
- User controls everything

---

## Complete Example: Thirdweb Integration

```typescript
// hooks/useDecentralizedCredentials.ts
import { useAddress, useSigner } from "@thirdweb-dev/react";
import { ethers } from "ethers";

const API_BASE = "http://localhost:3000";

export function useDecentralizedCredentials() {
  const address = useAddress();
  const signer = useSigner();

  // Get user's DID
  const getUserDID = () => {
    if (!address) return null;
    return `did:ethr:skale-titan:${address}`;
  };

  // Request credential from issuer
  const requestCredential = async (credentialData: any) => {
    const userDID = getUserDID();
    if (!userDID) throw new Error("Wallet not connected");

    const response = await fetch(`${API_BASE}/credential/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issuerDid: 'did:key:YOUR_ISSUER_DID', // Your service DID
        subjectDid: userDID,
        credentialSubject: credentialData
      })
    });

    const { credential } = await response.json();
    return credential;
  };

  // Create presentation with wallet signature
  const createPresentation = async (credentials: string[], challenge?: string) => {
    if (!signer || !address) throw new Error("Wallet not connected");

    const holderDID = getUserDID();
    const presentation = {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiablePresentation"],
      holder: holderDID,
      verifiableCredential: credentials,
      challenge: challenge || `challenge-${Date.now()}`
    };

    // Sign with wallet
    const message = JSON.stringify(presentation);
    const signature = await signer.signMessage(message);

    return {
      ...presentation,
      proof: {
        type: "EthereumEip712Signature2021",
        created: new Date().toISOString(),
        proofPurpose: "authentication",
        verificationMethod: `${holderDID}#controller`,
        signature: signature
      }
    };
  };

  // Verify presentation
  const verifyPresentation = async (presentation: any) => {
    const response = await fetch(`${API_BASE}/presentation/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presentation })
    });
    return await response.json();
  };

  return {
    getUserDID,
    requestCredential,
    createPresentation,
    verifyPresentation
  };
}

// Component usage
function CredentialManager() {
  const { getUserDID, requestCredential, createPresentation } =
    useDecentralizedCredentials();
  const [credential, setCredential] = useState<string | null>(null);

  const handleGetCredential = async () => {
    const cred = await requestCredential({
      name: "Alice",
      achievement: "Completed Course"
    });
    setCredential(cred);
    console.log("Credential received:", cred);
  };

  const handlePresentCredential = async () => {
    if (!credential) return;

    // User signs presentation with their wallet
    const presentation = await createPresentation([credential]);
    console.log("Presentation created:", presentation);

    // Send to verifier...
  };

  return (
    <div>
      <p>Your DID: {getUserDID()}</p>
      <button onClick={handleGetCredential}>Get Credential</button>
      <button onClick={handlePresentCredential}>Present (Client-Side)</button>
    </div>
  );
}
```

---

## Summary

**The Answer to Your Question:**

You're absolutely right! The user's wallet-based DID **should** be the holder. The current server-side approach is limited because:

1. ❌ Server can't sign with user's wallet DID
2. ✅ **Solution:** Implement client-side signing (user's wallet signs)

**What You Need:**

- Server: Issues credentials (signs as issuer)
- Client: Creates presentations (user signs with wallet)
- Server: Verifies presentations (stateless)

This is the **truly decentralized** architecture where users control their identity and credentials via their wallet!
