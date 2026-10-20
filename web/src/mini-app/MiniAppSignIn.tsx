import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useLocation, useNavigate } from "react-router-dom";
import { getMe, passwordSignIn, safeReturnTo, telegramMiniAppSignIn, type MiniAppSignInResult, type MiniAppTrip } from "../api";
import { digestInitData, launchMarker } from "./launch";
import { isEmbedded, openedByTelegram, readLaunch, stripLaunchFragment, type MiniLaunch, type MiniSdk } from "./sdk";
import { tripUsernameInputProps, tripUsernameRegisterOptions } from "./username";

type View =
  | { name: "checking" }
  /** Signed in; waiting for the router to be on `appPath` so the wrong trip's view never mounts first. */
  | { name: "opening"; appPath: string }
  | { name: "open" }
  | { name: "unsupported" }
  | { name: "choose"; trips: MiniAppTrip[]; notice: boolean }
  | { name: "password"; tripId: string }
  | { name: "message"; kind: "no_trip" | "invalid" | "limited" };

const messages: Record<"no_trip" | "invalid" | "limited", { title: string; body: string }> = {
  no_trip: {
    title: "Your Telegram account isn't linked to a trip yet",
    body: "Open Kinerary from your trip's chat in Telegram, or ask the organizer for an invitation to the trip.",
  },
  invalid: {
    title: "We couldn't verify this Telegram launch",
    body: "Close this window and open Kinerary from Telegram again.",
  },
  limited: {
    title: "Too many attempts",
    body: "Please wait a minute, then close this window and open Kinerary from Telegram again.",
  },
};

/**
 * Signs a person in with the identity Telegram verified for this launch, and
 * decides what they see until that is settled.
 *
 * The SERVER does all of the deciding (POST /v1/auth/telegram-mini-app); this
 * component only sends the signed string it was handed and renders the answer:
 * a session (go where it says), a chooser, "not linked" (the trip-password form,
 * but only when the launch named a trip), or a refusal. Outside Telegram — no
 * launch parameters — it is a pass-through, and an ordinary browser keeps the
 * ordinary sign-in page. So does a deployment that has the feature switched off.
 */
