import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import { api, getMe, getTrip, getTrips, signIn, type TripSummary } from "../api";
import { Brand } from "../components/Brand";

export type ProductView = "sign-in" | "trips" | "new-trip" | "trip" | "runtime" | "join" | "ops";

export default function ProductApp({ view }: { view: ProductView }) {
  if (view === "sign-in") return <SignIn />;
  if (view === "join") return <Join />;
  return <Protected>{view === "trips" ? <Trips /> : view === "new-trip" ? <NewTrip /> : view === "trip" ? <TripSetup /> : view === "runtime" ? <Runtime /> : <Ops />}</Protected>;
}

function SignIn() {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false });
  const returnTo = new URLSearchParams(useLocation().search).get("return_to") || "/trips";
  if (me.data) return <Navigate replace to={returnTo.startsWith("/") ? returnTo : "/trips"} />;
  return (
    <div className="product-shell">
      <header className="product-header"><Brand /></header>
      <main className="placeholder-card">
        <p className="eyebrow">Kinerary personal space</p>
        <h1>Sign in to continue</h1>
        <p>Use Google to create trips, follow setup, and invite the people traveling with you. Telegram is only used for the planning interview.</p>
        <button className="button wide" onClick={() => signIn(returnTo)}>Continue with Google</button>
        {me.isError && <p className="subtle">Your session is not active yet.</p>}
      </main>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false });
  if (me.isPending) return <div className="route-loading">Opening your personal space…</div>;
  if (me.isError) return <Navigate replace to={`/sign-in?return_to=${encodeURIComponent(location.pathname)}`} />;
  return <div className="product-shell"><DashboardHeader name={me.data.displayName} admin={me.data.isProvisioningAdmin} />{children}</div>;
}

