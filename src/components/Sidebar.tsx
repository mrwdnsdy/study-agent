import { useRef, useState, type DragEvent } from 'react';
import {
  AlertCircle,
  BookOpen,
  FileImage,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Presentation,
  Trash2,
  Upload,
} from 'lucide-react';
import type { MaterialMeta, ServerConfigResponse, Session, SessionSummary } from '../../shared/types';
import { formatBytes, relativeTime } from '../lib/format';
import { getMode } from '../lib/mode';

const ACCEPT = '.pdf,.pptx,.docx,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.markdown,.csv';

function MaterialIcon({ kind }: { kind: MaterialMeta['kind'] }) {
  switch (kind) {
    case 'pptx':
      return <Presentation size={16} />;
    case 'image':
      return <FileImage size={16} />;
    case 'pdf':
    case 'docx':
    case 'text':
    default:
      return <FileText size={16} />;
  }
}

interface Props {
  sessions: SessionSummary[];
  session: Session | null;
  config: ServerConfigResponse | null;
  uploading: boolean;
  busy: boolean;
  onOpenSession: (id: string) => void;
  onCreateSession: () => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  onUpload: (files: File[]) => void;
  onDeleteMaterial: (materialId: string) => void;
}

export function Sidebar({
  sessions,
  session,
  config,
  uploading,
  busy,
  onOpenSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onUpload,
  onDeleteMaterial,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const pickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onUpload(Array.from(list));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    pickFiles(event.dataTransfer.files);
  };

  const rename = (s: SessionSummary) => {
    const title = window.prompt('Rename session', s.title);
    if (title && title.trim() && title.trim() !== s.title) onRenameSession(s.id, title.trim());
  };

  const remove = (s: SessionSummary) => {
    if (window.confirm(`Delete "${s.title}" and all of its materials, guide, chat and quizzes?`)) onDeleteSession(s.id);
  };

  return (
    <div className="sidebar__inner">
      <section className="sidebar__section">
        <div className="sidebar__heading">
          <h2>Sessions</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCreateSession} title="New session">
            <Plus size={16} /> New
          </button>
        </div>
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className={`session-item${session?.id === s.id ? ' is-active' : ''}`}>
              <button type="button" className="session-item__main" onClick={() => onOpenSession(s.id)}>
                <span className="session-item__title">{s.title}</span>
                <span className="session-item__meta">
                  {s.materialCount} file{s.materialCount === 1 ? '' : 's'} · {s.hasGuide ? 'guide ready' : 'no guide'} ·{' '}
                  {s.quizCount} quiz{s.quizCount === 1 ? '' : 'zes'} · {relativeTime(s.updatedAt)}
                </span>
              </button>
              <span className="session-item__actions">
                <button type="button" className="icon-btn" title="Rename" onClick={() => rename(s)}>
                  <Pencil size={14} />
                </button>
                <button type="button" className="icon-btn icon-btn--danger" title="Delete" onClick={() => remove(s)}>
                  <Trash2 size={14} />
                </button>
              </span>
            </li>
          ))}
          {sessions.length === 0 && <li className="muted">No sessions yet.</li>}
        </ul>
      </section>

      <section className="sidebar__section sidebar__section--grow">
        <div className="sidebar__heading">
          <h2>Materials</h2>
          {session && <span className="muted small">{session.materials.length} file{session.materials.length === 1 ? '' : 's'}</span>}
        </div>
        {session ? (
          <>
            <div
              className={`dropzone${dragOver ? ' is-dragover' : ''}${uploading ? ' is-busy' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => !uploading && inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
              }}
            >
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                hidden
                onChange={(e) => {
                  pickFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              {uploading ? (
                <>
                  <Loader2 size={22} className="spin" />
                  <strong>Processing your files…</strong>
                  <span className="muted small">Slides are converted and read page by page.</span>
                </>
              ) : (
                <>
                  <Upload size={22} />
                  <strong>Drop lecture slides, notes or images</strong>
                  <span className="muted small">
                    PDF, PowerPoint (.pptx), Word (.docx), images, text · up to {config?.maxUploadMb ?? 100} MB each
                  </span>
                </>
              )}
            </div>
            <ul className="material-list">
              {session.materials.map((m) => (
                <li key={m.id} className={`material${m.status === 'error' ? ' material--error' : ''}`}>
                  <span className="material__icon">{m.status === 'error' ? <AlertCircle size={16} /> : <MaterialIcon kind={m.kind} />}</span>
                  <span className="material__body">
                    <span className="material__name" title={m.name}>
                      {m.name}
                    </span>
                    <span className="material__meta">
                      {m.status === 'error' ? m.error : `${m.summary} · ${formatBytes(m.sizeBytes)}`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    title="Remove"
                    disabled={busy}
                    onClick={() => onDeleteMaterial(m.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {session.materials.length === 0 && (
              <p className="muted small sidebar__hint">
                <BookOpen size={14} /> Upload the lecture slides and notes for one module, then generate the study guide.
              </p>
            )}
          </>
        ) : (
          <p className="muted small">Select or create a session.</p>
        )}
      </section>

      <footer className="sidebar__footer muted small">
        {config ? (
          getMode() === 'browser' ? (
            <>
              Browser mode · model <code>{config.model}</code> · your files, guides and key stay on this device
            </>
          ) : (
            <>
              Model <code>{config.model}</code>
              {config.sofficeAvailable ? ' · slide rendering on' : ' · slide text extraction (install LibreOffice to render slides)'}
            </>
          )
        ) : (
          'Connecting…'
        )}
      </footer>
    </div>
  );
}
