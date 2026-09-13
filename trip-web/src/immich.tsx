import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type TripConfig } from "./api";
import { getHealth } from "./account";
import {
  tr,
  bi,
  Section,
  External,
  useAction,
  ActionState,
  type Lang,
} from "./parity-ui";
export function ImmichAlbum({
  config,
  lang,
}: {
  config?: TripConfig;
  lang: Lang;
}) {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const [phase, setPhase] = useState(
    config?.phases?.[0]?.short_id || config?.phases?.[0]?.id || "",
  );
  useEffect(() => {
    if (!phase && config?.phases?.length)
      setPhase(config.phases[0].short_id || config.phases[0].id);
  }, [config, phase]);
  const [files, setFiles] = useState<File[]>([]),
    [link, setLink] = useState("");
  const share = useAction(lang, [], async () => {
    const result = await api<{ url: string }>(
      `/api/album-share/${encodeURIComponent(phase)}`,
    );
    setLink(result.url);
  });
  const upload = useAction(lang, [], async () => {
    const body = new FormData();
    body.set("phase", phase);
    files.forEach((f) => body.append("files", f));
    const result = await api<{ results: Array<{ name: string; ok: boolean }> }>(
      "/api/upload",
      { method: "POST", body },
    );
    const failed = result.results.filter((r) => !r.ok);
    setFiles(files.filter((f) => failed.some((r) => r.name === f.name)));
    if (failed.length) throw new Error("Some files failed");
  });
  if (!health.data?.immich) return null;
  return (
    <Section title={tr(lang, "Connected photo album", "אלבום תמונות מחובר")}>
      <label>
        {tr(lang, "Album", "אלבום")}
        <select
          value={phase}
          onChange={(e) => {
            setPhase(e.target.value);
            setLink("");
          }}
          disabled={share.isPending || upload.isPending}
        >
          {config?.phases?.map((p) => (
            <option value={p.short_id || p.id} key={p.id}>
              {bi(p.title, lang) || p.id}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!phase || share.isPending}
        onClick={() => share.mutate()}
      >
        {tr(lang, "Open album link", "פתיחת קישור לאלבום")}
      </button>
      <ActionState action={share} lang={lang} />
      <External url={link}>
        {tr(lang, "View shared album", "צפייה באלבום המשותף")}
      </External>
      <label>
        {tr(lang, "Upload to connected album", "העלאה לאלבום המחובר")}
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files || []))}
          disabled={upload.isPending}
        />
      </label>
      <p>
        {files.length} {tr(lang, "files pending", "קבצים ממתינים")}
      </p>
      <button
        disabled={!files.length || upload.isPending}
        onClick={() => upload.mutate()}
      >
        {tr(lang, "Upload pending files", "העלאת הקבצים הממתינים")}
      </button>
      <ActionState action={upload} lang={lang} />
    </Section>
  );
}
