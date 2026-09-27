import React, { useMemo, useState } from "react";
import { CATEGORIES, describeType, ProviderLogo, TfIcon, type CategoryId } from "./terraformCatalog.js";

export interface TerraformItem { kind: "resource" | "data" | "output"; type: string; name: string; address: string; provider?: string; file: string; line: number; module: string | null; multiple?: boolean; sensitive?: boolean; refs?: string[] }
export interface TerraformModule { name: string; address: string; source: string; version: string | null; local: boolean; parent: string | null; multiple: boolean; file: string; line: number; module: string | null; refs?: string[] }
export interface TerraformProvider { name: string; source: string | null; version: string | null; configured: boolean; resources: number }
export interface TerraformResources { items: TerraformItem[]; modules: TerraformModule[]; providers: TerraformProvider[]; backend: string | null; files: number }

/** "../../node_modules/@scope/pkg/terraform/aws/site" → "@scope/pkg/terraform/aws/site". */
const shortSource = (source: string) => source.replace(/^(\.\.?\/)+(node_modules\/)?/, "");
const colorOf = (id: CategoryId) => CATEGORIES.find((c) => c.id === id)!.color;

/**
 * Visual map of what a Terraform stack declares, grouped by category, with provider logos and a
 * module filter. Built from the .tf files only: it shows what is configured, not what is deployed.
 */
export function TerraformResourcesMap({ data }: { data: TerraformResources }) {
  const [module, setModule] = useState<string>("*");
  const [query, setQuery] = useState("");
  const moduleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of data.items) if (item.kind === "resource") counts.set(item.module?.split(".")[0] ?? "", (counts.get(item.module?.split(".")[0] ?? "") ?? 0) + 1);
    return counts;
  }, [data]);
  const visible = data.items.filter((item) => {
    if (module !== "*" && (item.module?.split(".")[0] ?? "") !== module) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    const d = describeType(item.type, item.kind);
    return [item.address, d.service, d.label].some((text) => text.toLowerCase().includes(q));
  });
  const groups = CATEGORIES.map((category) => ({ category, items: visible.filter((item) => describeType(item.type, item.kind).category === category.id) })).filter((g) => g.items.length);
  const resources = data.items.filter((i) => i.kind === "resource").length;
  const topModules = data.modules.filter((m) => !m.parent);

  return (
    <div className="rt-tf-map">
      <div className="rt-tf-providers">
        {data.providers.map((p) => (
          <span key={p.name} className="rt-tf-provider" title={[p.source, p.version && `version ${p.version}`].filter(Boolean).join(" · ") || p.name}>
            <ProviderLogo name={p.name} />
            <span><strong>{p.name === "aws" ? "AWS" : p.name[0].toUpperCase() + p.name.slice(1)}</strong><small>{p.version ?? p.source ?? "provider"}{p.resources ? ` · ${p.resources} resources` : ""}</small></span>
          </span>
        ))}
        {data.backend && <span className="rt-tf-provider rt-tf-backend" title="Where Terraform keeps its state"><span className="rt-tf-chip-icon"><TfIcon name="database" size={16} /></span><span><strong>State</strong><small>{data.backend} backend</small></span></span>}
      </div>

      <div className="rt-tf-stats">
        <span><strong>{resources}</strong> resources</span>
        <span><strong>{data.modules.length}</strong> modules</span>
        <span><strong>{data.items.filter((i) => i.kind === "data").length}</strong> data sources</span>
        <span><strong>{data.items.filter((i) => i.kind === "output").length}</strong> outputs</span>
        <span><strong>{data.files}</strong> files</span>
      </div>

      <div className="rt-tf-filters">
        <input type="search" placeholder="Filter by name, service or type…" aria-label="Filter resources" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="rt-tf-module-chips" role="group" aria-label="Filter by module">
          <button aria-pressed={module === "*"} onClick={() => setModule("*")}>All <small>{resources}</small></button>
          {moduleCounts.has("") && <button aria-pressed={module === ""} onClick={() => setModule("")}>root <small>{moduleCounts.get("")}</small></button>}
          {topModules.map((m) => <button key={m.address} aria-pressed={module === m.name} title={m.source} onClick={() => setModule(m.name)}><TfIcon name="module" size={11} /> {m.name} <small>{moduleCounts.get(m.name) ?? 0}</small></button>)}
        </div>
      </div>

      {!groups.length && <p className="rt-wizard-note">Nothing matches this filter.</p>}
      {groups.map(({ category, items }) => (
        <section key={category.id} className="rt-tf-category" style={{ ["--cat" as string]: category.color }}>
          <h4><span className="rt-tf-cat-icon"><TfIcon name={category.icon} size={14} /></span>{category.label}<small>{items.length}</small></h4>
          <div className="rt-tf-cards">
            {items.map((item) => {
              const d = describeType(item.type, item.kind);
              return (
                <article key={item.address} className="rt-tf-card" title={`${item.address}\n${item.file}:${item.line}`} style={{ ["--svc" as string]: colorOf(d.category) }}>
                  <span className="rt-tf-card-icon"><TfIcon name={d.icon} size={20} /></span>
                  <span className="rt-tf-card-body">
                    <strong>{item.kind === "output" ? item.name : <>{d.service} <em>{d.label}</em></>}</strong>
                    <code>{item.kind === "output" ? `output.${item.name}` : item.name}</code>
                    <span className="rt-tf-card-meta">
                      {item.module && <span className="rt-tf-tag">module.{item.module.replace(/\./g, ".module.")}</span>}
                      {item.multiple && <span className="rt-tf-tag" title="count / for_each: may create several">× n</span>}
                      {item.sensitive && <span className="rt-tf-tag">sensitive</span>}
                      {item.provider && <ProviderLogo name={item.provider} size={14} />}
                    </span>
                  </span>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {!!data.modules.length && module === "*" && !query && (
        <section className="rt-tf-category" style={{ ["--cat" as string]: "#A78BFA" }}>
          <h4><span className="rt-tf-cat-icon"><TfIcon name="module" size={14} /></span>Modules<small>{data.modules.length}</small></h4>
          <div className="rt-tf-cards">
            {data.modules.map((m) => (
              <article key={m.address} className="rt-tf-card" title={`${m.address}\n${m.source}`} style={{ ["--svc" as string]: "#A78BFA" }}>
                <span className="rt-tf-card-icon"><TfIcon name="module" size={20} /></span>
                <span className="rt-tf-card-body">
                  <strong>{m.parent ? `${m.parent} › ${m.name}` : m.name}</strong>
                  <code>{shortSource(m.source)}</code>
                  <span className="rt-tf-card-meta">
                    <span className="rt-tf-tag">{m.local ? "local" : "remote · not expanded"}</span>
                    {m.version && <span className="rt-tf-tag">{m.version}</span>}
                    {m.local && <span className="rt-tf-tag">{data.items.filter((i) => i.kind === "resource" && (i.module === (m.parent ? `${m.parent}.${m.name}` : m.name) || i.module?.startsWith(`${m.parent ? `${m.parent}.${m.name}` : m.name}.`))).length} resources</span>}
                  </span>
                </span>
              </article>
            ))}
          </div>
        </section>
      )}
      <p className="rt-wizard-note">Read from the .tf files (including local modules). It shows what is configured, not what is deployed.</p>
    </div>
  );
}
