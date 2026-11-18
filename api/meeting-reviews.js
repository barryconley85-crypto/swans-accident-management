import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

function adminApp() {
  if (getApps().length) return getApps()[0];
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is not configured");
  const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return initializeApp({ credential: cert(serviceAccount), projectId: "swans-accident-management" });
}

async function authenticate(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) throw new Error("Please sign in again.");
  return getAuth(adminApp()).verifyIdToken(header.slice(7));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const actor = await authenticate(req);
    const db = getFirestore(adminApp());
    if (req.method === "GET") {
      const snapshot = await db.collection("meetingReviews").orderBy("reviewedAt", "desc").get();
      return res.status(200).json({ reviews: snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })) });
    }
    const review = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!review || typeof review !== "object" || Array.isArray(review)) return res.status(400).json({ error: "Invalid meeting outcome." });
    if (typeof review.id !== "string" || !/^review-[A-Za-z0-9-]{10,100}$/.test(review.id)) return res.status(400).json({ error: "Invalid meeting outcome reference." });
    if (typeof review.driver !== "string" || !review.driver.trim() || typeof review.notes !== "string" || !review.notes.trim()) return res.status(400).json({ error: "Driver and decision rationale are required." });
    if (typeof review.outcome !== "string" || typeof review.reviewedAt !== "number") return res.status(400).json({ error: "The meeting decision is incomplete." });
    const safe = { ...review, driver: review.driver.trim(), notes: review.notes.trim(), reviewedBy: review.reviewedBy || actor.email || actor.uid, updatedAt: Date.now() };
    await db.collection("meetingReviews").doc(review.id).set(safe, { merge: true });
    return res.status(200).json({ ok: true, review: safe });
  } catch (error) {
    console.error("Meeting review API failed:", error);
    const message = error?.code === "auth/id-token-expired" || error?.code === "auth/argument-error"
      ? "Your session has expired. Sign in again."
      : error?.message === "FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is not configured"
        ? "Meeting record storage is not configured on the server."
        : "The meeting outcome could not be saved to the accident management database.";
    return res.status(500).json({ error: message, code: error?.code || "meeting_review_error" });
  }
}
