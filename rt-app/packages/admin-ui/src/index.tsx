import React, { useEffect, useState } from "react";
export type Api = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<any>;
export interface PanelProps {
  api: Api;
  manifest: any;
  user: any;
}
export function ResourcePanel({ api, manifest, user }: PanelProps) {
  const [detailTab,setDetailTab]=useState("edit");
  const [trash,setTrash]=useState(false);
  const [confirmTrash,setConfirmTrash]=useState(false);
  const [items, setItems] = useState<any[]>([]),
    [filters, setFilters] = useState<Record<string, string>>({}),
    [cursor, setCursor] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<any>(),
    [mode, setMode] = useState("list"),
    [resources, setResources] = useState<any[]>([]);
  const users = manifest.component === "users",
    tasks = manifest.component === "tasks";
  const supportsTrash = (users || tasks) && manifest.actions?.includes("delete");
  const allowed = (r: string) =>
    user?.role === "owner" || (Array.isArray(user?.grants) && user.grants.includes(r));
  async function load(next?: string, inTrash=trash) {
    setBusy(true);
    setError("");
    try {
      const q = new URLSearchParams(
        Object.entries(filters).filter(([, v]) => v),
      );
      if(inTrash && supportsTrash)q.set("trash","true");
      if (next) q.set("cursor", next);
      const result = await api(`${manifest.path}?${q}`);
      setItems(Array.isArray(result) ? result : result.items);
      setCursor(result.cursor);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setTrash(false);
    setFilters({});
    setSelected(undefined);
    setMode("list");
    void load(undefined,false);
  }, [manifest.id]);
  async function edit(item: any) {
    setDetailTab("edit");
    setSelected(item);
    setMode("edit");
    if (users && user.role === "owner") {
      try {
        setResources(await api("/acl/resources"));
      } catch (e: any) {
        setError(e.message);
      }
    }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (users) {
        if (mode === "create") await api("/users", "POST", data);
        else
          await api(`/users/${encodeURIComponent(selected.id)}`, "PATCH", {
            name: data.name,
          });
      }
      if (tasks) {
        if (mode === "create")
          await api("/tasks", "POST", { title: data.title });
        else
          await api(
            `/tasks/${manifest.path === "/tasks/admin" ? "admin/" : ""}${encodeURIComponent(selected.id)}`,
            "PATCH",
            { title: data.title, done: data.done === "on" },
          );
      }
      setMode("list");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(item: any, confirmed = false) {
    if (!confirmed && !confirm("Move this record to trash?"))
      return;
    setConfirmTrash(false);
    setBusy(true);
    try {
      await api(
        `${users ? "/users" : manifest.path === "/tasks/admin" ? "/tasks/admin" : "/tasks"}/${encodeURIComponent(item.id)}`,
        "DELETE",
      );
      setMode("list");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function restore(item:any) {
    setBusy(true);try{await api(`${manifest.path}/${encodeURIComponent(item.id)}/restore`,"POST",{});setMode("list");await load();}catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  async function permissions(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = new FormData(e.currentTarget);
      await api(`/acl/users/${encodeURIComponent(selected.id)}`, "PUT", {
        role: data.get("role"),
        grants: data.getAll("grant"),
      });
      setMode("list");
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const detailTrash=mode==="edit"&&detailTab==="edit"&&selected&&!trash&&(tasks||allowed("users.delete"));
  useEffect(()=>setConfirmTrash(false),[selected?.id,mode,detailTab]);
  return (
    <section>
      {mode!=="list"&&<nav className="admin-breadcrumb" aria-label="Record breadcrumb"><button onClick={()=>{setMode("list");void load();}}>{manifest.title}</button><span aria-hidden="true">/</span><span aria-current="page">{mode==="create"?"New record":selected?.name??selected?.title??selected?.id}</span></nav>}
      {detailTrash ? <div className="record-list-summary record-actions">
        {confirmTrash ? <>
          <span className="badge">Move this record to trash?</span>
          <button className="danger" disabled={busy} onClick={()=>void remove(selected,true)}>Confirm</button>
          <button disabled={busy} onClick={()=>setConfirmTrash(false)}>Cancel</button>
        </> : <button disabled={busy||(users&&(selected.role==="owner"||selected.id===user.id))} onClick={()=>setConfirmTrash(true)}>Move to trash</button>}
      </div> : <>
      <div className="record-list-summary">
        <span className="badge">{items.length} on this page</span>
      </div>
      {supportsTrash && <button className="trash-link" disabled={busy} onClick={()=>{const next=!trash;setTrash(next);setSelected(undefined);setMode("list");void load(undefined,next);}}>{trash?"← Active records":"Trash"}</button>}</>}
      <nav className="tabs">
        <button
          className={mode === "list" ? "active" : ""}
          onClick={() => {
            setMode("list");
            setTrash(false);void load(undefined,false);
          }}
        >
          Manage
        </button>
        {(!trash && (tasks || (users && allowed("users.create")))) && (
          <button
            onClick={() => {
              setDetailTab("edit");setSelected(undefined);
              setMode("create");
              setError("");
            }}
          >
            Create {users ? "user" : "task"}
          </button>
        )}
      </nav>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {mode === "list" ? (
        <>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            {manifest.fields.map((field: string) => (
              <label key={field}>
                {field}
                <input
                  aria-label={`Search ${field}`}
                  value={filters[field] ?? ""}
                  onChange={(e) =>
                    setFilters({ ...filters, [field]: e.target.value })
                  }
                  placeholder={`Filter ${field}`}
                />
              </label>
            ))}
            <button className="primary" disabled={busy}>
              Search
            </button>
          </form>
          <p className="hint">
            Filters apply to each data page. Continue to view more results.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {manifest.fields.map((f: string) => (
                    <th key={f}>{f}</th>
                  ))}
                  {(users || tasks) && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={item.id ?? item.resource ?? i}>
                    {manifest.fields.map((f: string) => (
                      <td key={f}>
                        {(users || tasks) && ["id","name","title"].includes(f) ? (
                          <button className="record-link" disabled={busy} onClick={()=>void edit(item)}>{String(item[f] ?? "—")}</button>
                        ) : f === "active" || f === "done" ? (
                          <span
                            className={`badge ${item[f] ? "positive" : ""}`}
                          >
                            {String(item[f])}
                          </span>
                        ) : (
                          String(item[f] ?? "")
                        )}
                      </td>
                    ))}
                    {(users || tasks) && (
                      <td className="actions">
                        {trash && (tasks || allowed("users.restore")) && <button disabled={busy} onClick={()=>void restore(item)}>Restore</button>}
                        {(tasks ||
                          allowed("users.edit") ||
                          user.role === "owner") && (
                          <button
                            disabled={busy}
                            onClick={() => void edit(item)}
                          >
                            Open
                          </button>
                        )}
                        {!trash && (tasks || allowed("users.delete")) && (
                          <button
                            disabled={
                              busy ||
                              (users &&
                                (item.role === "owner" || item.id === user.id))
                            }
                            onClick={() => void remove(item)}
                          >
                            Move to trash
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && (
              <div className="empty">No results on this page.</div>
            )}
          </div>
          <div className="pagination">
            <button disabled={busy} onClick={() => void load()}>
              First page
            </button>
            <button
              disabled={!cursor || busy}
              onClick={() => void load(cursor)}
            >
              Next →
            </button>
          </div>
        </>
      ) : (
        <div className="record-detail">
          {mode==="edit"&&<nav className="tabs" aria-label="Record functions"><button onClick={()=>setDetailTab("edit")} className={detailTab==="edit"?"active":""}>Edit record</button>{users&&user.role==="owner"&&selected?.role!=="owner"&&!trash&&<button onClick={()=>setDetailTab("permissions")} className={detailTab==="permissions"?"active":""}>Permissions</button>}<button onClick={()=>setDetailTab("audit")} className={detailTab==="audit"?"active":""}>Audit</button></nav>}
          {detailTab==="audit"&&<dl>{["createdAt","createdBy","updatedAt","updatedBy","deletedAt","deletedBy","restoredAt","restoredBy"].map(key=><div key={key}><dt>{key}</dt><dd>{selected?.[key]??"—"}</dd></div>)}</dl>}
          {detailTab==="edit"&&<form onSubmit={save}><fieldset disabled={trash||busy} style={{border:0,padding:0,margin:0}}>
            <h2>{mode === "create" ? "New record" : "Edit record"}</h2>
            {users ? (
              <>
                <label>
                  Name
                  <input
                    name="name"
                    defaultValue={selected?.name ?? ""}
                    required
                    maxLength={200}
                  />
                </label>
                {mode === "create" ? (
                  <>
                    <label>
                      Email
                      <input name="email" type="email" required />
                    </label>
                    <label>
                      Initial password
                      <input
                        name="password"
                        type="password"
                        minLength={12}
                        maxLength={128}
                        required
                        autoComplete="new-password"
                      />
                    </label>
                  </>
                ) : (
                  <p className="hint">
                    {selected?.email} · Changing an email address requires verification.
                  </p>
                )}
              </>
            ) : (
              <>
                <label>
                  Title
                  <input
                    name="title"
                    defaultValue={selected?.title ?? ""}
                    required
                    maxLength={200}
                  />
                </label>
                {mode === "edit" && (
                  <label className="check">
                    <input
                      type="checkbox"
                      name="done"
                      defaultChecked={selected?.done}
                    />
                    Completed
                  </label>
                )}
              </>
            )}
            <button className="primary" disabled={busy}>
              Save
            </button>
          </fieldset></form>}
          {detailTab==="permissions"&&users &&
            selected &&
            user.role === "owner" &&
            selected.role !== "owner" && (
              <form key={selected.id} onSubmit={permissions}>
                <h2>Resource permissions</h2>
                <label>
                  Role
                  <select name="role" defaultValue={selected.role}>
                    <option value="user">User</option>
                    <option value="admin">Administrator</option>
                  </select>
                </label>
                <p className="hint">
                  The admin role does not grant permissions automatically.
                </p>
                <div className="permissions">
                  {resources
                    .filter((r,i,all) => r.access === "permission" && all.findIndex(other=>other.resource===r.resource)===i)
                    .map((r) => (
                      <label className="check" key={r.resource}>
                        <input
                          type="checkbox"
                          name="grant"
                          value={r.resource}
                          defaultChecked={(selected.grants??[]).includes(r.resource)}
                        />
                        <span>
                          <strong>{r.resource}</strong>
                          <small>
                            {r.method} {r.path}
                          </small>
                        </span>
                      </label>
                    ))}
                </div>
                <button className="primary" disabled={busy}>
                  Save permissions
                </button>
              </form>
            )}
        </div>
      )}
    </section>
  );
}

/** Shared settings contract: versioned values + public field descriptions. */
export function SettingsPanel({
  api,
  path,
  editable = true,
}: {
  api: Api;
  path: string;
  editable?: boolean;
}) {
  const [settings, setSettings] = useState<any>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api(path)
      .then(setSettings)
      .catch((e) => setMessage(e.message));
  }, [path]);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      setSettings(
        await api(path, "PUT", {
          version: settings.version,
          values: settings.values,
        }),
      );
      setMessage("Settings saved.");
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="profile-card" onSubmit={save}>
      <h2>Settings</h2>
      <p className="hint">
        Module settings. Changes are validated on the server.
      </p>
      {settings?.fields.map((field: any) => (
        <label
          key={field.name}
          className={field.type === "boolean" ? "check" : ""}
        >
          {field.label}
          {field.type === "boolean" ? (
            <input
              type="checkbox"
              disabled={!editable}
              checked={settings.values[field.name]}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  values: {
                    ...settings.values,
                    [field.name]: e.target.checked,
                  },
                })
              }
            />
          ) : field.type === "textarea" ? (
            <textarea
              required
              disabled={!editable}
              maxLength={field.maxLength}
              value={settings.values[field.name]}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  values: { ...settings.values, [field.name]: e.target.value },
                })
              }
            />
          ) : (
            <input
              required
              disabled={!editable}
              maxLength={field.maxLength}
              value={settings.values[field.name]}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  values: { ...settings.values, [field.name]: e.target.value },
                })
              }
            />
          )}
        </label>
      ))}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {editable && (
        <button className="primary" disabled={busy || !settings}>
          Save settings
        </button>
      )}
    </form>
  );
}
export function ModuleWorkspace({
  manifest,
  user,
  api,
  children,
  settingsComponent: CustomSettings,
}: {
  manifest: any;
  user: any;
  api: Api;
  children: React.ReactNode;
  settingsComponent?: React.ComponentType<any>;
}) {
  const [tab, setTab] = useState("module");
  const editable =
    user?.role === "owner" || (Array.isArray(user?.grants) && user.grants.includes(manifest.settings?.resource));
  return (
    <>
      {manifest.settings && <nav className="module-tabs">
        <button
          className={tab === "module" ? "active" : ""}
          onClick={() => setTab("module")}
        >
          {manifest.title}
        </button>
        {manifest.settings && (
          <button
            className={tab === "settings" ? "active" : ""}
            onClick={() => setTab("settings")}
          >
            Settings
          </button>
        )}
      </nav>}
      <div className="module-content">
      {tab === "settings" ? (
        CustomSettings ? (
          <CustomSettings api={api} manifest={manifest} user={user} />
        ) : (
          <SettingsPanel
            api={api}
            path={manifest.settings.path}
            editable={editable}
          />
        )
      ) : (
        children
      )}
      </div>
    </>
  );
}
