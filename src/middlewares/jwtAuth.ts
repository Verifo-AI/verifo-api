import jwt from "jsonwebtoken";

export const JWT_SECRET = process.env.JWT_SECRET || "verifo-dev-secret-2024";

export function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers.authorization as string | undefined;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { walletAddress: string };
    req.userId = payload.walletAddress;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
