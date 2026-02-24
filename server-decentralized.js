// src/veramo-ethr-did/server-decentralized.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { createAgent } from "@veramo/core";
import { CredentialPlugin } from "@veramo/credential-w3c";
import { KeyStore, PrivateKeyStore, DIDStore, Entities } from "@veramo/data-store";
import { DIDManager } from "@veramo/did-manager";
import { EthrDIDProvider } from "@veramo/did-provider-ethr";
import { KeyDIDProvider } from "@veramo/did-provider-key";
import { DIDResolverPlugin } from "@veramo/did-resolver";
import { KeyManager } from "@veramo/key-manager";
import { KeyManagementSystem, SecretBox } from "@veramo/kms-local";
import { MessageHandler } from "@veramo/message-handler";
import { createConnection, EntitySchema } from "typeorm";
import { Resolver } from "did-resolver";
import { getResolver as ethrDidResolver } from "ethr-did-resolver";
import { getResolver as keyDidResolver } from "key-did-resolver";
import { randomBytes } from "crypto";

// -------------------------
// EntitySchemas (SQL Persistence)
// -------------------------

const CredentialEntity = new EntitySchema({
  name: "credential",
  tableName: "credentials",
  columns: {
    id: { primary: true, type: Number, generated: true },
    credentialId: { type: String, unique: true },
    credential: { type: "simple-json" },
    createdAt: { type: Date, createDate: true },
  },
});

const PresentationEntity = new EntitySchema({
  name: "presentation",
  tableName: "presentations",
  columns: {
    id: { primary: true, type: Number, generated: true },
    presentationId: { type: String, unique: true },
    presentation: { type: "simple-json" },
    createdAt: { type: Date, createDate: true },
  },
});

// Share / ephemeral link entity
const ShareEntity = new EntitySchema({
  name: "share",
  tableName: "shares",
  columns: {
    id: { primary: true, type: Number, generated: true },
    token: { type: String, unique: true },
    presentationId: { type: String },
    ownerDid: { type: String, nullable: true },
    payload: { type: "simple-json" }, // store presentation snapshot
    expiresAt: { type: Date },
    createdAt: { type: Date, createDate: true },
  },
});

// NEW: VP presentation table storing issuer DID + holder DID
const VPPresentationEntity = new EntitySchema({
  name: "vp_presentation",
  tableName: "vp_presentations",
  columns: {
    id: { primary: true, type: Number, generated: true },

    presentationId: { type: String, unique: true },

    ownerDid: { type: String, nullable: true, index: true },

    holderDid: { type: String },

    issuerDid: { type: String },

    presentation: { type: "simple-json" },

    createdAt: { type: Date, createDate: true },
  },
});

// -------------------------
// In-memory fallback stores
// -------------------------

const VCStore = {
  credentials: new Map(),
  presentations: new Map(),

  saveCredential(id, credential) {
    this.credentials.set(id, { credential, timestamp: new Date().toISOString() });
    return id;
  },

  getCredential(id) {
    return this.credentials.get(id);
  },

  getAllCredentials() {
    return Array.from(this.credentials.values()).map((item) => item.credential);
  },

  savePresentation(id, presentation) {
    this.presentations.set(id, { presentation, timestamp: new Date().toISOString() });
    return id;
  },

  getPresentation(id) {
    return this.presentations.get(id);
  },

  getAllPresentations() {
    return Array.from(this.presentations.values()).map((item) => item.presentation);
  },
};

// In-memory DID registry (session-only)
const DIDRegistry = {
  dids: new Map(),

  registerDID(did, metadata = {}) {
    this.dids.set(did, {
      did,
      createdAt: new Date().toISOString(),
      ...metadata,
    });
    return did;
  },

  getDID(did) {
    return this.dids.get(did);
  },

  getAllDIDs() {
    return Array.from(this.dids.values());
  },

  isDIDRegistered(did) {
    return this.dids.has(did);
  },
};

// -------------------------
// Network Configuration
// -------------------------

