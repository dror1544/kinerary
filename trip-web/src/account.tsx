import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, runtimeUrl, tokenStore, type CurrentUser } from "./api";
import {
  tr,
  Section,
  QueryState,
  useAction,
  ActionState,
  type Lang,
} from "./parity-ui";

type GoogleApi = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (r: { credential: string }) => void;
      }) => void;
      renderButton: (
        node: HTMLElement,
        options: Record<string, unknown>,
      ) => void;
    };
  };
};
export const getHealth = () =>
  api<{
    googleClientId: string | null;
    telegramBotUsername: string | null;
    immich: boolean;
  }>("/api/health");
let googleScript: Promise<void> | undefined;
function loadGoogle() {
  if ((window as unknown as { google?: GoogleApi }).google)
    return Promise.resolve();
  return (googleScript ||= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      googleScript = undefined;
      script.remove();
      reject(new Error("Google unavailable"));
    };
    document.head.appendChild(script);
  }));
}
export function GoogleSignIn({
  lang,
  link = false,
  onSuccess,
}: {
  lang: Lang;
  link?: boolean;
  onSuccess: () => void;
}) {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth });
  const mount = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const action = useAction(
    lang,
    ["me"],
    async (idToken: string) => {
      const result = await api<{ token?: string }>(
        link ? "/api/auth/google-link" : "/api/auth/google-login",
        { method: link ? "PUT" : "POST", body: JSON.stringify({ idToken }) },
      );
      if (result.token) tokenStore.set(result.token);
    },
    onSuccess,
  );
  useEffect(() => {
    let active = true;
    if (!health.data?.googleClientId) return;
    void loadGoogle()
      .then(() => {
        if (!active || !mount.current) return;
        const g = (window as unknown as { google: GoogleApi }).google;
        g.accounts.id.initialize({
          client_id: health.data!.googleClientId!,
          callback: (r) => {
            if (active) action.mutate(r.credential);
          },
        });
        g.accounts.id.renderButton(mount.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          locale: lang,
        });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [health.data?.googleClientId, lang]);
  return (
    <>
      <div ref={mount} />
      {failed && (
        <p role="alert">
          {tr(
            lang,
            "Google sign-in is unavailable. Try again later.",
            "הכניסה עם Google אינה זמינה. נסו שוב מאוחר יותר.",
          )}
        </p>
      )}
      <ActionState action={action} lang={lang} />
    </>
  );
}

export async function cropAvatar(
  file: File,
  zoom: number,
  x: number,
  y: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 320;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    const size = Math.min(bitmap.width, bitmap.height) / zoom;
    ctx.drawImage(
      bitmap,
      ((bitmap.width - size) * x) / 100,
      ((bitmap.height - size) * y) / 100,
      size,
      size,
      0,
      0,
      320,
      320,
    );
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Image conversion failed"))),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}
export function Account({
  currentUser,
  lang,
}: {
  currentUser?: CurrentUser;
  lang: Lang;
}) {
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [zoom, setZoom] = useState(1),
    [x, setX] = useState(50),
    [y, setY] = useState(50);
  const [variants, setVariants] = useState<string[]>([]);
  const [cropError, setCropError] = useState(false);
  const user = currentUser as
    | (CurrentUser & { google_email?: string })
    | undefined;
  const updatePassword = useAction(
    lang,
    [],
    () =>
      api("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({ password }),
      }),
    () => {
      setPassword("");
      setConfirmation("");
    },
  );
  const avatar = useAction(
    lang,
    ["me"],
    async () => {
      if (!file) throw new Error("No image");
      const body = new FormData();
      body.append("avatar", await cropAvatar(file, zoom, x, y), "avatar.png");
      body.append("fullPhoto", file);
      return api("/api/auth/avatar/upload", { method: "POST", body });
    },
    () => setFile(null),
  );
  const choose = useAction(lang, ["me"], (avatar_file: string) =>
    api("/api/auth/avatar", {
      method: "PUT",
      body: JSON.stringify({ avatar_file }),
    }),
  );
  const reset = useAction(lang, ["me"], () =>
    api("/api/auth/avatar", { method: "DELETE" }),
  );
  const unlink = useAction(lang, ["me"], () =>
    api("/api/auth/google-link", { method: "DELETE" }),
  );
  useEffect(() => {
    let active = true;
    const name = currentUser?.username;
    if (!name) return;
    const base = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    void Promise.all(
      Array.from({ length: 9 }, (_, i) => `${base}${i ? i + 1 : ""}.png`).map(
        (name) =>
          new Promise<string | null>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(name);
            img.onerror = () => resolve(null);
            img.src = runtimeUrl(`/avatars/${encodeURIComponent(name)}`);
          }),
      ),
    ).then((files) => {
      if (active) setVariants(files.filter((v): v is string => Boolean(v)));
    });
    return () => {
      active = false;
    };
  }, [currentUser?.username]);
  useEffect(() => {
    let active = true,
      url = "";
    setCropError(false);
    if (!file) {
      setPreview("");
      return;
    }
    void cropAvatar(file, zoom, x, y)
      .then((blob) => {
        if (active) {
          url = URL.createObjectURL(blob);
          setPreview(url);
        }
      })
      .catch(() => {
        if (active) {
          setPreview("");
          setCropError(true);
        }
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, zoom, x, y]);
  return (
    <div className="parity-layout">
      <Section title={tr(lang, "Your account", "החשבון שלך")}>
        <p>{currentUser?.name || currentUser?.username}</p>
        <h3>{tr(lang, "Profile picture", "תמונת פרופיל")}</h3>
        <div className="parity-actions">
          {variants.map((name) => (
            <button
              aria-label={name}
              key={name}
              disabled={choose.isPending}
              onClick={() => choose.mutate(name)}
            >
              <img
                width="64"
                height="64"
                src={runtimeUrl(`/avatars/${encodeURIComponent(name)}`)}
                alt=""
              />
            </button>
          ))}
        </div>
        <ActionState action={choose} lang={lang} />
        <label>
          {tr(lang, "Upload a picture", "העלאת תמונה")}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setZoom(1);
              setX(50);
              setY(50);
            }}
          />
        </label>
        {preview && (
          <>
            <div className="avatar-crop-preview">
              <img
                src={preview}
                alt={tr(lang, "Crop preview", "תצוגת חיתוך")}
              />
            </div>
            {[
              [tr(lang, "Zoom", "זום"), zoom, setZoom, 1, 3, 0.1],
              [
                tr(lang, "Horizontal position", "מיקום אופקי"),
                x,
                setX,
                0,
                100,
                1,
              ],
              [tr(lang, "Vertical position", "מיקום אנכי"), y, setY, 0, 100, 1],
            ].map(([label, value, set, min, max, step]) => (
              <label key={String(label)}>
                {String(label)}
                <input
                  type="range"
                  min={Number(min)}
                  max={Number(max)}
                  step={Number(step)}
                  value={Number(value)}
                  onChange={(e) =>
                    (set as (n: number) => void)(Number(e.target.value))
                  }
                />
              </label>
            ))}
            <button disabled={avatar.isPending} onClick={() => avatar.mutate()}>
              {tr(lang, "Save cropped picture", "שמירת תמונה חתוכה")}
            </button>
          </>
        )}
        {cropError && (
          <p role="alert">
            {tr(
              lang,
              "This image could not be decoded. Choose another picture.",
              "לא ניתן לקרוא את התמונה. בחרו תמונה אחרת.",
            )}
          </p>
        )}
        <ActionState action={avatar} lang={lang} />
        <button disabled={reset.isPending} onClick={() => reset.mutate()}>
          {tr(lang, "Use default picture", "שימוש בתמונת ברירת מחדל")}
        </button>
        <ActionState action={reset} lang={lang} />
      </Section>
      <Section title={tr(lang, "Trip password", "סיסמת הטיול")}>
        <p>
          {tr(
            lang,
            "Changes your direct trip login; your portal account stays the same.",
            "משנה את סיסמת הכניסה הישירה לטיול; חשבון הפורטל נשאר ללא שינוי.",
          )}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password === confirmation) updatePassword.mutate();
          }}
        >
          <label>
            {tr(lang, "New password", "סיסמה חדשה")}
            <input
              type="password"
              autoComplete="new-password"
              minLength={4}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            {tr(lang, "Repeat password", "חזרה על הסיסמה")}
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          {confirmation && password !== confirmation && (
            <p role="alert">
              {tr(lang, "Passwords do not match.", "הסיסמאות אינן תואמות.")}
            </p>
          )}
          <button
            disabled={
              updatePassword.isPending ||
              password !== confirmation ||
              password.length < 4
            }
          >
            {tr(lang, "Change password", "שינוי סיסמה")}
          </button>
          <ActionState action={updatePassword} lang={lang} />
        </form>
      </Section>
      <Section title={tr(lang, "Google account", "חשבון Google")}>
        {user?.google_email ? (
          <>
            <p>{user.google_email}</p>
            <button disabled={unlink.isPending} onClick={() => unlink.mutate()}>
              {tr(lang, "Unlink Google", "ניתוק Google")}
            </button>
            <ActionState action={unlink} lang={lang} />
          </>
        ) : (
          <GoogleSignIn lang={lang} link onSuccess={() => {}} />
        )}
      </Section>
    </div>
  );
}

