import { html } from "lit";

export type NotesViewProps = {
  secondBrainUrl: string;
};

/**
 * Render the Notes view - Second Brain iframe
 */
export function renderNotes(props: NotesViewProps) {
  const { secondBrainUrl } = props;

  return html`
    <div class="notes-view">
      <iframe 
        src="${secondBrainUrl}"
        class="notes-iframe"
        title="Second Brain"
        allow="clipboard-read; clipboard-write"
      ></iframe>
    </div>
  `;
}