export default function MiniAppSignIn({ sdk, settled, children }: { sdk: MiniSdk | null; settled: boolean; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [telegram] = useState(openedByTelegram);
  const [view, setView] = useState<View>(telegram ? { name: "checking" } : { name: "open" });
  const [banner, setBanner] = useState<string | null>(null);
  const launch = useRef<MiniLaunch | null>(null);
  const started = useRef(false);
  const path = useRef(location.pathname);
  path.current = location.pathname;

  // Whatever the exchange concluded, the page's cached data belonged to whoever
  // held the WebView before: drop it.
  const settle = async (result: MiniAppSignInResult, digest: string | null) => {
    queryClient.clear();
    if (result.kind === "session") {
      // Inside Telegram Web the session is a partitioned cross-site cookie. Some
      // browsers (Safari, a Chrome with third-party cookies blocked) refuse it
      // without saying so, and a sign-in that cannot be read back would leave
      // the person on a blank page. Ask once, and say so if it did not stick.
      if (isEmbedded(launch.current?.platform ?? null)) {
        try { await getMe(); } catch { launchMarker.clear(); setView({ name: "unsupported" }); return; }
      }
      if (digest) launchMarker.write(digest);
      if (result.notice) setBanner("That trip isn't available to your account. Here is what is.");
      // The launch fragment goes with it until the SDK has read it (stripLaunchFragment, below).
      if (result.appPath !== path.current) {
        navigate({ pathname: result.appPath, hash: window.location.hash }, { replace: true });
        setView({ name: "opening", appPath: result.appPath });
      } else setView({ name: "open" });
    } else if (result.kind === "choose") {
      launchMarker.clear();
      setView({ name: "choose", trips: result.trips, notice: result.notice === "TRIP_UNAVAILABLE" });
    } else if (result.kind === "not_linked") {
      launchMarker.clear();
      setView(result.fallback === "trip_password" && result.tripId ? { name: "password", tripId: result.tripId } : { name: "message", kind: "no_trip" });
    } else if (result.kind === "invalid") {
      launchMarker.clear();
      setView({ name: "message", kind: "invalid" });
    } else if (result.kind === "limited") {
      setView({ name: "message", kind: "limited" });
    } else {
      // Feature off, wrong origin or no network: the page behaves as it did before Telegram sign-in existed.
      setView({ name: "open" });
    }
  };

  useEffect(() => {
    if (!telegram || started.current) return;
    const found = readLaunch(sdk);
    // The SDK may still be about to supply the string (a reload after the URL fragment was stripped).
    if (!found.initData && !settled) return;
    started.current = true;
    launch.current = found;
    (async () => {
      if (!found.initData) { setView({ name: "message", kind: "invalid" }); return; }
      const digest = await digestInitData(found.initData);
      // A reload of a launch that already signed in: the cookie session is still
      // good, so the launch string is not sent again (it has a cap).
      if (launchMarker.read() === digest) {
        try { await getMe(); setView({ name: "open" }); return; } catch { launchMarker.clear(); }
      }
      await settle(await telegramMiniAppSignIn({ initData: found.initData, embedded: isEmbedded(found.platform) }), digest);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telegram, sdk, settled]);

  useEffect(() => {
    if (view.name === "opening" && location.pathname === view.appPath) setView({ name: "open" });
  }, [view, location.pathname]);

  // Once the SDK has had its chance to read the launch fragment, take it out of the address bar.
  useEffect(() => { if (telegram && settled) stripLaunchFragment(); }, [telegram, settled]);

  const choose = async (tripId: string) => {
    const found = launch.current;
    if (!found?.initData) return;
    setView({ name: "checking" });
    await settle(await telegramMiniAppSignIn({ initData: found.initData, tripId, embedded: isEmbedded(found.platform) }), await digestInitData(found.initData));
  };

  const shell = (title: string, body: ReactNode) => (
    <main className="mini-app-unavailable" data-testid="mini-app-sign-in">
      <p className="eyebrow">Kinerary</p>
      <h1>{title}</h1>
      {body}
    </main>
  );

  if (view.name === "checking" || view.name === "opening") return shell("Signing you in…", <p role="status">Checking your Telegram account.</p>);
  if (view.name === "unsupported") {
    return shell("Open Kinerary in the Telegram app", <p>Your browser didn't keep the sign-in inside Telegram Web — it blocks cookies from sites opened in another site's frame. Open this chat in the Telegram app on your phone or desktop, or allow third-party cookies for web.telegram.org and try again.</p>);
  }
  if (view.name === "message") return shell(messages[view.kind].title, <p>{messages[view.kind].body}</p>);
  if (view.name === "choose") {
    return shell("Choose a trip", <>
      {view.notice && <p role="status">That trip isn't available to your account. Choose one of yours.</p>}
      <ul className="mini-app-trip-choices">
        {view.trips.map((trip) => (
          <li key={trip.tripId}>
            <button className="button wide" onClick={() => void choose(trip.tripId)}>{trip.title}{trip.destination ? ` — ${trip.destination}` : ""}</button>
          </li>
        ))}
      </ul>
    </>);
  }
  if (view.name === "password") {
    return shell("Sign in to this trip", <TripPasswordForm
      tripId={view.tripId}
      initData={launch.current?.initData ?? null}
      platform={launch.current?.platform ?? null}
      onSignedIn={(appPath, note) => {
        queryClient.clear();
        if (launch.current?.initData) void digestInitData(launch.current.initData).then(launchMarker.write);
        if (note) setBanner(note);
        const target = safeReturnTo(appPath);
        if (target !== path.current) {
          navigate({ pathname: target, hash: window.location.hash }, { replace: true });
          setView({ name: "opening", appPath: target });
        } else setView({ name: "open" });
      }}
    />);
  }
  return <>{banner && <p className="notice" role="status">{banner}</p>}{children}</>;
}

function TripPasswordForm({ tripId, initData, platform, onSignedIn }: { tripId: string; initData: string | null; platform: string | null; onSignedIn: (appPath: string, note: string | null) => void }) {
  const form = useForm<{ runtimeUsername: string; password: string; remember: boolean }>({ defaultValues: { runtimeUsername: "", password: "", remember: false } });
  const returnTo = `/mini-app/trips/${tripId}`;
  const signIn = useMutation({
    mutationFn: (values: { runtimeUsername: string; password: string; remember: boolean }) => passwordSignIn({
      tripId, returnTo, runtimeUsername: values.runtimeUsername, password: values.password,
      ...(isEmbedded(platform) ? { embedded: true as const } : {}),
      // The consent flag travels WITH the credential, in this one request, or not at all.
      ...(values.remember && initData ? { telegramLink: { initData, consent: true as const } } : {}),
    }),
    onSuccess: (result, values) => onSignedIn(
      result.appPath,
      values.remember && result.telegramLink !== "linked"
        ? "You're signed in, but Telegram wasn't linked this time. Close and reopen Kinerary from Telegram, then sign in again to link it."
        : null,
    ),
  });
  return (
    <form className="compact-form" onSubmit={form.handleSubmit((values) => signIn.mutate(values))}>
      <p>Use the username and password you chose for this trip.</p>
      <label>Trip username<input {...tripUsernameInputProps} {...form.register("runtimeUsername", tripUsernameRegisterOptions)} /></label>
      <label>Password<input required minLength={8} type="password" autoComplete="current-password" {...form.register("password")} /></label>
      <label className="checkbox-row"><input type="checkbox" {...form.register("remember")} /> Next time, open with Telegram</label>
      <p className="subtle">Links this Telegram account to your trip sign-in. You can remove it later from that trip's Telegram menu (the three dots) on My trips.</p>
      <button className="button wide" disabled={signIn.isPending}>{signIn.isPending ? "Signing in…" : "Continue with trip password"}</button>
      {signIn.isError && <div className="notice" role="alert">{signIn.error.message}</div>}
    </form>
  );
}
