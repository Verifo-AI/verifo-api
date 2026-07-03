import { collectHardwareReport } from "../src/hardware.mjs";
import { loadOrCreateIdentity, signHeartbeat, signMessage, signRawMessage, loadConfig, saveConfig } from "../src/identity.mjs";
import { runLocalModel } from "../src/localModel.mjs";

const DEFAULT_API_URL = process.env.VERIFO_API_URL || "https://api.verifo.network/api";
const HEARTBEAT_INTERVAL_MS = 30_000;
const TASK_POLL_INTERVAL_MS = 4_000;

function usage() {
  console.log(`Verifo Node Client

Usage:
  verifo-node link <pairingToken> [--api <apiUrl>]   Link this machine to your Verifo account
  verifo-node start [--api <apiUrl>]                 Start reporting real hardware + heartbeats

Get a pairing token from the "Download Node Software" card on your Verifo contributor dashboard.
`);
}

async function cmdLink(pairingToken, apiUrl) {
  if (!pairingToken) {
    console.error("Missing pairing token. Copy it from your Verifo dashboard.");
    process.exit(1);
  }

  const identity = loadOrCreateIdentity();
  const hardware = await collectHardwareReport();

  console.log(`Detected hardware: ${hardware.cpu}, ${hardware.ramGb} GB RAM${hardware.gpu ? `, ${hardware.gpu}` : ""} (${hardware.os})`);

  const res = await fetch(`${apiUrl}/nodes/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingToken,
      nodePublicKey: identity.publicKey,
      os: hardware.os,
      cpu: hardware.cpu,
      gpu: hardware.gpu,
      ramGb: hardware.ramGb,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Linking failed: ${data.error || res.statusText}`);
    process.exit(1);
  }

  const contributionMode = data.contributionMode || "compute";
  saveConfig({ apiUrl, nodePublicKey: identity.publicKey, contributionMode });

  const modeDescriptions = {
    compute: "Compute — your device will run AI models locally for full reward.",
    relay: "Relay — your device will relay tasks to Claude and earn partial reward.",
    witness: "Witness — your device is too light for AI work, so it just proves real uptime for a small reward.",
  };
  console.log(`Linked successfully to node #${data.nodeId}.`);
  console.log(`Contribution mode: ${modeDescriptions[contributionMode] || contributionMode}`);
  console.log(`Run "verifo-node start" to begin contributing.`);
}

