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
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sign in to the app first" });

  let actor;
  try {
    actor = await getAuth(adminApp()).verifyIdToken(token);
  } catch (_) {
    return res.status(401).json({ error: "Your session has expired. Sign in again." });
  }

  const db = getFirestore(adminApp());
  const eventKey = "email-test:" + actor.uid + ":" + Date.now();
  const to = ["bc@swanstravel.com"];
  const subject = "Swans Accident Management — email delivery test";
  const text = "This is a test email from Swans Travel Accident Management.\n\nIf you received this message, the app successfully reached the configured Google mailer.\n\nRequested by: " + (actor.email || actor.uid) + "\nTime: " + new Date().toLocaleString("en-GB", { timeZone: "Europe/London" });

  try {
    const url = process.env.GOOGLE_MAILER_URL;
    const secret = process.env.GOOGLE_MAILER_SHARED_SECRET;
    if (!url) throw new Error("GOOGLE_MAILER_URL is not configured in Vercel");
    if (!secret) throw new Error("GOOGLE_MAILER_SHARED_SECRET is not configured in Vercel");

    await db.collection("notificationEvents").doc(eventKey).set({
      type: "email_test", actor: actor.uid, actorEmail: actor.email || "", recipients: to,
      subject, status: "attempted", attemptedAt: FieldValue.serverTimestamp()
    });

    const html = '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#163b35;padding:24px"><h2>Swans Travel Accident Management</h2><p>This is a test email from the Accident Management app.</p><p>If you received this message, the app successfully reached the configured Google mailer.</p><p>Requested by: ' + String(actor.email || actor.uid).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])) + '</p><p>Time: ' + new Date().toLocaleString("en-GB", { timeZone: "Europe/London" }) + '</p></body></html>';
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, to, subject, text, html, eventKey })
    });
    const raw = await response.text();
    let body = {};
    try { body = JSON.parse(raw); } catch (_) {}
    if (!response.ok || !body.ok) {
      throw new Error("Google mailer rejected the email (" + response.status + "): " + String(body.error || raw || "Unknown response").slice(0, 400));
    }
    await db.collection("notificationEvents").doc(eventKey).set({
      status: "sent", providerId: body.id || (body.duplicate ? "duplicate" : "accepted"),
      sentAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return res.status(200).json({ ok: true, message: "The Google mailer accepted the test email to bc@swanstravel.com. Check Inbox and Junk." });
  } catch (error) {
    const detail = String(error && error.message || error);
    try {
      await db.collection("notificationEvents").doc(eventKey).set({
        status: "failed", error: detail, failedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (_) {}
    return res.status(502).json({ error: detail });
  }
}
