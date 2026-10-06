import { packageDetailLines, type PackageDetails } from '@/lib/packageDetails';

export function PackageDetailsNote({ details }: { details?: PackageDetails }) {
  return <div role="note" aria-label="Package estimates" className="muted" style={{ fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere', marginTop: 6 }}>
    {packageDetailLines(details).map(line => <div key={line}>{line}</div>)}
  </div>;
}
