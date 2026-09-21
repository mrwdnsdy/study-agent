/** Browser download helpers. */

/** Trigger a "Save as" download for a Blob via a temporary object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been processed; revoking synchronously can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turn an arbitrary title into a safe filename: unsafe characters stripped,
 * whitespace collapsed to `-`, base name limited to 80 characters, then `ext`
 * (with or without a leading dot) appended.
 */
export function safeFilename(name: string, ext: string): string {
  const extension = ext ? (ext.startsWith('.') ? ext : `.${ext}`) : '';
  let base = String(name ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!base) base = 'document';
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  base = base.slice(0, 80).replace(/[-.]+$/g, '') || 'document';
  return base + extension;
}
