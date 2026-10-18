import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createHash, randomBytes } from "node:crypto";

function adminApp() {
  if (getApps().length) return getApps()[0];
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is not configured");
  const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return initializeApp({ credential: cert(serviceAccount) });
}
function csvEmails(value) {
  return (value || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
  });
}
function brandedHtml(subject, text) {
  const lines = String(text || "").split("\n");
  const details = [];
  const intro = [];
  for (const line of lines) {
    const match = line.match(/^([^:]{2,45}):\s*(.*)$/);
    if (match) details.push('<tr><td style="padding:9px 12px;color:#64748b;font-size:12px;border-bottom:1px solid #e8eef0;width:34%;vertical-align:top;">' + escapeHtml(match[1]) + '</td><td style="padding:9px 12px;color:#163b35;font-size:13px;font-weight:600;border-bottom:1px solid #e8eef0;vertical-align:top;">' + escapeHtml(match[2] || "—") + '</td></tr>');
    else if (line.trim()) intro.push(escapeHtml(line));
  }
  const heading = escapeHtml(subject.replace(/^\[[^\]]+\]\s*/, ""));
  const content = (intro.length ? '<p style="margin:0 0 18px;color:#425b56;font-size:14px;line-height:1.7;">' + intro.join("<br>") + '</p>' : "")
    + (details.length ? '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e5eceb;border-radius:10px;overflow:hidden;">' + details.join("") + '</table>' : "");
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f4;font-family:Arial,Helvetica,sans-serif;color:#163b35;">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Swans Travel Accident Management notification</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f4;padding:28px 12px;"><tr><td align="center">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dce7e4;border-radius:14px;overflow:hidden;">'
    + '<tr><td style="background:#123d38;padding:24px 28px;"><div style="font-size:11px;letter-spacing:2px;color:#9ee4d5;font-weight:bold;text-transform:uppercase;">SWANS TRAVEL</div><div style="font-size:23px;line-height:1.3;color:#ffffff;font-weight:bold;margin-top:8px;">Accident Management</div><div style="font-size:12px;color:#d4e8e3;margin-top:6px;">Operational notification</div></td></tr>'
    + '<tr><td style="padding:26px 28px 10px;"><div style="display:inline-block;background:#e2f5ef;color:#087767;border-radius:20px;padding:6px 10px;font-size:11px;font-weight:bold;letter-spacing:.5px;">ACTION / INFORMATION</div><h1 style="font-size:21px;line-height:1.35;margin:15px 0 18px;color:#153d37;">' + heading + '</h1>' + content + '</td></tr>'
    + '<tr><td style="padding:22px 28px 26px;"><div style="border-top:1px solid #e5eceb;padding-top:16px;color:#71817d;font-size:11px;line-height:1.6;">Automated notification from Swans Travel Accident Management.<br>Please open the app to review the case and update any outstanding tasks.<br><span style="color:#9aa8a4;">This is an automated email — please do not reply.</span></div></td></tr>'
    + '</table><div style="padding:14px 8px;color:#9aa8a4;font-size:10px;">Swans Travel · Accident Management</div></td></tr></table></body></html>';
}
async function sendEmail(to, subject, text, eventKey, htmlOverride) {
  const url = process.env.GOOGLE_MAILER_URL;
  const secret = process.env.GOOGLE_MAILER_SHARED_SECRET;
  if (!url) throw new Error("GOOGLE_MAILER_URL is not configured");
  if (!secret) throw new Error("GOOGLE_MAILER_SHARED_SECRET is not configured");
  if (!to || !to.length) throw new Error("No notification recipients are configured");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: secret, to: to, subject: subject, text: text, html: htmlOverride || brandedHtml(subject, text), eventKey: eventKey })
  });
  const raw = await response.text();
  let body = {};
  try { body = JSON.parse(raw); } catch (_) {}
  if (!response.ok || !body.ok) {
    throw new Error("Google mailer rejected email (" + response.status + "): " + String(body.error || raw || "Unknown response").slice(0, 500));
  }
  return body.id || (body.duplicate ? "duplicate" : "accepted");
}
async function staffEmails(db) {
  const users = await db.collection("appUsers").get();
  const active = users.docs.map(function (d) { return d.data(); }).filter(function (u) {
    return u.email && u.status !== "Disabled" && u.status !== "Invite pending";
  }).map(function (u) { return String(u.email).trim().toLowerCase(); });
  return Array.from(new Set(active.concat(csvEmails(process.env.ACCIDENT_ALERT_TO)).filter(Boolean)));
}
async function logAttempt(db, eventKey, details) {
  await db.collection("notificationEvents").doc(eventKey).set({
    ...details, attemptedAt: FieldValue.serverTimestamp(), status: details.status || "attempted"
  }, { merge: true });
}
async function notifyEvent(req, res, db) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Authentication required" });
  let actor;
  try { actor = await getAuth(adminApp()).verifyIdToken(token); }
  catch (_) { return res.status(401).json({ error: "Invalid authentication token" }); }
  const input = req.body || {};
  const eventType = input.type;
  const caseId = String(input.caseId || "");
  const eventKey = String(input.eventKey || "");
  if (!caseId || !eventKey || !["new_accident", "task_assigned", "fnol_acknowledged", "driver_insurance_form"].includes(eventType)) {
    return res.status(400).json({ error: "Invalid notification event" });
  }
  const eventRef = db.collection("notificationEvents").doc(eventKey);
  const prior = await eventRef.get();
  if (prior.exists && prior.data().status === "sent") return res.status(200).json({ ok: true, duplicate: true });
  const caseSnap = await db.collection("accidentCases").doc(caseId).get();
  if (!caseSnap.exists) return res.status(404).json({ error: "Accident case not found" });
  const accident = caseSnap.data();
  let to = [];
  let subject = "";
  let message = "";
  if (eventType === "new_accident") {
    to = await staffEmails(db);
    subject = "New accident recorded: " + (accident.ref || caseId);
    message = "A new accident has been recorded.\n\nReference: " + (accident.ref || caseId) + "\nDate: " + (accident.date || "Not recorded") + "\nDriver: " + (accident.driver || "Not recorded") + "\nVehicle: " + (accident.vehicle || "Not recorded") + "\nLocation: " + (accident.location || "Not recorded") + "\nSeverity: " + (accident.severity || "Not recorded") + "\nRecorded by: " + (actor.email || actor.uid);
  } else if (eventType === "fnol_acknowledged") {
    to = csvEmails(process.env.FNOL_ALERT_TO || process.env.ACCIDENT_ALERT_TO);
    subject = "FNOL acknowledged: " + (accident.ref || caseId);
    message = "FNOL has been acknowledged for accident " + (accident.ref || caseId) + ".\nDriver: " + (accident.driver || "Not recorded") + "\nAcknowledged by: " + (accident.fnolAcknowledgedBy || actor.email || actor.uid) + "\nReference: " + (accident.fnolReference || "Not recorded");
  } else if (eventType === "driver_insurance_form") {
    const formUrl = String(process.env.INSURANCE_FORM_URL || "").trim();
    if (!formUrl || !/^https:\/\//i.test(formUrl)) return res.status(503).json({ error: "Adobe insurance form link is not configured" });
    const baseUrl = String(process.env.APP_BASE_URL || "https://swans-accident-management.vercel.app").replace(/\/$/, "");
    if (!/^https:\/\//i.test(baseUrl)) return res.status(503).json({ error: "App base URL must use HTTPS" });
    const driverId = String(input.driverId || accident.driverId || "");
    let driver = null;
    if (driverId) {
      const driverSnap = await db.collection("drivers").doc(driverId).get();
      if (driverSnap.exists) driver = driverSnap.data();
    }
    if (!driver) {
      const driverSnap = await db.collection("drivers").where("name", "==", accident.driver).limit(1).get();
      if (!driverSnap.empty) driver = driverSnap.docs[0].data();
    }
    // Prefer the saved driver email. The UI only sends recipientEmail when the
    // profile has no email, allowing one-off delivery without editing records.
    const driverEmail = String(driver && driver.email || input.recipientEmail || "").trim().toLowerCase();
    if (!driverEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(driverEmail)) {
      return res.status(400).json({ error: "This driver has no valid email address. Add it in Register > Drivers or enter an email address when prompted." });
    }
    to = [driverEmail];
    subject = "Action required: complete your insurance form — " + (accident.ref || caseId);
    message = "Hello " + (driver.name || accident.driver || "there") + ",\n\nPlease complete the Swans Travel insurance paperwork for the incident recorded below.\n\nOpen your Adobe form using the link provided, complete all required fields accurately, check your answers, and submit the form when finished. Please contact the office if you have difficulty accessing or completing it.\n\nAdobe insurance form: " + formUrl + "\n\nAccident reference: " + (accident.ref || caseId) + "\nIncident date: " + (accident.date || "Not recorded") + "\nVehicle: " + (accident.vehicle || "Not recorded") + "\n\nThank you,\nSwans Travel";
    const safe = function (v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (ch) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]; }); };
    const trackingToken = randomBytes(32).toString("base64url");
    const trackingId = createHash("sha256").update(trackingToken).digest("hex");
    const trackedFormUrl = baseUrl + "/api/insurance-form-click?t=" + encodeURIComponent(trackingToken);
    message = message.replaceAll(formUrl, trackedFormUrl);
    await db.collection("insuranceFormLinks").doc(trackingId).set({
      caseId: caseId,
      accidentRef: accident.ref || caseId,
      driverName: driver.name || accident.driver || "Driver",
      driverEmail: driverEmail,
      requestedByEmail: String(actor.email || "").trim().toLowerCase(),
      targetUrl: formUrl,
      emailEventKey: eventKey,
      sentAt: FieldValue.serverTimestamp(),
      clickCount: 0,
      status: "sent"
    });
    const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#eef3f1;font-family:Arial,Helvetica,sans-serif;color:#183b35;">'
      + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Action required: complete your Swans Travel insurance form for accident ' + safe(accident.ref || caseId) + '.</div>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f1;padding:28px 12px;"><tr><td align="center">'
      + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dce7e4;border-radius:16px;overflow:hidden;">'
      + '<tr><td style="background:#123d38;padding:24px 30px;"><div style="font-size:11px;letter-spacing:2px;color:#a8e6d8;font-weight:bold;">SWANS TRAVEL</div><div style="font-size:22px;line-height:1.3;color:#ffffff;font-weight:bold;margin-top:7px;">Accident Management</div></td></tr>'
      + '<tr><td style="padding:30px 32px 12px;"><div style="display:inline-block;background:#e5f5ef;color:#087767;border-radius:20px;padding:7px 11px;font-size:10px;font-weight:bold;letter-spacing:.7px;">DRIVER ACTION REQUIRED</div><h1 style="font-size:25px;line-height:1.25;margin:16px 0 14px;color:#153d37;">Complete your insurance form</h1><p style="font-size:15px;line-height:1.7;margin:0 0 12px;color:#294a43;">Hello ' + safe(driver.name || accident.driver || "Driver") + ',</p><p style="font-size:14px;line-height:1.75;margin:0;color:#526761;">Please complete the online insurance form for the incident below. Review your answers carefully before you submit it.</p></td></tr>'
      + '<tr><td style="padding:18px 32px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8f7;border:1px solid #e2ebe7;border-radius:12px;"><tr><td style="padding:16px 18px;border-bottom:1px solid #e2ebe7;color:#718079;font-size:12px;width:38%;">Accident reference</td><td style="padding:16px 18px;border-bottom:1px solid #e2ebe7;color:#183b35;font-size:13px;font-weight:bold;">' + safe(accident.ref || caseId) + '</td></tr><tr><td style="padding:13px 18px;border-bottom:1px solid #e2ebe7;color:#718079;font-size:12px;">Incident date</td><td style="padding:13px 18px;border-bottom:1px solid #e2ebe7;color:#183b35;font-size:13px;font-weight:bold;">' + safe(accident.date || "Not recorded") + '</td></tr><tr><td style="padding:13px 18px;color:#718079;font-size:12px;">Vehicle</td><td style="padding:13px 18px;color:#183b35;font-size:13px;font-weight:bold;">' + safe(accident.vehicle || "Not recorded") + '</td></tr></table></td></tr>'
      + '<tr><td style="padding:22px 32px 8px;"><h2 style="font-size:15px;margin:0 0 13px;color:#183b35;">What you need to do</h2><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:30px;vertical-align:top;padding:0 0 10px;"><span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:50%;background:#e5f5ef;color:#087767;font-size:11px;font-weight:bold;">1</span></td><td style="padding:2px 0 10px;color:#526761;font-size:13px;line-height:1.6;">Open the secure form using the button below.</td></tr><tr><td style="width:30px;vertical-align:top;padding:0 0 10px;"><span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:50%;background:#e5f5ef;color:#087767;font-size:11px;font-weight:bold;">2</span></td><td style="padding:2px 0 10px;color:#526761;font-size:13px;line-height:1.6;">Complete each required section accurately.</td></tr><tr><td style="width:30px;vertical-align:top;"><span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:50%;background:#e5f5ef;color:#087767;font-size:11px;font-weight:bold;">3</span></td><td style="padding:2px 0 0;color:#526761;font-size:13px;line-height:1.6;">Check your answers, then submit the form.</td></tr></table></td></tr>'
      + '<tr><td align="center" style="padding:24px 32px 12px;"><a href="' + safe(trackedFormUrl) + '" style="display:inline-block;background:#087767;border-radius:9px;padding:15px 28px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;">Open insurance form</a></td></tr>'
      + '<tr><td style="padding:8px 32px 26px;text-align:center;"><p style="font-size:11px;line-height:1.65;color:#718079;margin:0;">If the button does not open, copy this address into your browser:<br><a href="' + safe(trackedFormUrl) + '" style="color:#087767;word-break:break-all;">' + safe(trackedFormUrl) + '</a></p><p style="font-size:12px;line-height:1.65;color:#526761;margin:16px 0 0;">If you have difficulty accessing or completing the form, contact the Swans Travel office.</p></td></tr>'
      + '<tr><td style="background:#f7faf8;border-top:1px solid #e5eceb;padding:18px 32px;color:#718079;font-size:11px;line-height:1.6;">Automated email from Swans Travel Accident Management.<br>Please do not forward the form link. This mailbox is not monitored for replies.</td></tr>'
      + '</table><div style="padding:14px 8px;color:#98a7a1;font-size:10px;">Swans Travel - Accident Management</div></td></tr></table></body></html>';
    input._driverEmailHtml = html;
  } else {
    const taskId = String(input.taskId || "");
    const task = (accident.tasks || []).find(function (t) { return t.id === taskId; });
    if (!task) return res.status(404).json({ error: "Assigned task not found" });
    const assignee = String(task.assignee || "");
    if (!assignee || /unassigned/i.test(assignee)) return res.status(200).json({ ok: true, skipped: "Task is unassigned" });
    const users = await db.collection("appUsers").get();
    const matched = users.docs.map(function (d) { return d.data(); }).filter(function (u) {
      return String(u.name || "").trim().toLowerCase() === assignee.trim().toLowerCase() && u.email;
    });
    to = matched.map(function (u) { return u.email; });
    if (!to.length && /insurance|claims/i.test(assignee)) to = csvEmails(process.env.FNOL_ALERT_TO);
    if (!to.length) to = csvEmails(process.env.ACCIDENT_ALERT_TO);
    subject = "Accident task assigned to " + assignee + ": " + (accident.ref || caseId);
    message = "An accident management task has been assigned.\n\nAccident: " + (accident.ref || caseId) + "\nTask: " + (task.title || task.type || "Task") + "\nAssigned to: " + assignee + "\nStatus: " + (task.status || "Pending") + "\nDue: " + (task.dueAt || "Not specified") + "\nAssigned by: " + (actor.email || actor.uid);
  }
  try {
    await logAttempt(db, eventKey, { type: eventType, caseId: caseId, actor: actor.uid, recipients: to, status: "attempted" });
    const providerId = await sendEmail(to, subject, message, eventKey, input._driverEmailHtml);
    await eventRef.set({ type: eventType, caseId: caseId, actor: actor.uid, recipients: to, subject: subject, status: "sent", providerId: providerId, sentAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(200).json({ ok: true, sent: true });
  } catch (error) {
    await eventRef.set({ type: eventType, caseId: caseId, actor: actor.uid, recipients: to, subject: subject, status: "failed", error: String(error.message || error), failedAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(502).json({ error: "Notification failed", detail: String(error.message || error) });
  }
}
async function checkDeadlines(res, db) {
  const cases = await db.collection("accidentCases").get();
  const everyone = await staffEmails(db);
  let checked = 0, sent = 0, failed = 0;
  const now = Date.now();
  for (const docSnap of cases.docs) {
    const accident = docSnap.data();
    if (accident.status === "Closed") continue;
    for (const task of (accident.tasks || [])) {
      if (!task || task.status === "Completed" || task.status === "Not required") continue;
      const isInvestigation = task.type === "Investigation";
      const dueMs = task.dueAt ? Date.parse(task.dueAt) : NaN;
      const incidentTime = accident.date ? Date.parse(String(accident.date) + "T" + String(accident.time || "00:00") + ":00") : NaN;
      const ageHours = Number.isFinite(incidentTime) ? (now - incidentTime) / 3600000 : 0;
      const dueSoon = Number.isFinite(dueMs) && dueMs > now && dueMs - now <= 2 * 3600000;
      const overdue = Number.isFinite(dueMs) && dueMs <= now;
      const unacknowledged = task.status === "Pending" && dueSoon;
      const investigation72 = isInvestigation && ageHours >= 72;
      if (!dueSoon && !overdue && !investigation72) continue;
      checked++;
      const kind = overdue ? "task_overdue" : investigation72 ? "investigation_72h" : unacknowledged ? "task_unacknowledged_due_soon" : "task_due_soon";
      const eventKey = kind + ":" + docSnap.id + ":" + task.id;
      const eventRef = db.collection("notificationEvents").doc(eventKey);
      const existing = await eventRef.get();
      if (existing.exists && existing.data().status === "sent") continue;
      const assignee = String(task.assignee || "");
      const users = await db.collection("appUsers").get();
      const assignedTo = users.docs.map(function (d) { return d.data(); }).filter(function (u) {
        return String(u.name || "").trim().toLowerCase() === assignee.trim().toLowerCase() && u.email && u.status !== "Disabled";
      }).map(function (u) { return String(u.email).trim().toLowerCase(); });
      // Deadline and acknowledgement warnings go to the whole accident team, plus the assignee.
      const recipients = Array.from(new Set(everyone.concat(assignedTo)));
      const subject = overdue ? "OVERDUE accident task: " + (accident.ref || docSnap.id)
        : investigation72 ? "72-hour investigation deadline: " + (accident.ref || docSnap.id)
        : unacknowledged ? "ACTION REQUIRED — unacknowledged task due soon: " + (accident.ref || docSnap.id)
        : "Accident task deadline approaching: " + (accident.ref || docSnap.id);
      const message = "An accident management task needs attention.\n\nAccident: " + (accident.ref || docSnap.id)
        + "\nDriver: " + (accident.driver || "Not recorded")
        + "\nTask: " + (task.title || task.type || "Task")
        + "\nAssigned to: " + (assignee || "Unassigned")
        + "\nDue: " + (task.dueAt || "Not specified")
        + "\nStatus: " + (task.status || "Pending")
        + "\nAlert: " + (overdue ? "The deadline has passed." : investigation72 ? "The investigation has reached 72 hours." : unacknowledged ? "The task is still Pending and is not acknowledged." : "The task deadline is within the next two hours.")
        + "\nPlease update the task or close the case once all required work is complete.";
      try {
        await logAttempt(db, eventKey, { type: kind, caseId: docSnap.id, taskId: task.id, recipients: recipients, status: "attempted" });
        const providerId = await sendEmail(recipients, subject, message, eventKey);
        await eventRef.set({ type: kind, caseId: docSnap.id, taskId: task.id, recipients: recipients, subject: subject, status: "sent", providerId: providerId, sentAt: FieldValue.serverTimestamp() }, { merge: true });
        sent++;
      } catch (error) {
        await eventRef.set({ type: kind, caseId: docSnap.id, taskId: task.id, recipients: recipients, status: "failed", error: String(error.message || error), failedAt: FieldValue.serverTimestamp() }, { merge: true });
        failed++;
      }
    }
  }
  return res.status(200).json({ ok: true, checked: checked, sent: sent, failed: failed });
}
export default async function handler(req, res) {
  try {
    const db = getFirestore(adminApp());
    if (req.method === "POST") return await notifyEvent(req, res, db);
    if (req.method === "GET") {
      const secret = process.env.CRON_SECRET;
      if (!secret || req.headers.authorization !== "Bearer " + secret) return res.status(401).json({ error: "Unauthorized" });
      return await checkDeadlines(res, db);
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res.status(500).json({ error: "Notification service unavailable", detail: String(error.message || error) });
  }
}
