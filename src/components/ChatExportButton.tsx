import { useMemo } from 'react';
import type { Session } from '../../shared/types';
import type { Toast } from '../state';
import { chatToMarkdown } from '../lib/exportMarkdown';
import { ExportMenu } from './ExportMenu';

interface Props {
  session: Session;
  agentName: string;
  onToast: (toast: Toast) => void;
}

/** Export for the chat panel header: the whole conversation as one document. */
export function ChatExportButton({ session, agentName, onToast }: Props) {
  const { messages, title } = session;
  // Rebuilt only when the transcript changes, not on every streamed token that re-renders the panel.
  const markdown = useMemo(() => chatToMarkdown(messages, agentName, title), [messages, agentName, title]);
  const hasMessages = messages.some((message) => message.content.trim());
  return (
    <ExportMenu
      markdown={markdown}
      title={`${title} — chat with ${agentName}`}
      folder={title}
      onToast={onToast}
      compact
      disabled={!hasMessages}
    />
  );
}