async function cmdStart(apiUrl) {
  const config = loadConfig();
  const identity = loadOrCreateIdentity();

  if (!config || config.nodePublicKey !== identity.publicKey) {
    console.error('This machine is not linked yet. Run "verifo-node link <pairingToken>" first.');
    process.exit(1);
  }

  const effectiveApiUrl = apiUrl || config.apiUrl;
  const contributionMode = config.contributionMode || "compute";
  console.log(`Verifo node client started in "${contributionMode}" mode. Sending heartbeats every ${HEARTBEAT_INTERVAL_MS / 1000}s to ${effectiveApiUrl}`);
  if (contributionMode === "witness") {
    console.log("This device is a witness node: it won't be assigned AI tasks, it only proves real uptime on-chain for a small reward.");
  } else if (contributionMode === "relay") {
    console.log("This device is a relay node: it will forward AI tasks to Claude rather than running a local model.");
  }

  // Fase 5: real on-chain proof-of-activity. For each real event (connect,
  // disconnect, task assigned, task completed) we ask the server for an
  // unsigned Solana transaction, sign it locally with this node's own key,
  // and send the signature back so the server can broadcast it to mainnet
  // with the treasury paying the fee. This never spends the contributor's
  // own SOL, but the resulting transaction is genuinely co-signed by them.
  async function sendProofEvent(eventType, taskId) {
    try {
      const secretKeyBytes = loadOrCreateIdentity().secretKey;
      const requestTimestampMs = Date.now();
      const requestSignature = signMessage("verifo-request-proof", secretKeyBytes, identity.publicKey, requestTimestampMs);

      const reqRes = await fetch(`${effectiveApiUrl}/nodes/proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodePublicKey: identity.publicKey,
          timestampMs: requestTimestampMs,
          signature: requestSignature,
          eventType,
          taskId,
        }),
      });
      const reqData = await reqRes.json().catch(() => ({}));
      if (!reqRes.ok || !reqData.messageBase64) {
        console.error(`[proof:${eventType}] request failed: ${reqData.error || reqRes.statusText}`);
        return;
      }

      const messageBytes = Buffer.from(reqData.messageBase64, "base64");
      const nodeSignatureBase64 = signRawMessage(secretKeyBytes, messageBytes);

      const submitTimestampMs = Date.now();
      const submitSignature = signMessage("verifo-submit-proof", secretKeyBytes, identity.publicKey, submitTimestampMs);
      const submitRes = await fetch(`${effectiveApiUrl}/nodes/proof/${reqData.proofId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodePublicKey: identity.publicKey,
          timestampMs: submitTimestampMs,
          signature: submitSignature,
          nodeSignatureBase64,
        }),
      });
      const submitData = await submitRes.json().catch(() => ({}));
      if (submitRes.ok && submitData.txSignature) {
        console.log(`[proof:${eventType}] on-chain proof confirmed: https://explorer.solana.com/tx/${submitData.txSignature}`);
      } else {
        console.error(`[proof:${eventType}] on-chain proof failed: ${submitData.error || submitRes.statusText}`);
      }
    } catch (err) {
      console.error(`[proof:${eventType}] error: ${err.message}`);
    }
  }

  let hasSentConnectProof = false;
  let shuttingDown = false;

  async function handleShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, sending disconnect proof before exiting...`);
    const timeoutMs = 8_000;
    await Promise.race([sendProofEvent("disconnect"), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    process.exit(0);
  }
  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  async function beat() {
    const timestampMs = Date.now();
    const secretKeyBytes = loadOrCreateIdentity().secretKey;
    const signature = signHeartbeat(secretKeyBytes, identity.publicKey, timestampMs);

    try {
      const res = await fetch(`${effectiveApiUrl}/nodes/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodePublicKey: identity.publicKey, timestampMs, signature }),
      });
      if (res.ok) {
        console.log(`[${new Date(timestampMs).toLocaleTimeString()}] heartbeat ok`);
        if (!hasSentConnectProof) {
          hasSentConnectProof = true;
          sendProofEvent("connect");
        }
      } else {
        const data = await res.json().catch(() => ({}));
        console.error(`[${new Date(timestampMs).toLocaleTimeString()}] heartbeat rejected: ${data.error || res.statusText}`);
      }
    } catch (err) {
      console.error(`[${new Date(timestampMs).toLocaleTimeString()}] heartbeat failed: ${err.message}`);
    }
  }

  async function pollForTask() {
    const timestampMs = Date.now();
    const secretKeyBytes = loadOrCreateIdentity().secretKey;
    const signature = signMessage("verifo-next-task", secretKeyBytes, identity.publicKey, timestampMs);
    const qs = new URLSearchParams({ nodePublicKey: identity.publicKey, timestampMs: String(timestampMs), signature });

    try {
      const res = await fetch(`${effectiveApiUrl}/nodes/next-task?${qs}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.task) return;

      const { taskId, prompt } = data.task;
      sendProofEvent("task_assigned", taskId);

      // Relay-mode nodes are honest about not attempting local inference —
      // their real contribution is forwarding the task, not running a model
      // they weren't classified as capable of running reliably.
      let result;
      if (contributionMode === "relay") {
        console.log(`[${new Date().toLocaleTimeString()}] received task ${taskId}, relaying (this device runs in relay mode, not local inference)...`);
        result = { ok: false, reason: "relay-mode: this device relays tasks rather than running a local model" };
      } else {
        console.log(`[${new Date().toLocaleTimeString()}] received task ${taskId}, attempting local model...`);
        result = await runLocalModel(prompt);
        if (result.ok) {
          console.log(`[${new Date().toLocaleTimeString()}] task ${taskId} completed locally`);
        } else {
          console.log(`[${new Date().toLocaleTimeString()}] task ${taskId} could not run locally: ${result.reason}`);
        }
      }

      const resultTimestampMs = Date.now();
      const resultSignature = signMessage("verifo-task-result", secretKeyBytes, identity.publicKey, resultTimestampMs);
      const resultRes = await fetch(`${effectiveApiUrl}/nodes/task-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodePublicKey: identity.publicKey,
          timestampMs: resultTimestampMs,
          signature: resultSignature,
          taskId,
          success: result.ok,
          output: result.ok ? result.output : undefined,
          reason: result.ok ? undefined : result.reason,
        }),
      }).catch(() => null);
      if (resultRes?.ok) {
        sendProofEvent("task_completed", taskId);
      }
    } catch {
      // Network hiccups are expected on a poll loop; the server will time
      // out the assignment and fall back to Claude if we miss too many.
    }
  }

  await beat();
  setInterval(beat, HEARTBEAT_INTERVAL_MS);

  // Witness nodes never run AI work, so there's nothing to poll for — they
  // only prove real uptime via heartbeats + connect/disconnect proofs.
  if (contributionMode !== "witness") {
    setInterval(pollForTask, TASK_POLL_INTERVAL_MS);
  }
}

function parseArgs(argv) {
  const apiFlagIdx = argv.indexOf("--api");
  if (apiFlagIdx === -1) {
    return { apiUrl: DEFAULT_API_URL, positional: argv };
  }
  const apiUrl = argv[apiFlagIdx + 1] ?? DEFAULT_API_URL;
  const positional = argv.filter((_, i) => i !== apiFlagIdx && i !== apiFlagIdx + 1);
  return { apiUrl, positional };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { apiUrl, positional } = parseArgs(rest);

  if (command === "link") {
    await cmdLink(positional[0], apiUrl);
  } else if (command === "start") {
    await cmdStart(apiUrl);
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
