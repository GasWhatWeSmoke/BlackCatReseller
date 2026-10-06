"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import styles from "./PromptDialog.module.css";

// In-app replacement for window.prompt(): Electron never implemented prompt(), it
// THROWS on call — which silently killed every flow that asked for a SKU (split,
// move, rename, new-item). This modal is the popup those flows open instead.
//
// onSubmit contract: return null/undefined/void on success (the dialog closes);
// return an error STRING to show it inline and keep the dialog open so the value
// can be corrected (e.g. "SKU already exists").
export interface PromptSpec {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  actionLabel: string;
  onSubmit: (value: string) => Promise<string | null | void> | string | null | void;
}

export function PromptDialog({ spec, onClose }: { spec: PromptSpec | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const modalRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const submitting = useRef(false);
  const closing = useRef(false);
  const currentSpec = useRef(spec); currentSpec.current = spec;
  const closeCallback = useRef(onClose); closeCallback.current = onClose;
  const titleId = useId();
  const messageId = useId();
  const errorId = useId();

  useLayoutEffect(() => {
    const modal = modalRef.current, token = ++generation.current;
    submitting.current = false; closing.current = false;
    setValue(spec?.defaultValue ?? ""); setError(null); setBusy(false);
    if (!modal || !spec) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!modal.open) modal.showModal();
    // Select only after the new controlled value has reached the input. A stale
    // open/close cycle must never steal focus from a replacement dialog.
    queueMicrotask(() => {
      if (token === generation.current && modal.open) { inputRef.current?.focus(); inputRef.current?.select(); }
    });
    return () => {
      generation.current++;
      if (modal.open) modal.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [spec]);

  useLayoutEffect(() => {
    if (busy && modalRef.current?.open) modalRef.current.focus({ preventScroll: true });
    else if (error) inputRef.current?.focus();
  }, [error, busy]);
  const protectNavigation = busy || !!spec && value !== (spec.defaultValue ?? "");
  useEffect(() => {
    if (!protectNavigation) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [protectNavigation]);

  const requestClose = () => {
    if (submitting.current || closing.current || !currentSpec.current) return;
    closing.current = true; closeCallback.current();
  };

  const submit = async () => {
    if (!spec || submitting.current || closing.current) return;
    const v = value.trim();
    if (!v) { setError("Enter a value."); return; }
    const token = generation.current, submittedSpec = spec;
    const stillCurrent = () => token === generation.current && currentSpec.current === submittedSpec;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const err = await submittedSpec.onSubmit(v);
      if (!stillCurrent()) return;
      submitting.current = false; setBusy(false);
      if (typeof err === "string" && err) { setError(err); return; }
      requestClose();
    } catch (e) {
      if (!stillCurrent()) return;
      submitting.current = false;
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <dialog ref={modalRef} className={styles.modal} tabIndex={-1} aria-labelledby={titleId}
      aria-describedby={spec?.message ? messageId : undefined} aria-busy={busy}
      onCancel={event => { event.preventDefault(); requestClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) requestClose();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Tab") {
          const controls = [...event.currentTarget.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")]
            .filter(control => !control.disabled && control.getClientRects().length > 0);
          const first = controls[0], last = controls.at(-1), active = document.activeElement;
          if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); }
          else if (event.shiftKey && (active === first || active === event.currentTarget)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (active === last || active === event.currentTarget)) { event.preventDefault(); first.focus(); }
        }
        if (event.key === "Enter" && (event.repeat || event.nativeEvent.isComposing)) event.preventDefault();
      }}
    >
      {spec && <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <h3 id={titleId}>{spec.title}</h3>
        {spec.message && <p id={messageId} className="muted">{spec.message}</p>}
        <input
          ref={inputRef}
          className="input"
          value={value}
          placeholder={spec.placeholder}
          aria-labelledby={titleId}
          aria-describedby={[spec.message ? messageId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined}
          aria-invalid={!!error}
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
        />
        {error && <p id={errorId} role="alert" className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={requestClose} disabled={busy} data-sound="none">Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-sound="save">
            {busy ? <Loader2 size={14} className={styles.spinner} aria-hidden="true" /> : null} {busy ? "Working…" : spec.actionLabel}
          </button>
        </div>
      </form>}
    </dialog>
  );
}
