"use client";
import { useEffect, useState, type CSSProperties } from "react";
import styles from "./PhotoViewer.module.css";

export function PhotoImage({ src, alt, style, loading = "lazy", retryable = true, onReady, rotation }: {
  src: string; alt: string; style?: CSSProperties; loading?: "lazy" | "eager"; retryable?: boolean;
  /** Fit a saved quarter-turn rotation inside the parent frame. Omit for the zoom viewer. */
  rotation?: number;
  onReady?: (size: { width: number; height: number } | null) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); setAttempt(0); }, [src]);
  const angle = Number.isFinite(rotation) ? ((rotation! % 360) + 360) % 360 : 0;
  const sideways = angle === 90 || angle === 270;
  const fitted: CSSProperties = { ...style, position: "absolute", left: "50%", top: "50%",
    width: sideways ? "100cqh" : "100cqw", height: sideways ? "100cqw" : "100cqh",
    maxWidth: "none", maxHeight: "none", objectFit: "contain", display: "block",
    transform: `translate(-50%,-50%) rotate(${angle}deg)` };
  const image = failed ? <span className={styles.unavailable} data-compact={!retryable}>
    <span role="img" aria-label={`${alt} unavailable`}>Photo unavailable</span>
    {retryable && <button type="button" className="btn" onClick={event => {
      event.stopPropagation(); event.currentTarget.closest("dialog")?.focus({ preventScroll: true });
      setAttempt(value => value + 1); setFailed(false);
    }}>Retry image</button>}
  </span> : <img src={attempt ? `${src}${src.includes("?") ? "&" : "?"}refresh=${attempt}` : src}
    alt={alt} loading={loading} decoding="async" draggable={false} style={rotation === undefined ? style : fitted}
    onLoad={event => onReady?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
    onError={() => { setFailed(true); onReady?.(null); }} />;
  return rotation === undefined ? image : <span className={styles.fitFrame}>{image}</span>;
}