const SKALE_TITAN_CONFIG = {
  name: "skale-titan",
  chainId: 1020352220,
  rpcUrl: "https://testnet.skalenodes.com/v1/aware-fake-trim-testnet",
  registry: process.env.ETH_REGISTRY_ADDRESS || "0x0979446EB2A4a373eaA702336aC3c390B0139Fc5",
};

const NETWORK_CONFIGS = {
  "skale-titan": SKALE_TITAN_CONFIG,
  skale: SKALE_TITAN_CONFIG,
  sepolia: {
    name: "sepolia",
    chainId: 11155111,
    rpcUrl:
      process.env.ETH_PROVIDER_URL_SEPOLIA ||
      "https://sepolia.infura.io/v3/189303beb46d46d8a0327f90f441168d",
    registry: process.env.ETH_REGISTRY_ADDRESS_SEPOLIA || "0xc0660d54f4655dC3B045D69ced4308f1709FD35e",
  },
};

const getNetworkConfig = () => {
  const networkName = process.env.ETH_NETWORK || "skale-titan";
  const config = NETWORK_CONFIGS[networkName] || SKALE_TITAN_CONFIG;

  return {
    name: config.name,
    rpcUrl: process.env.ETH_PROVIDER_URL || config.rpcUrl,
    registry: process.env.ETH_REGISTRY_ADDRESS || config.registry,
    chainId: config.chainId,
  };
};

// -------------------------
// Registry contract deployment check
// -------------------------

async function checkRegistryDeployment(networkConfig) {
  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);

    const code = await provider.getCode(networkConfig.registry);
    const isDeployed = code && code !== "0x";

    console.log(
      `Registry ${networkConfig.registry} on ${networkConfig.name}:`,
      isDeployed ? "✅ Deployed" : "❌ Not deployed or no code"
    );

    if (!isDeployed && networkConfig.name === "skale-titan") {
      const knownRegistries = [
        "0xdca7ef03e98e0dc2b855be647c39abe984fcf21b",
        "0xd1d374dda6c5e1c0fd927de1c6c0e9cb7d7f12d3",
        "0x0000000000000000000000000000000000000000",
      ];

      for (const registry of knownRegistries) {
        try {
          const registryCode = await provider.getCode(registry);
          const registryDeployed = registryCode && registryCode !== "0x";

          if (registryDeployed) {
            console.log(`Found working registry at: ${registry}`);
            return { isDeployed: true, registry };
          }
        } catch (err) {
          console.log(`Failed to check registry ${registry}:`, err.message);
        }
      }
    }

    return { isDeployed, registry: networkConfig.registry };
  } catch (error) {
    console.error(`Error checking registry deployment:`, error.message);
    return { isDeployed: false, registry: networkConfig.registry };
  }
}

// -------------------------
// VP Issuer DID extractor
// -------------------------

function extractIssuerDidFromCredentials(verifiableCredentials) {
  try {
    if (!Array.isArray(verifiableCredentials)) return null;

    for (const vc of verifiableCredentials) {
      // VC is object
      if (vc && typeof vc === "object") {
        if (vc.issuer) {
          if (typeof vc.issuer === "string") return vc.issuer;
          if (typeof vc.issuer === "object" && vc.issuer.id) return vc.issuer.id;
        }
      }

      // VC is compact JWT
      if (typeof vc === "string" && vc.split(".").length === 3) {
        const payload = JSON.parse(Buffer.from(vc.split(".")[1], "base64").toString());
        if (payload.iss) return payload.iss;
      }
    }

    return null;
  } catch (err) {
    console.warn("Failed to extract issuer DID:", err.message);
    return null;
  }
}

// -------------------------
// Express app setup
// -------------------------

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

let agent;
let dbConnection;

const SECRET_KEY =
  process.env.SECRET_KEY ||
  "3c186fb58980777698bab8e95f010f40fd0d04e14de8f49b551108351aefaf28";

// -------------------------
// DB helper wrapper
// -------------------------

