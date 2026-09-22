import { useMemo, useState } from 'react';
import { BookOpen, ListTree, Loader2, RefreshCw, Sparkles, Square } from 'lucide-react';
import { DEFAULT_GUIDE_PROMPT, type GuideQuality, type Session, type TaskModels } from '../../shared/types';
import { displayModel } from '../../shared/agent/constants';
import { relativeTime, titleFromMarkdown, wordCount } from '../lib/format';
import { tableOfContents } from '../lib/toc';
import type { StreamState, Toast } from '../state';
import { ExportMenu } from './ExportMenu';
import { Markdown } from './Markdown';

interface Props {
  session: Session;
  stream: StreamState;
  busy: boolean;
  models: TaskModels | null;
  escalationModel?: string;
  agentName: string;
  onGenerate: (prompt: string, quality: GuideQuality) => void;
  onStop: () => void;
  onToast: (toast: Toast) => void;
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
            <option value="standard">Standard · {guideModel ?? 'default model'}</option>
            <option value="max">Maximum · {displayModel(escalationModel)} (slower, about twice the cost)</option>
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

export function GuideView({ session, stream, busy, models, escalationModel, agentName, onGenerate, onStop, onToast }: Props) {
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [showToc, setShowToc] = useState(true);
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
            <Loader2 size={18} className="spin" />
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
            <BookOpen size={28} />
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
            {session.guide.model ? ` · ${displayModel(session.guide.model)}` : ''}
          </span>
        </div>
        <div className="guide__actions">
          <button type="button" className={`btn btn--ghost${showToc ? ' is-active' : ''}`} onClick={() => setShowToc((v) => !v)} title="Table of contents">
            <ListTree size={16} /> Contents
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setShowRegenerate((v) => !v)} disabled={busy}>
            <RefreshCw size={16} /> Regenerate
          </button>
          <ExportMenu markdown={markdown} title={title} subtitle={`Study guide · ${session.title}`} onToast={onToast} />
        </div>
      </div>
      {showRegenerate && (
        <div className="guide__regenerate">
          <PromptForm
            initial={basePrompt(session.guide.prompt)}
            initialQuality={session.guide.model && session.guide.model === escalationModel ? 'max' : 'standard'}
            guideModel={displayModel(models?.guide)}
            escalationModel={escalationModel}
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
