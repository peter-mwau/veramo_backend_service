// src/veramo-ethr-did/server-decentralized.js
// Decentralized version: Blockchain-first, database-optional architecture
// - DIDs: Blockchain-based (no DB needed)
// - VCs: Stored as JWTs (in-memory or client-side, no DB)
// - Keys: Managed via environment/custodial solutions

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { createAgent } from "@veramo/core";
import { CredentialPlugin } from "@veramo/credential-w3c";
import {
    KeyStore,
    PrivateKeyStore,
    DIDStore,
    Entities,
} from "@veramo/data-store";
import { DIDManager } from "@veramo/did-manager";
import { EthrDIDProvider } from "@veramo/did-provider-ethr";
import { KeyDIDProvider } from "@veramo/did-provider-key";
import { DIDResolverPlugin } from "@veramo/did-resolver";
import { KeyManager } from "@veramo/key-manager";
import { KeyManagementSystem, SecretBox } from "@veramo/kms-local";
import { MessageHandler } from "@veramo/message-handler";
import { createConnection } from "typeorm";
import { Resolver } from "did-resolver";
import { getResolver as ethrDidResolver } from "ethr-did-resolver";
import { getResolver as keyDidResolver } from "key-did-resolver";

// In-memory storage for VCs instead of database
const VCStore = {
    credentials: new Map(), // credentialId -> credential
    presentations: new Map(), // presentationId -> presentation

    saveCredential(id, credential) {
        this.credentials.set(id, { credential, timestamp: new Date().toISOString() });
        return id;
    },

    getCredential(id) {
        return this.credentials.get(id);
    },

    getAllCredentials() {
        return Array.from(this.credentials.values()).map(item => item.credential);
    },

    savePresentation(id, presentation) {
        this.presentations.set(id, { presentation, timestamp: new Date().toISOString() });
        return id;
    },

    getPresentation(id) {
        return this.presentations.get(id);
    },

    getAllPresentations() {
        return Array.from(this.presentations.values()).map(item => item.presentation);
    }
};

