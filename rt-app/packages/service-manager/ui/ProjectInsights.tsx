import React, { useEffect, useMemo, useState } from "react";
import { TfIcon, type IconName } from "./terraformCatalog.js";

export interface InitValue { key: string; value: string | null; source: string; note?: string }
export interface InsightModule { id: string; label: string; description: string; kind: "core" | "app" | "crud" | "always"; package: string | null; required: boolean; init: InitValue[]; prefixes: string[]; migrations: { id: string; appliedAt: string | null }[]; seeds: { id: string; appliedAt: string | null; environment?: string }[]; records: number; collections: number }
export interface InsightCollection { id: string; module: string; count: number; partitions: number; updatedAt: string | null }
export interface Insights {
  project: { name: string; template: string | null; backend: string; target: string; mode: string };
  storage: { kind: string; location: string | null; readable: boolean; reason?: string; from: string };
  environment: string;
  modules: InsightModule[];
  collections: InsightCollection[];
  totals: { records: number; collections: number; modules: number; migrations: number; seeds: number; system: number; other: number };
  warnings: string[];
  readAt: string;
}
export interface RecordRow { pk: string; sk: string; version: number | null; ttl: number | null; data: unknown }
export interface InsightsClient {
  insights?(): Promise<Insights>;
  records?(options: { collection: string; offset?: number; limit?: number; search?: string }): Promise<{ collection: string; total: number; offset: number; limit: number; rows: RecordRow[] }>;
}

const MODULE_ICONS: Record<string, IconName> = { users: "user", auth: "key", acl: "shield", content: "archive", infra: "cube", "feature-flags": "tag", visits: "chart", health: "bolt", tasks: "clock", subscriptions: "dollar", observer: "search", "aws-monitor": "globe", catalog: "tag", cart: "card", payments: "dollar", orders: "archive", system: "gear", other: "cube" };
export const moduleIcon = (id: string, kind?: string): IconName => MODULE_ICONS[id] ?? (kind === "app" || kind === "crud" ? "module" : "cube");
export const KIND_LABEL: Record<string, string> = { core: "Core", always: "Framework", app: "App module", crud: "Generated CRUD" };
const home = (path: string | null) => (path ?? "").replace(/^\/Users\/[^/]+/, "~");
const since = (iso: string | null) => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
};

/** Loads the selected project's insights; `reload` re-reads them (they are never cached). */
export function useInsights(client: InsightsClient, project: string) {
  const [data, setData] = useState<Insights>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reload = async () => {
    if (!client.insights) return;
    setLoading(true);
    try { setData(await client.insights()); setError(""); } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); } finally { setLoading(false); }
  };
  useEffect(() => { setData(undefined); void reload(); }, [project]);
  return { data, error, loading, reload };
}

function Header({ title, data, loading, onReload }: { title: string; data?: Insights; loading: boolean; onReload(): void }) {
  return (
    <div className="rt-insights-head">
      <h3>{title}</h3>
      {data && <span className="rt-insights-storage" title={data.storage.location ?? undefined}><TfIcon name="database" size={13} /> {data.storage.kind}{data.storage.location ? ` · ${home(data.storage.location)}` : ""}</span>}
      <span className="rt-insights-read">{data ? `read ${since(data.readAt)}` : ""}</span>
      <button className="rt-tf-icon-button" aria-label="Reload" title="Read again" disabled={loading} onClick={onReload}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M20 7v5h-5 M20 12a8 8 0 1 0-2 5" /></svg></button>
    </div>
  );
}

function Problems({ data, error }: { data?: Insights; error: string }) {
  return <>
    {error && <p className="rt-services-error" role="alert">{error}</p>}
    {data && !data.storage.readable && <p className="rt-insights-note">Records are not available: {data.storage.reason}</p>}
    {data?.warnings.map((w) => <p key={w} className="rt-insights-note">{w}</p>)}
  </>;
}

/**
 * Records per module as horizontal bars (one series, so one hue); values are text, bars carry the
 * magnitude. Hovering a bar shows its collections.
 */
