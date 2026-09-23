import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloudUpload, Download, ExternalLink, Loader2, X } from 'lucide-react';
import type { Toast } from '../state';
import './export.css';

interface Props {
  /** The document to offer as a Word file; without it the dialog only explains the Drive steps. */
  markdown?: string;
  title: string;
  subtitle?: string;
  /** A line above the steps, e.g. why saving straight to Drive is not possible here. */
  note?: string;
  onClose: () => void;
  onToast: (toast: Toast) => void;
}

const MY_DRIVE_URL = 'https://drive.google.com/drive/my-drive';

/**
 * "Save to Google Drive" by hand, for pages where Google sign-in cannot run (no client id, or the
 * claude.ai artifact sandbox): download the Word file, then upload it in Drive. Rendered into
 * <body> so a sticky toolbar's stacking context cannot trap it.
 */
export function DriveFallbackDialog({ markdown, title, subtitle, note, onClose, onToast }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const stepsRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    // Keyboard and screen-reader users land on the first step rather than behind the dialog.
    stepsRef.current?.querySelector<HTMLElement>('.btn')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const download = async () => {
    if (!markdown) return;
    setBusy('Preparing…');
    try {
      const [{ markdownToDocxBlob }, { downloadBlob, safeFilename }] = await Promise.all([import('../lib/exportDocx'), import('../lib/download')]);
      const blob = await markdownToDocxBlob(markdown, { title, subtitle, onProgress: setBusy });
      await downloadBlob(blob, safeFilename(title, '.docx'));
      setDownloaded(true);
    } catch (err) {
      onToast({ kind: 'error', message: `Word export failed: ${(err as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal modal--drive" role="dialog" aria-modal="true" aria-labelledby="drive-fallback-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal__header">
          <h2 id="drive-fallback-title">
            <CloudUpload size={18} /> Save to Google Drive
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="modal__body">
          <p className="muted small">{note ?? 'Two quick steps and it’s a Google Doc in your Drive.'}</p>
          <ol className="drive-steps" ref={stepsRef}>
            {markdown && (
              <li>
                <button type="button" className="btn btn--primary" onClick={download} disabled={busy !== null} data-testid="drive-fallback-download">
                  {busy ? (
                    <>
                      <Loader2 size={16} className="spin" /> {busy}
                    </>
                  ) : (
                    <>
                      <Download size={16} /> {downloaded ? 'Download again' : 'Download Word file'}
                    </>
                  )}
                </button>
              </li>
            )}
            <li>
              <a className="btn" href={MY_DRIVE_URL} target="_blank" rel="noreferrer" data-testid="drive-fallback-open">
                Open Google Drive <ExternalLink size={14} />
              </a>
            </li>
          </ol>
          <p className="small">In Drive: New → File upload, then open the file with Google Docs. Diagrams, tables and headings come along.</p>
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
