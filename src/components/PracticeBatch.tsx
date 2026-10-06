"use client";
import { useState } from 'react';
import { PRACTICE_ITEMS, newPracticeDrafts, updatePracticeDraft, practiceReviewError, type PracticeDraft, type PracticeItem } from '@/lib/practiceBatch';
import styles from './StarterTutorial.module.css';

function SampleViews({ item }: { item: PracticeItem }) {
  const shape = item.shape === 'bottom' ? 'M28 12H72L78 86H56L50 43L44 86H22Z'
    : item.shape === 'dress' ? 'M38 12H62L69 31L61 40L82 86H18L39 40L31 31Z'
    : 'M34 15L20 22L8 44L26 54L33 43V85H67V43L74 54L92 44L80 22L66 15L59 24H41Z';
  return <div className={styles.views}>{['Front', 'Back', 'Label'].map((view, index) => <figure key={view}>
    <svg viewBox="0 0 100 100" role="img" aria-label={`Fictional ${item.reference.color} ${item.reference.itemType}, ${view.toLowerCase()} illustration`}>
      {index < 2 ? <><path d={shape} fill={item.swatch} stroke="currentColor" strokeWidth="1.5" /><path d={index ? 'M50 28V74' : 'M38 28H62'} fill="none" stroke="currentColor" opacity=".5" /></>
        : <><rect x="13" y="16" width="74" height="68" rx="5" fill="var(--panel)" stroke="currentColor" /><text x="50" y="40" textAnchor="middle" fill="currentColor" fontSize="10">PRACTICE</text><text x="50" y="65" textAnchor="middle" fill="currentColor" fontSize="18">{item.reference.size}</text></>}
    </svg><figcaption>{view}</figcaption>
  </figure>)}</div>;
}

export function PracticeBatch() {
  const [started, setStarted] = useState(false), [selected, setSelected] = useState(0);
  const [drafts, setDrafts] = useState(newPracticeDrafts), [error, setError] = useState<string | null>(null);
  const item = PRACTICE_ITEMS[selected], draft = drafts[item.id];
  const done = PRACTICE_ITEMS.filter(sample => drafts[sample.id].reviewed).length;
  function edit(change: Partial<Omit<PracticeDraft, 'reviewed'>>) {
    setDrafts(current => ({ ...current, [item.id]: updatePracticeDraft(current[item.id], change) })); setError(null);
  }
  function review() {
    const problem = practiceReviewError(item, draft); setError(problem);
    if (!problem) setDrafts(current => ({ ...current, [item.id]: { ...current[item.id], reviewed: true } }));
  }
  function reset() { setDrafts(newPracticeDrafts()); setSelected(0); setError(null); setStarted(false); }
  return <section id="practice" className={`card ${styles.panel}`} aria-labelledby="practice-heading">
    <h2 id="practice-heading">Try a 10-item practice batch</h2>
    <p>Learn the review sequence with ten fictional garments. This is a <strong>simulated workflow</strong>: the illustrations and details are examples. Three drafts contain a mistake or missing field for you to correct.</p>
    <p className="muted">Practice stays on this page. It adds no inventory, uses no AI or accounts, and cannot publish. Leaving or reloading resets it. Completion does not verify recognition, photo processing or marketplace posting on your PC.</p>
    {!started ? <button className="btn btn-primary" onClick={() => setStarted(true)}>Start practice</button> : <>
      <p role="status"><strong>{done} of 10 practice items reviewed</strong></p>
      <nav className={styles.items} aria-label="Practice items">{PRACTICE_ITEMS.map((sample, index) => <button key={sample.id}
        className={`btn ${selected === index ? styles.selected : ''}`} aria-current={selected === index ? 'step' : undefined}
        aria-label={`Practice item ${index + 1}${drafts[sample.id].reviewed ? ', reviewed' : ', awaiting review'}`}
        onClick={() => { setSelected(index); setError(null); }}>{index + 1}{drafts[sample.id].reviewed ? ' ✓' : ''}</button>)}</nav>
      <div className={styles.workspace}>
        <div className={styles.reference}>
          <h3>{item.id}</h3><p className="muted">Fictional reference · use these facts</p>
          <SampleViews item={item} />
          <dl className={styles.facts}><dt>Item type</dt><dd>{item.reference.itemType}</dd><dt>Color</dt><dd>{item.reference.color}</dd><dt>Size</dt><dd>{item.reference.size}</dd><dt>Practice price</dt><dd>${item.reference.price}</dd><dt>Sample views</dt><dd>{item.photoCount} · marker kept separate</dd></dl>
          <p className="muted">In your own batch, compare real garment photos and tags. Measure when needed; leave unknown facts unclaimed.</p>
        </div>
        <div className={styles.form}>
          <h3>Review the practice draft</h3>
          {(['itemType', 'color', 'size', 'price'] as const).map(key => <label className={styles.field} key={key}>
            {{ itemType: 'Practice item type', color: 'Practice color', size: 'Practice size', price: 'Practice price ($)' }[key]}
            <input className="input" value={draft[key]} onChange={event => edit({ [key]: event.target.value })} inputMode={key === 'price' ? 'decimal' : 'text'} />
          </label>)}
          <label className={styles.check}><input type="checkbox" checked={draft.photosChecked} onChange={event => edit({ photosChecked: event.target.checked })} />I checked the three sample views and item identity.</label>
          <label className={styles.check}><input type="checkbox" checked={draft.labelChecked} onChange={event => edit({ labelChecked: event.target.checked })} />I compared the details and price with the fictional reference.</label>
          {error && <p role="alert" className={styles.notice}>{error}</p>}
          <button className="btn btn-primary" onClick={review} disabled={draft.reviewed}>{draft.reviewed ? 'Practice review complete' : 'Finish this practice review'}</button>
          {draft.reviewed && selected < PRACTICE_ITEMS.length - 1 && <button className="btn" onClick={() => { setSelected(selected + 1); setError(null); }}>Next practice item</button>}
        </div>
      </div>
      {done === 10 && <div className={styles.complete} role="status"><h3>All ten practice reviews complete</h3><p>In a real batch, reviewed items can be approved, then selected in Crosslisting. Before starting a run, check the exact items, marketplaces, prices and shipping choices. Afterward, inspect the actual listing on each marketplace.</p><p>No listing was created here. Your next test is ten real garments using the checklist below.</p></div>}
      <div className={styles.actions}><button className="btn" onClick={reset}>End practice and reset</button></div>
    </>}
  </section>;
}
