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

    const escapeHtml = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
      + '<body style="margin:0;padding:0;background:#eef3f1;font-family:Arial,Helvetica,sans-serif;color:#183b35;">'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f1;padding:28px 12px;"><tr><td align="center">'
      + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dce7e4;border-radius:14px;overflow:hidden;">'
      + '<tr><td style="background:#123d38;padding:24px 30px;"><div style="font-size:11px;letter-spacing:2px;color:#a8e6d8;font-weight:bold;">SWANS TRAVEL</div><div style="font-size:22px;line-height:1.3;color:#ffffff;font-weight:bold;margin-top:7px;">Accident Management</div></td></tr>'
      + '<tr><td style="padding:30px 32px;"><div style="display:inline-block;background:#e5f5ef;color:#087767;border-radius:20px;padding:7px 11px;font-size:10px;font-weight:bold;letter-spacing:.7px;">EMAIL DELIVERY TEST</div><h1 style="font-size:23px;line-height:1.3;margin:16px 0 12px;color:#153d37;">Your email is displaying as HTML</h1><p style="font-size:14px;line-height:1.7;margin:0 0 18px;color:#526761;">This branded message confirms that the Accident Management app reached the configured Google mailer and supplied an HTML email.</p>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8f7;border:1px solid #e2ebe7;border-radius:10px;"><tr><td style="padding:14px 16px;border-bottom:1px solid #e2ebe7;color:#718079;font-size:12px;width:38%;">Requested by</td><td style="padding:14px 16px;border-bottom:1px solid #e2ebe7;color:#183b35;font-size:13px;font-weight:bold;">' + escapeHtml(actor.email || actor.uid) + '</td></tr><tr><td style="padding:14px 16px;color:#718079;font-size:12px;">Time</td><td style="padding:14px 16px;color:#183b35;font-size:13px;font-weight:bold;">' + escapeHtml(new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })) + '</td></tr></table></td></tr>'
      + '<tr><td style="background:#f7faf8;border-top:1px solid #e5eceb;padding:18px 32px;color:#718079;font-size:11px;line-height:1.6;">Automated email from Swans Travel Accident Management.<br>This is a test message; no accident record was created.</td></tr>'
      + '</table><div style="padding:14px 8px;color:#98a7a1;font-size:10px;">Swans Travel - Accident Management</div></td></tr></table></body></html>';
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

