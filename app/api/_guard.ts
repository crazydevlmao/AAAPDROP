export function assertSecret(req: Request) {
  const secret = process.env.DROP_SECRET || "";
  if (!secret) return; // open for local dev
  const header = req.headers.get("x-drop-secret");
  if (header !== secret) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}
