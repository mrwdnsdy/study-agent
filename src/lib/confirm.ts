/**
 * Confirmation prompts. The browser's confirm() is used normally; inside the
 * claude.ai artifact viewer that dialog is suppressed (it returns false at once),
 * so a small in-page dialog is shown instead.
 */
import { isArtifactHost } from '../../shared/agent/providers/artifactSample';

export function confirmAction(message: string, confirmLabel = 'Confirm'): Promise<boolean> {
  if (!isArtifactHost()) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const modal = document.createElement('div');
    modal.className = 'modal modal--confirm';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');

    const body = document.createElement('div');
    body.className = 'modal__body';
    const text = document.createElement('p');
    text.textContent = message;
    body.appendChild(text);

    const footer = document.createElement('footer');
    footer.className = 'modal__footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn--ghost';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn--primary';
    ok.textContent = confirmLabel;
    footer.append(cancel, ok);

    modal.append(body, footer);
    backdrop.appendChild(modal);

    const finish = (value: boolean) => {
      window.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(false);
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(false);
    });
    modal.addEventListener('click', (event) => event.stopPropagation());
    window.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
    ok.focus();
  });
}
