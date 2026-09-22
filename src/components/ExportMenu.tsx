import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Loader2, Printer } from 'lucide-react';
import type { Toast } from '../state';

interface Props {
  markdown: string;
  title: string;
  subtitle?: string;
  onToast: (toast: Toast) => void;
}

export function ExportMenu({ markdown, title, subtitle, onToast }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    import('../lib/googleDocs').then((m) => setGoogleReady(m.isGoogleDocsConfigured())).catch(() => setGoogleReady(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const run = async (label: string, task: () => Promise<void>) => {
    setOpen(false);
    setBusy(label);
    try {
      await task();
    } catch (err) {
      onToast({ kind: 'error', message: `${label} failed: ${(err as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  const buildDocx = async () => {
    const [{ markdownToDocxBlob }] = await Promise.all([import('../lib/exportDocx')]);
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
        message: 'Word document downloaded. Drag it into Google Drive and open it to convert it into a Google Doc.',
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

  const exportGoogleDocs = () =>
    run('Google Docs export', async () => {
      const { uploadDocxToGoogleDocs } = await import('../lib/googleDocs');
      const blob = await buildDocx();
      setBusy('Uploading to Google Docs…');
      const { url } = await uploadDocxToGoogleDocs(blob, title);
      onToast({ kind: 'success', message: 'Your study guide is now a Google Doc.', link: { href: url, label: 'Open in Google Docs' } });
    });

  return (
    <div className="menu" ref={rootRef}>
      <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => setOpen((v) => !v)}>
        {busy ? (
          <>
            <Loader2 size={16} className="spin" /> {busy}
          </>
        ) : (
          <>
            <Download size={16} /> Export
          </>
        )}
      </button>
      {open && (
        <div className="menu__list" role="menu">
          <button type="button" role="menuitem" onClick={exportDocx}>
            <FileText size={16} /> Word document (.docx)
            <small>Opens in Google Docs, Word, Pages · diagrams included</small>
          </button>
          <button type="button" role="menuitem" onClick={exportGoogleDocs} disabled={!googleReady} title={googleReady ? '' : 'Set VITE_GOOGLE_CLIENT_ID to enable direct upload (see README)'}>
            <ExternalLink size={16} /> Open in Google Docs
            <small>{googleReady ? 'Uploads to your Drive as a Google Doc' : 'Not configured: download the .docx and drop it into Google Drive'}</small>
          </button>
          <button type="button" role="menuitem" onClick={openPrintable}>
            <Printer size={16} /> Printable view / Save as PDF
            <small>Opens in a new tab</small>
          </button>
          <button type="button" role="menuitem" onClick={exportHtml}>
            <Download size={16} /> HTML file
            <small>Self-contained web page</small>
          </button>
        </div>
      )}
    </div>
  );
}
