// "Tell the group when the plan changes" — the organizer's one toggle (video Release 1C,
// docs/specs/sprint-9/x-video-r1-group-line.md). It is a shortcut: the organizer can say the same to the
// companion in their own chat. The setting lives on the trip site (trip_settings.group_change_line), is on by
// default, and the control plane reads it before it sends anything.
//
// Shown by MoreView only to an organizer, and only while the trip's switch `plan_change_group_line` is on
// (featureOn). The server is the boundary that matters: PATCH /api/settings refuses a member.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { SETTINGS_KEY, type TripSettings as Settings } from "./trip-settings";

export function GroupLineToggle({ lang }: { lang: "en" | "he" }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<Settings>("/api/settings") });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api<Settings>("/api/settings", { method: "PATCH", body: JSON.stringify({ group_change_line: enabled }) }),
    onSuccess: (stored) => queryClient.setQueryData(SETTINGS_KEY, stored),
  });
  // Until the site has answered, the state is unknown, and an unknown state shows no control.
  if (typeof settings.data?.group_change_line !== "boolean") return null;
  const label = lang === "he" ? "לעדכן את הקבוצה כשהתוכנית משתנה" : "Tell the group when the plan changes";
  return (
    <div className="group-line-toggle">
      <label>
        <input
          type="checkbox"
          role="switch"
          checked={settings.data.group_change_line}
          disabled={save.isPending}
          onChange={(event) => save.mutate(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {save.isError ? <p role="alert">{lang === "he" ? "השמירה נכשלה. נסו שוב." : "Could not save. Please try again."}</p> : null}
    </div>
  );
}