function RecordsChart({ data }: { data: Insights }) {
  const [hover, setHover] = useState<string>();
  const [asTable, setAsTable] = useState(false);
  const rows = [...data.modules.filter((m) => m.records > 0).map((m) => ({ id: m.id, label: m.label, value: m.records, kind: m.kind })), ...(data.totals.system ? [{ id: "system", label: "Framework bookkeeping", value: data.totals.system, kind: "system" }] : []), ...(data.totals.other ? [{ id: "other", label: "Unassigned", value: data.totals.other, kind: "other" }] : [])].sort((a, b) => b.value - a.value).slice(0, 12);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const detail = (id: string) => data.collections.filter((c) => c.module === id || (id === "other" && !data.modules.some((m) => m.id === c.module) && c.module !== "system"));
  if (!rows.length) return <p className="rt-insights-note">No records yet. Start the project or run its seeds to see data here.</p>;
  return (
    <figure className="rt-insights-chart">
      <figcaption><strong>Records per module</strong><small>{data.totals.records} records in {data.totals.collections} collections</small><button onClick={() => setAsTable(!asTable)}>{asTable ? "Chart" : "Table"}</button></figcaption>
      {asTable ? (
        <table className="rt-insights-table"><thead><tr><th>Module</th><th>Records</th><th>Collections</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td>{r.label}</td><td>{r.value}</td><td>{detail(r.id).map((c) => `${c.id} (${c.count})`).join(", ")}</td></tr>)}</tbody></table>
      ) : (
        <div className="rt-insights-bars" role="img" aria-label={rows.map((r) => `${r.label}: ${r.value}`).join(", ")}>
          {rows.map((r, i) => (
            <div key={r.id} className={`rt-insights-bar${hover && hover !== r.id ? " dim" : ""}`} onPointerEnter={() => setHover(r.id)} onPointerLeave={() => setHover(undefined)} style={{ animationDelay: `${i * 40}ms` }}>
              <span className="rt-insights-bar-label"><TfIcon name={moduleIcon(r.id, r.kind)} size={13} />{r.label}</span>
              <span className="rt-insights-bar-track"><i style={{ width: `${(r.value / max) * 100}%` }} /></span>
              <span className="rt-insights-bar-value">{r.value}</span>
              {hover === r.id && (
                <span className="rt-insights-tooltip" role="tooltip">
                  <strong>{r.label} · {r.value} records</strong>
                  {detail(r.id).map((c) => <span key={c.id}><code>{c.id}</code> {c.count}{c.partitions > 1 ? ` in ${c.partitions} partitions` : ""}</span>)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

/** Overview tab: headline numbers, records per module and a card per loaded module. */
export function ProjectOverview({ client, project, onOpen }: { client: InsightsClient; project: string; onOpen(tab: "modules" | "data", id?: string): void }) {
  const { data, error, loading, reload } = useInsights(client, project);
  const busiest = data?.modules.reduce<InsightModule | undefined>((a, m) => (!a || m.records > a.records ? m : a), undefined);
  return (
    <section className="rt-insights" aria-label="Project overview">
      <Header title="Overview" data={data} loading={loading} onReload={() => void reload()} />
      <Problems data={data} error={error} />
      {!data && !error && <p className="rt-wizard-note">Reading the project…</p>}
      {data && <>
        <div className="rt-insights-tiles">
          <div className="rt-insights-tile"><small>Modules loaded</small><strong>{data.totals.modules}</strong><span>{data.modules.filter((m) => m.kind === "app" || m.kind === "crud").length} from this app</span></div>
          <div className="rt-insights-tile"><small>Records</small><strong>{data.storage.readable ? data.totals.records : "—"}</strong><span>{data.storage.readable ? `${data.totals.collections} collections` : data.storage.kind}</span></div>
          <div className="rt-insights-tile"><small>Most records</small><strong className="rt-insights-tile-text">{busiest && busiest.records ? busiest.label : "—"}</strong><span>{busiest?.records ? `${busiest.records} records` : "no data yet"}</span></div>
          <div className="rt-insights-tile"><small>Migrations · seeds</small><strong>{data.totals.migrations}<em> · {data.totals.seeds}</em></strong><span>applied in {data.environment}</span></div>
          <div className="rt-insights-tile"><small>Storage</small><strong className="rt-insights-tile-text">{data.storage.kind}</strong><span>{data.project.backend} · {data.project.target}</span></div>
        </div>
        {data.storage.readable && <RecordsChart data={data} />}
        <h4 className="rt-insights-subtitle">Loaded modules</h4>
        <div className="rt-insights-modules">
          {data.modules.map((m) => (
            <button key={m.id} className={`rt-insights-module kind-${m.kind}`} onClick={() => onOpen("modules", m.id)} title={m.description}>
              <span className="rt-insights-module-icon"><TfIcon name={moduleIcon(m.id, m.kind)} size={18} /></span>
              <span className="rt-insights-module-body">
                <strong>{m.label}</strong>
                <small>{KIND_LABEL[m.kind]}{m.required ? " · required" : ""}</small>
              </span>
              <span className="rt-insights-module-count"><strong>{m.records}</strong><small>records</small></span>
            </button>
          ))}
        </div>
      </>}
    </section>
  );
}

/** Modules tab: how each backend module was initialized and with which values. */
export function ProjectModules({ client, project, focus }: { client: InsightsClient; project: string; focus?: string }) {
  const { data, error, loading, reload } = useInsights(client, project);
  const [open, setOpen] = useState<Set<string>>(new Set(focus ? [focus] : []));
  const [filter, setFilter] = useState("");
  useEffect(() => { if (focus) { setOpen((o) => new Set([...o, focus])); setTimeout(() => document.getElementById(`rt-module-${focus}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 50); } }, [focus, data]);
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const list = (data?.modules ?? []).filter((m) => !filter || `${m.id} ${m.label} ${m.init.map((i) => `${i.key} ${i.value}`).join(" ")}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section className="rt-insights" aria-label="Module initialization">
      <Header title="Module initialization" data={data} loading={loading} onReload={() => void reload()} />
      <Problems data={data} error={error} />
      {data && <>
        <div className="rt-insights-toolbar">
          <input type="search" placeholder="Filter modules or values…" aria-label="Filter modules" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={() => setOpen(new Set(data.modules.map((m) => m.id)))}>Expand all</button>
          <button onClick={() => setOpen(new Set())}>Collapse all</button>
          <span className="rt-insights-read">Values come from the API service's environment and the framework defaults · secrets are never shown</span>
        </div>
        <ol className="rt-insights-init">
          {list.map((m) => (
            <li key={m.id} id={`rt-module-${m.id}`} className={open.has(m.id) ? "open" : undefined}>
              <button className="rt-insights-init-head" aria-expanded={open.has(m.id)} onClick={() => toggle(m.id)}>
                <span className={`rt-insights-module-icon kind-${m.kind}`}><TfIcon name={moduleIcon(m.id, m.kind)} size={16} /></span>
                <span className="rt-insights-init-title"><strong>{m.label}</strong><code>{m.package ?? m.id}</code></span>
                <span className="rt-insights-badges">
                  <em>{KIND_LABEL[m.kind]}</em>
                  {m.required && <em>required</em>}
                  <em>{m.init.length} values</em>
                  {m.migrations.length > 0 && <em>{m.migrations.length} migrations</em>}
                  {m.records > 0 && <em>{m.records} records</em>}
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d={open.has(m.id) ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} /></svg>
              </button>
              {open.has(m.id) && (
                <div className="rt-insights-init-body">
                  {m.description && <p>{m.description}</p>}
                  <table className="rt-insights-table">
                    <thead><tr><th>Option</th><th>Value</th><th>Source</th></tr></thead>
                    <tbody>{m.init.map((v, i) => <tr key={`${v.key}-${i}`} className={v.value === null ? "unset" : undefined}><td><code>{v.key}</code></td><td title={v.value ?? undefined}>{v.value === null ? "not set" : home(v.value)}</td><td>{v.source}</td></tr>)}</tbody>
                  </table>
                  {(m.migrations.length > 0 || m.seeds.length > 0) && (
                    <div className="rt-insights-steps">
                      {m.migrations.length > 0 && <div><h5>Migrations applied</h5>{m.migrations.map((s) => <span key={s.id}><code>{m.id}:{s.id}</code> {since(s.appliedAt)}</span>)}</div>}
                      {m.seeds.length > 0 && <div><h5>Seeds applied</h5>{m.seeds.map((s) => <span key={s.id}><code>{s.id}</code> {s.environment ?? ""} · {since(s.appliedAt)}</span>)}</div>}
                    </div>
                  )}
                  {m.prefixes.length > 0 && <p className="rt-insights-read">Record keys: {m.prefixes.map((p) => <code key={p}>{p}</code>)}</p>}
                </div>
              )}
            </li>
          ))}
        </ol>
      </>}
    </section>
  );
}

function preview(data: unknown) {
  if (!data || typeof data !== "object") return String(data ?? "");
  return Object.entries(data as Record<string, unknown>).filter(([k]) => !/^(created|updated|deleted)(At|By)$/.test(k)).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ").slice(0, 160);
}

/** Data tab: browse the records of each collection in the local store (JSON file or Postgres). */
export function ProjectData({ client, project, focus }: { client: InsightsClient; project: string; focus?: string }) {
  const { data, error, loading, reload } = useInsights(client, project);
  const [collection, setCollection] = useState<string>();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<{ total: number; rows: RecordRow[] }>();
  const [expanded, setExpanded] = useState<string>();
  const [failure, setFailure] = useState("");
  const groups = useMemo(() => {
    const labels = new Map((data?.modules ?? []).map((m) => [m.id, m.label]));
    const map = new Map<string, InsightCollection[]>();
    for (const c of data?.collections ?? []) map.set(c.module, [...(map.get(c.module) ?? []), c]);
    return [...map].map(([id, list]) => ({ id, label: id === "system" ? "Framework bookkeeping" : id === "other" ? "Unassigned" : labels.get(id) ?? id, list, total: list.reduce((n, c) => n + c.count, 0) })).sort((a, b) => (a.id === "system" ? 1 : b.id === "system" ? -1 : b.total - a.total));
  }, [data]);
  useEffect(() => {
    if (!data?.collections.length) return;
    const preferred = focus ? data.collections.find((c) => c.module === focus) : undefined;
    setCollection((current) => (current && data.collections.some((c) => c.id === current) ? current : (preferred ?? data.collections.find((c) => c.module !== "system") ?? data.collections[0]).id));
  }, [data, focus]);
  async function load(offset = 0) {
    if (!collection || !client.records) return;
    try {
      const next = await client.records({ collection, offset, limit: 50, search });
      setPage((p) => ({ total: next.total, rows: offset ? [...(p?.rows ?? []), ...next.rows] : next.rows }));
      setFailure("");
    } catch (e) { setFailure((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }
  }
  useEffect(() => { setPage(undefined); setExpanded(undefined); const t = setTimeout(() => void load(0), search ? 250 : 0); return () => clearTimeout(t); }, [collection, search, data?.readAt]);
  const current = data?.collections.find((c) => c.id === collection);
  return (
    <section className="rt-insights" aria-label="Stored records">
      <Header title="Records" data={data} loading={loading} onReload={() => void reload()} />
      <Problems data={data} error={error} />
      {data?.storage.readable && (
        <div className="rt-data-layout">
          <nav className="rt-data-collections" aria-label="Collections">
            {groups.map((g) => (
              <div key={g.id}>
                <h5><TfIcon name={moduleIcon(g.id)} size={12} />{g.label}<small>{g.total}</small></h5>
                {g.list.map((c) => <button key={c.id} aria-current={c.id === collection ? "true" : undefined} onClick={() => { setCollection(c.id); setSearch(""); }}><code>{c.id}</code><small>{c.count}</small></button>)}
              </div>
            ))}
            {!groups.length && <p className="rt-insights-note">The store is empty.</p>}
          </nav>
          <div className="rt-data-records">
            {current && (
              <div className="rt-insights-toolbar">
                <strong><code>{current.id}</code></strong>
                <span className="rt-insights-read">{page ? `${page.total} records` : "…"}{current.partitions > 1 ? ` · ${current.partitions} partitions` : ""} · updated {since(current.updatedAt)}</span>
                <input type="search" placeholder="Search in this collection…" aria-label="Search records" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            )}
            {failure && <p className="rt-services-error">{failure}</p>}
            {page && (
              <div className="rt-services-table rt-data-table">
                <table>
                  <thead><tr><th>Key</th><th>Data</th><th>Version</th><th>Updated</th></tr></thead>
                  <tbody>
                    {page.rows.map((r) => {
                      const id = `${r.pk}|${r.sk}`;
                      const d = (r.data ?? {}) as Record<string, string>;
                      return (
                        <React.Fragment key={id}>
                          <tr className={expanded === id ? "selected" : undefined} onClick={() => setExpanded(expanded === id ? undefined : id)}>
                            <td><code>{r.sk}</code>{r.pk !== collection && <small>{r.pk}</small>}</td>
                            <td className="rt-data-preview">{preview(r.data)}</td>
                            <td>{r.version ?? "—"}</td>
                            <td>{since(d.updatedAt ?? d.createdAt ?? d.appliedAt ?? null)}</td>
                          </tr>
                          {expanded === id && <tr className="rt-data-json"><td colSpan={4}><pre>{JSON.stringify({ pk: r.pk, sk: r.sk, version: r.version, ...(r.ttl ? { ttl: new Date(r.ttl * 1000).toISOString() } : {}), data: r.data }, null, 2)}</pre></td></tr>}
                        </React.Fragment>
                      );
                    })}
                    {!page.rows.length && <tr><td colSpan={4} className="rt-insights-note">No records match.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
            {page && page.rows.length < page.total && <button className="rt-data-more" onClick={() => void load(page.rows.length)}>Load more ({page.total - page.rows.length} left)</button>}
            <p className="rt-insights-read">Read-only view of the local {data.storage.kind} store · sensitive fields are hidden</p>
          </div>
        </div>
      )}
    </section>
  );
}
