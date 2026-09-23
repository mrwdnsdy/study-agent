import { useMemo, useState } from 'react';
import { ListTree, RefreshCw, Sparkles, Square } from 'lucide-react';
import { DEFAULT_GUIDE_PROMPT, type GuideQuality, type Session, type TaskModels } from '../../shared/types';
import { displayModel } from '../../shared/agent/constants';
import { relativeTime, titleFromMarkdown, wordCount } from '../lib/format';
import { tableOfContents } from '../lib/toc';
import type { StreamState, Toast } from '../state';
import { ExportMenu } from './ExportMenu';
import { IncompleteBanner } from './IncompleteBanner';
import { KiikuBuddy } from './Kiiku';
import { Markdown } from './Markdown';
import { SaveAllToDrive } from './SaveAllToDrive';
import './resilience.css';

interface Props {
  session: Session;
  stream: StreamState;
  busy: boolean;
  models: TaskModels | null;
  escalationModel?: string;
  /** False on white-label pages: never name the models. */
  showModels?: boolean;
  agentName: string;
  onGenerate: (prompt: string, quality: GuideQuality) => void;
  /** Finishes a guide that stopped partway (session.guide.incomplete). */
  onContinue: () => void;
  onStop: () => void;
  onToast: (toast: Toast) => void;
}

const TOC_KEY = 'kiiku:toc';

