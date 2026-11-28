import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import {
  ApiError, connectImmich, disconnectPhotoConnection, getMe, getPhotoConnections, setDefaultPhotoConnection, testPhotoConnection,
  type PhotoConnection,
} from "../api";
import { formatDay } from "./dates";

const QUERY_KEY = ["photo-connections"];
const NOT_CONFIGURED = "photo_library_not_configured";
/** The permission the server checks a key for first (control-plane/api/src/photo-library.ts), named when the answer names none. */
const CHECKED_PERMISSION = "album.read";

/**
 * One plain sentence per answer, for a traveller rather than an operator. The server's own `message` is never shown: a
 * code it sends that is not here gets the general sentence. `field` says which address was refused; `permission` which
 * permission a key lacks (api.ts checks both for shape before they get here).
 */
function sentenceFor(code: string, detail: { permission?: string; field?: string } = {}): string {
  switch (code) {
    case "invalid_address":
      return detail.field === "publicUrl"
        ? "Enter the public address in full, starting with https://, or leave it empty."
        : "Enter the full address, starting with https:// (for example https://photos.example.com).";
    case "address_not_allowed": return "This address is on a private network this service cannot reach. Use the address Immich has on the internet.";
    case "not_immich": return "There is no Immich at this address. Use the address you open Immich at in your browser.";
    case "unreachable": return "Immich could not be reached at this address. Check that it is online, then try again.";
    case "timeout": return "Immich took too long to answer. Try again in a minute.";
    case "response_too_large": return "The server at this address answered with more than Immich sends. Check the address.";
    case "redirect_refused": return "This address sends visitors on to another address. Enter the address Immich itself opens at.";
    case "invalid_key": return "Immich did not accept this key. Make a new key in Immich and paste it here.";
    case "key_lacks_permission": {
      const permission = detail.permission || CHECKED_PERMISSION;
      return `This key is missing the permission ${permission}. Make a new key in Immich with ${permission} allowed and paste it here.`;
    }
    case "invalid_request": return "Paste the API key Immich gave you.";
    case "NOT_FOUND": return "This connection is no longer there. The list has been refreshed.";
    case "credential_unreadable": case "credential_key_invalid": case "credential_key_unresolved": case "credential_key_rotated":
      return "Kinerary can no longer read the key it kept for this library. Reconnect it with a new key.";
    case "not_supported": return "This library cannot be tested yet.";
    case "ACCOUNT_SIGN_IN_REQUIRED": return "Sign in with your password to do this.";
    case "RATE_LIMITED": return "Too many requests. Please wait a minute and try again.";
    default: return "Something went wrong. Please try again.";
  }
}

const sentenceOf = (error: unknown) => error instanceof ApiError ? sentenceFor(error.code, error.detail) : sentenceFor("");
const notConfigured = (error: unknown) => error instanceof ApiError && error.code === NOT_CONFIGURED;
const serviceName = (connection: PhotoConnection) => connection.service === "immich" ? "Immich" : "Google Photos";

type PhotoService = PhotoConnection["service"];

/**
 * The service's own mark in its own colours, as Telegram and WhatsApp get theirs (chat-service.tsx, #690). Simplified
 * pinwheels in each service's palette, not the trademark artwork: Immich's five petals, Google Photos' four.
 */
function PhotoServiceMark({ service, size = 22 }: { service: PhotoService; size?: number }) {
  const petals = service === "immich"
    ? ["#fa2921", "#ed79b5", "#ffb400", "#1e83f7", "#18c249"]
    : ["#ea4335", "#4285f4", "#34a853", "#fbbc04"];
  return (
    <svg className={`photo-mark photo-mark-${service}`} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {petals.map((fill, index) => (
        <ellipse key={fill} cx="12" cy="6.2" rx="3.6" ry="5.2" fill={fill} fillOpacity="0.92" transform={`rotate(${(360 / petals.length) * index} 12 12)`} />
      ))}
    </svg>
  );
}

/**
 * "Photo library" on the dashboard, for the signed-in account (#699, docs/specs/sprint-9/699-user-photo-library.md):
 * connect Immich, see each connection's state, test it, choose the default and disconnect. The account's own; a session a
 * Telegram link minted is told to sign in with its password and asks the server nothing, and the Mini App does not show it.
 * A deployment with no photo library set up (503 `photo_library_not_configured`, from the list or a connect) shows nothing
 * at all, as the WhatsApp section does when the deployment has no number (Dror, 2026-11-27, regression plan decision 1).
 * Nothing is drawn until the list has answered, so such a deployment never shows the heading for a moment either.
 *
 * The Immich key is read from its field at the moment of sending and the field emptied at once, whatever the answer. It is
 * never kept in React state, a query cache, a mutation's variables, storage or a URL, and no answer carries it back.
 */
