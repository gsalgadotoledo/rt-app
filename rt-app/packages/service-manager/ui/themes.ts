import {themes as baseThemes} from "@gsalgadotoledo/rt-app-admin-ui/themes";

/**
 * Service Manager themes: the shared admin catalog plus playful looks that only make sense in the
 * desktop app. `fx` names the decorative layer rendered by ThemeFx (see workspace.css for colors).
 */
export type ThemeFxKind = "matrix" | "runner" | "sakura" | "pixel" | "crt" | "synthwave" | null;
export const themes: readonly (readonly [id: string, title: string, description: string, fx?: ThemeFxKind])[] = [
  ...baseThemes,
  ["matrix", "Matrix", "Green digital rain on black", "matrix"],
  ["pixel", "8-bit", "Blocky pixel borders and a console palette", "pixel"],
  ["runner", "Arcade runner", "A pixel hero runs while the project is up", "runner"],
  ["sketch", "Draft", "Hand-drawn, a little unfinished"],
  ["sakura", "Sakura", "Pastel anime vibes with falling petals", "sakura"],
  ["dots", "Dot art", "Halftone dots and bold outlines"],
  ["synthwave", "Synthwave", "Neon sunset and a retro grid", "synthwave"],
  ["crt", "Amber CRT", "Scanlines on an old amber monitor", "crt"],
  ["blueprint", "Blueprint", "Technical drawing on blue paper"],
  ["brutal", "Neo-brutal", "Loud yellow, thick outlines, hard shadows"],
  ["forest", "Forest", "Moss, bark and firefly accents"],
];
export const themeFx = (id: string): ThemeFxKind => themes.find((t) => t[0] === id)?.[3] ?? null;
