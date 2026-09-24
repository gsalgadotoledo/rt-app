import React, { useEffect, useRef, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
import { formatMoney, currencyDecimals, currencyStep, majorAmount } from "@gsalgadotoledo/rt-app-subscriptions/currency";
import { CurrencyPicker } from "./currency.js";

const path = "/subscriptions/admin";

const KIND_LABELS: Record<string, string> = {
  allowance: "Plan allowance",
  expiry: "Expired",
  usage: "Usage",
  grant: "Assigned",
  purchase: "Purchase",
  plan: "Plan",
  adjustment: "Adjustment",
  reset: "Courtesy reset",
};

const SOURCE_LABELS: Record<string, string> = {
  system: "System",
  admin: "Administrator",
  billing: "Billing",
  user: "User",
  api: "Application",
};

const money = (totals: Record<string, number> = {}) =>
  Object.entries(totals).map(([currency, minor]) => formatMoney(minor, currency)).join(" · ") || "—";

/** Stable request id per identical submission, so retries never record twice. */
function useRequestId() {
  const current = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  return {
    for(fingerprint: string) {
      if (current.current?.fingerprint !== fingerprint) current.current = { fingerprint, id: crypto.randomUUID() };
      return current.current.id;
    },
    clear() {
      current.current = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Credit statement of one user
// ---------------------------------------------------------------------------

/** Balance tab: available credits, totals and the chronological statement (credits and debits). */
export function CreditStatement({ api, userId, products, onChange }: { api: Api; userId: string; products: any[]; onChange?: () => void }) {
  const [ledger, setLedger] = useState<any>();
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function load(cursor?: string) {
    setError("");
    try {
      setLedger(await api(`${path}/accounts/${encodeURIComponent(userId)}/ledger${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [userId]);

  if (!ledger) return error ? <p role="alert">{error}</p> : <p className="hint">Loading balance…</p>;
  const rows = [...ledger.entries, ...ledger.pending];
  return (
    <div className="credit-statement">
      {error && <p role="alert">{error}</p>}
      <div className="overview-stats">
        {ledger.balances.map((b: any) => (
          <article key={b.productId}>
            <small>Available · {products.find((p) => p.id === b.productId)?.name ?? b.productId}</small>
            <strong>{b.available}</strong>
            <span>{b.allowanceLeft} plan allowance · {b.additionalCredits} additional</span>
          </article>
        ))}
        <article>
          <small>Credits in / out</small>
          <strong><span className="positive">+{ledger.totals.creditsIn}</span> / <span className="negative">−{ledger.totals.creditsOut}</span></strong>
          <span>{ledger.totals.expired} expired · {ledger.totals.consumed} consumed</span>
        </article>
        <article>
          <small>Total paid</small>
          <strong>{money(ledger.totals.paidMinor)}</strong>
          <span>Assigned value (not charged): {money(ledger.totals.grantedValueMinor)}</span>
        </article>
      </div>
      <div className="table-wrap">
        <table className="ledger-table">
          <thead>
            <tr><th>Date</th><th>Movement</th><th>Detail</th><th>Source</th><th className="num">Credits</th><th className="num">Money</th><th className="num">Available</th></tr>
          </thead>
          <tbody>
            {rows.map((e: any) => (
              <tr key={e.id ?? e.kind + e.at + e.productId} className={e.pending ? "pending" : ""}>
                <td>{new Date(e.at).toLocaleString()}</td>
                <td><span className={"ledger-kind " + e.kind}>{KIND_LABELS[e.kind] ?? e.kind}</span></td>
                <td>
                  {e.reason}
                  {e.kind === "usage" && e.fromBalance > 0 && <small> · {e.fromAllowance} allowance + {e.fromBalance} additional</small>}
                  {e.details && <small> · {Object.entries(e.details).map(([k, v]) => `${k}: ${v}`).join(", ")}</small>}
                  {e.pending && <small> · pending: recorded on the next change</small>}
                </td>
                <td>{SOURCE_LABELS[e.source] ?? e.source}{e.actorId ? " · " + e.actorId : ""}</td>
                <td className={"num " + (e.credits > 0 ? "positive" : e.credits < 0 ? "negative" : "")}>{e.credits > 0 ? "+" + e.credits : e.credits < 0 ? "−" + -e.credits : "—"}</td>
                <td className="num">{e.amountMinor ? formatMoney(e.amountMinor, e.currency) : ""}</td>
                <td className="num">{e.available ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="empty">No credit movements yet.</p>}
      </div>
      <div className="pagination">
        {pages.length > 0 && <button onClick={() => { const previous = pages.slice(0, -1); setPages(previous); void load(previous.at(-1)); }}>Previous</button>}
        {ledger.cursor && <button onClick={() => { setPages([...pages, ledger.cursor]); void load(ledger.cursor); }}>Next</button>}
      </div>
      <RecordCredits api={api} userId={userId} products={products} onRecorded={async () => { setPages([]); await load(); onChange?.(); }} />
    </div>
  );
}

/** Log a credit (+) or debit (−) on the statement: purchases, adjustments, assignments, usage. */
function RecordCredits({ api, userId, products, onRecorded }: { api: Api; userId: string; products: any[]; onRecorded: () => Promise<void> }) {
  const [productId, setProductId] = useState(products[0]?.id ?? "api");
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [kind, setKind] = useState("purchase");
  const [credits, setCredits] = useState(100);
  const [paid, setPaid] = useState("");
  const [currency, setCurrency] = useState("usd");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const request = useRequestId();
  const kinds = direction === "credit" ? ["purchase", "grant", "adjustment"] : ["usage", "adjustment"];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body: any = { productId, credits: direction === "credit" ? credits : -credits, kind, reason };
    if (paid.trim()) Object.assign(body, { amountMinor: Math.round(Number(paid) * 10 ** currencyDecimals(currency)), currency });
    body.requestId = request.for(JSON.stringify(body));
    setBusy(true);
    setMessage("");
    try {
      await api(`${path}/accounts/${encodeURIComponent(userId)}/ledger`, "POST", body);
      request.clear();
      setReason("");
      setMessage("Recorded on the statement.");
      await onRecorded();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="subscription-plan" onSubmit={submit}>
      <h3>Record credits or debits</h3>
      <label>Movement
        <select value={direction} onChange={(e) => { const next = e.target.value as "credit" | "debit"; setDirection(next); setKind(next === "credit" ? "purchase" : "usage"); }}>
          <option value="credit">Credit (+)</option>
          <option value="debit">Debit (−)</option>
        </select>
      </label>
      <label>Type<select value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></label>
      <label>Product<select value={productId} onChange={(e) => setProductId(e.target.value)}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Credits<input required type="number" min={1} step={1} value={credits} onChange={(e) => setCredits(Number(e.target.value))} /></label>
      {direction === "credit" && kind === "purchase" && (
        <>
          <label>Amount paid (optional)<input type="number" min={0} step={currencyStep(currency)} value={paid} onChange={(e) => setPaid(e.target.value)} /></label>
          <CurrencyPicker value={currency} onChange={setCurrency} />
        </>
      )}
      <label>Reason<input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <p>{direction === "credit" ? "Credits are additional: they never expire and are used after the weekly plan allowance." : "Debits use the plan allowance first, then additional credits, and fail if the user has not enough credits."}</p>
      {message && <p role="status">{message}</p>}
      <button disabled={busy || !reason.trim() || credits < 1}>Record {direction}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Credit rates and sandbox (Settings tab)
// ---------------------------------------------------------------------------

/** Edit the credit pack (money value of a credit) and the per-model rates. Saved with the settings form. */
export function CreditRatesEditor({ credits, onChange }: { credits: any; onChange: (credits: any) => void }) {
  const set = (patch: any) => onChange({ ...credits, ...patch });
  const setRate = (index: number, patch: any) => set({ rates: credits.rates.map((r: any, i: number) => (i === index ? { ...r, ...patch } : r)) });
  const { pack } = credits;
  return (
    <fieldset className="credit-rates">
      <legend>Credits</legend>
      <p className="hint">The pack price sets the money value of one credit ({formatMoney(Math.round(pack.amountMinor / Math.max(1, pack.credits) * 1000), pack.currency)} per 1,000 credits). Rates say how many credits each model charges per 1,000 tokens.</p>
      <div className="credit-pack">
        <label>Credits per pack<input type="number" min={1} step={1} value={pack.credits} onChange={(e) => set({ pack: { ...pack, credits: Number(e.target.value) } })} /></label>
        <label>Pack price<input type="number" min={0} step={currencyStep(pack.currency)} value={majorAmount(pack.amountMinor, pack.currency)} onChange={(e) => set({ pack: { ...pack, amountMinor: Math.round(Number(e.target.value) * 10 ** currencyDecimals(pack.currency)) } })} /></label>
        <CurrencyPicker value={pack.currency} onChange={(currency) => set({ pack: { ...pack, currency } })} />
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Model / function</th><th>Credits per 1k input</th><th>Credits per 1k output</th><th>Minimum</th><th /></tr></thead>
          <tbody>
            {credits.rates.map((r: any, i: number) => (
              <tr key={i}>
                <td><input aria-label="Rate ID" value={r.id} maxLength={100} onChange={(e) => setRate(i, { id: e.target.value })} /></td>
                <td><input aria-label="Rate name" value={r.name} maxLength={80} onChange={(e) => setRate(i, { name: e.target.value })} /></td>
                <td><input aria-label="Input credits per 1k tokens" type="number" min={0} step={0.0001} value={r.inputPer1k} onChange={(e) => setRate(i, { inputPer1k: Number(e.target.value) })} /></td>
                <td><input aria-label="Output credits per 1k tokens" type="number" min={0} step={0.0001} value={r.outputPer1k} onChange={(e) => setRate(i, { outputPer1k: Number(e.target.value) })} /></td>
                <td><input aria-label="Minimum credits" type="number" min={0} step={1} value={r.minimum} onChange={(e) => setRate(i, { minimum: Number(e.target.value) })} /></td>
                <td><button type="button" onClick={() => set({ rates: credits.rates.filter((_: any, j: number) => j !== i) })}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => set({ rates: [...credits.rates, { id: "model-" + (credits.rates.length + 1), name: "New model", inputPer1k: 1, outputPer1k: 1, minimum: 1 }] })}>Add rate</button>
    </fieldset>
  );
}

/**
 * Credit sandbox: price tokens for a model (credits and money) and, for a user, preview how the
 * charge splits between plan allowance and additional credits. Optionally charge it for real.
 */
export function CreditSandbox({ api, rates, products }: { api: Api; rates: any[]; products: any[] }) {
  const [rateId, setRateId] = useState(rates[0]?.id ?? "");
  const [inputTokens, setInputTokens] = useState(1000);
  const [outputTokens, setOutputTokens] = useState(500);
  const [user, setUser] = useState("");
  const [productId, setProductId] = useState(products[0]?.id ?? "api");
  const [result, setResult] = useState<any>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRequestId();

  /** Accept a user id or search by email/name through the accounts list. */
  async function resolveUser() {
    const q = user.trim();
    if (!q) return undefined;
    const page = await api(`${path}/accounts?q=${encodeURIComponent(q)}`);
    const match = page.items.find((u: any) => u.userId === q || u.email === q) ?? (page.items.length === 1 ? page.items[0] : undefined);
    if (!match) throw new Error("User not found on the first page; use the exact email or ID");
    return match.userId as string;
  }

  async function run(charge: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const userId = await resolveUser();
      const estimate = await api(`${path}/credits/estimate`, "POST", { rateId, inputTokens, outputTokens, ...(userId ? { userId, productId } : {}) });
      setResult(estimate);
      if (charge && userId) {
        const body = {
          productId,
          credits: -estimate.credits,
          kind: "usage",
          reason: `Sandbox: ${estimate.rate.name} request`,
          details: { rateId, inputTokens, outputTokens },
        };
        await api(`${path}/accounts/${encodeURIComponent(userId)}/ledger`, "POST", { ...body, requestId: request.for(JSON.stringify([userId, body])) });
        request.clear();
        setResult(await api(`${path}/credits/estimate`, "POST", { rateId, inputTokens, outputTokens, userId, productId }));
        setMessage(`Charged ${estimate.credits} credits to the user. See the Balance tab.`);
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const account = result?.account;
  return (
    <section className="credit-sandbox">
      <h3>Credit sandbox</h3>
      <p className="hint">Test rates before using them in code: <code>subscriptions.consumeUsage(userId, productId, {"{rateId, inputTokens, outputTokens}"}, requestId)</code>. Estimates never write.</p>
      <form className="subscription-plan" onSubmit={(e) => { e.preventDefault(); void run(false); }}>
        <label>Model / function<select value={rateId} onChange={(e) => setRateId(e.target.value)}>{rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label>Input tokens<input type="number" min={0} step={1} value={inputTokens} onChange={(e) => setInputTokens(Number(e.target.value))} /></label>
        <label>Output tokens<input type="number" min={0} step={1} value={outputTokens} onChange={(e) => setOutputTokens(Number(e.target.value))} /></label>
        <label>User (optional: email or ID)<input value={user} maxLength={200} onChange={(e) => setUser(e.target.value)} /></label>
        {user.trim() && <label>Product<select value={productId} onChange={(e) => setProductId(e.target.value)}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        <div className="sandbox-actions">
          <button disabled={busy || !rateId}>Calculate</button>
          {user.trim() && <button type="button" disabled={busy || !account?.allowed} onClick={() => void run(true)}>Charge to user</button>}
        </div>
      </form>
      {message && <p role="status">{message}</p>}
      {result && (
        <div className="overview-stats">
          <article>
            <small>{result.rate.name} · {result.inputTokens.toLocaleString()} in + {result.outputTokens.toLocaleString()} out</small>
            <strong>{result.credits} credits</strong>
            <span>{result.exactCredits} exact, rounded up{result.rate.minimum ? ` · minimum ${result.rate.minimum}` : ""}</span>
          </article>
          <article>
            <small>Money value</small>
            <strong>{formatMoney(result.valueMinor, result.currency)}</strong>
            <span>At the pack price</span>
          </article>
          {account && (
            <article>
              <small>For this user</small>
              <strong className={account.allowed ? "positive" : "negative"}>{account.allowed ? "Allowed" : "Not enough credits"}</strong>
              <span>{account.fromAllowance} from allowance + {account.fromBalance} additional · {account.available} available → {account.availableAfter}</span>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