function DashboardHeader({ name, admin }: { name: string; admin: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useMutation({ mutationFn: () => api("/v1/logout", { method: "POST" }), onSuccess: async () => { queryClient.clear(); navigate("/"); } });
  return <header className="product-header"><Brand /><nav className="dashboard-nav"><Link to="/trips">My trips</Link>{admin && <Link to="/ops/provisioning">Operations</Link>}<span>{name}</span><button className="text-button" onClick={() => logout.mutate()}>Sign out</button></nav></header>;
}

function Trips() {
  const trips = useQuery({ queryKey: ["trips"], queryFn: getTrips });
  const sections = useMemo(() => {
    const grouped: Record<string, TripSummary[]> = { Setup: [], Provisioning: [], Ready: [], Completed: [] };
    for (const trip of trips.data?.trips || []) {
      if (["completed", "sealed"].includes(trip.lifecycleState)) grouped.Completed.push(trip);
      else if (trip.runtimeReady || ["ready_private", "active"].includes(trip.lifecycleState)) grouped.Ready.push(trip);
      else if (trip.provisioning) grouped.Provisioning.push(trip);
      else grouped.Setup.push(trip);
    }
    return grouped;
  }, [trips.data]);
  return <main className="dashboard-main"><div className="page-title"><div><p className="eyebrow">Personal space</p><h1>My trips</h1></div><Link className="button" to="/trips/new">Plan a new trip</Link></div>{trips.isError && <Notice>We could not load your trips. Please retry.</Notice>}{trips.isPending && <p>Loading trips…</p>}{Object.entries(sections).map(([name, items]) => items.length > 0 && <section className="trip-section" key={name}><h2>{name}</h2><div className="trip-grid">{items.map((trip) => <TripCard key={trip.id} trip={trip} />)}</div></section>)}{trips.data?.trips.length === 0 && <div className="empty-state"><h2>Your first trip starts here.</h2><p>Add the broad outline. The private Telegram interview will help fill in the rest.</p><Link className="button" to="/trips/new">Create a trip</Link></div>}</main>;
}

function TripCard({ trip }: { trip: TripSummary }) {
  const open = trip.runtimeReady ? `/trips/${trip.id}/app` : `/trips/${trip.id}/setup`;
  return <article className="trip-card"><div className="status-chip">{humanize(trip.nextAction)}</div><h3>{trip.title}</h3><p>{trip.destination || "Destination to be confirmed"}</p><small>{[trip.startDate, trip.endDate].filter(Boolean).join(" → ") || "Dates are flexible"}</small><Link className="button button-small" to={open}>{trip.runtimeReady ? "Open trip" : humanize(trip.nextAction)}</Link></article>;
}

const tripSchema = z.object({ destination: z.string().trim().min(2, "Add a destination").max(160), startDate: z.string().optional(), endDate: z.string().optional(), tripType: z.enum(["family", "group", "couple", "other"]) }).refine((value) => !value.startDate || !value.endDate || value.endDate >= value.startDate, { message: "End date must follow the start date", path: ["endDate"] });
type TripForm = z.infer<typeof tripSchema>;

function NewTrip() {
  const navigate = useNavigate();
  const stored = JSON.parse(sessionStorage.getItem("kinerary-trip-starter") || "{}") as Partial<TripForm>;
  const form = useForm<TripForm>({ resolver: zodResolver(tripSchema), defaultValues: { destination: stored.destination || "", startDate: stored.startDate || "", endDate: stored.endDate || "", tripType: stored.tripType || "family" } });
  useEffect(() => { const subscription = form.watch((value) => sessionStorage.setItem("kinerary-trip-starter", JSON.stringify(value))); return () => subscription.unsubscribe(); }, [form]);
  const create = useMutation({ mutationFn: (values: TripForm) => api<TripSummary>("/v1/trips", { method: "POST", body: JSON.stringify(values) }), onSuccess: (trip) => { sessionStorage.removeItem("kinerary-trip-starter"); navigate(`/trips/${trip.id}/setup`); } });
  return <main className="dashboard-main narrow"><Link className="back-link" to="/trips">← My trips</Link><p className="eyebrow">New trip</p><h1>Start with the outline</h1><p className="lede">Nothing needs to be final. Your interview will confirm or correct these details.</p><form className="form-card" onSubmit={form.handleSubmit((values) => create.mutate(values))}><label>Destination<input {...form.register("destination")} placeholder="e.g. Northern Italy" />{form.formState.errors.destination && <small className="field-error">{form.formState.errors.destination.message}</small>}</label><div className="field-row"><label>Approximate start<input type="date" {...form.register("startDate")} /></label><label>Approximate end<input type="date" {...form.register("endDate")} />{form.formState.errors.endDate && <small className="field-error">{form.formState.errors.endDate.message}</small>}</label></div><label>Who is traveling?<select {...form.register("tripType")}><option value="family">Family</option><option value="couple">Couple</option><option value="group">Group</option><option value="other">Other</option></select></label>{create.isError && <Notice>{create.error.message}</Notice>}<button className="button" disabled={create.isPending}>{create.isPending ? "Creating…" : "Create trip"}</button></form></main>;
}

function TripSetup() {
  const { tripId = "" } = useParams();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["trip", tripId], queryFn: () => getTrip(tripId), refetchInterval: 5000 });
  const interview = useMutation({ mutationFn: () => api<{ deepLink: string }>(`/v1/trips/${tripId}/interview-link`, { method: "POST" }), onSuccess: ({ deepLink }) => window.open(deepLink, "_blank", "noopener,noreferrer") });
  const provision = useMutation({ mutationFn: () => api(`/v1/trips/${tripId}/provisioning-request`, { method: "POST" }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["trip", tripId] }) });
  if (detail.isPending) return <main className="dashboard-main">Loading trip…</main>;
  if (detail.isError) return <main className="dashboard-main"><Notice>Trip not found or unavailable.</Notice></main>;
  const trip = detail.data;
  return <main className="dashboard-main"><Link className="back-link" to="/trips">← My trips</Link><div className="page-title"><div><p className="eyebrow">Trip setup</p><h1>{trip.title}</h1><p>{trip.destination}</p></div>{trip.runtimeReady && <Link className="button" to={`/trips/${trip.id}/app`}>Open trip</Link>}</div><div className="setup-layout"><section className="workflow-card"><h2>Setup progress</h2><WorkflowStep done={Boolean(trip.interview)} title="Start your private planning interview" detail={trip.interview ? `Interview ${humanize(trip.interview.state)}` : "Continue in the shared Kinerary Telegram bot."}><button className="button button-small" onClick={() => interview.mutate()} disabled={interview.isPending}>Open Telegram interview</button></WorkflowStep><WorkflowStep done={trip.lifecycleState !== "draft" && trip.lifecycleState !== "intake_in_progress"} title="Confirm the trip outline" detail="The normalized summary becomes available here after confirmation." /><WorkflowStep done={Boolean(trip.provisioning)} title="Request provisioning" detail={trip.provisioning ? humanize(trip.provisioning.reviewState || trip.provisioning.jobState || trip.provisioning.planStatus) : "An operations administrator reviews the immutable plan before work begins."}>{trip.nextAction === "request_provisioning" && <button className="button button-small" onClick={() => provision.mutate()} disabled={provision.isPending}>Request provisioning</button>}</WorkflowStep>{trip.provisioning?.safeErrorCode && <Notice>Setup needs attention: {humanize(trip.provisioning.safeErrorCode)}</Notice>}{(interview.isError || provision.isError) && <Notice>{(interview.error || provision.error)?.message}</Notice>}</section><InvitePanel trip={trip} /></div></main>;
}

