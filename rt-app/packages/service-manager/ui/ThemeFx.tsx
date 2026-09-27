import React, { useEffect, useRef } from "react";
import { themeFx } from "./themes.js";

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Digital rain on a canvas, throttled to ~16 fps and paused while the window is hidden. */
function MatrixRain() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || reducedMotion()) return;
    const glyphs = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789ABCDEF<>/{}=+*";
    const size = 14;
    let drops: number[] = [];
    let frame = 0;
    let last = 0;
    const resize = () => {
      el.width = el.clientWidth;
      el.height = el.clientHeight;
      drops = Array.from({ length: Math.ceil(el.width / size) }, () => Math.random() * -50);
    };
    const draw = (time: number) => {
      frame = requestAnimationFrame(draw);
      if (time - last < 60 || document.hidden) return;
      last = time;
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.fillRect(0, 0, el.width, el.height);
      ctx.font = `${size}px monospace`;
      drops.forEach((y, i) => {
        ctx.fillStyle = Math.random() > 0.96 ? "#d6ffe0" : "#1fd65f";
        ctx.fillText(glyphs[Math.floor(Math.random() * glyphs.length)], i * size, y * size);
        drops[i] = y * size > el.height && Math.random() > 0.975 ? 0 : y + 1;
      });
    };
    resize();
    window.addEventListener("resize", resize);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return <canvas ref={canvas} className="rt-fx-matrix" aria-hidden="true" />;
}

/** Pixel hero drawn with box-shadows; two frames alternate while running. */
const HERO_A = [
  "..HHHH..",
  ".HHHHHH.",
  ".HSESSE.",
  "..SSSS..",
  "..CCCC.S",
  ".SCCCCC.",
  "S.CCCC..",
  "..PPPP..",
  ".PP..PP.",
  "PP....PP",
  "B......B",
];
const HERO_B = [
  "..HHHH..",
  ".HHHHHH.",
  ".HSESSE.",
  "..SSSS..",
  "..CCCC..",
  "..CSCC..",
  "..CCCC..",
  "..PPPP..",
  "...PP...",
  "...PP...",
  "..BBB...",
];
const PALETTE: Record<string, string> = { H: "var(--fx-hair)", S: "#f5c9a0", E: "#1b1b2b", C: "var(--accent)", P: "var(--fx-pants)", B: "var(--text)" };
const PX = 4;
function shadows(grid: string[]) {
  return grid
    .flatMap((row, y) => [...row].map((c, x) => (PALETTE[c] ? `${(x + 1) * PX}px ${y * PX}px 0 0 ${PALETTE[c]}` : null)))
    .filter(Boolean)
    .join(",");
}
const FRAME_A = shadows(HERO_A);
const FRAME_B = shadows(HERO_B);

function Runner({ running }: { running: boolean }) {
  return (
    <div className={`rt-fx-runner${running ? " running" : ""}`} aria-hidden="true">
      <div className="rt-fx-hero">
        <i className="rt-fx-frame a" style={{ boxShadow: FRAME_A }} />
        <i className="rt-fx-frame b" style={{ boxShadow: FRAME_B }} />
        {!running && <span className="rt-fx-zzz">z z</span>}
      </div>
      <div className="rt-fx-ground" />
    </div>
  );
}

const PETALS = Array.from({ length: 14 }, (_, i) => ({ left: (i * 37) % 100, delay: -(i * 1.7) % 12, duration: 9 + (i % 5) * 2, scale: 0.6 + (i % 4) * 0.2 }));
function Sakura() {
  return (
    <div className="rt-fx-sakura" aria-hidden="true">
      {PETALS.map((p, i) => (
        <i key={i} style={{ left: `${p.left}%`, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s`, scale: String(p.scale) }} />
      ))}
    </div>
  );
}

const STARS = Array.from({ length: 24 }, (_, i) => ({ left: (i * 43) % 100, top: (i * 29) % 100, delay: -(i % 6) * 0.5 }));
function PixelStars() {
  return (
    <div className="rt-fx-stars" aria-hidden="true">
      {STARS.map((s, i) => (
        <i key={i} style={{ left: `${s.left}%`, top: `${s.top}%`, animationDelay: `${s.delay}s` }} />
      ))}
    </div>
  );
}

/**
 * Decorative background layer for the active theme. Purely visual: it never takes pointer events
 * and every animation stops under prefers-reduced-motion.
 */
export function ThemeFx({ theme, running }: { theme: string; running: boolean }) {
  switch (themeFx(theme)) {
    case "matrix":
      return <MatrixRain />;
    case "runner":
      return <Runner running={running} />;
    case "sakura":
      return <Sakura />;
    case "pixel":
      return <PixelStars />;
    case "crt":
      return <div className="rt-fx-scanlines" aria-hidden="true" />;
    case "synthwave":
      return <div className="rt-fx-grid" aria-hidden="true"><i /></div>;
    default:
      return null;
  }
}
