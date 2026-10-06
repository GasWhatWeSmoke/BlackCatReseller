"use client";
import { useEffect } from "react";

// Electron has a long-standing Chromium bug: after a NATIVE JS dialog
// (confirm / prompt / alert) closes, the window still LOOKS focused but keyboard
// input is dead — typing does nothing until the user clicks out of the app and
// back in. This app uses those dialogs (delete confirms, split/move SKU prompts),
// so the bug showed up as "sometimes I can't type in Brand until I alt-tab".
//
// Fix: wrap all three so that right after any of them closes we ask the main
// process to blur+refocus the window (the programmatic version of the user's
// alt-tab workaround), then re-focus whatever element was active.
export function NativeFixes() {
  useEffect(() => {
    const native = (window as Window & { blackcat?: { refocus?: () => Promise<boolean> } }).blackcat;
    if (!native?.refocus) return; // plain browser — nothing to fix

    const kick = () => {
      const el = document.activeElement as HTMLElement | null;
      native.refocus!().then(() => {
        // Restore the caret to where the user was working.
        if (el && typeof el.focus === "function") setTimeout(() => el.focus(), 0);
      }).catch(() => {});
    };

    const origConfirm = window.confirm.bind(window);
    const origPrompt = window.prompt.bind(window);
    const origAlert = window.alert.bind(window);
    window.confirm = (msg?: string) => { const r = origConfirm(msg); kick(); return r; };
    window.prompt = (msg?: string, def?: string) => { const r = origPrompt(msg, def); kick(); return r; };
    window.alert = (msg?: string) => { origAlert(msg); kick(); };

    return () => {
      window.confirm = origConfirm;
      window.prompt = origPrompt;
      window.alert = origAlert;
    };
  }, []);
  return null;
}
