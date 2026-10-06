import styles from './AmbientBackdrop.module.css';

export function AmbientBackdrop({ contained = false }: { contained?: boolean }) {
  return <div className={`${styles.backdrop} ${contained ? styles.contained : ''}`} aria-hidden="true" data-ambient-background={contained ? 'preview' : 'workspace'}>
    <span className={`${styles.layer} ${styles.first}`} />
    <span className={`${styles.layer} ${styles.second}`} />
  </div>;
}