export function PhotoLibrary() {
  const inMiniApp = useLocation().pathname.startsWith("/mini-app");
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false });
  const scoped = me.data?.scope === "telegram";
  const list = useQuery({ queryKey: QUERY_KEY, queryFn: getPhotoConnections, retry: false, enabled: me.isSuccess && !scoped && !inMiniApp });
  const [lostConfig, setLostConfig] = useState(false);
  // An id, looked up in the live list: a connection disconnected while its form was open takes the form with it.
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  // The Immich connect form is its own step: a service's button opens it, so a person is asked only what that service needs.
  const [addingImmich, setAddingImmich] = useState(false);
  if (inMiniApp || !me.isSuccess) return null;
  const unavailable = lostConfig || notConfigured(list.error);
  if (!scoped && (list.isPending || unavailable)) return null;
  const connections = list.data ?? [];
  const immich = connections.find((connection) => connection.service === "immich");
  const many = connections.length > 1;
  const reconnecting = connections.find((connection) => connection.id === reconnectingId) ?? null;
  const showForm = list.isSuccess && ((addingImmich && !immich) || reconnecting !== null);
  return (
    <section className="trip-section photo-library">
      <h2>Photo library</h2>
      <div className="workflow-card photo-library-card">
        {scoped ? <p>Signed in with Telegram: to connect a photo library, sign in with your password.</p>
          : <>
            <p>
              Connect your own photo library and Kinerary adds your trips' photos to an album in it, with each photo's story
              written on it: its caption, the moment it belongs to, who took it, and where and when. Kinerary never deletes
              anything in your library, not even a photo later removed from a trip, and it can create a share link for an album
              so the family can open it.
            </p>
            {/* A load that failed by itself is a status, not an alert: the alert is kept for an answer to something the person did. */}
            {list.isError && <div className="notice" role="status">We could not load your photo libraries. Please retry.</div>}
            {!showForm && list.isSuccess && connections.length === 0 && <p className="subtle">No photo library is connected yet.</p>}
            {!showForm && connections.length > 0 && (
              <ul className="photo-connections">
                {connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id} connection={connection} many={many}
                    onReconnect={() => setReconnectingId(connection.id)} onUnavailable={() => setLostConfig(true)}
                  />
                ))}
              </ul>
            )}
            {showForm && (
              <ImmichForm
                key={reconnecting?.id ?? "new"} reconnect={reconnecting}
                onDone={() => { setReconnectingId(null); setAddingImmich(false); }} onUnavailable={() => setLostConfig(true)}
              />
            )}
            {!showForm && list.isSuccess && (
              <div className="photo-services">
                {!immich && (
                  <div className="photo-service-tile photo-service-immich">
                    <PhotoServiceMark service="immich" size={28} />
                    <div><strong>Immich</strong><small>Your own Immich server. You paste its address and a key you make in Immich.</small></div>
                    <button type="button" className="button button-small photo-connect" onClick={() => setAddingImmich(true)}>Connect Immich</button>
                  </div>
                )}
                {!connections.some((connection) => connection.service === "google_photos") && (
                  <div className="photo-service-tile photo-service-google_photos">
                    <PhotoServiceMark service="google_photos" size={28} />
                    <div><strong>Google Photos</strong><small>Coming soon: you will sign in on Google's own page and choose to let Kinerary add photos.</small></div>
                    <button type="button" className="button button-small photo-connect" disabled>Connect Google Photos</button>
                  </div>
                )}
              </div>
            )}
          </>}
      </div>
    </section>
  );
}

function ImmichForm({ reconnect, onDone, onUnavailable }: { reconnect: PhotoConnection | null; onDone: () => void; onUnavailable: () => void }) {
  const queryClient = useQueryClient();
  const keyField = useRef<HTMLInputElement>(null);
  const [serverUrl, setServerUrl] = useState(reconnect?.serverUrl ?? "");
  const [publicUrl, setPublicUrl] = useState(reconnect?.publicUrl ?? "");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !keyField.current) return;
    // The key goes from the field into the request body and nowhere else; the field is emptied before the answer comes.
    // Trimmed: a key pasted with a trailing space or line break is still the key (Immich keys hold no spaces).
    const apiKey = keyField.current.value.trim();
    keyField.current.value = "";
    setPending(true);
    setProblem("");
    try {
      const address = publicUrl.trim();
      await connectImmich({ serverUrl: serverUrl.trim(), apiKey, ...(address ? { publicUrl: address } : {}) });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      onDone();
    } catch (error) {
      if (notConfigured(error)) { onUnavailable(); return; }
      if (error instanceof ApiError && error.code === "NOT_FOUND") void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setProblem(sentenceOf(error));
    } finally {
      if (keyField.current) keyField.current.value = "";
      setPending(false);
    }
  };
  const label = reconnect ? "Reconnect Immich" : "Connect Immich";
  return (
    <form className="compact-form photo-library-form photo-service-immich" onSubmit={submit} autoComplete="off">
      <h3 className="photo-service-title"><PhotoServiceMark service="immich" size={20} />{label}</h3>
      <div className="photo-explain">
        <p>Kinerary needs two things from your Immich:</p>
        <ol>
          <li><strong>The address</strong> you open Immich at in your browser, starting with https://. It has to be reachable from the internet, not only from your home network.</li>
          <li><strong>An API key.</strong> In Immich open Account Settings, then API Keys, choose New API Key, name it Kinerary, allow the album permissions, and copy the key.</li>
        </ol>
        <p>Kinerary keeps the key encrypted, never shows it again, and only adds photos and albums: it never deletes anything.</p>
      </div>
      <label>Server address
        <input type="text" inputMode="url" dir="ltr" required spellCheck={false} autoComplete="off" placeholder="https://photos.example.com"
          value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
      </label>
      <label>API key
        <input ref={keyField} type="password" dir="ltr" required spellCheck={false} autoComplete="off" defaultValue="" />
      </label>
      <label>Public address (optional)
        <input type="text" inputMode="url" dir="ltr" spellCheck={false} autoComplete="off" placeholder="https://share.example.com"
          value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} />
      </label>
      <small className="subtle">Only if the family opens your Immich at a different address. Share links use it.</small>
      {problem && <p className="notice" role="alert">{problem}</p>}
      <div className="button-row">
        <button className="button button-small photo-connect" disabled={pending}>{pending ? "Checking with Immich…" : label}</button>
        <button type="button" className="text-button" onClick={onDone} disabled={pending}>{reconnect ? "Cancel" : "Back"}</button>
      </div>
    </form>
  );
}