function WorkflowStep({ done, title, detail, children }: { done: boolean; title: string; detail: string; children?: React.ReactNode }) {
  return <div className="workflow-step"><span className={done ? "step-dot done" : "step-dot"}>{done ? "✓" : ""}</span><div><h3>{title}</h3><p>{detail}</p>{children}</div></div>;
}

function InvitePanel({ trip }: { trip: TripSummary }) {
  const queryClient = useQueryClient();
  const [joinUrl, setJoinUrl] = useState("");
  const form = useForm<{ displayName: string; runtimeUsername: string }>({ defaultValues: { displayName: "", runtimeUsername: "" } });
  const create = useMutation({ mutationFn: (values: { displayName: string; runtimeUsername: string }) => api<{ joinUrl: string }>(`/v1/trips/${trip.id}/site-invites`, { method: "POST", body: JSON.stringify(values) }), onSuccess: ({ joinUrl: value }) => { setJoinUrl(value); form.reset(); queryClient.invalidateQueries({ queryKey: ["trip", trip.id] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/v1/trips/${trip.id}/site-invites/${id}`, { method: "DELETE" }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["trip", trip.id] }) });
  if (!trip.permissions.invite) return null;
  return <aside className="workflow-card"><h2>Site invitations</h2><p>Each private link is for one person and can be used once.</p><form className="compact-form" onSubmit={form.handleSubmit((value) => create.mutate(value))}><label>Name<input required {...form.register("displayName")} /></label><label>Trip username<input required pattern="[a-z0-9][a-z0-9._-]{1,63}" {...form.register("runtimeUsername")} /></label><button className="button button-small">Create invite</button></form>{joinUrl && <div className="share-box"><strong>Copy this link now</strong><input readOnly value={joinUrl} /><div className="share-actions"><button onClick={() => navigator.clipboard.writeText(joinUrl)}>Copy</button>{navigator.share && <button onClick={() => navigator.share({ title: trip.title, url: joinUrl })}>Share</button>}<a href={`mailto:?subject=${encodeURIComponent(`Join ${trip.title}`)}&body=${encodeURIComponent(joinUrl)}`}>Email</a><a href={`https://t.me/share/url?url=${encodeURIComponent(joinUrl)}`} target="_blank" rel="noreferrer">Telegram</a></div></div>}<ul className="invite-list">{trip.invites?.map((invite) => <li key={invite.id}><div><strong>{invite.displayName}</strong><small>{invite.runtimeUsername} · {humanize(invite.status)}</small></div>{invite.status === "unused" && <button className="text-button" onClick={() => revoke.mutate(invite.id)}>Revoke</button>}</li>)}</ul></aside>;
}

function Runtime() {
  const { tripId = "" } = useParams();
  const iframe = useRef<HTMLIFrameElement>(null);
  const [launch, setLaunch] = useState<{ runtimeOrigin: string; framePath: string; launchToken: string }>();
  const grant = useMutation({ mutationFn: () => api<{ runtimeOrigin: string; framePath: string; launchToken: string }>(`/v1/trips/${tripId}/launch`, { method: "POST" }), onSuccess: setLaunch });
  useEffect(() => { grant.mutate(); }, [tripId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!launch) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== launch.runtimeOrigin || event.source !== iframe.current?.contentWindow || event.data?.type !== "kinerary:runtime-ready") return;
      iframe.current.contentWindow?.postMessage({ type: "kinerary:launch", token: launch.launchToken }, launch.runtimeOrigin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [launch]);
  return <main className="runtime-shell"><div className="runtime-bar"><Link to={`/trips/${tripId}/setup`}>← Trip setup</Link><strong>Kinerary trip</strong><span /></div>{grant.isPending && <div className="route-loading">Opening your trip…</div>}{grant.isError && <div className="route-loading">This trip is not ready to open.</div>}{launch && <iframe ref={iframe} title="Kinerary trip" src={`${launch.runtimeOrigin}${launch.framePath}`} sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts allow-downloads" allow="clipboard-write" />}</main>;
}

function Join() {
  const navigate = useNavigate();
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  const inspect = useQuery({ queryKey: ["invite", token], queryFn: () => api<{ tripTitle: string; displayName: string; status: string }>("/v1/site-invites/inspect", { method: "POST", body: JSON.stringify({ token }) }), enabled: Boolean(token), retry: false });
  const [method, setMethod] = useState<"google" | "password">("google");
  const [password, setPassword] = useState("");
  const redeem = useMutation({ mutationFn: () => api<{ appPath: string }>("/v1/site-invites/redeem", { method: "POST", body: JSON.stringify({ token, method, ...(method === "password" ? { password } : {}) }) }), onSuccess: ({ appPath }) => navigate(appPath), onError: (error) => { if (method === "google" && error.message.includes("GOOGLE_SIGN_IN_REQUIRED")) signIn(`/join#token=${token}`); } });
  return <div className="product-shell"><header className="product-header"><Brand /></header><main className="placeholder-card"><p className="eyebrow">Private invitation</p>{!token || inspect.isError ? <><h1>This invitation is unavailable</h1><p>Ask the organizer for a fresh link.</p></> : inspect.isPending ? <p>Checking invitation…</p> : <><h1>Join {inspect.data.tripTitle}</h1><p>This invitation is intended for {inspect.data.displayName}.</p><div className="method-tabs"><button className={method === "google" ? "active" : ""} onClick={() => setMethod("google")}>Use Google</button><button className={method === "password" ? "active" : ""} onClick={() => setMethod("password")}>Use a password</button></div>{method === "password" && <label className="standalone-field">Choose a password<input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></label>}<button className="button wide" onClick={() => redeem.mutate()} disabled={redeem.isPending || inspect.data.status !== "unused"}>Join this trip</button>{redeem.isError && <Notice>{redeem.error.message}</Notice>}</>}</main></div>;
}

type OpsRequest = { planId: string; tripId: string; title: string; digest: string; releaseId: string; requestedResources: Array<{ logical_type: string; isolation_tier: string }>; createdAt: string };
function Ops() {
  const queryClient = useQueryClient();
  const requests = useQuery({ queryKey: ["ops"], queryFn: () => api<{ requests: OpsRequest[] }>("/v1/ops/provisioning-requests") });
  const decide = useMutation({ mutationFn: ({ planId, action }: { planId: string; action: "approve" | "reject" }) => api(`/v1/ops/provisioning-requests/${planId}/${action}`, { method: "POST", body: action === "reject" ? JSON.stringify({ reasonCode: "OPERATIONS_REJECTED" }) : undefined }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ops"] }) });
  return <main className="dashboard-main"><p className="eyebrow">Operations</p><h1>Provisioning requests</h1><p className="lede">Only the exact immutable plan digest shown here can be released.</p>{requests.isError && <Notice>Administrator access is required.</Notice>}<div className="ops-list">{requests.data?.requests.map((request) => <article className="workflow-card" key={request.planId}><div><small>{request.releaseId}</small><h2>{request.title}</h2><p>{request.requestedResources.map((resource) => `${humanize(resource.logical_type)} · ${humanize(resource.isolation_tier)}`).join(", ")}</p><code>{request.digest}</code></div><div className="ops-actions"><button className="button button-small" onClick={() => decide.mutate({ planId: request.planId, action: "approve" })}>Approve and queue</button><button className="button button-small button-quiet" onClick={() => decide.mutate({ planId: request.planId, action: "reject" })}>Reject</button></div></article>)}</div>{requests.data?.requests.length === 0 && <div className="empty-state"><h2>The queue is clear.</h2></div>}</main>;
}

function Notice({ children }: { children: React.ReactNode }) { return <div className="notice" role="alert">{children}</div>; }
function humanize(value: string) { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
