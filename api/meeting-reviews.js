import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function adminApp() {
  const existing = getApps().find(app => app.name === "swans-meeting-reviews");
  if (existing) return existing;
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) {
    const error = new Error("Meeting record storage is not configured on the server.");
    error.code = "meeting_storage_not_configured";
    throw error;
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    const error = new Error("The server's Firebase service account configuration is invalid.");
    error.code = "meeting_storage_configuration_invalid";
    throw error;
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    const error = new Error("The server's Firebase service account is incomplete.");
    error.code = "meeting_storage_configuration_incomplete";
    throw error;
  }
  return initializeApp({
    credential: cert(serviceAccount),
    projectId: "swans-accident-management"
  }, "swans-meeting-reviews");
}

async function authenticate(req, app) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    const error = new Error("Please sign in again before saving this meeting outcome.");
    error.status = 401;
    error.code = "missing_auth_token";
    throw error;
  }
  try {
    return await getAuth(app).verifyIdToken(header.slice(7));
  } catch (cause) {
    const error = new Error("Your sign-in has expired. Please sign in again, then retry the meeting outcome.");
    error.status = 401;
    error.code = cause?.code || "invalid_auth_token";
    throw error;
  }
}

export default async function handler(req, res) {
  const allowedOrigins = new Set([
    "https://swans-accident-management-ob3s.vercel.app",
    "https://swans-accident-management-barry-s-projects22.vercel.app",
    "https://swans-accident-management-git-main-barry-s-projects22.vercel.app"
  ]);
  const origin = req.headers.origin || "";
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const app = adminApp();
    const actor = await authenticate(req, app);
    const db = getFirestore(app);

    if (req.method === "GET") {
      const snapshot = await db.collection("meetingReviews").orderBy("reviewedAt", "desc").get();
      return res.status(200).json({
        ok: true,
        reviews: snapshot.docs.map(item => ({ ...item.data(), id: item.id }))
      });
    }

    const review = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      return res.status(400).json({ ok: false, error: "Invalid meeting outcome." });
    }
    if (typeof review.id !== "string" || !/^review-[A-Za-z0-9-]{10,100}$/.test(review.id)) {
      return res.status(400).json({ ok: false, error: "Invalid meeting outcome reference." });
    }
    if (typeof review.driver !== "string" || !review.driver.trim() ||
        typeof review.notes !== "string" || !review.notes.trim()) {
      return res.status(400).json({ ok: false, error: "Driver and decision rationale are required." });
    }
    if (typeof review.outcome !== "string" || typeof review.reviewedAt !== "number") {
      return res.status(400).json({ ok: false, error: "The meeting decision is incomplete." });
    }

    const safe = {
      ...review,
      driver: review.driver.trim(),
      notes: review.notes.trim(),
      reviewedBy: review.reviewedBy || actor.email || actor.uid,
      updatedAt: Date.now()
    };
    const record = db.collection("meetingReviews").doc(review.id);
    await record.set(safe, { merge: true });

    // Read the document back before telling the app that the save succeeded.
    const verification = await record.get();
    if (!verification.exists) {
      const error = new Error("The database did not confirm the saved meeting outcome.");
      error.code = "meeting_save_verification_failed";
      throw error;
    }

    return res.status(200).json({
      ok: true,
      review: { ...verification.data(), id: verification.id },
      verified: true
    });
  } catch (error) {
    const status = error.status || (error.code === "auth/id-token-expired" ? 401 : 500);
    console.error("Meeting review API failed:", {
      code: error.code || "meeting_review_error",
      message: error.message || "Unknown meeting storage error",
      status
    });
    return res.status(status).json({
      ok: false,
      error: error.message || "The meeting outcome could not be saved.",
      code: error.code || "meeting_review_error"
    });
  }
}
