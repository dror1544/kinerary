// The trip's organizer-set site settings (GET/PATCH /api/settings), read by everyone and changed only by an
// organizer: the navigation app every Go chip opens, and the group line's switch (group-line.tsx shares the key).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { normalizeNavApp, type NavApp } from "./nav-links";

export type TripSettings = { group_change_line?: boolean; nav_app?: string };

export const SETTINGS_KEY = ["trip-settings"] as const;

/**
 * The trip's navigation app. Unknown (not yet loaded, or the site could not say) is Google Maps, which is also
 * the default: a Go chip must always have somewhere to go.
 */
export function useNavApp(): NavApp {
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<TripSettings>("/api/settings"), staleTime: 60_000 });
  return normalizeNavApp(settings.data?.nav_app);
}

// "Navigation app: Google Maps | Waze", shown in the Plan tools module to an organizer. The server is the
// boundary that matters: PATCH /api/settings refuses a member.
export function NavAppSetting({ lang }: { lang: "en" | "he" }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<TripSettings>("/api/settings") });
  const save = useMutation({
    mutationFn: (app: NavApp) => api<TripSettings>("/api/settings", { method: "PATCH", body: JSON.stringify({ nav_app: app }) }),
    onSuccess: (stored) => queryClient.setQueryData(SETTINGS_KEY, stored),
  });
  // Until the site has answered, the setting is unknown, and an unknown setting shows no control.
  if (!settings.data) return null;
  const current = normalizeNavApp(settings.data.nav_app);
  const label = lang === "he" ? "אפליקציית ניווט" : "Navigation app";
  return (
    <div className="nav-app-setting">
      <label>
        <span>{label}</span>
        <select value={current} disabled={save.isPending} onChange={(event) => save.mutate(normalizeNavApp(event.target.value))}>
          <option value="google">Google Maps</option>
          <option value="waze">Waze</option>
        </select>
      </label>
      <small>{lang === "he" ? "כפתור הניווט בכל הטיול ייפתח באפליקציה שנבחרה." : "Every Go button on the trip opens this app."}</small>
      {save.isError ? <p role="alert">{lang === "he" ? "השמירה נכשלה. נסו שוב." : "Could not save. Please try again."}</p> : null}
    </div>
  );
}