// In-memory DID registry instead of database
const DIDRegistry = {
    dids: new Map(), // did -> metadata

    registerDID(did, metadata = {}) {
        this.dids.set(did, {
            did,
            createdAt: new Date().toISOString(),
            ...metadata
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
    }
};

// SKALE Titan Network Configuration
const SKALE_TITAN_CONFIG = {
    name: "skale-titan",
    chainId: 1020352220,
    rpcUrl: "https://testnet.skalenodes.com/v1/aware-fake-trim-testnet",
    registry:
        process.env.ETH_REGISTRY_ADDRESS_SEPOLIA ||
        "0x0979446EB2A4a373eaA702336aC3c390B0139Fc5",
};

// Network-specific configurations
const NETWORK_CONFIGS = {
    "skale-titan": SKALE_TITAN_CONFIG,
    skale: SKALE_TITAN_CONFIG,
    sepolia: {
        name: "sepolia",
        chainId: 11155111,
        rpcUrl: "https://sepolia.infura.io/v3/189303beb46d46d8a0327f90f441168d", //fix
        registry: "0xc0660d54f4655dC3B045D69ced4308f1709FD35e",//fix
    },
};

// Get network configuration
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

// Function to check registry contract deployment
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

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Veramo agent (no database required)
let agent;

// Secret key for encryption - In production, use environment variables
const SECRET_KEY =
    process.env.SECRET_KEY ||
    "3c186fb58980777698bab8e95f010f40fd0d04e14de8f49b551108351aefaf28";

// Database connection - using in-memory SQLite for key management only
let dbConnection;

// Initialize Veramo agent with in-memory database
// Keys are stored in-memory (not persisted across restarts)
async function initializeAgent() {
    try {
        // Create in-memory SQLite connection for Veramo's key/DID stores
        dbConnection = await createConnection({
            type: "sqlite",
            database: ":memory:", // In-memory database
            synchronize: true,
            logging: false,
            entities: Entities,
        });
        console.log("In-memory database initialized (keys only, not persisted)");

        const networkConfig = getNetworkConfig();
        console.log("Using network configuration:", networkConfig);

        // Check if registry is deployed
        const registryCheck = await checkRegistryDeployment(networkConfig);
        const actualRegistry = registryCheck.registry;

        if (!registryCheck.isDeployed) {
            console.warn(
                `⚠️  Warning: ERC1056 registry not found at ${networkConfig.registry} on ${networkConfig.name}`
            );
            console.warn(
                `⚠️  DID resolution will still work for did:key, but ethr DIDs may have limited functionality`
            );
        }

        // Create agent with proper Veramo stores (in-memory, not persisted)
        agent = createAgent({
            plugins: [
                // Key manager with in-memory store
                new KeyManager({
                    store: new KeyStore(dbConnection),
                    kms: {
                        local: new KeyManagementSystem(
                            new PrivateKeyStore(dbConnection, new SecretBox(SECRET_KEY))
                        ),
                    },
                }),
                // DID Manager - blockchain-first
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
                // DID Resolver - blockchain queries only
                new DIDResolverPlugin({
                    resolver: new Resolver({
                        ...ethrDidResolver({
                            networks: [
                                // SKALE Titan network
                                {
                                    name: "skale-titan",
                                    rpcUrl: NETWORK_CONFIGS["skale-titan"].rpcUrl,
                                    registry: NETWORK_CONFIGS["skale-titan"].registry,
                                },
                                // Alias for SKALE
                                {
                                    name: "skale",
                                    rpcUrl: NETWORK_CONFIGS["skale-titan"].rpcUrl,
                                    registry: NETWORK_CONFIGS["skale-titan"].registry,
                                },
                                // Sepolia testnet
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
                // Credential plugin - stateless VC creation/verification
                new CredentialPlugin(),
                // Message handler
                new MessageHandler({ messageHandlers: [] }),
            ],
        });

        console.log(
            "Veramo agent initialized (decentralized mode - in-memory only) with network:",
            networkConfig.name
        );
    } catch (error) {
        console.error("Error initializing agent:", error);
        process.exit(1);
    }
}

// Routes

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        message: "Veramo Backend Service (Decentralized) is running",
        architecture: "Blockchain-first, no central database",
        timestamp: new Date().toISOString(),
    });
});

// Get agent information
app.get("/agent/info", async (req, res) => {
    try {
        const methods = await agent.availableMethods();
        res.json({
            availableMethods: methods,
            architecture: "Decentralized - Blockchain and in-memory only",
            features: {
                did_creation: "Blockchain-based (ethr and key DIDs)",
                did_resolution: "Blockchain queries only",
                vc_issuance: "In-memory, JWTs",
                vc_storage: "In-memory cache (no persistence)",
            },
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create a new DID
app.post("/did/create", async (req, res) => {
    try {
        const { provider = "did:key", alias, walletAddress, network } = req.body;

        // WALLET-BASED DID (for thirdweb integration)
        // Use this when user connects their wallet - creates DID from existing wallet address
        if (provider === "did:ethr" && walletAddress) {
            // Validate Ethereum address format
            if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid Ethereum wallet address format. Must be a 40-character hex string starting with '0x'",
                });
            }

            const networkConfig = getNetworkConfig();
            const targetNetwork = network || networkConfig.name;

            // Structure: did:ethr:network:walletAddress
            const didIdentifier = `did:ethr:${targetNetwork}:${walletAddress}`;

            console.log(
                `Creating wallet-based DID for network: ${targetNetwork}, address: ${walletAddress}`
            );

            // Check if DID already exists
            if (DIDRegistry.isDIDRegistered(didIdentifier)) {
                const existing = DIDRegistry.getDID(didIdentifier);
                return res.json({
                    success: true,
                    identifier: {
                        did: didIdentifier,
                        provider: "did:ethr",
                        walletAddress,
                        network: targetNetwork,
                    },
                    message: "Wallet-based DID already exists",
                    type: "wallet-based",
                    note: "This DID is linked to your wallet address. You control it with your wallet private key."
                });
            }

            // Register the wallet-based DID
            DIDRegistry.registerDID(didIdentifier, {
                provider: "did:ethr",
                walletAddress,
                network: targetNetwork,
                type: "wallet-based",
                alias: alias || `wallet-${walletAddress.slice(0, 10)}`
            });

            res.json({
                success: true,
                identifier: {
                    did: didIdentifier,
                    provider: "did:ethr",
                    walletAddress,
                    network: targetNetwork,
                },
                message: `Wallet-based DID created successfully`,
                type: "wallet-based",
                note: "This DID is linked to your wallet. Your wallet private key controls it.",
                stored: "blockchain (resolved from ERC1056 registry)"
            });
        }
        // GENERATED KEY DID (Veramo manages the key)
        else if (provider === "did:ethr" && !walletAddress) {
            // Generate a new key pair - Veramo controls the key
            let createOptions = {
                provider: "did:ethr",
                alias: alias || `did-generated-${Date.now()}`,
            };

            const networkConfig = getNetworkConfig();
            createOptions.options = {
                anchor: false,
                network: networkConfig.name,
            };

            console.log("Creating generated-key DID (Veramo manages the key)");

            const identifier = await agent.didManagerCreate(createOptions);

            // Register in our in-memory registry
            DIDRegistry.registerDID(identifier.did, {
                ...identifier,
                type: "generated-key",
                note: "This is a generated key. Veramo stores the private key."
            });

            res.json({
                success: true,
                identifier,
                type: "generated-key",
                note: "⚠️ This DID uses a generated key. For blockchain persistence, use wallet-based DIDs (pass walletAddress)",
                stored: "in-memory (session only, not persisted)",
                recommendation: "For production with thirdweb, use wallet-based DIDs: { provider: 'did:ethr', walletAddress: '0x...' }"
            });
        }
        // SELF-ISSUED DID (did:key)
        else if (provider === "did:key") {
            let createOptions = {
                provider: "did:key",
                alias: alias || `key-${Date.now()}`,
            };

            console.log("Creating self-issued DID (did:key)");

            const identifier = await agent.didManagerCreate(createOptions);

            // Register in our in-memory registry
            DIDRegistry.registerDID(identifier.did, {
                ...identifier,
                type: "self-issued",
                note: "Self-issued DID, no blockchain required"
            });

            res.json({
                success: true,
                identifier,
                type: "self-issued",
                note: "Self-issued DID using did:key method. No blockchain required.",
                stored: "in-memory (ephemeral, can be recreated)",
            });
        }
        else {
            res.status(400).json({
                success: false,
                error: "Invalid provider or missing required parameters",
                supported_methods: {
                    "wallet-based": {
                        provider: "did:ethr",
                        walletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
                        network: "skale-titan (optional)",
                        note: "Best for thirdweb integration"
                    },
                    "generated-key": {
                        provider: "did:ethr",
                        note: "Generates a new key, Veramo manages it"
                    },
                    "self-issued": {
                        provider: "did:key",
                        note: "Self-issued DID, no blockchain needed"
                    },
                },
                success: false,
                error: error.message,
            });
        }
    }
    catch (error) {
        console.error("DID creation error:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Get all DIDs (from in-memory registry only)
app.get("/did/list", async (req, res) => {
    try {
        const identifiers = DIDRegistry.getAllDIDs();
        res.json({
            success: true,
            count: identifiers.length,
            identifiers,
            note: "Only DIDs created in this session are listed (no database persistence)",
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Get a specific DID
app.get("/did/:did", async (req, res) => {
    try {
        const { did } = req.params;
        const identifier = DIDRegistry.getDID(did);

        if (!identifier) {
            return res.status(404).json({
                success: false,
                error: "DID not found in this session",
                note: "Use did:ethr with a wallet address for blockchain-persisted DIDs",
            });
        }

        res.json({
            success: true,
            identifier,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Resolve a DID Document
app.get("/did/:did/resolve", async (req, res) => {
    try {
        const { did } = req.params;
        console.log(`Attempting to resolve DID: ${did}`);

        // Check if it's an ethr DID and validate network
        if (did.startsWith("did:ethr:")) {
            const parts = did.split(":");
            if (parts.length >= 4) {
                const network = parts[2];
                const address = parts[3];

                console.log(
                    `DID components - Network: ${network}, Address: ${address}`
                );

                // For SKALE networks, try a simplified resolution first
                if (network === "skale-titan" || network === "skale") {
                    try {
                        const resolution = await agent.resolveDid({ didUrl: did });
                        return res.json({
                            success: true,
                            resolution,
                            method: "blockchain-resolved",
                        });
                    } catch (standardError) {
                        console.log(
                            `Standard resolution failed, trying fallback approach:`,
                            standardError.message
                        );

                        // Fallback: Create a basic DID document without registry
                        const fallbackDidDocument = {
                            "@context": ["https://www.w3.org/ns/did/v1"],
                            id: did,
                            verificationMethod: [
                                {
                                    id: `${did}#controller`,
                                    type: "EcdsaSecp256k1RecoveryMethod2020",
                                    controller: did,
                                    blockchainAccountId: `eip155:1020352220:${address}`,
                                },
                            ],
                            authentication: [`${did}#controller`],
                            assertionMethod: [`${did}#controller`],
                        };

                        return res.json({
                            success: true,
                            resolution: {
                                didDocumentMetadata: {
                                    fallback: true,
                                    message: "Registry call failed, using fallback DID document",
                                },
                                didResolutionMetadata: {
                                    contentType: "application/did+ld+json",
                                },
                                didDocument: fallbackDidDocument,
                            },
                            method: "fallback",
                        });
                    }
                }

                const networkConfig = getNetworkConfig();
                if (
                    network !== networkConfig.name &&
                    network !== "skale" &&
                    network !== "skale-titan"
                ) {
                    return res.status(400).json({
                        success: false,
                        error: `Network '${network}' is not configured. Available networks: ${networkConfig.name}`,
                    });
                }
            }
        }

        const resolution = await agent.resolveDid({ didUrl: did });
        res.json({
            success: true,
            resolution,
            method: "blockchain-resolved",
        });
    } catch (error) {
        console.error(`DID resolution error for ${req.params.did}:`, error);

        let errorMessage = error.message;
        if (
            error.message.includes("CALL_EXCEPTION") ||
            error.message.includes("missing revert data")
        ) {
            errorMessage = `Registry contract error: ${error.message}. For decentralized DIDs, use did:ethr with a wallet address or did:key for self-issued DIDs.`;
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            did: req.params.did,
        });
    }
});

// Create a Verifiable Credential (stateless - no database)
app.post("/credential/create", async (req, res) => {
    try {
        const {
            issuerDid,
            subjectDid,
            credentialSubject,
            type = ["VerifiableCredential"],
            expirationDate,
        } = req.body;

        if (!issuerDid || !subjectDid || !credentialSubject) {
            return res.status(400).json({
                success: false,
                error:
                    "Missing required fields: issuerDid, subjectDid, credentialSubject",
            });
        }

        const credential = await agent.createVerifiableCredential({
            credential: {
                issuer: { id: issuerDid },
                credentialSubject: {
                    id: subjectDid,
                    ...credentialSubject,
                },
                type,
                ...(expirationDate && { expirationDate }),
            },
            proofFormat: "jwt",
        });

        // Store in in-memory cache (temporary)
        const credentialId = `cred-${Date.now()}`;
        VCStore.saveCredential(credentialId, credential);

        res.json({
            success: true,
            credential,
            credentialId,
            storage: "in-memory (temporary, pass to client for persistence)",
            note: "Credential is a JWT - store and manage on the client side for decentralization",
        });
    } catch (error) {
        console.error("Credential creation error:", error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Verify a Verifiable Credential (stateless)
app.post("/credential/verify", async (req, res) => {
    try {
        const { credential } = req.body;

        if (!credential) {
            return res.status(400).json({
                success: false,
                error: "Missing required field: credential",
            });
        }

        const result = await agent.verifyCredential({ credential });

        res.json({
            success: true,
            verification: result,
            note: "Verification is stateless - no database lookup required",
        });
    } catch (error) {
        console.error("Credential verification error:", error);

        let errorMessage = error.message;
        if (error.message && error.message.includes("EVM revert instruction")) {
            errorMessage =
                "SKALE network registry contract issue - verification requires blockchain interaction";
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            originalError: error.message,
        });
    }
});

// Get all credentials (in-memory cache only)
app.get("/credential/list", async (req, res) => {
    try {
        const credentials = VCStore.getAllCredentials();
        res.json({
            success: true,
            count: credentials.length,
            credentials,
            note: "Only credentials created in this session. For true decentralization, store credentials on the client.",
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Create a Verifiable Presentation (stateless - no database)
app.post("/presentation/create", async (req, res) => {
    try {
        const {
            holderDid,
            verifiableCredentials,
            type = ["VerifiablePresentation"],
            domain,
            challenge,
        } = req.body;

        if (
            !holderDid ||
            !verifiableCredentials ||
            !Array.isArray(verifiableCredentials)
        ) {
            return res.status(400).json({
                success: false,
                error:
                    "Missing required fields: holderDid, verifiableCredentials (array)",
            });
        }

        const presentation = await agent.createVerifiablePresentation({
            presentation: {
                holder: holderDid,
                verifiableCredential: verifiableCredentials,
                type,
                ...(domain && { domain }),
                ...(challenge && { challenge }),
            },
            proofFormat: "jwt",
        });

        // Store in in-memory cache (temporary)
        const presentationId = `pres-${Date.now()}`;
        VCStore.savePresentation(presentationId, presentation);

        res.json({
            success: true,
            presentation,
            presentationId,
            storage: "in-memory (temporary, pass to client for persistence)",
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Verify a Verifiable Presentation (stateless)
app.post("/presentation/verify", async (req, res) => {
    try {
        const { presentation, domain, challenge } = req.body;

        if (!presentation) {
            return res.status(400).json({
                success: false,
                error: "Missing required field: presentation",
            });
        }

        const result = await agent.verifyPresentation({
            presentation,
            ...(domain && { domain }),
            ...(challenge && { challenge }),
        });

        res.json({
            success: true,
            verification: result,
            note: "Verification is stateless - no database lookup required",
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Get all presentations (in-memory cache only)
app.get("/presentation/list", async (req, res) => {
    try {
        const presentations = VCStore.getAllPresentations();
        res.json({
            success: true,
            count: presentations.length,
            presentations,
            note: "Only presentations created in this session.",
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Network status
app.get("/network/status", async (req, res) => {
    try {
        const networkConfig = getNetworkConfig();
        const isRegistryDeployed = await checkRegistryDeployment(networkConfig);

        res.json({
            success: true,
            network: {
                name: networkConfig.name,
                chainId: networkConfig.chainId,
                rpcUrl: networkConfig.rpcUrl,
                registry: networkConfig.registry,
                registryDeployed: isRegistryDeployed,
            },
            architecture: "Blockchain-first, decentralized",
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error("Unhandled error:", error);
    res.status(500).json({
        success: false,
        error: "Internal server error",
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "Endpoint not found",
    });
});

// Start server
async function startServer() {
    await initializeAgent();

    app.listen(PORT, () => {
        console.log(
            `🚀 Veramo Backend Service (Decentralized) is running on port ${PORT}`
        );
        console.log("📋 Architecture: Blockchain-first, no central database");
        console.log("📖 API Documentation available at http://localhost:${PORT}/health");
        console.log("🔑 Available endpoints:");
        console.log("  GET  /health - Health check");
        console.log("  GET  /agent/info - Agent information");
        console.log("  GET  /network/status - Network and registry status");
        console.log("  POST /did/create - Create blockchain-based DID");
        console.log("  GET  /did/list - List DIDs from this session");
        console.log("  GET  /did/:did - Get specific DID");
        console.log("  GET  /did/:did/resolve - Resolve DID from blockchain");
        console.log("  POST /credential/create - Create verifiable credential (JWT)");
        console.log("  POST /credential/verify - Verify credential (stateless)");
        console.log("  GET  /credential/list - List credentials from this session");
        console.log("  POST /presentation/create - Create verifiable presentation");
        console.log("  POST /presentation/verify - Verify presentation (stateless)");
        console.log("  GET  /presentation/list - List presentations from this session");
    });
}

// Handle process termination
process.on("SIGINT", async () => {
    console.log("\n⏱️  Shutting down gracefully...");
    if (dbConnection) {
        await dbConnection.close();
        console.log("📦 In-memory database connection closed");
    }
    process.exit(0);
});

process.on("SIGTERM", async () => {
    console.log("\n⏱️  Shutting down gracefully...");
    if (dbConnection) {
        await dbConnection.close();
        console.log("📦 In-memory database connection closed");
    }
    process.exit(0);
});

// Start the server
startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
