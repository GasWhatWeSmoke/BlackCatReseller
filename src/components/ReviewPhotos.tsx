"use client";
import { useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Star, Eye, EyeOff, Trash2, Expand } from "lucide-react";
import styles from "@/app/review/Review.module.css";
import { toast } from "sonner";
import { PhotoImage } from "./PhotoImage";
interface Photo { id: number; storedPath: string; thumbPath: string | null; rotation: number; isCover: boolean; isMarker: boolean; includeInListing: boolean; sortOrder: number }
export function ReviewPhotos({ photos, sku, disabled, onEnlarge, onChange, onMove, onRemove, onSelect }: {
  photos: Photo[]; sku: string; disabled: boolean; onEnlarge: (photo: Photo) => void;
  onChange: (photo: Photo, patch: Record<string, unknown>) => Promise<void>;
  onMove: (photo: Photo, delta: -1 | 1) => Promise<void>; onRemove: (photo: Photo) => Promise<void>;
  onSelect: (id: number) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const ordered = [...photos].sort((a, b) => Number(a.isMarker) - Number(b.isMarker) || a.sortOrder - b.sortOrder);
  const active = ordered.find(photo => photo.id === selected) ?? ordered.find(photo => photo.isCover && !photo.isMarker) ?? ordered[0];
  const action = async (run: () => Promise<void>) => { if (busy || disabled) return; setBusy(true); try { await run(); } catch (error) { toast.error(error instanceof Error ? error.message : "Photo change did not finish"); } finally { setBusy(false); } };
  const source = (photo: Photo) => `/api/thumb?path=${encodeURIComponent(photo.thumbPath ?? photo.storedPath)}&full=${encodeURIComponent(photo.storedPath)}`;
  return <section className={styles.photoStudio} aria-label={`Photos for inventory ${sku}`}>
    <header><span className="hub-eyebrow">THE PIECE</span><strong>#{sku}</strong><span>{ordered.filter(photo => !photo.isMarker).length} photos</span></header>
    {active ? <>
      <button className={styles.heroPhoto} onClick={() => onEnlarge(active)} aria-label="Enlarge selected item photo">
        <PhotoImage src={`/api/photo?path=${encodeURIComponent(active.storedPath)}`} alt={`Inventory ${sku}, selected view`} loading="eager" retryable={false} rotation={active.rotation} />
        <span><Expand size={16} /> Inspect full size</span>
      </button>
      <div className={styles.photoStrip}>{ordered.map((photo, index) => <button key={photo.id} onClick={() => { setSelected(photo.id); if (!photo.isMarker && photo.includeInListing) onSelect(photo.id); }} aria-label={`Select ${photo.isMarker ? "SKU marker" : `photo ${index + 1}`}`} aria-pressed={photo.id === active.id}>
        <PhotoImage src={source(photo)} alt={photo.isMarker ? "SKU marker" : `Photo ${index + 1}`} retryable={false} rotation={photo.rotation} />
        <span>{photo.isMarker ? "SKU" : photo.isCover ? "Cover" : `${index + 1}`}</span>
      </button>)}</div>
      {!active.isMarker && <div className={styles.photoTools} aria-busy={busy}>
        <button className="btn" disabled={busy || disabled} onClick={() => void action(() => onChange(active, { rotation: (active.rotation + 90) % 360 }))}><RotateCw size={17} /> Rotate</button>
        <button className="btn" disabled={busy || disabled || active.isCover} onClick={() => void action(() => onChange(active, { isCover: true }))}><Star size={17} /> {active.isCover ? "Cover photo" : "Use as cover"}</button>
        <button className="btn" disabled={busy || disabled} onClick={() => void action(() => onChange(active, { includeInListing: !active.includeInListing }))}>{active.includeInListing ? <EyeOff size={17} /> : <Eye size={17} />} {active.includeInListing ? "Exclude" : "Include"}</button>
        <button className="btn" aria-label="Move photo earlier" disabled={busy || disabled || ordered[0]?.id === active.id} onClick={() => void action(() => onMove(active, -1))}><ArrowLeft size={17} /></button>
        <button className="btn" aria-label="Move photo later" disabled={busy || disabled || ordered.filter(photo => !photo.isMarker).at(-1)?.id === active.id} onClick={() => void action(() => onMove(active, 1))}><ArrowRight size={17} /></button>
        <button className="btn" aria-label="Remove selected photo" disabled={busy || disabled} onClick={() => void action(() => onRemove(active))}><Trash2 size={17} /></button>
      </div>}
      <p className="muted">Inspect the garment and its label. Ruler markings belong to measurements, not the brand, model, or label size.</p>
    </> : <p className="muted">Add photos in the item editor to review this piece.</p>}
  </section>;
}
