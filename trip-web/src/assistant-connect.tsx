import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Lang } from "./parity-ui";

type Connection = { id: string; username: string; client: string; host?: string | null; connected_at: string; last_used_at: string | null };
type ConnectionState = { enabled: false } | { enabled: true; url: string; connections: Connection[] };

const copy = (lang: Lang, en: string, he: string) => (lang === "he" ? he : en);

/**
 * "Connect your AI assistant" — the organizer's way in to the trip's own MCP
 * endpoint (server/trip-mcp). Renders nothing unless the trip turned the
 * endpoint on, so an organizer is never shown an address that does not work.
 */
export function AssistantConnect({ lang }: { lang: Lang }) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["mcp-connection"],
    queryFn: () => api<ConnectionState>("/api/mcp/connection"),
    retry: false,
  });
  const [copied, setCopied] = useState(false);
  const disconnect = useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/mcp/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["mcp-connection"] }),
  });

  const data = state.data;
  if (!data || !data.enabled) return null;

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the address stays visible to copy by hand */
    }
  }
  const when = (iso: string) => new Date(iso).toLocaleDateString(lang === "he" ? "he-IL" : "en-US", { month: "short", day: "numeric" });

  return (
    <div className="assistant-connect">
      <h3>{copy(lang, "Connect your AI assistant", "חיבור עוזר AI")}</h3>
      <p>{copy(lang,
        "Manage this trip from Claude or ChatGPT: add this address as a connector, then sign in with your trip account.",
        "נהלו את הטיול מ-Claude או מ-ChatGPT: הוסיפו את הכתובת הזו כמחבר, ואז התחברו עם חשבון הטיול שלכם.")}</p>
      <div className="assistant-connect-url">
        <code dir="ltr">{data.url}</code>
        <button type="button" onClick={() => copyUrl(data.url)}>
          {copied ? copy(lang, "Copied", "הועתק") : copy(lang, "Copy", "העתקה")}
        </button>
      </div>
      <ol>
        <li>{copy(lang,
          "Claude: Settings → Connectors → Add custom connector, and paste the address.",
          "Claude: הגדרות ← מחברים ← הוספת מחבר מותאם, והדביקו את הכתובת.")}</li>
        <li>{copy(lang,
          "ChatGPT: Settings → Apps & Connectors → Create, paste the address and choose OAuth.",
          "ChatGPT: הגדרות ← אפליקציות ומחברים ← יצירה, הדביקו את הכתובת ובחרו OAuth.")}</li>
        <li>{copy(lang,
          "A page from this site opens. Sign in and allow the connection.",
          "ייפתח דף מהאתר הזה. התחברו ואשרו את החיבור.")}</li>
      </ol>
      {data.connections.length ? (
        <>
          <h4>{copy(lang, "Connected", "מחוברים")}</h4>
          <ul>
            {data.connections.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.client}</strong> <small>{c.host && c.host !== c.client ? `${c.host} · ` : ""}@{c.username} · {copy(lang, "since", "מאז")} {when(c.connected_at)}</small>
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