/** The reader's last choice for the contents panel, if they made one (storage can be unavailable). */
function storedToc(): boolean | null {
  try {
    const value = localStorage.getItem(TOC_KEY);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}

function storeToc(show: boolean): void {
  try {
    localStorage.setItem(TOC_KEY, show ? '1' : '0');
  } catch {
    /* private mode or storage disabled: the choice lasts until reload */
  }
}

function basePrompt(prompt: string | undefined): string {
  const raw = prompt ?? DEFAULT_GUIDE_PROMPT;
  const index = raw.indexOf('\n\nRevision instructions:');
  return index === -1 ? raw : raw.slice(0, index);
}

function PromptForm({
  initial,
  initialQuality,
  guideModel,
  escalationModel,
  showModels = true,
  agentName,
  hasMaterials,
  busy,
  regenerate,
  onSubmit,
  onCancel,
}: {
  initial: string;
  initialQuality: GuideQuality;
  guideModel?: string;
  escalationModel?: string;
  /** False on white-label pages: never name the models. */
  showModels?: boolean;
  agentName: string;
  hasMaterials: boolean;
  busy: boolean;
  regenerate: boolean;
  onSubmit: (prompt: string, quality: GuideQuality) => void;
  onCancel?: () => void;
}) {
  const [prompt, setPrompt] = useState(initial);
  const [quality, setQuality] = useState<GuideQuality>(initialQuality);
  return (
    <form
      className="prompt-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (prompt.trim()) onSubmit(prompt.trim(), escalationModel ? quality : 'standard');
      }}
    >
      <label htmlFor="guide-prompt">Tell {agentName} what you need</label>
      <textarea id="guide-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} />
      {!hasMaterials && (
        <p className="notice notice--warn">
          No materials uploaded yet. Add your lecture slides or notes in the sidebar first, otherwise the guide will be based on general knowledge only.
        </p>
      )}
      {escalationModel && (
        <label className="prompt-form__quality">
          Quality
          <select value={quality} onChange={(e) => setQuality(e.target.value as GuideQuality)} data-testid="guide-quality">
            <option value="standard">{showModels ? `Standard · ${guideModel ?? 'default model'}` : 'Standard'}</option>
            <option value="max">{showModels ? `Maximum · ${displayModel(escalationModel)} (slower, about twice the cost)` : 'Maximum quality (slower)'}</option>
          </select>
        </label>
      )}
      <div className="prompt-form__actions">
        <button type="submit" className="btn btn--primary btn--lg" disabled={busy || !prompt.trim()}>
          <Sparkles size={18} /> {regenerate ? 'Generate new version' : 'Generate study guide'}
        </button>
        {onCancel && (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function GuideView({ session, stream, busy, models, escalationModel, showModels = true, agentName, onGenerate, onContinue, onStop, onToast }: Props) {
  const [showRegenerate, setShowRegenerate] = useState(false);
  // Open by default only where there is room for it beside the guide.
  const [showToc, setShowToc] = useState(() => storedToc() ?? window.matchMedia('(min-width: 1440px)').matches);
  const toggleToc = () => {
    const next = !showToc;
    setShowToc(next);
    storeToc(next);
  };
  const streamingGuide = stream.guideDraft !== null;
  const markdown = streamingGuide ? stream.guideDraft! : (session.guide?.markdown ?? '');
  const toc = useMemo(() => (streamingGuide || !markdown ? [] : tableOfContents(markdown, 3)), [markdown, streamingGuide]);
  const title = titleFromMarkdown(markdown, session.title);
  const hasMaterials = session.materials.some((m) => m.status === 'ready');

  if (streamingGuide) {
    return (
      <div className="guide guide--streaming">
        <div className="guide__toolbar">
          <div className="guide__status">
            <KiikuBuddy size={28} mood="thinking" />
            <div>
              <strong>Writing your study guide{stream.guideVersion ? ` (v${stream.guideVersion})` : ''}…</strong>
              <div className="muted small">
                {stream.status || 'Working through your materials'} · {wordCount(markdown).toLocaleString()} words so far
              </div>
            </div>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onStop}>
            <Square size={16} /> Stop
          </button>
        </div>
        {stream.thinking && (
          <details className="thinking">
            <summary>Reasoning</summary>
            <pre>{stream.thinking}</pre>
          </details>
        )}
        <div className="guide__body">
          <Markdown markdown={markdown} streaming className="guide__doc" />
        </div>
      </div>
    );
  }

  if (!session.guide) {
    return (
      <div className="guide guide--empty">
        <div className="hero">
          <div className="hero__icon">
            <KiikuBuddy size={48} />
          </div>
          <h1>Your study guide starts here</h1>
          <p className="muted">
            Upload your lecture slides and notes, then describe the guide you want. {agentName} reads every slide, explains each concept
            in depth with gold-standard tips, diagrams and tables, and streams the document here as it writes.
          </p>
          <PromptForm
            initial={DEFAULT_GUIDE_PROMPT}
            initialQuality="standard"
            guideModel={displayModel(models?.guide)}
            escalationModel={escalationModel}
            showModels={showModels}
            agentName={agentName}
            hasMaterials={hasMaterials}
            busy={busy}
            regenerate={false}
            onSubmit={onGenerate}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="guide">
      <div className="guide__toolbar">
        <div className="guide__info">
          <strong>{title}</strong>
          <span className="muted small">
            v{session.guide.version} · {wordCount(markdown).toLocaleString()} words · updated {relativeTime(session.guide.updatedAt)}
            {showModels && session.guide.model ? ` · ${displayModel(session.guide.model)}` : ''}
          </span>
        </div>
        <div className="guide__actions">
          <button type="button" className={`btn btn--ghost${showToc ? ' is-active' : ''}`} onClick={toggleToc} title="Table of contents" aria-label="Contents">
            <ListTree size={16} aria-hidden="true" /> <span className="btn__label">Contents</span>
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setShowRegenerate((v) => !v)} disabled={busy} title="Regenerate the guide" aria-label="Regenerate">
            <RefreshCw size={16} aria-hidden="true" /> <span className="btn__label">Regenerate</span>
          </button>
          <SaveAllToDrive session={session} agentName={agentName} onToast={onToast} />
          <ExportMenu markdown={markdown} title={title} subtitle={`Study guide · ${session.title}`} folder={session.title} onToast={onToast} />
        </div>
      </div>
      {session.guide.incomplete && (
        <IncompleteBanner
          agentName={agentName}
          reason={session.guide.stoppedReason}
          busy={busy}
          onContinue={onContinue}
          onRegenerate={() => setShowRegenerate(true)}
        />
      )}
      {showRegenerate && (
        <div className="guide__regenerate">
          <PromptForm
            initial={basePrompt(session.guide.prompt)}
            initialQuality={session.guide.model && session.guide.model === escalationModel ? 'max' : 'standard'}
            guideModel={displayModel(models?.guide)}
            escalationModel={escalationModel}
            showModels={showModels}
            agentName={agentName}
            hasMaterials={hasMaterials}
            busy={busy}
            regenerate
            onSubmit={(prompt, quality) => {
              setShowRegenerate(false);
              onGenerate(prompt, quality);
            }}
            onCancel={() => setShowRegenerate(false)}
          />
        </div>
      )}
      <div className={`guide__body${showToc && toc.length > 0 ? ' guide__body--toc' : ''}`}>
        {showToc && toc.length > 0 && (
          <nav className="toc" aria-label="Table of contents">
            <div className="toc__title">Contents</div>
            <ul>
              {toc.map((entry, i) => (
                <li key={`${entry.id}-${i}`} className={`toc__item toc__item--l${entry.level}`}>
                  <a href={`#${entry.id}`}>{entry.text}</a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <Markdown markdown={markdown} className="guide__doc" />
      </div>
    </div>
  );
}
