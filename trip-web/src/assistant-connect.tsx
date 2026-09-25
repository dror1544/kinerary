import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Lang } from "./parity-ui";

type Access = "read" | "read_write";
type Connection = { id: string; username: string; client: string; host?: string | null; access?: Access; connected_at: string; last_used_at: string | null };
type ConnectionState = { enabled: false } | { enabled: true; url: string; access: Access; connections: Connection[] };

const copy = (lang: Lang, en: string, he: string) => (lang === "he" ? he : en);

/**
 * Claude's documented install link: it opens the "Add custom connector" dialog
 * with the name and address filled in, marked as coming from an external
 * link. The person still reviews and confirms; nothing is added by the click.
 * https://claude.com/docs/connectors/custom/remote-mcp
 */
export function claudeInstallLink(name: string, url: string) {
  const q = new URLSearchParams({ modal: "add-custom-connector", connectorName: name, connectorUrl: url });
  return `https://claude.ai/customize/connectors?${q}`;
}

/**
 * "Connect your AI assistant" — the way in to the trip's own MCP endpoint
 * (server/trip-mcp) for everyone on the trip: an organizer's connection can
 * read and change the trip, anyone else's can only read it. Renders nothing
 * unless the trip turned the endpoint on, so nobody is shown an address that
 * does not work.
 */
export function AssistantConnect({ lang, tripName }: { lang: Lang; tripName?: string }) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["mcp-connection"],
    queryFn: () => api<ConnectionState>("/api/mcp/connection"),
    retry: false,
  });
  const [copied, setCopied] = useState(false);
  const [chatgptHint, setChatgptHint] = useState(false);
  const disconnect = useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["mcp-connection"] }),
  });

  const data = state.data;
  if (!data || !data.enabled) return null;
  const readOnly = data.access !== "read_write";
  const name = tripName ? `${tripName} (Kinerary)` : "Kinerary trip";

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the address stays visible to copy by hand */
    }
  }
  // ChatGPT has no install link: copy the address first, then open ChatGPT,
  // and say where it goes.
  async function openChatGPT(url: string) {
    await copyUrl(url);
    setChatgptHint(true);
    window.open("https://chatgpt.com/", "_blank", "noopener");
  }
  const when = (iso: string) => new Date(iso).toLocaleDateString(lang === "he" ? "he-IL" : "en-US", { month: "short", day: "numeric" });

  return (
    <div className="assistant-connect">
      <h3>{copy(lang, "Connect your AI assistant", "חיבור עוזר AI")}</h3>
      <p>{readOnly
        ? copy(lang,
            "Ask Claude or ChatGPT about this trip — the plan, bookings, who is coming. It can read the trip, not change it.",
            "שאלו את Claude או את ChatGPT על הטיול — התוכנית, ההזמנות, מי מגיע. הוא יכול לקרוא את הטיול, לא לשנות אותו.")
        : copy(lang,
            "Manage this trip from Claude or ChatGPT: it can read the trip and make the changes you can make here.",
            "נהלו את הטיול מ-Claude או מ-ChatGPT: הוא יכול לקרוא את הטיול ולעשות את השינויים שאתם יכולים לעשות כאן.")}</p>
      <div className="assistant-connect-actions">
        <a className="assistant-connect-button" href={claudeInstallLink(name, data.url)} target="_blank" rel="noopener noreferrer">
          {copy(lang, "Add to Claude", "הוספה ל-Claude")}
        </a>
        <button type="button" onClick={() => openChatGPT(data.url)}>
          {copy(lang, "Add to ChatGPT", "הוספה ל-ChatGPT")}
        </button>
      </div>
      {chatgptHint ? (
        <p className="assistant-connect-hint" role="status">{copy(lang,
          "The address is copied. In ChatGPT on the web: Settings → Security and login → turn on Developer mode, then + to create an app, paste the address and choose OAuth.",
          "הכתובת הועתקה. ב-ChatGPT באתר: הגדרות ← אבטחה והתחברות ← הפעלת מצב מפתח, ואז + ליצירת אפליקציה, הדביקו את הכתובת ובחרו OAuth.")}</p>
      ) : null}
      <p className="assistant-connect-note">{copy(lang,
        "After that, a page from this site opens: sign in with your trip account and allow.",
        "לאחר מכן ייפתח דף מהאתר הזה: התחברו עם חשבון הטיול ואשרו.")}</p>
      <div className="assistant-connect-url">
        <code dir="ltr">{data.url}</code>
        <button type="button" className="ghost" onClick={() => copyUrl(data.url)}>
          {copied ? copy(lang, "Copied", "הועתק") : copy(lang, "Copy", "העתקה")}
        </button>
      </div>
      {data.connections.length ? (
        <>
          <h4>{copy(lang, "Connected", "מחוברים")}</h4>
          <ul>
            {data.connections.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.client}</strong>{" "}
                  <small>
                    {c.host && c.host !== c.client ? `${c.host} · ` : ""}@{c.username} ·{" "}
                    {c.access === "read_write" ? copy(lang, "read and change", "קריאה ושינוי") : copy(lang, "read only", "קריאה בלבד")} ·{" "}
                    {copy(lang, "since", "מאז")} {when(c.connected_at)}
                  </small>
                </span>
                <button type="button" className="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate(c.id)}>
                  {copy(lang, "Disconnect", "ניתוק")}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
