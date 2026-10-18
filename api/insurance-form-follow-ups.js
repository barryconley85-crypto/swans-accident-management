import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function adminApp() {
  if (getApps().length) return getApps()[0];
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is not configured");
  const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return initializeApp({ credential: cert(serviceAccount) });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Authentication required" });

  try {
    await getAuth(adminApp()).verifyIdToken(token);
    const db = getFirestore(adminApp());
    const links = await db.collection("insuranceFormLinks").orderBy("sentAt", "desc").limit(500).get();
    const latestByCase = new Map();
    for (const snap of links.docs) {
      const link = snap.data();
      if (!link.caseId || latestByCase.has(link.caseId)) continue;
      latestByCase.set(link.caseId, { id: snap.id, ...link });
    }
    const pending = await Promise.all(Array.from(latestByCase.values()).map(async link => {
      const caseSnap = await db.collection("accidentCases").doc(link.caseId).get();
      if (!caseSnap.exists) return null;
      const accident = caseSnap.data();
      const driverFormTask = (accident.tasks || []).find(task => task.type === "DriverForm");
      if (!driverFormTask || ["Completed", "Not required"].includes(driverFormTask.status)) return null;
      const asIso = value => value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
      return {
        caseId: link.caseId,
        reference: link.accidentRef || accident.ref || link.caseId,
        driver: link.driverName || accident.driver || "Not recorded",
        driverEmail: link.driverEmail || "",
        sentAt: asIso(link.sentAt),
        firstClickedAt: asIso(link.firstClickedAt),
        lastClickedAt: asIso(link.lastClickedAt),
        clickCount: Number(link.clickCount || 0),
        clickNotificationStatus: link.clickNotificationStatus || "not sent"
      };
    }));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, items: pending.filter(Boolean) });
  } catch (error) {
    const message = String(error && error.message || error);
    if (/verify|token|credential/i.test(message)) return res.status(401).json({ error: "Invalid authentication token" });
    console.error("Could not load insurance form follow-ups", error);
    return res.status(500).json({ error: "Could not load insurance form follow-ups" });
  }
}
