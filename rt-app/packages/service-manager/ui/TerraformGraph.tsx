import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, describeType, TfIcon, type IconName } from "./terraformCatalog.js";
import type { TerraformResources } from "./TerraformResources.js";

const NODE_W = 196;
const NODE_H = 48;
const COL_W = 250;
const ROW_H = 66;
const MODULE_COLOR = "#A78BFA";

interface GraphNode { id: string; kind: "resource" | "data" | "output" | "module"; title: string; subtitle: string; icon: IconName; color: string; refs: string[]; parent: string | null; count?: number; local?: boolean; file: string; line: number }
interface Placed extends GraphNode { x: number; y: number; rank: number }
interface RawEdge { from: string; to: string; kind: "uses" | "contains" }
interface Edge extends RawEdge { back: boolean }
interface Note { id: string; text: string; target?: string; x?: number; y?: number; createdAt: number }

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

/** "admin.site" → "module.admin.module.site" */
const moduleAddress = (path: string | null | undefined) => (path ? `module.${path.split(".").join(".module.")}` : null);

/** Every block of the stack as a node, with the module that contains it as `parent`. */
function allNodes(data: TerraformResources): GraphNode[] {
  const nodes: GraphNode[] = data.items.map((item) => {
    const d = describeType(item.type, item.kind);
    return { id: item.address, kind: item.kind, title: item.kind === "output" ? `Output ${item.name}` : `${d.service} ${d.label}`, subtitle: item.kind === "output" ? "output" : item.name, icon: d.icon, color: CATEGORIES.find((c) => c.id === d.category)!.color, refs: item.refs ?? [], parent: moduleAddress(item.module), file: item.file, line: item.line };
  });
  for (const m of data.modules) {
    const path = m.parent ? `${m.parent}.${m.name}` : m.name;
    const count = data.items.filter((i) => i.kind === "resource" && (i.module === path || i.module?.startsWith(path + "."))).length;
    nodes.push({ id: m.address, kind: "module", title: `module ${m.name}`, subtitle: m.local ? `${count} resources` : "remote module", icon: "module", color: MODULE_COLOR, refs: m.refs ?? [], parent: moduleAddress(m.parent), count, local: m.local, file: m.file, line: m.line });
  }
  return nodes;
}

/**
 * Visible nodes and edges with some modules collapsed: blocks inside a collapsed module are hidden
 * and their links are redirected to the module. Parents link to their children ("contains").
 */
function visibleGraph(nodes: GraphNode[], collapsed: Set<string>) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hidden = (n: GraphNode): boolean => {
    for (let p = n.parent; p; p = byId.get(p)?.parent ?? null) if (collapsed.has(p)) return true;
    return false;
  };
  const shown = nodes.filter((n) => !hidden(n));
  const shownIds = new Set(shown.map((n) => n.id));
  const nearest = (id: string): string | undefined => {
    let n = byId.get(id);
    while (n && !shownIds.has(n.id)) n = n.parent ? byId.get(n.parent) : undefined;
    return n?.id;
  };
  const edges = new Map<string, RawEdge>();
  for (const n of shown) if (n.parent && shownIds.has(n.parent)) edges.set(`${n.parent}>${n.id}`, { from: n.parent, to: n.id, kind: "contains" });
  for (const n of nodes) for (const r of n.refs) {
    const from = nearest(r), to = nearest(n.id);
    if (!from || !to || from === to) continue;
    edges.set(`${from}>${to}`, { from, to, kind: "uses" });
  }
  return { nodes: shown, edges: [...edges.values()], nearest };
}

/**
 * Layered layout: every block sits one column right of what it uses or what contains it, so the
 * picture reads left → right. Cycles are broken where DFS finds them; unlinked blocks go below.
 */
