import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";

const CONFIG_DIR = path.join(os.homedir(), ".verifo");
const IDENTITY_FILE = path.join(CONFIG_DIR, "identity.json");

export function loadOrCreateIdentity() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (fs.existsSync(IDENTITY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
    return {
      publicKey: raw.publicKey,
      secretKey: new Uint8Array(Buffer.from(raw.secretKey, "base64")),
    };
  }

  const keyPair = nacl.sign.keyPair();
  const publicKey = bs58.encode(Buffer.from(keyPair.publicKey));
  const secretKeyB64 = Buffer.from(keyPair.secretKey).toString("base64");

  fs.writeFileSync(
    IDENTITY_FILE,
    JSON.stringify({ publicKey, secretKey: secretKeyB64 }, null, 2),
    { mode: 0o600 }
  );

  return { publicKey, secretKey: keyPair.secretKey };
}

export function signMessage(purpose, secretKey, publicKey, timestampMs) {
  const message = new TextEncoder().encode(`${purpose}:${publicKey}:${timestampMs}`);
  const signature = nacl.sign.detached(message, secretKey);
  return Buffer.from(signature).toString("base64");
}

export function signHeartbeat(secretKey, publicKey, timestampMs) {
  return signMessage("verifo-heartbeat", secretKey, publicKey, timestampMs);
}

// Fase 5: signs the RAW bytes of a real Solana transaction message (not a
// fixed text template like the other signers above). Used to co-sign the
// on-chain proof-of-activity memo transactions the server prepares for this
// node — this is what makes the resulting transaction genuinely signed by
// the node's own key, not just a claim made by the server.
export function signRawMessage(secretKey, messageBytes) {
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return Buffer.from(signature).toString("base64");
}

export function loadConfig() {
  const configFile = path.join(CONFIG_DIR, "config.json");
  if (!fs.existsSync(configFile)) return null;
  return JSON.parse(fs.readFileSync(configFile, "utf8"));
}

export function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const configFile = path.join(CONFIG_DIR, "config.json");
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}
