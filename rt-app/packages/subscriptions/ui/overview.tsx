import React, { useEffect, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
import { formatMoney } from "@gsalgadotoledo/rt-app-subscriptions/currency";

interface Month {
  month: string;
  customers: number | null;
  paying: number | null;
  new: number;
  canceled: number;
}

/** Subscriptions at a glance: customers, revenue projection, new and canceled subscriptions. */
export function SubscriptionsOverview({ api }: { api: Api }) {
  const [data, setData] = useState<any>();
  const [months, setMonths] = useState(12);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    api("/subscriptions/admin/overview?months=" + months)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [months]);

  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p className="hint">Loading overview…</p>;
  const revenue = Object.entries(data.mrrMinor as Record<string, number>);
  const asOf = new Date(data.asOf).toLocaleDateString(undefined, { dateStyle: "long" });
  return (
    <div className="subscriptions-overview">
      <div className="overview-stats">
        <article>
          <small>Customers · {asOf}</small>
          <strong>{data.customers}</strong>
          <span>{data.paying} paying · {data.customers - data.paying} free or assigned</span>
        </article>
        <article>
          <small>Projected monthly revenue</small>
          <strong>{revenue.length ? revenue.map(([currency, minor]) => formatMoney(minor, currency)).join(" · ") : "—"}</strong>
          <span>{data.canceling ? `Excludes ${data.canceling} subscriptions ending this period` : "Active paid plans, monthly equivalent"}</span>
        </article>
        <article className="overview-split">
          <small>Today · {data.today.date}</small>
          <div>
            <p><strong className="positive">+{data.today.new}</strong><span>new</span></p>
            <p><strong className="negative">−{data.today.canceled}</strong><span>canceled</span></p>
          </div>
        </article>
        <article className="overview-split">
          <small>This month · {data.month.month}</small>
          <div>
            <p><strong className="positive">+{data.month.new}</strong><span>new</span></p>
            <p><strong className="negative">−{data.month.canceled}</strong><span>canceled</span></p>
          </div>
        </article>
      </div>
      <div className="overview-chart-head">
        <h3>Customers per month</h3>
        <label>
          Range
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[6, 12, 24].map((n) => <option key={n} value={n}>{n} months</option>)}
          </select>
        </label>
      </div>
      <MonthlyChart series={data.series} />
      <p className="hint">
        Customers per month come from daily snapshots saved when this overview is opened; months before the first snapshot show no line.
        Revenue projects the monthly price of active paid plans billed by the payment provider, without currency conversion. Administrative assignments are excluded.
      </p>
      {data.plans.length > 0 && (
        <table>
          <thead><tr><th>Plan</th><th>Customers</th><th>Paying</th></tr></thead>
          <tbody>
            {data.plans.map((p: any) => (
              <tr key={p.planId}><td>{p.name}</td><td>{p.customers}</td><td>{p.paying}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** New/canceled bars per month with the customer line on top. Pure SVG, theme colors. */
function MonthlyChart({ series }: { series: Month[] }) {
  const width = 720, height = 220, pad = { top: 16, right: 12, bottom: 28, left: 36 };
  const max = Math.max(1, ...series.flatMap((m) => [m.new, m.canceled, m.customers ?? 0]));
  const band = (width - pad.left - pad.right) / series.length;
  const y = (value: number) => pad.top + (height - pad.top - pad.bottom) * (1 - value / max);
  const x = (index: number) => pad.left + band * index + band / 2;
  const bar = Math.max(2, Math.min(14, band / 4));
  const line = series
    .map((m, i) => (m.customers === null ? null : `${x(i)},${y(m.customers)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <figure className="overview-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Customers, new and canceled subscriptions per month">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(max * t)} y2={y(max * t)} className="grid" />
            <text x={pad.left - 6} y={y(max * t) + 4} textAnchor="end">{Math.round(max * t)}</text>
          </g>
        ))}
        {series.map((m, i) => (
          <g key={m.month}>
            <rect className="bar-new" x={x(i) - bar - 1} y={y(m.new)} width={bar} height={y(0) - y(m.new)}><title>{`${m.month}: ${m.new} new`}</title></rect>
            <rect className="bar-canceled" x={x(i) + 1} y={y(m.canceled)} width={bar} height={y(0) - y(m.canceled)}><title>{`${m.month}: ${m.canceled} canceled`}</title></rect>
            {(series.length <= 12 || i % 2 === 0) && <text x={x(i)} y={height - 8} textAnchor="middle">{m.month.slice(2)}</text>}
          </g>
        ))}
        {line && <polyline points={line} className="customers-line" />}
        {series.map((m, i) =>
          m.customers === null ? null : (
            <circle key={m.month} cx={x(i)} cy={y(m.customers)} r={3} className="customers-dot"><title>{`${m.month}: ${m.customers} customers`}</title></circle>
          ),
        )}
      </svg>
      <figcaption>
        <span className="legend customers">Customers</span>
        <span className="legend new">New</span>
        <span className="legend canceled">Canceled</span>
      </figcaption>
    </figure>
  );
}