const DB = {
  async saveCredentialToDB(credentialId, credential) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(CredentialEntity);
      const entity = repo.create({ credentialId, credential });
      await repo.save(entity);
      return credentialId;
    } catch (e) {
      console.warn("saveCredentialToDB fallback to in-memory:", e.message);
      return VCStore.saveCredential(credentialId, credential);
    }
  },

  async getCredentialFromDB(credentialId) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(CredentialEntity);
      const entity = await repo.findOne({ where: { credentialId } });
      return entity ? entity.credential : null;
    } catch (e) {
      console.warn("getCredentialFromDB fallback to in-memory:", e.message);
      const found = VCStore.getCredential(credentialId);
      return found ? found.credential : null;
    }
  },

  async getAllCredentialsFromDB() {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(CredentialEntity);
      const rows = await repo.find({ order: { id: "DESC" } });
      return rows.map((r) => r.credential);
    } catch (e) {
      console.warn("getAllCredentialsFromDB fallback to in-memory:", e.message);
      return VCStore.getAllCredentials();
    }
  },

  async savePresentationToDB(presentationId, presentation) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(PresentationEntity);
      const entity = repo.create({ presentationId, presentation });
      await repo.save(entity);
      return presentationId;
    } catch (e) {
      console.warn("savePresentationToDB fallback to in-memory:", e.message);
      return VCStore.savePresentation(presentationId, presentation);
    }
  },

  async getPresentationFromDB(presentationId) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(PresentationEntity);
      const entity = await repo.findOne({ where: { presentationId } });
      return entity ? entity.presentation : null;
    } catch (e) {
      console.warn("getPresentationFromDB fallback to in-memory:", e.message);
      const found = VCStore.getPresentation(presentationId);
      return found ? found.presentation : null;
    }
  },

  async getAllPresentationsFromDB() {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(PresentationEntity);
      const rows = await repo.find({ order: { id: "DESC" } });
      return rows.map((r) => r.presentation);
    } catch (e) {
      console.warn("getAllPresentationsFromDB fallback to in-memory:", e.message);
      return VCStore.getAllPresentations();
    }
  },

  // NEW: save VP + issuer DID + holder DID
  async saveVPPresentationToDB(presentationId, ownerDid, holderDid, issuerDid, presentation) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");

      const repo = dbConnection.getRepository(VPPresentationEntity);

      const entity = repo.create({
        presentationId,
        ownerDid,
        holderDid,
        issuerDid,
        presentation,
      });

      await repo.save(entity);

      return presentationId;
    } catch (e) {
      console.warn("saveVPPresentationToDB failed:", e.message);
      return presentationId;
    }
  },

  async getVPPresentationsByOwner(ownerDid) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(VPPresentationEntity);
      const rows = await repo.find({
        where: { ownerDid },
        order: { id: "DESC" },
      });
      return rows;
    } catch (e) {
      console.warn("getVPPresentationsByOwner failed:", e.message);
      return [];
    }
  },

  async getAllVPPresentations() {
    try {
      if (!dbConnection) throw new Error("DB not initialized");

      const repo = dbConnection.getRepository(VPPresentationEntity);
      const rows = await repo.find({ order: { id: "DESC" } });

      return rows;
    } catch (e) {
      console.warn("getAllVPPresentations failed:", e.message);
      return [];
    }
  },

  async getVPPresentationsByIssuer(issuerDid) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");

      const repo = dbConnection.getRepository(VPPresentationEntity);

      const rows = await repo.find({
        where: { issuerDid },
        order: { id: "DESC" },
      });

      return rows;
    } catch (e) {
      console.warn("getVPPresentationsByIssuer failed:", e.message);
      return [];
    }
  },

  // Save share record (token, payload, expiry)
  async saveShareToDB(token, presentationId, ownerDid, payload, expiresAt) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(ShareEntity);
      const entity = repo.create({
        token,
        presentationId,
        ownerDid,
        payload,
        expiresAt,
      });
      await repo.save(entity);
      return token;
    } catch (e) {
      console.warn("saveShareToDB failed:", e.message);
      throw e;
    }
  },

  // Retrieve share record by token
  async getShareByToken(token) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(ShareEntity);
      const entity = await repo.findOne({ where: { token } });
      return entity || null;
    } catch (e) {
      console.warn("getShareByToken failed:", e.message);
      return null;
    }
  },

  // Delete (revoke) a share by token
  async revokeShare(token) {
    try {
      if (!dbConnection) throw new Error("DB not initialized");
      const repo = dbConnection.getRepository(ShareEntity);
      const r = await repo.delete({ token });
      return r.affected > 0;
    } catch (e) {
      console.warn("revokeShare failed:", e.message);
      return false;
    }
  },
};

