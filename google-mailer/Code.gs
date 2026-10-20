/**
 * Swans Accident Management free email gateway.
 *
 * Deploy as a Google Apps Script Web App:
 * - Execute as: Me
 * - Who has access: Anyone
 * Set Script Property MAILER_SHARED_SECRET to the same strong random value
 * stored in Vercel as GOOGLE_MAILER_SHARED_SECRET.
 *
 * This endpoint only sends to @swanstravel.com recipients.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const props = PropertiesService.getScriptProperties();
    const expected = props.getProperty("MAILER_SHARED_SECRET") || props.getProperty("WEBHOOK_SECRET");
    if (!expected || !body.secret || !constantTimeEqual(String(body.secret), expected)) {
      return json({ ok: false, error: "Unauthorized" });
    }
    const recipients = Array.isArray(body.to) ? body.to : [];
    if (!recipients.length || recipients.length > 20) return json({ ok: false, error: "Invalid recipients" });
    const clean = recipients.map(function (x) { return String(x).trim().toLowerCase(); });
    if (clean.some(function (email) { return !/^[^\s@]+@swanstravel\.com$/.test(email); })) {
      return json({ ok: false, error: "Recipients must use an approved Swans Travel email address" });
    }
    const subject = String(body.subject || "").trim().slice(0, 180);
    const message = String(body.text || "").trim().slice(0, 18000);
    const eventKey = String(body.eventKey || "").trim().slice(0, 200);
    if (!subject || !message || !eventKey) return json({ ok: false, error: "Missing subject, text or eventKey" });
    lock.waitLock(10000);
    const key = "sent_" + Utilities.base64EncodeWebSafe(eventKey).slice(0, 180);
    if (props.getProperty(key)) return json({ ok: true, duplicate: true, id: props.getProperty(key) });
    if (MailApp.getRemainingDailyQuota() < clean.length) return json({ ok: false, error: "Google daily email quota reached" });
    const suppliedHtml = String(body.html || "").trim();
    const html = (suppliedHtml || brandedHtml(subject, message)).slice(0, 40000);
    // Keep `body` populated so mail clients that disable HTML can show the message.
    MailApp.sendEmail({ to: clean.join(","), subject: subject, body: message, htmlBody: html, name: "Swans Travel | Accident Management" });
    const id = Utilities.getUuid();
    props.setProperty(key, id);
    return json({ ok: true, id: id });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>\"']/g, function (ch) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" })[ch];
  });
}
function brandedHtml(subject, message) {
  const paragraphs = String(message || "").split(/\n\s*\n/).map(function (part) {
    return part.trim() ? '<p style="margin:0 0 16px;color:#425b56;font-size:14px;line-height:1.7;white-space:pre-line;">' + escapeHtml(part.trim()) + '</p>' : "";
  }).join("");
  return '<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f1f5f4;font-family:Arial,Helvetica,sans-serif;color:#163b35;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f4;padding:16px 0;"><tr><td align="center">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #dce7e4;border-radius:14px;overflow:hidden;">'
    + '<tr><td style="background:#123d38;padding:24px 28px;"><div style="font-size:11px;letter-spacing:2px;color:#9ee4d5;font-weight:bold;">SWANS TRAVEL</div><div style="font-size:23px;line-height:1.3;color:#fff;font-weight:bold;margin-top:8px;">Accident Management</div></td></tr>'
    + '<tr><td style="padding:28px;"><h1 style="font-size:21px;line-height:1.35;margin:0 0 18px;color:#153d37;">' + escapeHtml(subject) + '</h1>' + paragraphs + '</td></tr>'
    + '<tr><td style="padding:18px 28px;background:#f8faf9;border-top:1px solid #e5eceb;color:#71817d;font-size:11px;line-height:1.6;">Automated notification from Swans Travel Accident Management.<br>This is an automated email — please do not reply.</td></tr>'
    + '</table><div style="padding:14px 8px;color:#9aa8a4;font-size:10px;">Swans Travel · Accident Management</div></td></tr></table></body></html>';
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function json(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Scheduled accident deadline checker.
 * Run setupAccidentDeadlineChecks once from the Apps Script editor.
 * It creates a 15-minute trigger that calls the protected Vercel endpoint.
 */
function setupAccidentDeadlineChecks() {
  const properties = PropertiesService.getScriptProperties();
  const secret = properties.getProperty("CRON_SECRET") || properties.getProperty("MAILER_SHARED_SECRET") || properties.getProperty("WEBHOOK_SECRET");
  if (!secret) throw new Error("Set MAILER_SHARED_SECRET (or CRON_SECRET) in Project Settings > Script properties before enabling deadline checks.");

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "runAccidentDeadlineChecks") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("runAccidentDeadlineChecks").timeBased().everyMinutes(15).create();
  runAccidentDeadlineChecks();
}

function runAccidentDeadlineChecks() {
  const properties = PropertiesService.getScriptProperties();
  const secret = properties.getProperty("CRON_SECRET") || properties.getProperty("MAILER_SHARED_SECRET") || properties.getProperty("WEBHOOK_SECRET");
  if (!secret) throw new Error("No scheduler secret configured in Apps Script properties.");

  const endpoint = properties.getProperty("ACCIDENT_NOTIFICATIONS_URL") || "https://swans-accident-management.vercel.app/api/notifications";
  const response = UrlFetchApp.fetch(endpoint, {
    method: "get",
    headers: { Authorization: "Bearer " + secret },
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  console.log("Accident deadline check returned HTTP " + status + ": " + body);
  if (status < 200 || status >= 300) {
    throw new Error("Accident deadline check failed with HTTP " + status + ": " + body);
  }
  return body;
}
