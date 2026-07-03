import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import { db, nodesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { classifyContributionMode, type ContributionMode } from "../lib/contributionMode";

const router: IRouter = Router();

// contributionMode (compute/relay/witness) is the real, hardware-derived
// classification. nodeType is the older, coarser display category used by
// the marketing/dashboard pages — we derive it from contributionMode so the
// registration flow never asks the user to self-report something we can
// detect, and it can never disagree with the real classification.
function nodeTypeFromContributionMode(mode: ContributionMode): "compute" | "verification" | "storage" {
  if (mode === "compute") return "compute";
  if (mode === "relay") return "verification";
  return "storage";
}

function validateRegisterBody(
  body: unknown
): { os: string; walletAddress: string; ramGb: number | null; gpu: string | null; hardwareNote: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.os !== "string" || !b.os) return null;
  if (typeof b.walletAddress !== "string" || b.walletAddress.length < 8) return null;
  const ramGb = typeof b.ramGb === "number" && Number.isFinite(b.ramGb) ? b.ramGb : null;
  const gpu = typeof b.gpu === "string" && b.gpu ? b.gpu : null;
  const hardwareNote = typeof b.hardwareNote === "string" ? b.hardwareNote.slice(0, 200) : "";
  return { os: b.os, walletAddress: b.walletAddress, ramGb, gpu, hardwareNote };
}

// Public (no auth) — lets the registration wizard preview the classification
// a given hardware report would produce, using the exact same logic that
// will run at registration and again (with real, verified numbers) at CLI
// link time. No side effects, so it's safe to call before sign-in.
router.post("/contributors/detect-mode", (req, res) => {
  const { ramGb, gpu } = req.body ?? {};
  if (typeof ramGb !== "number" || !Number.isFinite(ramGb)) {
    res.status(400).json({ error: "ramGb must be a number" });
    return;
  }
  const contributionMode = classifyContributionMode(Math.round(ramGb), typeof gpu === "string" ? gpu : null);
  res.json({ contributionMode });
});

router.post("/contributors/register", requireAuth, async (req: any, res) => {
  try {
    const body = validateRegisterBody(req.body);
    if (!body) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const existing = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.clerkUserId, req.userId))
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({ error: "Node already registered for this account", node: existing[0] });
      return;
    }

    // A missing/undetectable ramGb (e.g. a privacy-hardened browser) defaults
    // to "relay" rather than "compute" — we never want an undetected device
    // to land in the highest-reward tier by default. This is only ever the
    // registration-time estimate; it's superseded once the node client links
    // with real, verified hardware numbers.
    const contributionMode: ContributionMode =
      body.ramGb != null ? classifyContributionMode(Math.round(body.ramGb), body.gpu) : "relay";

    const [node] = await db.insert(nodesTable).values({
      clerkUserId: req.userId,
      nodeType: nodeTypeFromContributionMode(contributionMode),
      os: body.os,
      hardware: body.hardwareNote,
      walletAddress: body.walletAddress,
      contributionMode,
      reportedRamGb: body.ramGb != null ? Math.round(body.ramGb) : null,
      reportedGpu: body.gpu,
    }).returning();

    res.status(201).json(node);
  } catch (err) {
    console.error("POST /contributors/register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/contributors/me", requireAuth, async (req: any, res) => {
  try {
    const [node] = await db
      .select()
      .from(nodesTable)
      .where(eq(nodesTable.clerkUserId, req.userId))
      .limit(1);

    if (!node) {
      res.status(404).json({ error: "No node registered" });
      return;
    }

    res.json(node);
  } catch (err) {
    console.error("GET /contributors/me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