export function Enrollment({ token, lang }: { token: string; lang: Lang }) {
  const [password, setPassword] = useState(""),
    [repeat, setRepeat] = useState("");
  const [username, setUsername] = useState("");
  const action = useAction(lang, [], async () => {
    const result = await api<{ username: string }>("/api/auth/enroll", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    setUsername(result.username);
    setPassword("");
    setRepeat("");
  });
  return (
    <main className="app-content">
      <Section title={tr(lang, "Set your trip password", "הגדרת סיסמה לטיול")}>
        {username ? (
          <>
            <p>
              {tr(
                lang,
                "Your account is ready. Sign in as",
                "החשבון מוכן. היכנסו בשם",
              )}{" "}
              {username}
            </p>
            <a href="#today">{tr(lang, "Sign in", "כניסה")}</a>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (password === repeat) action.mutate();
            }}
          >
            <label>
              {tr(lang, "Password", "סיסמה")}
              <input
                type="password"
                autoComplete="new-password"
                minLength={4}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              {tr(lang, "Repeat password", "חזרה על הסיסמה")}
              <input
                type="password"
                autoComplete="new-password"
                required
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </label>
            <button
              disabled={
                password.length < 4 || password !== repeat || action.isPending
              }
            >
              {tr(lang, "Set password", "הגדרת סיסמה")}
            </button>
            <ActionState action={action} lang={lang} />
          </form>
        )}
      </Section>
    </main>
  );
}