function ConnectionRow({ connection, many, onReconnect, onUnavailable }: {
  connection: PhotoConnection; many: boolean; onReconnect: () => void; onUnavailable: () => void;
}) {
  const queryClient = useQueryClient();
  const [verdict, setVerdict] = useState("");
  const [confirming, setConfirming] = useState(false);
  const failed = (error: unknown) => {
    if (notConfigured(error)) onUnavailable();
    else if (error instanceof ApiError && error.code === "NOT_FOUND") void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  };
  const replace = (next: PhotoConnection) =>
    queryClient.setQueryData<PhotoConnection[]>(QUERY_KEY, (old) => old?.map((entry) => entry.id === next.id ? next : entry));
  const test = useMutation({
    mutationFn: () => testPhotoConnection(connection.id),
    onMutate: () => setVerdict(""),
    onSuccess: ({ connection: next, check }) => {
      replace(next);
      setVerdict(check.ok ? "Immich answered and accepted the key." : sentenceFor(check.error, { permission: check.permission }));
    },
    onError: failed,
  });
  const makeDefault = useMutation({
    mutationFn: () => setDefaultPhotoConnection(connection.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: failed,
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectPhotoConnection(connection.id),
    onSuccess: (remaining) => { setConfirming(false); queryClient.setQueryData(QUERY_KEY, remaining); },
    onError: failed,
  });
  const error = test.error ?? makeDefault.error ?? disconnect.error;
  const needsReconnect = connection.state === "needs_reconnect";
  const busy = test.isPending || makeDefault.isPending || disconnect.isPending;
  return (
    <li className={`photo-connection photo-service-${connection.service}`}>
      <div className="photo-connection-head">
        <PhotoServiceMark service={connection.service} />
        <strong>{serviceName(connection)}</strong>
        {many && connection.isDefault && <span className="status-chip">Default</span>}
      </div>
      {connection.serverUrl && <bdi dir="ltr" className="photo-address">{connection.serverUrl}</bdi>}
      {needsReconnect
        ? <p className="photo-state photo-state-reconnect">Needs reconnecting: the library no longer accepts the key Kinerary has. Photos are kept on the trip site until you reconnect.</p>
        : <p className="photo-state"><span>Connected</span></p>}
      {connection.lastCheckedAt && <small className="subtle">Last checked {formatDay(connection.lastCheckedAt)}</small>}
      {!needsReconnect && connection.lastErrorCode && <small className="subtle">The last check failed: {sentenceFor(connection.lastErrorCode)}</small>}
      {verdict && <p className="subtle" role="status">{verdict}</p>}
      {Boolean(error) && !notConfigured(error) && <p className="notice" role="alert">{sentenceOf(error)}</p>}
      {confirming
        ? <div className="telegram-confirm" role="group" aria-label="Confirm disconnect">
          <small>Disconnect {serviceName(connection)}? Kinerary deletes the key it keeps for it, and your trips stop copying photos to it. Nothing in your library is touched.</small>
          <span>
            <button type="button" className="text-button" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Confirm disconnect</button>
            <button type="button" className="text-button" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        </div>
        : <div className="button-row photo-actions">
          {needsReconnect && connection.service === "immich" && <button type="button" className="button button-small photo-connect" onClick={onReconnect}>Reconnect</button>}
          {connection.service === "immich" && <button type="button" className="text-button" onClick={() => test.mutate()} disabled={busy}>Test connection</button>}
          {many && !connection.isDefault && <button type="button" className="text-button" onClick={() => makeDefault.mutate()} disabled={busy}>Make default</button>}
          <button type="button" className="text-button" onClick={() => { disconnect.reset(); setConfirming(true); }} disabled={busy}>Disconnect</button>
        </div>}
    </li>
  );
}
