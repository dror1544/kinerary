// "Trip photos from the chat" — the organizer's two choices about photos and moments that start in the trip's group
// (docs/specs/sprint-9/x-trip-photos-and-moments.md, Part A). Both live on the trip site (trip_settings: group_photo_autosave,
// moment_capture_mode) and are read by the relay and the companion; this is only where the organizer sets them.
//
//   - "Save photos posted in the group": on by default, shown while the trip's switch `chat_photos_to_album` is on;
//   - "New trip moments": Ask in the chat / Save as a draft for organizers / Publish straight away, default Ask in the chat,
//     shown while `trip_moments_capture` is on.
//
// Shown by the Organizer settings page only to an organizer. The server is the boundary that matters: PATCH /api/settings
// refuses a member, and an unknown mode is a 400. An unknown stored mode shows as the most restrictive one (organizer_draft),
// like the server reads it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { SETTINGS_KEY, type TripSettings as Settings } from "./trip-settings";

export const MOMENT_MODES = ["ask_in_chat", "organizer_draft", "publish"] as const;
export type MomentMode = (typeof MOMENT_MODES)[number];

export function normalizeMomentMode(value: unknown): MomentMode {
  return MOMENT_MODES.find((mode) => mode === value) ?? "organizer_draft";
}

const LABELS: Record<MomentMode, { en: string; he: string }> = {
  ask_in_chat: { en: "Ask in the chat", he: "לשאול בצ'אט" },
  organizer_draft: { en: "Save as a draft for organizers", he: "לשמור כטיוטה למארגנים" },
  publish: { en: "Publish straight away", he: "לפרסם מיד" },
};

export function ChatPhotosSettings({ lang, autosaveOn, momentsOn }: { lang: "en" | "he"; autosaveOn: boolean; momentsOn: boolean }) {
  const he = lang === "he";
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<Settings>("/api/settings") });
  const save = useMutation({
    mutationFn: (body: { group_photo_autosave?: boolean; moment_capture_mode?: MomentMode }) =>
      api<Settings>("/api/settings", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (stored) => queryClient.setQueryData(SETTINGS_KEY, stored),
  });
  // Until the site has answered, the settings are unknown, and unknown settings show no control.
  if (!settings.data || (!autosaveOn && !momentsOn)) return null;
  const autosave = settings.data.group_photo_autosave;
  return (
    <div className="chat-photos-settings">
      {autosaveOn && typeof autosave === "boolean" ? (
        <div className="group-line-toggle">
          <label>
            <input
              type="checkbox"
              role="switch"
              checked={autosave}
              disabled={save.isPending}
              onChange={(event) => save.mutate({ group_photo_autosave: event.target.checked })}
            />
            <span>{he ? "לשמור תמונות שמפורסמות בקבוצה" : "Save photos posted in the group"}</span>
          </label>
          <small>{he ? "התמונות נשמרות באלבום הטיול על שם מי ששלח אותן." : "They go to the trip album under the name of whoever sent them."}</small>
        </div>
      ) : null}
      {momentsOn ? (
        <div className="nav-app-setting">
          <label>
            <span>{he ? "רגעי טיול חדשים" : "New trip moments"}</span>
            <select
              value={normalizeMomentMode(settings.data.moment_capture_mode)}
              disabled={save.isPending}
              onChange={(event) => save.mutate({ moment_capture_mode: normalizeMomentMode(event.target.value) })}
            >
              {MOMENT_MODES.map((mode) => <option key={mode} value={mode}>{LABELS[mode][lang]}</option>)}
            </select>
          </label>
          <small>{he ? "מה קורה לרגע שהעוזר מנסח מתמונות ומהשיחה." : "What happens to a moment the assistant drafts from photos and the chat."}</small>
        </div>
      ) : null}
      {save.isError ? <p role="alert">{he ? "השמירה נכשלה. נסו שוב." : "Could not save. Please try again."}</p> : null}
    </div>
  );
}