function layout(nodes: GraphNode[], raw: RawEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, RawEdge[]>();
  raw.forEach((e) => incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]));
  const back = new Set<string>();
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    visiting.add(id);
    let r = 0;
    for (const e of incoming.get(id) ?? []) {
      if (visiting.has(e.from)) { back.add(`${e.from}>${e.to}`); continue; }
      r = Math.max(r, visit(e.from) + 1);
    }
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  nodes.forEach((n) => visit(n.id));
  const edges: Edge[] = raw.map((e) => ({ ...e, back: back.has(`${e.from}>${e.to}`) }));
  const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
  const columns: string[][] = [];
  for (const n of nodes) if (connected.has(n.id)) (columns[rank.get(n.id)!] ??= []).push(n.id);
  for (let i = 0; i < columns.length; i++) columns[i] ??= [];
  const order = (id: string) => CATEGORIES.findIndex((c) => c.color === byId.get(id)!.color);
  columns.forEach((col) => col.sort((a, b) => order(a) - order(b) || a.localeCompare(b)));

  // Barycenter sweeps: place each block near the blocks it connects to.
  const position = new Map<string, number>();
  const index = () => columns.forEach((col) => col.forEach((id, i) => position.set(id, i - col.length / 2)));
  index();
  const into = new Map<string, string[]>(), out = new Map<string, string[]>();
  edges.forEach((e) => { into.set(e.to, [...(into.get(e.to) ?? []), e.from]); out.set(e.from, [...(out.get(e.from) ?? []), e.to]); });
  for (let sweep = 0; sweep < 8; sweep++) {
    const forward = sweep % 2 === 0;
    for (const col of forward ? columns.slice(1) : columns.slice(0, -1).reverse()) {
      const score = new Map(col.map((id) => {
        const near = ((forward ? into : out).get(id) ?? []).map((n) => position.get(n)!).filter((v) => v !== undefined);
        return [id, near.length ? near.reduce((a, b) => a + b, 0) / near.length : position.get(id)!];
      }));
      col.sort((a, b) => score.get(a)! - score.get(b)!);
      index();
    }
  }

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const placed: Placed[] = [];
  columns.forEach((col, r) => col.forEach((id, i) => placed.push({ ...byId.get(id)!, rank: r, x: r * COL_W, y: (i + (tallest - col.length) / 2) * ROW_H })));
  const loose = nodes.filter((n) => !connected.has(n.id));
  const perRow = Math.max(3, columns.length);
  const top = connected.size ? tallest * ROW_H + 50 : 0;
  loose.forEach((n, i) => placed.push({ ...n, rank: Math.floor(i / perRow), x: (i % perRow) * COL_W, y: top + Math.floor(i / perRow) * ROW_H }));
  const width = Math.max(...placed.map((p) => p.x + NODE_W), NODE_W);
  const height = Math.max(...placed.map((p) => p.y + NODE_H), NODE_H);
  return { placed, edges, width, height, looseTop: loose.length && connected.size ? top : null };
}

function edgePath(a: Placed, b: Placed, back: boolean) {
  const sx = a.x + NODE_W, sy = a.y + NODE_H / 2, tx = b.x, ty = b.y + NODE_H / 2;
  if (back || tx <= sx) {
    const drop = Math.max(a.y, b.y) + NODE_H + 30;
    return `M${sx} ${sy} C${sx + 60} ${sy} ${sx + 60} ${drop} ${(sx + tx) / 2} ${drop} S${tx - 60} ${ty} ${tx} ${ty}`;
  }
  const dx = Math.max(50, (tx - sx) / 2);
  return `M${sx} ${sy} C${sx + dx} ${sy} ${tx - dx} ${ty} ${tx} ${ty}`;
}

/** Comments kept on this computer (localStorage), one list per stack. Never written to the project. */
function useNotes(key: string) {
  const storage = `rt-app.terraform.notes:${key}`;
  const load = (): Note[] => { try { return JSON.parse(localStorage.getItem(storage) ?? "[]"); } catch { return []; } };
  const [notes, setNotes] = useState<Note[]>(load);
  useEffect(() => setNotes(load()), [storage]);
  const save = (next: Note[]) => {
    setNotes(next);
    try { localStorage.setItem(storage, JSON.stringify(next)); } catch { /* storage unavailable: keep them in memory */ }
  };
  return {
    notes,
    add: (note: Omit<Note, "id" | "createdAt">) => { const created = { ...note, id: Math.random().toString(36).slice(2, 10), createdAt: Date.now() }; save([...notes, created]); return created.id; },
    update: (id: string, patch: Partial<Note>) => save(notes.map((n) => (n.id === id ? { ...n, ...patch } : n))),
    remove: (id: string) => save(notes.filter((n) => n.id !== id)),
  };
}

