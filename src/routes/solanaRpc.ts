import { Router, type IRouter } from "express";
import { solanaFetch } from "../lib/solanaTreasury";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Proxies Solana JSON-RPC requests to Helius (with automatic runtime
 * fallback to the public RPC if Helius rate-limits us) so the frontend
 * wallet provider never needs the raw HELIUS_API_KEY in browser-shipped
 * code.
 */
router.post("/solana-rpc", async (req, res) => {
  try {
    const upstream = await solanaFetch("solana-rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    logger.error({ err }, "Solana RPC proxy request failed");
    res.status(502).json({ error: "Solana RPC proxy request failed" });
  }
});

export default router;
