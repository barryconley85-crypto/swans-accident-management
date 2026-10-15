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
function csvEmails(value) {
  return (value || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}
async function sendEmail(to, subject, text, eventKey) {
  const url = process.env.GOOGLE_MAILER_URL;
  const secret = process.env.GOOGLE_MAILER_SHARED_SECRET;
  if (!url) throw new Error("GOOGLE_MAILER_URL is not configured");
  if (!secret) throw new Error("GOOGLE_MAILER_SHARED_SECRET is not configured");
  if (!to || !to.length) throw new Error("No notification recipients are configured");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: secret, to: to, subject: subject, text: text, eventKey: eventKey })
  });
  const raw = await response.text();
  let body = {};
  try { body = JSON.parse(raw); } catch (_) {}
  if (!response.ok || !body.ok) {
    throw new Error("Google mailer rejected email (" + response.status + "): " + String(body.error || raw || "Unknown response").slice(0, 500));
  }
  return body.id || (body.duplicate ? "duplicate" : "accepted");
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
  if (!caseId || !eventKey || !["new_accident", "task_assigned", "fnol_acknowledged"].includes(eventType)) {
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
    to = csvEmails(process.env.ACCIDENT_ALERT_TO);
    subject = "New accident recorded: " + (accident.ref || caseId);
    message = "A new accident has been recorded.\n\nReference: " + (accident.ref || caseId) + "\nDate: " + (accident.date || "Not recorded") + "\nDriver: " + (accident.driver || "Not recorded") + "\nVehicle: " + (accident.vehicle || "Not recorded") + "\nLocation: " + (accident.location || "Not recorded") + "\nSeverity: " + (accident.severity || "Not recorded") + "\nRecorded by: " + (actor.email || actor.uid);
  } else if (eventType === "fnol_acknowledged") {
    to = csvEmails(process.env.FNOL_ALERT_TO || process.env.ACCIDENT_ALERT_TO);
    subject = "FNOL acknowledged: " + (accident.ref || caseId);
    message = "FNOL has been acknowledged for accident " + (accident.ref || caseId) + ".\nDriver: " + (accident.driver || "Not recorded") + "\nAcknowledged by: " + (accident.fnolAcknowledgedBy || actor.email || actor.uid) + "\nReference: " + (accident.fnolReference || "Not recorded");
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
    const providerId = await sendEmail(to, subject, message, eventKey);
    await eventRef.set({ type: eventType, caseId: caseId, actor: actor.uid, recipients: to, subject: subject, status: "sent", providerId: providerId, sentAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(200).json({ ok: true, sent: true });
  } catch (error) {
    await eventRef.set({ type: eventType, caseId: caseId, actor: actor.uid, recipients: to, subject: subject, status: "failed", error: String(error.message || error), failedAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(502).json({ error: "Notification failed", detail: String(error.message || error) });
  }
}
async function checkDeadlines(res, db) {
  const cases = await db.collection("accidentCases").get();
  let checked = 0, sent = 0, failed = 0;
  for (const docSnap of cases.docs) {
    const accident = docSnap.data();
    for (const task of (accident.tasks || [])) {
      if (!task || task.status === "Completed" || task.status === "Not required") continue;
      const isInvestigation = task.type === "Investigation";
      const incidentTime = accident.date ? Date.parse(String(accident.date) + "T" + String(accident.time || "00:00") + ":00") : NaN;
      const ageHours = Number.isFinite(incidentTime) ? (Date.now() - incidentTime) / 3600000 : 0;
      const dueMs = task.dueAt ? Date.parse(task.dueAt) : NaN;
      const overdue = Number.isFinite(dueMs) && dueMs < Date.now();
      const investigation72 = isInvestigation && ageHours >= 72;
      if (!overdue && !investigation72) continue;
      checked++;
      const kind = investigation72 ? "investigation_72h" : "task_overdue";
      const eventKey = kind + ":" + docSnap.id + ":" + task.id;
      const eventRef = db.collection("notificationEvents").doc(eventKey);
      const existing = await eventRef.get();
      if (existing.exists && existing.data().status === "sent") continue;
      let recipients = csvEmails(process.env.ACCIDENT_ALERT_TO);
      const assignee = String(task.assignee || "");
      const users = await db.collection("appUsers").get();
      const matched = users.docs.map(function (d) { return d.data(); }).filter(function (u) {
        return String(u.name || "").trim().toLowerCase() === assignee.trim().toLowerCase() && u.email;
      });
      if (matched.length) recipients = matched.map(function (u) { return u.email; });
      const subject = (investigation72 ? "72-hour investigation deadline" : "Overdue accident task") + ": " + (accident.ref || docSnap.id);
      const message = "An accident management task needs attention.\n\nAccident: " + (accident.ref || docSnap.id) + "\nTask: " + (task.title || task.type || "Task") + "\nAssigned to: " + (assignee || "Unassigned") + "\nDue: " + (task.dueAt || "72 hours after task creation") + "\nStatus: " + (task.status || "Pending");
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