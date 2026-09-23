import { useEffect, useRef, useState } from 'react';
import { CloudUpload, Download, FileText, Loader2, Printer } from 'lucide-react';
import type { Toast } from '../state';
import { DRIVE_ROOT_FOLDER, DriveError, connect, isDriveAvailable, isSignedIn, preloadGoogleSignIn, saveDocument } from '../lib/googleDrive';
import { DriveFallbackDialog } from './DriveFallbackDialog';
import './export.css';

interface Props {
  markdown: string;
  title: string;
  subtitle?: string;
  onToast: (toast: Toast) => void;
  /** Drive folder inside "Kiiku Study Buddy", usually the session title. Default: `title`. */
  folder?: string;
  /** Button text. Default: "Export". */
  label?: string;
  /** A small ghost button, for panel headers and list rows. */
  compact?: boolean;
  /** Greys the button out, e.g. while there is nothing to export yet. */
  disabled?: boolean;
}

/** Word, HTML, printable view and Google Drive exports of one markdown document. */
export function ExportMenu({ markdown, title, subtitle, onToast, folder, label = 'Export', compact = false, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const driveAvailable = isDriveAvailable();
  const driveFolder = folder?.trim() || title;

  useEffect(() => {
    if (!open) return;
    // Load Google's sign-in script now, so a click on "Save to Google Drive" can open its popup at once.
    preloadGoogleSignIn();
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = async (action: string, task: () => Promise<void>) => {
    setOpen(false);
    setBusy(action);
    try {
      await task();
    } catch (err) {
      // Drive errors are already worded for the visitor; a closed sign-in is a choice, not a failure.
      if (err instanceof DriveError) onToast({ kind: err.cancelled ? 'info' : 'error', message: err.message });
      else onToast({ kind: 'error', message: `${action} failed: ${(err as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  const buildDocx = async () => {
    const { markdownToDocxBlob } = await import('../lib/exportDocx');
    return markdownToDocxBlob(markdown, {
      title,
      subtitle,
      onProgress: (message) => setBusy(message),
    });
  };

  const exportDocx = () =>
    run('Word export', async () => {
      const { downloadBlob, safeFilename } = await import('../lib/download');
      const blob = await buildDocx();
      await downloadBlob(blob, safeFilename(title, '.docx'));
      onToast({
        kind: 'success',
        message: 'Word document downloaded. To turn it into a Google Doc, upload it to Google Drive and open it with Google Docs.',
      });
    });

  const exportHtml = () =>
    run('HTML export', async () => {
      const { markdownToStandaloneHtml } = await import('../lib/exportHtml');
      const { downloadBlob, safeFilename } = await import('../lib/download');
      const html = await markdownToStandaloneHtml(markdown, { title, subtitle });
      await downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), safeFilename(title, '.html'));
    });

  const openPrintable = () =>
    run('Printable view', async () => {
      const { markdownToStandaloneHtml } = await import('../lib/exportHtml');
      const html = await markdownToStandaloneHtml(markdown, { title, subtitle });
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const opened = window.open(url, '_blank');
      if (!opened) {
        onToast({ kind: 'info', message: 'Pop-up blocked. Allow pop-ups for this site, or use the HTML export.', link: { href: url, label: 'Open printable view' } });
      }
    });

  const saveToDrive = () => {
    setOpen(false);
    if (!isDriveAvailable()) {
      setFallbackOpen(true);
      return;
    }
    const signedIn = isSignedIn();
    // First thing, synchronously inside the click: browsers only let the Google sign-in popup open from a click.
    const access = connect();
    void run('Save to Google Drive', async () => {
      setBusy(signedIn ? 'Saving to Google Drive…' : 'Waiting for Google sign-in…');
      await access;
      const { url } = await saveDocument(markdown, { title, subtitle, folder: [DRIVE_ROOT_FOLDER, driveFolder], onProgress: setBusy });
      onToast({ kind: 'success', message: 'Saved to your Google Drive.', link: { href: url, label: 'Open' } });
    });
  };

  const iconSize = compact ? 14 : 16;
  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        className={compact ? 'btn btn--ghost btn--sm menu__trigger menu__trigger--compact' : 'btn btn--primary menu__trigger'}
        disabled={disabled || busy !== null}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact && !busy ? `${label}: Word, HTML, PDF or Google Drive` : undefined}
      >
        {busy ? (
          <>
            <Loader2 size={iconSize} className="spin" /> <span className="menu__busy">{busy}</span>
          </>
        ) : (
          <>
            <Download size={iconSize} /> <span className="menu__label">{label}</span>
          </>
        )}
      </button>
      {open && (
        <div className="menu__list" role="menu">
          <button type="button" role="menuitem" onClick={exportDocx}>
            <FileText size={16} /> Word document (.docx)
            <small>Opens in Word, Pages or Google Docs · diagrams included</small>
          </button>
          <button type="button" role="menuitem" onClick={exportHtml}>
            <Download size={16} /> HTML file
            <small>Self-contained web page</small>
          </button>
          <button type="button" role="menuitem" onClick={openPrintable}>
            <Printer size={16} /> Printable view / Save as PDF
            <small>Opens in a new tab</small>
          </button>
          <div className="menu__divider" role="separator" />
          <button type="button" role="menuitem" onClick={saveToDrive} data-testid="export-drive">
            <CloudUpload size={16} /> Save to Google Drive
            <small>{driveAvailable ? `As a Google Doc in ${DRIVE_ROOT_FOLDER} / ${driveFolder}` : 'Download the Word file, then add it to your Drive'}</small>
          </button>
        </div>
      )}
      {fallbackOpen && <DriveFallbackDialog markdown={markdown} title={title} subtitle={subtitle} onClose={() => setFallbackOpen(false)} onToast={onToast} />}
    </div>
  );
}
