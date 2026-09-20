export function Skeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 py-3">
      <div className="h-3 w-3/4 rounded-sm bg-hover" />
      <div className="h-3 w-1/2 rounded-sm bg-hover" />
      <div className="h-3 w-2/3 rounded-sm bg-hover" />
    </div>
  );
}
