"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";
import { PhotoImage } from "./PhotoImage";
import styles from "./PhotoViewer.module.css";
import { MAX_PHOTO_SCALE, photoViewport, photoViewCenter, photoViewScroll } from "@/lib/photoViewport";

interface ViewerPhoto { id: number; storedPath: string; rotation: number; isMarker: boolean; includeInListing?: boolean }
export function PhotoViewer({ photos, photoId, sku, onSelect, onClose }: {
  photos: readonly ViewerPhoto[]; photoId: number; sku: string; onSelect: (id: number) => void; onClose: () => void;
}) {
  const modalRef = useRef<HTMLDialogElement>(null), frameRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const index = photos.findIndex(photo => photo.id === photoId), active = photos[index];
  const imageKey = active ? `${active.id}:${active.storedPath}` : "";
  const currentKey = useRef(imageKey); currentKey.current = imageKey;
  const [natural, setNatural] = useState<{ key: string; width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const center = useRef({ x: .5, y: .5 });
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const view = natural?.key === imageKey && active ? photoViewport(natural, bounds, active.rotation, zoom) : null;
  useLayoutEffect(() => {
    const modal = modalRef.current, frame = frameRef.current;
    if (!modal || !frame) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modal.showModal();
    const measure = () => setBounds({ width: frame.clientWidth, height: frame.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(frame);
    return () => { observer.disconnect(); modal.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useLayoutEffect(() => {
    center.current = { x: .5, y: .5 }; setZoom(null); drag.current = null; setDragging(false);
    frameRef.current?.scrollTo(0, 0);
  }, [imageKey, active?.rotation]);
  useLayoutEffect(() => {
    if (view && frameRef.current) frameRef.current.scrollTo(photoViewScroll(view, center.current));
  }, [view?.scale, view?.width, view?.height, bounds.width, bounds.height]);
  useLayoutEffect(() => {
    const modal = modalRef.current, focused = document.activeElement;
    if (modal?.open && document.hasFocus() && (!modal.contains(focused) || focused?.matches(":disabled"))) modal.focus({ preventScroll: true });
  }, [index, view?.scale]);
  const move = (delta: number) => { if (index >= 0 && photos[index + delta]) onSelect(photos[index + delta].id); };
  const changeZoom = (next: number | null) => {
    const frame = frameRef.current;
    if (!view || !frame) return;
    center.current = photoViewCenter(view, frame.scrollLeft, frame.scrollTop);
    setZoom(next === null ? null : Math.max(view.minimumScale, Math.min(MAX_PHOTO_SCALE, next)));
  };
  const stopDrag = () => {
    const pointer = drag.current; drag.current = null; setDragging(false);
    if (pointer && frameRef.current?.hasPointerCapture(pointer.id)) frameRef.current.releasePointerCapture(pointer.id);
  };
  const sideways = active && Math.abs(active.rotation % 180) === 90;
  return <dialog ref={modalRef} className={styles.viewer} tabIndex={-1} aria-label={`Photos for ${sku}`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) {
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    } }}
    onKeyDown={event => {
      event.stopPropagation();
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        if (["+", "=", "-", "0"].includes(event.key) && view) {
          event.preventDefault();
          if (event.key === "0") changeZoom(null);
          else if (event.key === "-" ? view.scale > view.minimumScale + .00001 : view.scale < MAX_PHOTO_SCALE)
            changeZoom(view.scale * (event.key === "-" ? 1 / 1.5 : 1.5));
        }
        if (view?.canPan && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); frameRef.current?.scrollBy({ left: event.key === "ArrowLeft" ? -80 : event.key === "ArrowRight" ? 80 : 0,
            top: event.key === "ArrowUp" ? -80 : event.key === "ArrowDown" ? 80 : 0 });
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); }
      }
      if (event.key === "Tab") {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button,[tabindex="0"]')].filter(control => !control.matches(":disabled") && control.getClientRects().length);
        const first = controls[0], last = controls.at(-1), focused = document.activeElement;
        if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); }
        else if (event.shiftKey && (focused === first || focused === event.currentTarget)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (focused === last || focused === event.currentTarget)) { event.preventDefault(); first.focus(); }
      }
    }}>
    <header className={styles.header}><div><h2>{sku}</h2><p role="status">{active ? `${active.isMarker ? "SKU marker · never listed" : active.includeInListing === false ? "Excluded from listing" : "Garment photo"} · ${index + 1} of ${photos.length}` : "This photo is no longer attached to the item."}</p></div>
      <button type="button" className="btn" autoFocus onClick={onClose} aria-label="Close photo viewer"><X size={17} /> Close</button></header>
    <div className={styles.zoom} role="group" aria-label="Photo zoom controls">
      <button type="button" className="btn" aria-label="Zoom out" disabled={!view || view.scale <= view.minimumScale + .00001} onClick={() => view && changeZoom(view.scale / 1.5)}><ZoomOut size={17} /></button>
      <button type="button" className="btn" aria-label="Zoom in" disabled={!view || view.scale >= MAX_PHOTO_SCALE} onClick={() => view && changeZoom(view.scale * 1.5)}><ZoomIn size={17} /></button>
      <button type="button" className="btn" disabled={!view} aria-pressed={zoom === null} onClick={() => changeZoom(null)}>Fit</button>
      <button type="button" className="btn" disabled={!view} aria-pressed={zoom === 1} onClick={() => changeZoom(1)}>100%</button>
      <output aria-label="Zoom level">{view ? `${Math.round(view.scale * 100)}%` : "—"}</output>
    </div>
    <div ref={frameRef} className={styles.frame} tabIndex={0} role="region" aria-label="Photo viewing area" data-pannable={!!view?.canPan} data-dragging={dragging}
      onScroll={event => { if (view && view.frameWidth === event.currentTarget.clientWidth && view.frameHeight === event.currentTarget.clientHeight)
        center.current = photoViewCenter(view, event.currentTarget.scrollLeft, event.currentTarget.scrollTop); }}
      onPointerDown={event => {
        if (!view?.canPan || event.pointerType !== "mouse" || event.button !== 0 || !(event.target as Element).closest("[data-photo-stage]") || (event.target as Element).closest("button")) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
        event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
      }}
      onPointerMove={event => { const pointer = drag.current; if (pointer?.id === event.pointerId) {
        event.currentTarget.scrollLeft = pointer.left - (event.clientX - pointer.x); event.currentTarget.scrollTop = pointer.top - (event.clientY - pointer.y);
      } }} onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
      <div className={styles.stage} data-photo-stage style={{ width: view?.stageWidth ?? bounds.width, height: view?.stageHeight ?? bounds.height }}>
        {active && <PhotoImage key={imageKey} src={`/api/photo?path=${encodeURIComponent(active.storedPath)}`} alt={`${sku}, ${active.isMarker ? "SKU marker" : `photo ${index + 1}`}`} loading="eager"
          onReady={size => { if (currentKey.current === imageKey) { center.current = { x: .5, y: .5 }; setZoom(null); setNatural(size ? { ...size, key: imageKey } : null); } }}
          style={view ? { position: "absolute", left: "50%", top: "50%", width: view.imageWidth, height: view.imageHeight, maxWidth: "none", maxHeight: "none", transform: `translate(-50%,-50%) rotate(${active.rotation}deg)` }
            : { width: "auto", height: "auto", maxWidth: sideways ? bounds.height : bounds.width, maxHeight: sideways ? bounds.width : bounds.height, objectFit: "contain", transform: `rotate(${active.rotation}deg)` }} />}
      </div>
    </div>
    <footer className={styles.footer}><span>{view?.canPan ? "Drag, swipe or use arrows to pan · Press 0 to fit · Escape closes" : "Arrow keys browse photos · + / − zoom · Escape closes"}</span><div>
      <button type="button" className="btn" disabled={index <= 0} onClick={() => move(-1)}><ChevronLeft size={16} /> Previous photo</button>
      <button type="button" className="btn" disabled={index < 0 || index >= photos.length - 1} onClick={() => move(1)}>Next photo <ChevronRight size={16} /></button>
    </div></footer>
  </dialog>;
}
