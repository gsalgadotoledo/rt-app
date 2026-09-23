import {formatMoney as money} from '@gsalgadotoledo/rt-app-subscriptions/currency';
import "./style.css";
import React, { useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";

function PaymentFields({
  kind,
  onDone,
}: {
  kind: "setup" | "payment";
  onDone: (id?: string) => Promise<void>;
}) {
  const stripe = useStripe(),
    elements = useElements(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!stripe || !elements) return;
        setBusy(true);
        try {
          const result =
            kind === "setup"
              ? await stripe.confirmSetup({
                  elements,
                  confirmParams: { return_url: location.origin + "/account" },
                  redirect: "if_required",
                })
              : await stripe.confirmPayment({
                  elements,
                  confirmParams: { return_url: location.origin + "/account" },
                  redirect: "if_required",
                });
          if (result.error) throw new Error(result.error.message);
          await onDone(
            "setupIntent" in result ? result.setupIntent?.id : undefined,
          );
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <PaymentElement />
      {error && <p role="alert">{error}</p>}
      <button disabled={!stripe || busy}>
        {busy
          ? "Processing…"
          : kind === "setup"
            ? "Save payment method"
            : "Confirm payment"}
      </button>
    </form>
  );
}
export default function SubscriptionProfile({ api }: { api: Api }) {
  const [account, setAccount] = useState<any>(),
    [billing, setBilling] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [payment, setPayment] = useState<any>(),
    [operation, setOperation] = useState<{ input: string; key: string }>();
  const stripe = useMemo(
    () => (account?.publishableKey ? loadStripe(account.publishableKey) : null),
    [account?.publishableKey],
  );
  async function refresh() {
    const [a, b] = await Promise.all([
      api("/subscriptions/me"),
      api("/subscriptions/billing"),
    ]);
    setAccount(a);
    setBilling(b);
    if (a.pendingBillingRequest) {
      const p = a.pendingBillingRequest;
      const path =
        p.action === "change"
          ? "/subscriptions/change"
          : p.action === "setup"
            ? "/subscriptions/payment/setup"
            : "/subscriptions/cancel";
      const body = p.action === "change" ? { planId: p.planId } : {};
      setOperation({ input: path + JSON.stringify(body), key: p.requestId });
    }
  }
  useEffect(() => {
    void (async () => {
      const params = new URLSearchParams(location.search);
      const recovery = JSON.parse(
        sessionStorage.getItem("rt-app-billing-return") ?? "null",
      );
      const setupId = params.get("setup_intent") ?? recovery?.setupId;
      if (setupId)
        await api("/subscriptions/payment/save", "POST", { setupId });
      if (setupId || params.has("payment_intent") || recovery?.payment) {
        await api("/subscriptions/sync", "POST", {});
        sessionStorage.removeItem("rt-app-billing-return");
        history.replaceState(null, "", location.pathname);
      }
      await refresh();
    })().catch((e) => setError(e.message));
  }, []);
  async function run(path: string, body: any = {}) {
    setBusy(true);
    setError("");
    const input = path + JSON.stringify(body),
      key = operation?.input === input ? operation.key : crypto.randomUUID();
    setOperation({ input, key });
    try {
      const result = await api(path, "POST", { ...body, requestId: key });
      if (result.clientSecret)
        setPayment({
          kind: path.includes("/setup") ? "setup" : "payment",
          ...result,
        });
      else await refresh();
      setOperation(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="subscription-profile">
      <h3>Subscription & billing</h3>
      {error && <p role="alert">{error}</p>}
      {account && (
        <>
          <p>
            <strong>{account.plan?.name ?? "No plan"}</strong> ·{" "}
            {account.active ? "Active" : account.status}
            {account.provider === "local" ? " · Payment simulation" : ""}
          </p>
          {account.assignedByAdmin && <p>Plan assigned by an administrator.</p>}
          {Object.entries(account.creditBalance ?? {}).map(([product, credits]) => <p key={product}>Additional credits · {product}: {String(credits)}</p>)}
          {account.periodEnd && (
            <p>
              Period ends {new Date(account.periodEnd).toLocaleDateString()}
              {account.cancelAtPeriodEnd ? " · Will not renew" : ""}
            </p>
          )}
          {account.pendingBillingRequest && (
            <p>
              A billing request is pending.{" "}
              <button
                disabled={busy}
                onClick={() => {
                  const p = account.pendingBillingRequest;
                  void run(
                    p.action === "change"
                      ? "/subscriptions/change"
                      : p.action === "setup"
                        ? "/subscriptions/payment/setup"
                        : "/subscriptions/cancel",
                    p.action === "change" ? { planId: p.planId } : {},
                  );
                }}
              >
                Retry pending request
              </button>
            </p>
          )}
          <div>
            {account.usage.map((p: any) => (
              <article key={p.id}>
                <strong>{p.name}</strong>
                <p>
                  {p.remaining} / {p.credits} credits remaining
                </p>
                <small>
                  Daily: {p.dayUsed} / {p.dailyLimit} · resets{" "}
                  {new Date(p.dayResetAt).toLocaleString()}
                  <br />
                  Weekly: {p.weekUsed} / {p.weeklyLimit} · resets{" "}
                  {new Date(p.weekResetAt).toLocaleString()}
                </small>
              </article>
            ))}
          </div>
          <details>
            <summary>Choose or change plan</summary>
            {account.plans.map((p: any) => (
              <div key={p.id}>
                <strong>{p.name}</strong> ·{" "}
                {account.paymentRequired
                  ? money(p.amount, p.currency)
                  : "No payment required"}{" "}
                / {p.periodDays} days{" "}
                <button
                  disabled={
                    busy || (account.active && account.plan?.id === p.id)
                  }
                  onClick={() =>
                    void run("/subscriptions/change", { planId: p.id })
                  }
                >
                  Select
                </button>
              </div>
            ))}
            {account.paymentRequired && (
              <p>
                Changes may generate a prorated invoice. Access updates after
                payment confirmation.
              </p>
            )}
          </details>
          {account.paymentRequired && (
            <button
              disabled={busy}
              onClick={() => void run("/subscriptions/payment/setup")}
            >
              Update payment method
            </button>
          )}
          {payment && stripe && (
            <Elements
              stripe={stripe}
              options={{ clientSecret: payment.clientSecret }}
              key={payment.clientSecret}
            >
              <PaymentFields
                kind={payment.kind}
                onDone={async (setupId) => {
                  if (setupId)
                    await api("/subscriptions/payment/save", "POST", {
                      setupId,
                    });
                  await api("/subscriptions/sync", "POST", {});
                  setPayment(undefined);
                  await refresh();
                }}
              />
            </Elements>
          )}
          <button
            disabled={busy}
            onClick={() => void run("/subscriptions/sync")}
          >
            Refresh billing
          </button>
          {account.plan && !account.cancelAtPeriodEnd && (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Cancel renewal at the end of the current period?",
                  )
                )
                  void run("/subscriptions/cancel");
              }}
            >
              Cancel renewal
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={account.notifications !== false}
              onChange={async (e) => {
                try {
                  await api("/subscriptions/preferences", "PUT", {
                    notifications: e.target.checked,
                  });
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
            Email subscription alerts
          </label>
          <details>
            <summary>Invoices & payment history</summary>
            {billing?.simulated && (
              <p>Simulated invoices — no money was charged.</p>
            )}
            {billing?.partial && (
              <p>
                Showing the latest 100 invoices; totals cover only these
                invoices.
              </p>
            )}
            {billing?.totals?.map((t: any) => (
              <p key={t.currency}>
                Paid: {money(t.paid, t.currency)} · Due:{" "}
                {money(t.due, t.currency)}
              </p>
            ))}
            {billing?.paymentMethods?.map((m: any, i: number) => (
              <p key={m.id ?? i}>
                {m.brand} ···· {m.last4}
              </p>
            ))}
            {billing?.invoices?.map((i: any) => (
              <div key={i.id}>
                {i.number ?? i.id} · {i.status} ·{" "}
                {money(i.amountPaid, i.currency)}{" "}
                {i.pdf && (
                  <a href={i.pdf} target="_blank" rel="noreferrer">
                    PDF
                  </a>
                )}
              </div>
            ))}
            {!billing?.invoices?.length && <p>No invoices yet.</p>}
          </details>
        </>
      )}
    </section>
  );
}
