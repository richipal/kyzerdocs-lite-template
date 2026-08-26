import { AppShell } from "../../components/layout/AppShell.js";
import { ChatPanel } from "../../components/chat/ChatPanel.js";

/** Screen 2 of the two-screen UI (D2-13) — the Ask experience: stream a cited answer, click a
 * citation to see the passage it came from, and follow up without repeating yourself. */
export default function AskPage() {
  return (
    <AppShell active="chat">
      <ChatPanel />
    </AppShell>
  );
}
