import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Clock3, RefreshCw } from "lucide-react";

type FollowUp = {
  caseId: string;
  reference: string;
  driver: string;
  driverEmail: string;
  sentAt: string | null;
  firstClickedAt: string | null;
  lastClickedAt: string | null;
  clickCount: number;
  clickNotificationStatus: string;
};

export default function InsuranceFollowUpsPage({ user }: { user: any }) {
  const [items, setItems] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/insurance-form-follow-ups", { headers: { Authorization: "Bearer " + token } });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not load follow-ups");
      setItems(result.items || []);
    } catch (err: any) {
      setError(err?.message || "Could not load follow-ups");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { void load(); }, [load]);
  const date = (value: string | null) => value ? new Date(value).toLocaleString("en-GB") : "—";

  return <>
    <div className="head"><div><small className="eyebrow">Driver paperwork</small><h2>Insurance form follow-ups</h2><p>Sent forms whose Driver Form task is still open. Link activity helps you decide when to follow up.</p></div><button className="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={15}/> {loading ? "Refreshing…" : "Refresh"}</button></div>
    <div className="card">
      <div className="cardtitle"><h3><Clock3 size={16}/> Awaiting completed form</h3><span className="muted">{items.length} open</span></div>
      {error ? <p className="muted" role="alert">{error}</p> : null}
      {loading && !items.length ? <div className="empty">Loading follow-ups…</div> : !items.length && !error ? <div className="empty">No sent insurance forms are waiting for completion.</div> : null}
      {items.length ? <div className="tablewrap"><table><thead><tr><th>Accident</th><th>Driver</th><th>Form emailed</th><th>Link activity</th><th>Last opened</th><th>Case</th></tr></thead><tbody>{items.map(item => <tr key={item.caseId}>
        <td><b>{item.reference}</b></td><td>{item.driver}<small style={{ display: "block", color: "var(--muted)", marginTop: 3 }}>{item.driverEmail}</small></td><td>{date(item.sentAt)}</td>
        <td>{item.firstClickedAt ? <><b>Opened</b><small style={{ display: "block", color: "var(--muted)", marginTop: 3 }}>{item.clickCount} request{item.clickCount === 1 ? "" : "s"}</small></> : "Not opened yet"}</td><td>{date(item.lastClickedAt)}</td><td><Link className="link" href={"/accidents/" + item.caseId}>Open case</Link></td>
      </tr>)}</tbody></table></div> : null}
      <p className="muted" style={{ marginTop: 14 }}>An opened link does not mean the form was submitted. Check Adobe for completion, then complete the Driver Form task in the case.</p>
    </div>
  </>;
}