// -------------------------
// Initialize Veramo agent + SQLite DB
// -------------------------

async function initializeAgent() {
  try {
    dbConnection = await createConnection({
      type: "sqlite",
      database: process.env.SQLITE_DB_PATH || "./veramo.sqlite",
      synchronize: true,
      logging: false,
      entities: [...Entities, CredentialEntity, PresentationEntity, VPPresentationEntity, VPPresentationEntity, ShareEntity],
    });

    console.log("SQLite database initialized:", process.env.SQLITE_DB_PATH || "./veramo.sqlite");

    const networkConfig = getNetworkConfig();
    console.log("Using network configuration:", networkConfig);

    const registryCheck = await checkRegistryDeployment(networkConfig);
    const actualRegistry = registryCheck.registry;

    if (!registryCheck.isDeployed) {
      console.warn(`⚠️  Warning: ERC1056 registry not found at ${networkConfig.registry} on ${networkConfig.name}`);
    }

    agent = createAgent({
      plugins: [
        new KeyManager({
          store: new KeyStore(dbConnection),
          kms: {
            local: new KeyManagementSystem(new PrivateKeyStore(dbConnection, new SecretBox(SECRET_KEY))),
          },
        }),

        new DIDManager({
          store: new DIDStore(dbConnection),
          defaultProvider: "did:key",
          providers: {
            "did:ethr": new EthrDIDProvider({
              defaultKms: "local",
              network: networkConfig.name,
              rpcUrl: networkConfig.rpcUrl,
              registry: actualRegistry,
            }),
            "did:key": new KeyDIDProvider({ defaultKms: "local" }),
          },
        }),

        new DIDResolverPlugin({
          resolver: new Resolver({
            ...ethrDidResolver({
              networks: [
                {
                  name: "skale-titan",
                  rpcUrl: NETWORK_CONFIGS["skale-titan"].rpcUrl,
                  registry: NETWORK_CONFIGS["skale-titan"].registry,
                },
                {
                  name: "skale",
                  rpcUrl: NETWORK_CONFIGS["skale-titan"].rpcUrl,
                  registry: NETWORK_CONFIGS["skale-titan"].registry,
                },
                {
                  name: "sepolia",
                  rpcUrl: NETWORK_CONFIGS["sepolia"].rpcUrl,
                  registry: NETWORK_CONFIGS["sepolia"].registry,
                },
              ],
            }),
            ...keyDidResolver(),
          }),
        }),

        new CredentialPlugin(),

        new MessageHandler({ messageHandlers: [] }),
      ],
    });

    console.log("✅ Veramo agent initialized successfully");
  } catch (error) {
    console.error("❌ Error initializing agent:", error);
    process.exit(1);
  }
}

// -------------------------
// Routes
// -------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Veramo Backend Service (Decentralized) is running",
    database: process.env.SQLITE_DB_PATH || "./veramo.sqlite",
    timestamp: new Date().toISOString(),
  });
});

