"use client";
import { useEffect } from "react";
import { playSound } from "@/lib/sound";

// Global, app-wide UI sounds: a subtle cue when the user clicks a button, selects a
// dropdown option, toggles a checkbox, or changes a field. A button can override its
// cue with data-sound="save" (etc.). Mounted once in the root layout.
export function SoundEffects() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const btn = t?.closest("button, [role=button], a.btn, .icon-btn") as HTMLElement | null;
      if (!btn) return;
      if ((btn as HTMLButtonElement).disabled) return;
      const s = btn.getAttribute("data-sound");
      if (s === "none") return;                 // button manages its own (or no) sound
      playSound(s || "click");
    };
    const onChange = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.tagName === "SELECT") playSound("select");
      else if (t.tagName === "INPUT" && (t as HTMLInputElement).type === "checkbox") playSound("toggle");
      else if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") playSound("change");
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onChange, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
    };
  }, []);
  return null;
}
