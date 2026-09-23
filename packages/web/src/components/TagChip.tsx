import { hueFor } from '../tags.ts';

export function TagChip({
  id, name, count, active, onClick, onRemove,
}: {
  id: string; name: string; count?: number;
  active?: boolean; onClick?: () => void; onRemove?: () => void;
}) {
  return (
    <span
      className={`chip hue-${hueFor(id)} ${active ? 'on' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
    >
      {name}
      {count !== undefined && <span className="n">{count}</span>}
      {onRemove && (
        <span className="x" role="button" aria-label={`Remove ${name}`}
              onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</span>
      )}
    </span>
  );
}
