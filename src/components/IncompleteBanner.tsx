import { PenLine, RefreshCw } from 'lucide-react';
import { KiikuBuddy } from './Kiiku';
import './resilience.css';

interface Props {
  agentName: string;
  /** Why writing stopped, e.g. "connection problem". */
  reason?: string;
  busy: boolean;
  onContinue: () => void;
  onRegenerate?: () => void;
}

/** Shown above a study guide or review that stopped partway: the text is kept and can be finished. */
export function IncompleteBanner({ agentName, reason, busy, onContinue, onRegenerate }: Props) {
  return (
    <div className="incomplete-banner" role="status">
      <KiikuBuddy size={40} mood="thinking" className="incomplete-banner__buddy" />
      <p className="incomplete-banner__text">
        {agentName} stopped partway{reason ? ` (${reason})` : ''}. What it wrote is saved.
      </p>
      <div className="incomplete-banner__actions">
        <button type="button" className="btn btn--primary" onClick={onContinue} disabled={busy}>
          <PenLine size={16} /> Continue writing
        </button>
        {onRegenerate && (
          <button type="button" className="btn btn--ghost" onClick={onRegenerate} disabled={busy}>
            <RefreshCw size={16} /> Regenerate
          </button>
        )}
      </div>
    </div>
  );
}
