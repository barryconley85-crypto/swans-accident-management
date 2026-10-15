import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function adminApp() {
  if (getApps().length) return getApps()[0];
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is not configured");
  const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return initializeApp({ credential: cert(serviceAccount) });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Sign in to the app first." });

    const app = adminApp();
    let actor;
    try {
      actor = await getAuth(app).verifyIdToken(token);
    } catch (_) {
      return res.status(401).json({ ok: false, error: "Your session could not be verified. Sign in again." });
    }

    const db = getFirestore(app);
    const limitRef = db.collection("mailerTestLimits").doc(actor.uid);
    const limitSnap = await limitRef.get();
    const lastSentAt = limitSnap.exists ? Number(limitSnap.data().lastSentAt || 0) : 0;
    if (Date.now() - lastSentAt < 10 * 60 * 1000) {
      return res.status(429).json({ ok: false, error: "A test was already requested recently. Wait 10 minutes before trying again." });
    }

    const url = process.env.GOOGLE_MAILER_URL;
    const secret = process.env.GOOGLE_MAILER_SHARED_SECRET;
    if (!url) throw new Error("GOOGLE_MAILER_URL is not configured in Vercel.");
    if (!secret) throw new Error("GOOGLE_MAILER_SHARED_SECRET is not configured in Vercel.");

    const eventKey = "mailer-test:" + actor.uid + ":" + Date.now();
    const stamp = new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        to: ["bc@swanstravel.com"],
        subject: "Swans Accident Management — Email connection test",
        text: "This is a test email sent from the Swans Accident Management app through the configured Google Apps Script mailer.\n\nRequested: " + stamp + "\nRequested by: " + (actor.email || actor.uid) + "\n\nNo accident records were created or changed.",
        eventKey
      })
    });

    const raw = await response.text();
    let result = {};
    try { result = JSON.parse(raw); } catch (_) {}
    if (!response.ok || !result.ok) {
      const detail = String(result.error || raw || "Unknown Google mailer response").slice(0, 400);
      return res.status(502).json({ ok: false, error: "Google mailer rejected the test: " + detail });
    }

    await limitRef.set({ lastSentAt: Date.now(), lastRequestedBy: actor.email || actor.uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(200).json({ ok: true, sent: true, to: "bc@swanstravel.com", duplicate: !!result.duplicate });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error && error.message || error) });
  }
}
