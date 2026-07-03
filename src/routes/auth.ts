import { Router } from "express";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { JWT_SECRET } from "../middlewares/jwtAuth";

const router = Router();

router.post("/auth/login", async (req, res) => {
  const { walletAddress, signature, message } = req.body;

  if (!walletAddress || !signature || !message) {
    return res.status(400).json({ error: "walletAddress, signature, and message are required" });
  }

  try {
    const msgBytes = new Uint8Array(Buffer.from(message));
    const sigBytes = new Uint8Array(Buffer.from(signature, "base64"));
    const pubKeyBytes = new Uint8Array(bs58.decode(walletAddress));

    const valid = nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);

    if (!valid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const token = jwt.sign({ walletAddress }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, walletAddress });
  } catch (err) {
    console.error("POST /auth/login error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
});

export default router;