function NoteCard({ note, editing, onEdit, onSave, onRemove, onDragStart, compact }: { note: Note; editing: boolean; onEdit(): void; onSave(text: string): void; onRemove(): void; onDragStart?: (e: React.PointerEvent) => void; compact?: boolean }) {
  const [text, setText] = useState(note.text);
  useEffect(() => setText(note.text), [note.text, editing]);
  return (
    <div className={`rt-tf-note${note.target ? " attached" : ""}${compact ? " compact" : ""}`} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}>
      <div className={`rt-tf-note-head${onDragStart ? " draggable" : ""}`} onPointerDown={onDragStart} title={onDragStart ? "Drag to move" : undefined}>
        <span>{new Date(note.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        {!editing && <button aria-label="Edit comment" title="Edit" onPointerDown={(e) => e.stopPropagation()} onClick={onEdit}>✎</button>}
        <button aria-label="Delete comment" title="Delete" onPointerDown={(e) => e.stopPropagation()} onClick={onRemove}>✕</button>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={text}
          placeholder="Write a comment… (⌘↵ to save)"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => onSave(text)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
            if (e.key === "Escape") { setText(note.text); (e.target as HTMLTextAreaElement).blur(); }
          }}
        />
      ) : (
        <p onClick={onEdit}>{note.text}</p>
      )}
    </div>
  );
}

/**
 * Relationship canvas for a Terraform stack. Everything is expanded by default: modules link to the
 * blocks they contain and every reference is an animated flow toward the block that uses it.
 * Modules collapse into one node. Comments float on the canvas or attach to a block, and are kept
 * on this computer only.
 */
