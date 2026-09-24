import {CurrencyPicker} from './currency.js';
import {formatMoney, majorAmount, currencyDecimals, currencyStep} from '@gsalgadotoledo/rt-app-subscriptions/currency';
import "./style.css";
import {PlansEditor} from "./plans.js";
import {SubscriptionsOverview} from "./overview.js";
import {CreditStatement, CreditRatesEditor, CreditSandbox} from "./credits.js";
import React, { useEffect, useRef, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
export default function SubscriptionsAdmin({ api }: { api: Api }) {
  const [tab, setTab] = useState("overview"),
    [detailTab, setDetailTab] = useState("balance"),
    [settings, setSettings] = useState<any>(),
    [accounts, setAccounts] = useState<any>({ items: [] }),
    [detail, setDetail] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [scope, setScope] = useState("day"),
    [reason, setReason] = useState(""),
    [message, setMessage] = useState("");
  const resetRequest = useRef<{ input: string; id: string } | undefined>(
    undefined,
  );
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const path = "/subscriptions/admin";
  async function load(cursor?: string, q = query) {
    const [s, a] = await Promise.all([
      api(path + "/settings"),
      api(
        path +
          "/accounts" +
          "?q=" + encodeURIComponent(q) + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      ),
    ]);
    setSettings(s);
    setAccounts(a);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function action(fn: () => Promise<void>) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(userId: string) {
    setDetail(await api(path + "/accounts/" + encodeURIComponent(userId)));
  }
  // Products across all plans, for credit forms and the sandbox.
  const products = [...new Map((settings?.values.plans ?? []).flatMap((p: any) => p.products).map((p: any) => [p.id, p])).values()] as any[];
  function changePlan(index: number, field: string, value: any) {
    setSettings((s: any) => ({
      ...s,
      values: {
        ...s.values,
        plans: s.values.plans.map((p: any, i: number) =>
          i === index ? { ...p, [field]: value } : p,
        ),
      },
    }));
  }
  return (
    <section className="subscriptions-admin">
      <nav className="tabs">
        {["overview", "accounts", "plans", "settings"].map((t) => (
          <button
            key={t.charAt(0).toUpperCase()+t.slice(1)}
            className={tab === t ? "active" : ""}
            onClick={() => {
              setTab(t);
              setDetail(undefined);
            }}
          >
            {t.charAt(0).toUpperCase()+t.slice(1)}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {tab === "overview" && <SubscriptionsOverview api={api} />}
      {tab === "accounts" &&
        (detail ? (
          <>
            <button onClick={() => setDetail(undefined)}>← Users</button>
            <h2>{detail.account.email ?? detail.account.userId}</h2>
            <nav className="tabs">
              {[["balance", "Balance"], ["account", "Account"]].map(([id, label]) => (
                <button key={id} className={detailTab === id ? "active" : ""} onClick={() => setDetailTab(id)}>{label}</button>
              ))}
            </nav>
            {detailTab === "balance" && <CreditStatement api={api} userId={detail.account.userId} products={products} onChange={() => void load()} />}
            {detailTab === "account" && <>
            <p>
              {detail.account.plan?.name} · {detail.account.status} · Credits
              used: {detail.account.totalConsumed ?? 0}
            </p>
            {Object.entries(detail.account.creditBalance ?? {}).map(([product, credits]) => <p key={product}>Additional credits · {product}: {String(credits)}</p>)}
            {detail.account.usage.map((p: any) => (
              <p key={p.id}>
                {p.name}: {p.remaining}/{p.credits} remaining · daily{" "}
                {p.dayUsed}/{p.dailyLimit} · weekly {p.weekUsed}/{p.weeklyLimit}
              </p>
            ))}
            {detail.account.assignedByAdmin && <p><strong>Assigned by administrator</strong> · Valid until {new Date(detail.account.periodEnd).toLocaleDateString()}</p>}
            <AdminGrant key={detail.account.userId + ":" + detail.account.version} plans={settings?.values.plans ?? []} busy={busy} onGrant={input => action(async () => {
              await api(path + "/accounts/" + encodeURIComponent(detail.account.userId) + "/grant", "POST", input);
              await open(detail.account.userId);
              await load();
              setMessage("Assignment saved. No payment was charged.");
            })} />
            <h3>Administrative assignments</h3>
            {detail.grants?.items.map((r: any) => <p key={r.sk}>{new Date(r.data.at).toLocaleString()} · {r.data.kind === "plan" ? "Plan: " + r.data.target : r.data.credits + " credits · " + r.data.target} · {formatMoney(r.data.valueMinor,r.data.currency)} · Admin: {r.data.actorId} · {r.data.reason}</p>)}
            {detail.grants?.cursor && <button disabled={busy} onClick={() => void action(async () => setDetail(await api(path + "/accounts/" + encodeURIComponent(detail.account.userId) + "?historyCursor=" + encodeURIComponent(detail.grants.cursor))))}>Next assignments page</button>}
            <h3>Courtesy reset</h3>
            <label>
              Window
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                {["day", "week", "period", "all"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Reason
              <input
                value={reason}
                maxLength={300}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !reason.trim()}
              onClick={() =>
                void action(async () => {
                  const input = JSON.stringify([
                    detail.account.userId,
                    scope,
                    reason,
                  ]);
                  if (resetRequest.current?.input !== input)
                    resetRequest.current = { input, id: crypto.randomUUID() };
                  await api(
                    path + "/accounts/" + detail.account.userId + "/reset",
                    "POST",
                    { scope, reason, requestId: resetRequest.current.id },
                  );
                  resetRequest.current = undefined;
                  await open(detail.account.userId);
                  setReason("");
                  setMessage(
                    "Courtesy reset granted. Billing status is unchanged.",
                  );
                })
              }
            >
              Grant reset
            </button>
            {settings?.provider === "local" && (
              <div>
                <h3>Local simulation</h3>
                {["active", "past_due", "canceled"].map((status) => (
                  <button
                    key={status}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api(
                          path +
                            "/accounts/" +
                            detail.account.userId +
                            "/simulate",
                          "POST",
                          { status },
                        );
                        await open(detail.account.userId);
                      })
                    }
                  >
                    {status}
                  </button>
                ))}
              </div>
            )}
            <h3>Invoices</h3>
            {detail.billing.invoices?.map((i: any) => (
              <p key={i.id}>
                {i.number ?? i.id} · {i.status} ·{" "}
                {formatMoney(i.amountPaid,i.currency)}
              </p>
            ))}
            <h3>Usage ledger</h3>
            {detail.usage.items.map((r: any) => (
              <p key={r.sk}>
                {new Date(r.data.at).toLocaleString()} · {r.data.productId} ·{" "}
                {r.data.credits} credits
              </p>
            ))}
            {detail.usage.cursor && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () =>
                    setDetail(
                      await api(
                        path +
                          "/accounts/" +
                          detail.account.userId +
                          "?cursor=" +
                          encodeURIComponent(detail.usage.cursor),
                      ),
                    ),
                  )
                }
              >
                Next usage page
              </button>
            )}
            </>}
          </>
        ) : (
          <>
            <form className="filters" onSubmit={e => {e.preventDefault(); setQuery(search); void action(() => load(undefined, search));}}>
              <label>Find user by name, email or ID<input value={search} maxLength={200} onChange={e => setSearch(e.target.value)} /></label>
              <button disabled={busy}>Search</button>
              <button type="button" disabled={busy} onClick={() => {setSearch(""); setQuery(""); void action(() => load(undefined, ""));}}>Clear</button>
            </form>
            <p>Search filters one data page at a time. Continue to find more users.</p>
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th>Credits used / available</th>
                  <th>Courtesy resets</th>
                </tr>
              </thead>
              <tbody>
                {accounts.items.map((a: any) => (
                  <tr key={a.userId}>
                    <td>
                      <button onClick={() => void action(async () => { setDetailTab("balance"); await open(a.userId); })}>
                        {a.email ?? a.userId}
                      </button>
                    </td>
                    <td>{a.plan ?? "No plan"}{a.source === "admin" && <small> · Admin assigned</small>}</td>
                    <td>{a.status ?? "none"}</td>
                    <td>{a.totalConsumed} / {a.creditsAvailable}</td>
                    <td>{a.courtesyResets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!accounts.items.length && (
              <p>
                No matching users on this page.
              </p>
            )}
            <button disabled={busy} onClick={() => void action(() => load())}>First page</button>
            {accounts.cursor && (
              <button onClick={() => void action(() => load(accounts.cursor))}>
                Next page
              </button>
            )}
          </>
        ))}
      {settings && tab === "settings" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              setSettings(await api(path + "/settings", "PUT", settings));
              setMessage(
                "Settings saved. Existing subscriptions keep their plan limits until their next plan change or billing synchronization.",
              );
            });
          }}
        >
          {tab === "settings" ? (
            <>
              <p>Payment adapter: {settings.provider}</p>
              {["paymentRequired", "notifications"].map((k) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={settings.values[k]}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        values: { ...settings.values, [k]: e.target.checked },
                      })
                    }
                  />
                  {k === "paymentRequired"
                    ? "Require payment method / paid billing"
                    : "Enable subscription emails"}
                </label>
              ))}
              <label>
                Expiry reminder · days before
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={settings.values.reminderDays}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      values: {
                        ...settings.values,
                        reminderDays: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
            </>
          ) : null}
          <CreditRatesEditor
            credits={settings.values.credits}
            onChange={(credits) => setSettings({ ...settings, values: { ...settings.values, credits } })}
          />
          <button className="primary" disabled={busy}>
            Save configuration
          </button>
        </form>
      )}
      {settings && tab === "settings" && <CreditSandbox api={api} rates={settings.values.credits.rates} products={products} />}
      {settings && tab === "plans" && <PlansEditor settings={settings} setSettings={setSettings} api={api} busy={busy} onAction={action} />}
    </section>
  );
}

