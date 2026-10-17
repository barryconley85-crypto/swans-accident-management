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
    const expected = props.getProperty("MAILER_SHARED_SECRET");
    if (!expected || !body.secret || !constantTimeEqual(String(body.secret), expected)) {
      return json({ ok: false, error: "Unauthorized" });
    }
    const recipients = Array.isArray(body.to) ? body.to : [];
    if (!recipients.length || recipients.length > 20) return json({ ok: false, error: "Invalid recipients" });
    const clean = recipients.map(function (x) { return String(x).trim().toLowerCase(); });
    // Driver forms may be sent to personal or other non-company addresses.
    if (clean.some(function (email) { return !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email); })) {
      return json({ ok: false, error: "One or more recipients are not valid email addresses" });
    }
    const subject = String(body.subject || "").trim().slice(0, 180);
    const message = String(body.text || "").trim().slice(0, 18000);
    const eventKey = String(body.eventKey || "").trim().slice(0, 200);
    if (!subject || !message || !eventKey) return json({ ok: false, error: "Missing subject, text or eventKey" });
    lock.waitLock(10000);
    const key = "sent_" + Utilities.base64EncodeWebSafe(eventKey).slice(0, 180);
    if (props.getProperty(key)) return json({ ok: true, duplicate: true, id: props.getProperty(key) });
    if (MailApp.getRemainingDailyQuota() < clean.length) return json({ ok: false, error: "Google daily email quota reached" });
    const html = String(body.html || "").trim().slice(0, 40000);
    MailApp.sendEmail({ to: clean.join(","), subject: subject, body: message, htmlBody: html || undefined, name: "Swans Travel | Accident Management" });
    const id = Utilities.getUuid();
    props.setProperty(key, id);
    return json({ ok: true, id: id });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
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