export function TerraformGraph({ data, storageKey }: { data: TerraformResources; storageKey: string }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState({ x: 20, y: 20, k: 1 });
  const [commenting, setCommenting] = useState(false);
  const [showNotes, setShowNotes] = useState(true);
  const [editing, setEditing] = useState<string>();
  const [listOpen, setListOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | undefined>(undefined);
  const noteDrag = useRef<{ id: string; x: number; y: number; nx: number; ny: number } | undefined>(undefined);
  const { notes, add, update, remove } = useNotes(storageKey);
  const nodes = useMemo(() => allNodes(data), [data]);
  const visible = useMemo(() => visibleGraph(nodes, collapsed), [nodes, collapsed]);
  const graph = useMemo(() => layout(visible.nodes, visible.edges), [visible]);
  const byId = useMemo(() => new Map(graph.placed.map((p) => [p.id, p])), [graph]);
  const allById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const modules = nodes.filter((n) => n.kind === "module" && n.local);
  const motion = !reducedMotion();

  const fit = () => {
    const el = box.current;
    if (!el) return;
    const k = Math.min(1.1, Math.max(0.25, Math.min((el.clientWidth - 60) / graph.width, (el.clientHeight - 60) / graph.height)));
    setView({ k, x: (el.clientWidth - graph.width * k) / 2, y: (el.clientHeight - graph.height * k) / 2 });
  };
  useLayoutEffect(fit, [graph.width, graph.height]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      // Scrolling inside panels and text areas scrolls them; anywhere else zooms the canvas.
      if ((e.target as Element).closest?.(".rt-tf-note textarea, .rt-tf-graph-detail, .rt-tf-notes-list")) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const focus = hover ?? selected;
  const linked = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    graph.edges.forEach((e) => { if (e.from === focus) set.add(e.to); if (e.to === focus) set.add(e.from); });
    return set;
  }, [focus, graph]);
  const attached = useMemo(() => {
    const map = new Map<string, Note[]>();
    for (const n of notes) if (n.target) { const at = visible.nearest(n.target); if (at) map.set(at, [...(map.get(at) ?? []), n]); }
    return map;
  }, [notes, visible]);
  const current = selected ? byId.get(selected) : undefined;
  const legend = CATEGORIES.filter((c) => graph.placed.some((p) => p.color === c.color));

  const toGraph = (clientX: number, clientY: number) => { const r = box.current!.getBoundingClientRect(); return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k }; };
  const toggle = (id: string) => setCollapsed((c) => { const next = new Set(c); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const comment = (target?: string, point?: { x: number; y: number }) => { const id = add({ text: "", target, ...(point ?? {}) }); setEditing(id); setCommenting(false); setShowNotes(true); };
  const saveNote = (id: string, text: string) => { setEditing(undefined); if (text.trim()) update(id, { text: text.trim() }); else remove(id); };
  const nodeLabel = (id?: string) => { const n = id ? allById.get(id) : undefined; return n ? `${n.title}${n.kind === "module" ? "" : ` ${n.subtitle}`}` : "a removed block"; };
  const jump = (note: Note) => {
    const el = box.current;
    const at = note.target ? byId.get(visible.nearest(note.target) ?? "") : undefined;
    const x = at ? at.x + NODE_W / 2 : note.x ?? 0, y = at ? at.y : note.y ?? 0;
    if (el) setView((v) => ({ ...v, x: el.clientWidth / 2 - x * v.k, y: el.clientHeight / 2 - y * v.k }));
    if (at) setSelected(at.id);
    setListOpen(false);
  };

  return (
    <div className="rt-tf-graph">
      <div className="rt-tf-graph-bar">
        <div className="rt-tf-graph-group">
          <button onClick={() => setCollapsed(new Set())} disabled={!collapsed.size}>Expand all</button>
          <button onClick={() => setCollapsed(new Set(modules.filter((m) => !m.parent).map((m) => m.id)))} disabled={!modules.length}>Collapse all</button>
        </div>
        <div className="rt-tf-graph-group">
          <button className={commenting ? "active" : undefined} aria-pressed={commenting} title="Click the canvas for a free comment, or a block to attach one" onClick={() => setCommenting(!commenting)}>💬 {commenting ? "Click where to comment…" : "Add comment"}</button>
          <button aria-pressed={listOpen} onClick={() => setListOpen(!listOpen)} disabled={!notes.length}>Comments {notes.length}</button>
          <label className="rt-tf-graph-check"><input type="checkbox" checked={showNotes} onChange={(e) => setShowNotes(e.target.checked)} /> Show</label>
        </div>
        <span className="rt-tf-graph-count">{graph.placed.length} blocks · {graph.edges.filter((e) => e.kind === "uses").length} links</span>
        <div className="rt-tf-graph-zoom">
          <button aria-label="Zoom out" onClick={() => setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.2) }))}>−</button>
          <button aria-label="Zoom in" onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.2) }))}>+</button>
          <button onClick={fit}>Fit</button>
        </div>
      </div>
      <div
        ref={box}
        className={`rt-tf-canvas${commenting ? " commenting" : ""}`}
        onPointerDown={(e) => {
          if ((e.target as Element).closest(".rt-tf-node, .rt-tf-note, .rt-tf-graph-detail, .rt-tf-notes-list")) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const nd = noteDrag.current;
          if (nd) { update(nd.id, { x: nd.nx + (e.clientX - nd.x) / view.k, y: nd.ny + (e.clientY - nd.y) / view.k }); return; }
          const d = drag.current;
          if (!d) return;
          d.moved = d.moved || Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3;
          setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={(e) => {
          if (noteDrag.current) { noteDrag.current = undefined; return; }
          if (drag.current && !drag.current.moved) { if (commenting) comment(undefined, toGraph(e.clientX, e.clientY)); else setSelected(undefined); }
          drag.current = undefined;
        }}
      >
        <svg width="100%" height="100%" role="img" aria-label="Terraform relationships">
          <defs>
            <pattern id="rt-tf-dots" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <circle cx="1" cy="1" r="1" className="rt-tf-dot" />
            </pattern>
            <marker id="rt-tf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" className="rt-tf-arrowhead" /></marker>
          </defs>
          <rect width="100%" height="100%" fill="url(#rt-tf-dots)" />
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {graph.looseTop !== null && <text className="rt-tf-loose-label" x={0} y={graph.looseTop - 16}>Not linked to other blocks</text>}
            {graph.edges.map((e, i) => {
              const a = byId.get(e.from)!, b = byId.get(e.to)!;
              const d = edgePath(a, b, e.back);
              const on = focus ? e.from === focus || e.to === focus : false;
              return (
                <g key={`${e.from}>${e.to}`} className={`rt-tf-edge rt-tf-edge-${e.kind}${on ? " on" : ""}${linked && !on ? " dim" : ""}`} style={{ ["--edge" as string]: e.kind === "contains" ? MODULE_COLOR : a.color }}>
                  <path d={d} className="rt-tf-edge-base" markerEnd={e.kind === "uses" ? "url(#rt-tf-arrow)" : undefined} />
                  {e.kind === "uses" && <path d={d} className="rt-tf-edge-flow" style={{ animationDelay: `${-(i % 7) * 0.3}s` }} />}
                  {motion && e.kind === "uses" && (
                    <circle r={on ? 3.4 : 2.4} className="rt-tf-particle">
                      <animateMotion dur={`${2.2 + (i % 5) * 0.35}s`} begin={`${-(i % 9) * 0.4}s`} repeatCount="indefinite" path={d} />
                    </circle>
                  )}
                </g>
              );
            })}
            {graph.placed.map((n, i) => {
              const count = attached.get(n.id)?.length ?? 0;
              const isCollapsed = collapsed.has(n.id);
              return (
                <g
                  key={n.id}
                  className={`rt-tf-node rt-tf-node-${n.kind}${linked && !linked.has(n.id) ? " dim" : ""}${selected === n.id ? " selected" : ""}${isCollapsed ? " collapsed" : ""}`}
                  transform={`translate(${n.x} ${n.y})`}
                  style={{ ["--node" as string]: n.color, animationDelay: `${Math.min(n.rank * 60 + (i % 6) * 20, 900)}ms` }}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(undefined)}
                  onClick={() => (commenting ? comment(n.id) : setSelected(n.id === selected ? undefined : n.id))}
                  role="button"
                  tabIndex={0}
                  aria-label={`${n.title} ${n.subtitle}`}
                  onKeyDown={(e) => { if (e.key === "Enter") setSelected(n.id); }}
                >
                  <title>{`${n.id}\n${n.file}:${n.line}`}</title>
                  <rect width={NODE_W} height={NODE_H} rx="10" className="rt-tf-node-box" />
                  <rect x="0" y="0" width="4" height={NODE_H} rx="2" className="rt-tf-node-bar" />
                  <rect x="12" y="10" width="28" height="28" rx="7" className="rt-tf-node-icon-bg" />
                  <g transform="translate(17 15)" className="rt-tf-node-icon"><TfIcon name={n.icon} size={18} /></g>
                  <text x="50" y="21" className="rt-tf-node-title">{clip(n.title, n.kind === "module" && n.local ? 18 : 22)}</text>
                  <text x="50" y="36" className="rt-tf-node-sub">{clip(isCollapsed ? `${n.count} resources · collapsed` : n.subtitle, 25)}</text>
                  {n.kind === "module" && n.local && (
                    <g className="rt-tf-node-toggle" transform={`translate(${NODE_W - 26} 14)`} onClick={(e) => { e.stopPropagation(); toggle(n.id); }}>
                      <title>{isCollapsed ? "Expand module" : "Collapse module"}</title>
                      <rect width="18" height="20" rx="5" />
                      <text x="9" y="15">{isCollapsed ? "+" : "−"}</text>
                    </g>
                  )}
                  {count > 0 && (
                    <g className="rt-tf-node-comments" transform={`translate(${NODE_W - 4} -4)`}>
                      <circle r="9" /><text y="3.5">{count}</text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {showNotes && (
          <div className="rt-tf-notes-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            {notes.filter((n) => !n.target).map((note) => (
              <div key={note.id} className="rt-tf-note-anchor" style={{ left: note.x ?? 0, top: note.y ?? 0 }}>
                <NoteCard
                  note={note}
                  editing={editing === note.id}
                  onEdit={() => setEditing(note.id)}
                  onSave={(t) => saveNote(note.id, t)}
                  onRemove={() => remove(note.id)}
                  onDragStart={(e) => { e.stopPropagation(); noteDrag.current = { id: note.id, x: e.clientX, y: e.clientY, nx: note.x ?? 0, ny: note.y ?? 0 }; box.current?.setPointerCapture(e.pointerId); }}
                />
              </div>
            ))}
            {[...attached].map(([id, list]) => {
              const at = byId.get(id);
              if (!at) return null;
              return (
                <div key={id} className="rt-tf-note-stack" style={{ left: at.x + 10, top: at.y - 8 }}>
                  {list.map((note) => (
                    <NoteCard key={note.id} note={note} compact editing={editing === note.id} onEdit={() => setEditing(note.id)} onSave={(t) => saveNote(note.id, t)} onRemove={() => remove(note.id)} />
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {!graph.placed.length && <p className="rt-tf-graph-empty">No blocks in this stack.</p>}
        {listOpen && (
          <aside className="rt-tf-notes-list" onPointerDown={(e) => e.stopPropagation()}>
            <header><strong>Comments</strong><small>saved on this computer</small><button aria-label="Close" onClick={() => setListOpen(false)}>✕</button></header>
            {notes.map((note) => (
              <button key={note.id} onClick={() => jump(note)}>
                <small>{note.target ? `on ${nodeLabel(note.target)}` : "on the canvas"}</small>
                <span>{note.text || "(empty)"}</span>
              </button>
            ))}
          </aside>
        )}
        {current && !listOpen && (
          <aside className="rt-tf-graph-detail" onPointerDown={(e) => e.stopPropagation()}>
            <header><span className="rt-tf-card-icon" style={{ ["--svc" as string]: current.color }}><TfIcon name={current.icon} size={18} /></span><div><strong>{current.title}</strong><code>{current.id}</code></div><button aria-label="Close" onClick={() => setSelected(undefined)}>✕</button></header>
            <small>{current.file}:{current.line}</small>
            {current.kind === "module" && current.local && <button className="rt-tf-detail-action" onClick={() => toggle(current.id)}>{collapsed.has(current.id) ? "Expand module" : "Collapse module"}</button>}
            {current.parent && <><h5>Inside</h5><ul><li><button className="rt-services-link" onClick={() => setSelected(visible.nearest(current.parent!))}>↰ {nodeLabel(current.parent)}</button></li></ul></>}
            {([
              ["Uses", graph.edges.filter((e) => e.kind === "uses" && e.to === current.id).map((e) => e.from), "←"],
              ["Used by", graph.edges.filter((e) => e.kind === "uses" && e.from === current.id).map((e) => e.to), "→"],
              ["Contains", graph.edges.filter((e) => e.kind === "contains" && e.from === current.id).map((e) => e.to), "↳"],
            ] as [string, string[], string][]).map(([label, ids, arrow]) => ids.length ? (
              <React.Fragment key={label}>
                <h5>{label} ({ids.length})</h5>
                <ul>{ids.map((id) => <li key={id}><button className="rt-services-link" onClick={() => setSelected(id)}>{arrow} {nodeLabel(id)}</button></li>)}</ul>
              </React.Fragment>
            ) : null)}
            <h5>Comments ({attached.get(current.id)?.length ?? 0})</h5>
            <div className="rt-tf-detail-notes">
              {(attached.get(current.id) ?? []).map((note) => (
                <NoteCard key={note.id} note={note} editing={editing === note.id} onEdit={() => setEditing(note.id)} onSave={(t) => saveNote(note.id, t)} onRemove={() => remove(note.id)} />
              ))}
              <button className="rt-tf-detail-action" onClick={() => comment(current.id)}>💬 Add comment</button>
            </div>
          </aside>
        )}
      </div>
      <div className="rt-tf-graph-legend">
        <span><i className="rt-tf-legend-line uses" />uses (flow)</span>
        <span><i className="rt-tf-legend-line contains" />contains (module → block)</span>
        {legend.map((c) => <span key={c.id}><i style={{ background: c.color }} />{c.label}</span>)}
        {modules.length > 0 && <span><i style={{ background: MODULE_COLOR }} />Module</span>}
        <span className="rt-tf-graph-hint">Drag to move · scroll to zoom · comments are saved on this computer</span>
      </div>
    </div>
  );
}