app.get("/agent/info", async (req, res) => {
  try {
    const methods = agent ? await agent.availableMethods() : [];
    res.json({
      availableMethods: methods,
      architecture: "Decentralized - Blockchain + SQLite persistence",
      features: {
        did_creation: "ethr + key DIDs",
        did_resolution: "blockchain resolution",
        vc_storage: "sqlite",
        vp_storage: "sqlite + issuer DID storage",
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/network/status", async (req, res) => {
  try {
    const networkConfig = getNetworkConfig();
    const registryCheck = await checkRegistryDeployment(networkConfig);

    res.json({
      success: true,
      network: {
        name: networkConfig.name,
        chainId: networkConfig.chainId,
        rpcUrl: networkConfig.rpcUrl,
        registry: networkConfig.registry,
        registryDeployed: registryCheck,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------------
// DID ROUTES
// -------------------------

app.post("/did/create", async (req, res) => {
  try {
    const { provider = "did:key", alias, walletAddress, network } = req.body;

    if (provider === "did:ethr" && walletAddress) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        return res.status(400).json({
          success: false,
          error: "Invalid Ethereum wallet address format",
        });
      }

      const networkConfig = getNetworkConfig();
      const targetNetwork = network || networkConfig.name;

      const didIdentifier = `did:ethr:${targetNetwork}:${walletAddress}`;

      if (DIDRegistry.isDIDRegistered(didIdentifier)) {
        const existing = DIDRegistry.getDID(didIdentifier);
        return res.json({
          success: true,
          identifier: existing,
          message: "Wallet-based DID already exists",
        });
      }

      DIDRegistry.registerDID(didIdentifier, {
        did: didIdentifier,
        provider: "did:ethr",
        walletAddress,
        network: targetNetwork,
        alias: alias || `wallet-${walletAddress.slice(0, 10)}`,
      });

      return res.json({
        success: true,
        identifier: {
          did: didIdentifier,
          provider: "did:ethr",
          walletAddress,
          network: targetNetwork,
        },
        message: "Wallet-based DID created successfully",
      });
    }

    if (provider === "did:ethr" && !walletAddress) {
      const networkConfig = getNetworkConfig();

      const identifier = await agent.didManagerCreate({
        provider: "did:ethr",
        alias: alias || `did-generated-${Date.now()}`,
        options: {
          anchor: false,
          network: networkConfig.name,
        },
      });

      DIDRegistry.registerDID(identifier.did, {
        ...identifier,
        type: "generated-key",
      });

      return res.json({ success: true, identifier });
    }

    if (provider === "did:key") {
      const identifier = await agent.didManagerCreate({
        provider: "did:key",
        alias: alias || `key-${Date.now()}`,
      });

      DIDRegistry.registerDID(identifier.did, {
        ...identifier,
        type: "self-issued",
      });

      return res.json({ success: true, identifier });
    }

    return res.status(400).json({
      success: false,
      error: "Invalid provider",
    });
  } catch (error) {
    console.error("DID creation error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/did/list", async (req, res) => {
  try {
    const identifiers = DIDRegistry.getAllDIDs();
    res.json({ success: true, count: identifiers.length, identifiers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/did/:did/resolve", async (req, res) => {
  try {
    const did = decodeURIComponent(req.params.did);

    const resolution = await agent.resolveDid({ didUrl: did });

    res.json({ success: true, resolution });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/did/:did", async (req, res) => {
  try {
    const did = decodeURIComponent(req.params.did);

    const identifier = DIDRegistry.getDID(did);

    if (!identifier) {
      return res.status(404).json({ success: false, error: "DID not found in session" });
    }

    res.json({ success: true, identifier });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------------
// VC ROUTES
// -------------------------

app.post("/credential/create", async (req, res) => {
  try {
    const { issuerDid, subjectDid, credentialSubject, type = ["VerifiableCredential"], expirationDate } = req.body;

    if (!issuerDid || !subjectDid || !credentialSubject) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: issuerDid, subjectDid, credentialSubject",
      });
    }

    const credential = await agent.createVerifiableCredential({
      credential: {
        issuer: { id: issuerDid },
        credentialSubject: { id: subjectDid, ...credentialSubject },
        type,
        ...(expirationDate && { expirationDate }),
      },
      proofFormat: "jwt",
    });

    const credentialId = `cred-${Date.now()}`;
    await DB.saveCredentialToDB(credentialId, credential);

    res.json({
      success: true,
      credential,
      credentialId,
      storage: "sqlite",
    });
  } catch (error) {
    console.error("Credential creation error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/credential/verify", async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ success: false, error: "Missing credential" });
    }

    const result = await agent.verifyCredential({ credential });

    res.json({ success: true, verification: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/credential/list", async (req, res) => {
  try {
    const credentials = await DB.getAllCredentialsFromDB();
    res.json({ success: true, count: credentials.length, credentials });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------------
// VP ROUTES
// -------------------------

app.post("/presentation/create", async (req, res) => {
  try {
    const { holderDid, ownerDid: incomingOwnerDid, verifiableCredentials, type = ["VerifiablePresentation"], domain, challenge } = req.body;

    if (!holderDid || !verifiableCredentials || !Array.isArray(verifiableCredentials)) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: holderDid, verifiableCredentials (array)",
      });
    }

    const looksLikeJwt = (s) => typeof s === "string" && s.split(".").length === 3;

    const tryParseJSON = (s) => {
      try {
        return JSON.parse(s);
      } catch (e) {
        return null;
      }
    };

    const buildW3CCredentialFromRaw = (raw) => {
      const issuerId = raw.issuerDID || raw.issuer || raw.issuerId;
      const subjectId = raw.subjectDID || raw.subject || raw.owner;

      const subjectClaims = { ...(raw.claims || {}) };

      for (const k of Object.keys(raw)) {
        if (
          ["issuerDID", "issuer", "issuerId", "subjectDID", "subject", "owner", "credentialType", "issuanceDate", "claims"].includes(k)
        ) {
          continue;
        }
        subjectClaims[k] = raw[k];
      }

      const types = Array.isArray(raw.credentialType)
        ? raw.credentialType
        : raw.credentialType
          ? [raw.credentialType]
          : ["VerifiableCredential"];

      const issuanceDate =
        raw.issuanceDate && !isNaN(Number(raw.issuanceDate))
          ? String(raw.issuanceDate).length > 12
            ? new Date(Number(raw.issuanceDate)).toISOString()
            : new Date(Number(raw.issuanceDate) * 1000).toISOString()
          : raw.issuanceDate || new Date().toISOString();

      const credential = {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        id: raw.id || undefined,
        type: types,
        issuer: issuerId ? { id: issuerId } : undefined,
        issuanceDate,
        credentialSubject: {
          id: subjectId || undefined,
          ...subjectClaims,
        },
      };

      Object.keys(credential).forEach((k) => credential[k] === undefined && delete credential[k]);

      return credential;
    };

    const normalizedCredentials = [];

    for (const entry of verifiableCredentials) {
      let item = entry;

      if (item && typeof item === "object" && (item.jwt || item.verifiableCredential)) {
        const candidate = item.jwt || item.verifiableCredential;
        if (looksLikeJwt(candidate)) {
          normalizedCredentials.push(candidate);
          continue;
        }
        item = candidate;
      }

      if (typeof item === "string") {
        if (looksLikeJwt(item)) {
          normalizedCredentials.push(item);
          continue;
        }

        const parsed = tryParseJSON(item);
        if (parsed) {
          item = parsed;
        } else {
          return res.status(400).json({
            success: false,
            error: "Credential string is neither a JWT nor valid JSON",
            sample: item,
          });
        }
      }

      if (item && typeof item === "object") {
        if (item.proof || item["@context"] || item.verifiableCredential) {
          normalizedCredentials.push(item);
          continue;
        }

        const w3c = buildW3CCredentialFromRaw(item);

        if (!w3c.issuer) {
          if (req.body.issuerDid) {
            w3c.issuer = { id: req.body.issuerDid };
          } else {
            if (holderDid) {
              w3c.issuer = { id: holderDid };
            } else {
              return res.status(400).json({
                success: false,
                error: "Raw credential missing issuer DID",
              });
            }
          }
        }

        let created;
        try {
          created = await agent.createVerifiableCredential({
            credential: w3c,
            proofFormat: "jwt",
          });
        } catch (err) {
          console.error("Error creating JWT for raw credential:", err);
          return res.status(500).json({
            success: false,
            error: "Failed to convert raw credential to JWT",
            originalError: err.message,
            w3c,
          });
        }

        if (typeof created === "string") {
          normalizedCredentials.push(created);
        } else if (created.verifiableCredential && typeof created.verifiableCredential === "string") {
          normalizedCredentials.push(created.verifiableCredential);
        } else if (created.jwt && typeof created.jwt === "string") {
          normalizedCredentials.push(created.jwt);
        } else {
          normalizedCredentials.push(created);
        }

        continue;
      }

      return res.status(400).json({
        success: false,
        error: "Unsupported credential format",
        entry: item,
      });
    }

    const presentation = await agent.createVerifiablePresentation({
      presentation: {
        holder: holderDid,
        verifiableCredential: normalizedCredentials,
        type,
        ...(domain && { domain }),
        ...(challenge && { challenge }),
      },
      proofFormat: "jwt",
    });

    const presentationId = `pres-${Date.now()}`;

    // extract issuer DID and store in SQL
    const issuerDid = extractIssuerDidFromCredentials(normalizedCredentials);

    let ownerDidToStore = incomingOwnerDid || null;

    if (!ownerDidToStore) {
      try {
        const first = normalizedCredentials[0];
        if (typeof first === "string" && first.split(".").length === 3) {
          // JWT: inspect payload
          const payload = JSON.parse(Buffer.from(first.split(".")[1], "base64").toString());
          if (payload.sub) ownerDidToStore = payload.sub;
          // some VCs use credentialSubject.id inside 'vc' claim - attempt a few heuristics if needed
        } else if (first && typeof first === "object") {
          const subj = first.credentialSubject || first.vc?.credentialSubject;
          if (subj && subj.id) ownerDidToStore = subj.id;
        }
      } catch (e) {
        console.warn("Failed to extract owner DID from credentials for VP storage:", e.message);
      }
    }

    await DB.saveVPPresentationToDB(
      presentationId,
      ownerDidToStore,
      holderDid,
      issuerDid || "UNKNOWN_ISSUER",
      presentation
    );

    res.json({
      success: true,
      presentation,
      presentationId,
      ownerDid: ownerDidToStore || null,
      holderDid,
      issuerDid: issuerDid || "UNKNOWN_ISSUER",
      storage: "sqlite",
      table: "vp_presentations",
    });
  } catch (error) {
    console.error("Presentation creation error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.post("/presentation/verify", async (req, res) => {
  try {
    const { presentation, domain, challenge } = req.body;

    if (!presentation) {
      return res.status(400).json({ success: false, error: "Missing required field: presentation" });
    }

    const result = await agent.verifyPresentation({
      presentation,
      ...(domain && { domain }),
      ...(challenge && { challenge }),
    });

    res.json({ success: true, verification: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



// VP list from SQL table (with issuer DID)
app.get("/vp/list", async (req, res) => {
  try {
    const rows = await DB.getAllVPPresentations();

    res.json({
      success: true,
      count: rows.length,
      presentations: rows,
      table: "vp_presentations",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Query VP by issuer DID
app.get("/vp/issuer/:issuerDid", async (req, res) => {
  try {
    const issuerDid = decodeURIComponent(req.params.issuerDid);

    const rows = await DB.getVPPresentationsByIssuer(issuerDid);

    res.json({
      success: true,
      issuerDid,
      count: rows.length,
      presentations: rows,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Query VP by ownerDid (original subject/wallet DID)
app.get("/vp/owner/:ownerDid", async (req, res) => {
  try {
    const ownerDid = decodeURIComponent(req.params.ownerDid);
    const rows = await DB.getVPPresentationsByOwner(ownerDid);

    res.json({
      success: true,
      ownerDid,
      count: rows.length,
      presentations: rows,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create ephemeral share link for a presentation
app.post("/share/create", async (req, res) => {
  try {
    const { presentationId, ttlSeconds = 3600, ownerDid } = req.body;
    if (!presentationId) return res.status(400).json({ success: false, error: "Missing presentationId" });

    // load presentation from DB
    const repo = dbConnection.getRepository(VPPresentationEntity);
    const presentationRow = await repo.findOne({ where: { presentationId } });
    if (!presentationRow) return res.status(404).json({ success: false, error: "Presentation not found" });

    const token = randomBytes(20).toString("hex"); // 40 hex chars
    const expiresAt = new Date(Date.now() + Number(ttlSeconds) * 1000);

    // store a snapshot payload so share persists even if original row is removed
    const payload = {
      presentation: presentationRow.presentation,
      presentationId: presentationRow.presentationId,
      ownerDid: ownerDid || presentationRow.ownerDid || null,
      holderDid: presentationRow.holderDid,
      issuerDid: presentationRow.issuerDid,
      createdAt: presentationRow.createdAt,
    };

    await DB.saveShareToDB(token, presentationId, ownerDid || presentationRow.ownerDid || null, payload, expiresAt);

    const base = process.env.SHARE_BASE_URL || `http://localhost:${PORT}`;
    const shareUrl = `${base}/share/view/${token}`;

    res.json({ success: true, token, shareUrl, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    console.error("share/create error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// View share by token - returns JSON presentation if valid and not expired
app.get("/share/view/:token", async (req, res) => {
  try {
    const token = req.params.token;
    const share = await DB.getShareByToken(token);
    if (!share) return res.status(404).send("Share not found");

    if (new Date(share.expiresAt).getTime() < Date.now()) {
      return res.status(410).send("Share has expired");
    }

    return res.json({
      success: true,
      presentation: share.payload.presentation,
      presentationId: share.presentationId,
      ownerDid: share.ownerDid,
      issuerDid: share.payload.issuerDid,
      holderDid: share.payload.holderDid,
      expiresAt: share.expiresAt,
    });
  } catch (error) {
    console.error("share/view error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Revoke share (delete)
app.post("/share/revoke", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: "Missing token" });

    const ok = await DB.revokeShare(token);
    if (!ok) return res.status(404).json({ success: false, error: "Token not found" });

    res.json({ success: true, revoked: true });
  } catch (error) {
    console.error("share/revoke error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------------
// Global error + 404
// -------------------------

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found" });
});

// -------------------------
// Start server
// -------------------------

async function startServer() {
  await initializeAgent();

  app.listen(PORT, () => {
    console.log(`🚀 Veramo Backend Service running on port ${PORT}`);
    console.log(`📦 SQLite DB: ${process.env.SQLITE_DB_PATH || "./veramo.sqlite"}`);
    console.log("🔑 Key endpoints:");
    console.log("  GET  /health");
    console.log("  POST /did/create");
    console.log("  GET  /did/list");
    console.log("  GET  /did/:did/resolve");
    console.log("  POST /credential/create");
    console.log("  GET  /credential/list");
    console.log("  POST /presentation/create");
    console.log("  POST /presentation/verify");
    console.log("  GET  /vp/list");
    console.log("  GET  /vp/issuer/:issuerDid");
    console.log("  POST /share/create");
    console.log("  GET  /share/view/:token");
    console.log("  POST /share/revoke");
  });
}

process.on("SIGINT", async () => {
  console.log("⏱️ Shutting down gracefully...");
  if (dbConnection) {
    await dbConnection.close();
    console.log("📦 SQLite database connection closed");
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("⏱️ Shutting down gracefully...");
  if (dbConnection) {
    await dbConnection.close();
    console.log("📦 SQLite database connection closed");
  }
  process.exit(0);
});

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
