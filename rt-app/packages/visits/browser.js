/** Geometry only: no DOM snapshots, selectors, keystrokes, text, cookies or query strings. */
export function visitPoint(type, event, path, elapsed, viewport) {
  if (!["move", "click", "scroll", "page"].includes(type)) return undefined;
  if (
    event?.target?.closest?.(
      "input,textarea,select,form,[contenteditable],[data-private]",
    )
  )
    return undefined;
  const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));
  return {
    type,
    path,
    t: Math.min(1800000, Math.max(0, Math.round(elapsed))),
    x: clamp(((event?.clientX ?? 0) / Math.max(1, viewport.width)) * 100),
    y:
      type === "scroll"
        ? clamp(viewport.scroll * 100)
        : clamp(((event?.clientY ?? 0) / Math.max(1, viewport.height)) * 100),
  };
}

/** Starts an in-memory session, sampled twice/second and capped at 120 events. */
export function startVisitCapture({
  apiUrl,
  pages = ["/", "/about", "/services"],
  enabled = true,
  fetcher = fetch,
}) {
  if (
    !enabled ||
    typeof window === "undefined" ||
    navigator.doNotTrack === "1" ||
    navigator.globalPrivacyControl === true
  )
    return () => {};
  let disposed = false,
    token = "",
    sequence = 0,
    points = [],
    total = 0,
    lastMove = -Infinity,
    currentPath = "",
    sending = false;
  const started = Date.now(),
    base = apiUrl.replace(/\/$/, "");
  const viewport = () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scroll:
      window.scrollY /
      Math.max(1, document.documentElement.scrollHeight - window.innerHeight),
  });
  const capture = (type, event) => {
    const path = window.location.pathname;
    if (
      disposed ||
      !token ||
      total >= 120 ||
      !pages.includes(path) ||
      Date.now() - started >= 1800000
    )
      return;
    if (type === "move" && Date.now() - lastMove < 500) return;
    const point = visitPoint(
      type,
      event,
      path,
      Date.now() - started,
      viewport(),
    );
    if (!point) return;
    if (type === "move") lastMove = Date.now();
    points.push(point);
    total++;
  };
  const flush = async () => {
    if (disposed || sending || !token || !points.length) return;
    sending = true;
    const batch = points.splice(0, 20),
      batchSequence = ++sequence;
    try {
      await fetcher(base + "/visits/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, sequence: batchSequence, points: batch }),
        credentials: "omit",
        keepalive: true,
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      /* Best effort; never affect navigation or retry indefinitely. */
    } finally {
      sending = false;
    }
  };
  const move = (e) => capture("move", e),
    click = (e) => capture("click", e),
    scroll = () => {
      if (Date.now() - lastMove < 500) return;
      lastMove = Date.now();
      capture("scroll");
    };
  const tick = () => {
    if (currentPath !== window.location.pathname) {
      currentPath = window.location.pathname;
      capture("page");
    }
    void flush();
  };
  fetcher(base + "/visits/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    credentials: "omit",
    signal: AbortSignal.timeout(4000),
  })
    .then((r) => (r.ok ? r.json() : undefined))
    .then((result) => {
      if (!disposed && result?.token) {
        token = result.token;
        capture("page");
        currentPath = window.location.pathname;
      }
    })
    .catch(() => {});
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("click", click, { passive: true });
  window.addEventListener("scroll", scroll, { passive: true });
  window.addEventListener("pagehide", flush);
  const timer = setInterval(tick, 5000);
  return () => {
    void flush();
    disposed = true;
    clearInterval(timer);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("click", click);
    window.removeEventListener("scroll", scroll);
    window.removeEventListener("pagehide", flush);
  };
}