function AdminGrant({plans, busy, onGrant}: {plans: any[]; busy: boolean; onGrant: (input: any) => Promise<void>}) {
  const [kind, setKind] = useState("plan"), [target, setTarget] = useState(plans[0]?.id ?? ""),
    [credits, setCredits] = useState(100), [value, setValue] = useState(String(majorAmount(plans[0]?.amount ?? 0,plans[0]?.currency ?? 'usd'))),
    [currency, setCurrency] = useState(plans[0]?.currency ?? "usd"), [reason, setReason] = useState("");
  const request = useRef<{fingerprint: string; id: string} | undefined>(undefined);
  const products = [...new Map(plans.flatMap(p => p.products).map(p => [p.id, p])).values()];
  return <form className="subscription-plan" onSubmit={async e => {
    e.preventDefault();
    const input = {kind, planId: kind === "plan" ? target : undefined, productId: kind === "credits" ? target : undefined, credits, valueMinor: Math.round(Number(value) * 10 ** currencyDecimals(currency)), currency, reason};
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint) request.current = {fingerprint, id: crypto.randomUUID()};
    await onGrant({...input, requestId: request.current.id});
  }}>
    <h3>Assign plan or credits</h3>
    <label>Assignment<select value={kind} onChange={e => {setKind(e.target.value); setTarget(e.target.value === "plan" ? plans[0]?.id ?? "" : products[0]?.id ?? "");}}><option value="plan">Plan</option><option value="credits">Credits</option></select></label>
    <label>{kind === "plan" ? "Plan" : "Product"}<select required value={target} onChange={e => {setTarget(e.target.value); if (kind === "plan") {const p = plans.find(p => p.id === e.target.value); setValue(String(majorAmount(p.amount,p.currency))); setCurrency(p.currency);}}}>{(kind === "plan" ? plans : products).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {kind === "credits" && <label>Credits<input required type="number" min={1} max={1000000000} step={1} value={credits} onChange={e => setCredits(Number(e.target.value))} /></label>}
    <label>Recorded value (not a charge)<input required type="number" min={0} max={10000000} step={currencyStep(currency)} value={value} onChange={e => setValue(e.target.value)} /></label>
    <CurrencyPicker value={currency} onChange={setCurrency}/>
    <label>Reason<input required maxLength={300} value={reason} onChange={e => setReason(e.target.value)} /></label>
    <p>{kind === "plan" ? `Valid for ${plans.find(p => p.id === target)?.periodDays ?? 0} days. Replaces the current administrative assignment; existing Stripe billing continues.` : `Additional credits do not expire and are used after the weekly plan allowance; an active plan is still required. Value per credit: ${(Number(value) / (credits || 1)).toFixed(4)} ${currency.toUpperCase()}.`} No currency conversion is performed.</p>
    <button disabled={busy || !target || !reason.trim()}>Assign {kind === "plan" ? "plan" : "credits"}</button>
  </form>;
}
