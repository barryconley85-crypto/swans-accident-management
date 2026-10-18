import { createHash } from "node:crypto";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function adminApp() {
  if (getApps().length) return getApps()[0];
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is not configured");
  const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return initializeApp({ credential: cert(serviceAccount) });
}

function csvEmails(value) {
  return (value || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function staffEmails(db) {
  const users = await db.collection("appUsers").get();
  const active = users.docs.map(d => d.data()).filter(u => u.email && u.status !== "Disabled" && u.status !== "Invite pending")
    .map(u => String(u.email).trim().toLowerCase());
  return Array.from(new Set(active.concat(csvEmails(process.env.ACCIDENT_ALERT_TO)).filter(Boolean)));
}

async function clickAlertEmails(db, link) {
  const configured = csvEmails(process.env.INSURANCE_FORM_CLICK_ALERT_TO);
  if (configured.length) return configured;
  const sender = String(link.requestedByEmail || "").trim().toLowerCase();
  if (/^[^\s@]+@swanstravel\.com$/.test(sender)) return [sender];
  const accidentAlerts = csvEmails(process.env.ACCIDENT_ALERT_TO);
  if (accidentAlerts.length) return accidentAlerts;
  return staffEmails(db);
}

async function notifyFirstClick(db, trackingId, link) {
  const eventKey = "insurance-form-click:" + trackingId;
  const eventRef = db.collection("notificationEvents").doc(eventKey);
  const recipients = await clickAlertEmails(db, link);
  if (!recipients.length) throw new Error("No accident alert recipients are configured");

  const subject = "Driver opened insurance form: " + (link.accidentRef || link.caseId);
  const text = "The driver insurance form link was opened.\n\nAccident reference: " + (link.accidentRef || link.caseId)
    + "\nDriver: " + (link.driverName || "Not recorded") + "\nDriver email: " + (link.driverEmail || "Not recorded")
    + "\nFirst opened: " + new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })
    + "\n\nThis confirms the link was requested. It does not confirm that the form was completed.";
  const safeRef = escapeHtml(link.accidentRef || link.caseId);
  const safeDriver = escapeHtml(link.driverName || "Not recorded");
  const safeEmail = escapeHtml(link.driverEmail || "Not recorded");
  const html = '<!doctype html><html><body style="margin:0;padding:24px 12px;background:#eef3f1;font-family:Arial,Helvetica,sans-serif;color:#183b35;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f1;padding:16px 0;"><tr><td align="center">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #dce7e4;border-radius:14px;overflow:hidden;">'
    + '<tr><td style="background:#123d38;padding:24px 28px;"><div style="font-size:11px;letter-spacing:2px;color:#9ee4d5;font-weight:bold;">SWANS TRAVEL</div><div style="font-size:22px;color:#fff;font-weight:bold;margin-top:8px;">Accident Management</div></td></tr>'
    + '<tr><td style="padding:28px;"><div style="display:inline-block;background:#e2f5ef;color:#087767;border-radius:20px;padding:6px 10px;font-size:11px;font-weight:bold;">FORM LINK OPENED</div><h1 style="font-size:21px;line-height:1.35;margin:15px 0;color:#153d37;">The driver opened their insurance form link</h1>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8f7;border:1px solid #e2ebe7;border-radius:10px;"><tr><td style="padding:13px 16px;border-bottom:1px solid #e2ebe7;color:#718079;font-size:12px;width:38%;">Accident reference</td><td style="padding:13px 16px;border-bottom:1px solid #e2ebe7;color:#183b35;font-size:13px;font-weight:bold;">' + safeRef + '</td></tr><tr><td style="padding:13px 16px;border-bottom:1px solid #e2ebe7;color:#718079;font-size:12px;">Driver</td><td style="padding:13px 16px;border-bottom:1px solid #e2ebe7;color:#183b35;font-size:13px;font-weight:bold;">' + safeDriver + '</td></tr><tr><td style="padding:13px 16px;color:#718079;font-size:12px;">Email</td><td style="padding:13px 16px;color:#183b35;font-size:13px;font-weight:bold;">' + safeEmail + '</td></tr></table>'
    + '<p style="margin:18px 0 0;color:#526761;font-size:13px;line-height:1.65;">This confirms that the form link was opened. It does not confirm that the driver submitted the form.</p></td></tr>'
    + '<tr><td style="padding:18px 28px;background:#f8faf9;border-top:1px solid #e5eceb;color:#71817d;font-size:11px;line-height:1.6;">Automated notification from Swans Travel Accident Management.</td></tr>'
    + '</table></td></tr></table></body></html>';
  const url = process.env.GOOGLE_MAILER_URL;
  const secret = process.env.GOOGLE_MAILER_SHARED_SECRET;
  if (!url || !secret) throw new Error("Google mailer is not configured");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, to: recipients, subject, text, html, eventKey })
  });
  const raw = await response.text();
  let result = {};
  try { result = JSON.parse(raw); } catch (_) {}
  if (!response.ok || !result.ok) throw new Error("Google mailer rejected click notification (" + response.status + "): " + String(result.error || raw || "Unknown response").slice(0, 400));
  await eventRef.set({ type: "insurance_form_clicked", caseId: link.caseId, recipients, subject, status: "sent", providerId: result.id || (result.duplicate ? "duplicate" : "accepted"), sentAt: FieldValue.serverTimestamp() }, { merge: true });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }
  const token = String(req.query && req.query.t || "");
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return res.status(400).send("This form link is invalid.");

  try {
    const db = getFirestore(adminApp());
    const trackingId = createHash("sha256").update(token).digest("hex");
    const linkRef = db.collection("insuranceFormLinks").doc(trackingId);
    let link;
    let shouldNotify = false;
    await db.runTransaction(async tx => {
      const snap = await tx.get(linkRef);
      if (!snap.exists) return;
      link = snap.data();
      const firstClick = !link.firstClickedAt;
      const retryNotification = link.clickNotificationStatus === "failed";
      tx.set(linkRef, {
        clickCount: FieldValue.increment(1),
        lastClickedAt: FieldValue.serverTimestamp(),
        ...(firstClick ? { firstClickedAt: FieldValue.serverTimestamp() } : {}),
        ...(firstClick || retryNotification ? { clickNotificationStatus: "pending" } : {})
      }, { merge: true });
      shouldNotify = firstClick || retryNotification;
    });
    if (!link) return res.status(404).send("This form link is no longer available.");

    if (shouldNotify) {
      try {
        await notifyFirstClick(db, trackingId, link);
        await linkRef.set({ clickNotificationStatus: "sent", clickNotificationSentAt: FieldValue.serverTimestamp() }, { merge: true });
      } catch (error) {
        console.error("Insurance form click notification failed", error);
        await linkRef.set({ clickNotificationStatus: "failed", clickNotificationError: String(error.message || error).slice(0, 500) }, { merge: true });
      }
    }
    const targetUrl = String(link.targetUrl || "");
    if (!/^https:\/\//i.test(targetUrl)) return res.status(410).send("This form link is no longer available.");
    res.setHeader("Location", targetUrl);
    return res.status(302).end();
  } catch (error) {
    console.error("Insurance form click could not be recorded", error);
    return res.status(500).send("We could not open this form link. Please contact the Swans Travel office.");
  }
}
