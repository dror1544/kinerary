import { CompanionPanel } from "./CompanionPanel";
import { VenueLinks } from "./venue-links";
import { safeExternalUrl } from "./external-url";
import { dashboardHref } from "./dashboard-link";
export { safeExternalUrl } from "./external-url";
import { MobileSelect } from "./MobileSelect";
import { BOOKING_TYPES, bookingTypeLabel, ITEM_TYPES, itemTypeLabel } from "./item-types";
import { collapseSameFlight, sameFlightGroups } from "./same-flight";
import { rsvpForItem, venueForItem } from "./activity-rsvp";
import { datesInPhase, phaseDates as mergePhaseDates } from "./phase-calendar";
export { datesInPhase } from "./phase-calendar";
import { ImmichAlbum } from "./immich";
import { Readiness, CurrencyConverter } from "./readiness";
import { TripAnchorsCard } from "./trip-anchors";
import { GroupActivities, LostFound, ActivityRsvp, VenueFeedback } from "./group-utilities";
import { Account, GoogleSignIn, Enrollment } from "./account";
import { PlanTools } from "./plan-tools";
import { lodgingName, tonightLodging } from "./stops";
import { AssistantConnect } from "./assistant-connect";
import { Trivia } from "./trivia";
import { heroCandidates, useHeroPhoto } from "./hero-photo";
import { useTripUpdates, useLiveEditGuard } from "./live-updates";
import { featureOn } from "./features";
import { GroupLineToggle } from "./group-line";
import { ChatPhotosSettings } from "./chat-photos";
import { hasGoChip, mapUrlFor, navUrlFor, wazeUrlFor } from "./nav-links";
import { useNavApp } from "./trip-settings";
import { WeatherFlightsCard } from "./today-cards";
import { heroIntroSeen, markHeroIntroSeen, prefersReducedMotion, useHeroScroll } from "./hero-scroll";
import { ChangeBadge, ChangeTime, UpdatedForEveryone, changeClass, changeOf, movedFromLabel, useFreshChanges, weekdayName } from "./recent-change";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Star,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  DollarSign,
  Compass,
  ExternalLink,
  GalleryHorizontalEnd,
  Globe2,
  Home,
  LogOut,
  Map,
  MapPin,
  Menu,
  MessageCircle,
  Navigation,
  Pencil,
  Plane,
  Plus,
  RefreshCw,
  Route,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import brandLogo from "./assets/brand/logo.svg";
import brandMark from "./assets/brand/mark.svg";
import {
  ActiveItinerary,
  Booking,
  BudgetItem,
  CurrentUser,
  answerBookingSeed,
  answerItemSeed,
  keepBothPlanItems,
  approveBookingDraft,
  createBooking,
  createBudgetItem,
  deleteBooking,
  deleteBudgetItem,
  deletePhoto,
  createItineraryItem,
  deleteItineraryItem,
  setItineraryItemDay,
  ItineraryDay,
  ItineraryItem,
  ItineraryItemInput,
  TodayContext,
  TripConfig,
  createMoment,
  extractBookingDetails,
  getAuthenticatedDocument,
  getBookings,
  getBudget,
  getConfig,
  getFlightStatus,
  getHermes,
  getItinerary,
  getMe,
  getMoments,
  publishMoment,
  type Moment,
  getPhotoComments,
  getPhotoReactions,
  getPhotos,
  getToday,
  getUiSettings,
  type UiSettings,
  getLoginRoster,
  resetParticipantPassword,
  login,
  postPhotoComment,
  runtimeUrl,
  tokenStore,
  UNAUTHORIZED_EVENT,
  togglePhotoReaction,
  updateBooking,
  updateBudgetItem,
  updateItineraryItem,
  uploadBookingAppleWallet,
  uploadBookingConfirmation,
  uploadPhoto,
} from "./api";

type Tab = "today" | "journey" | "moments" | "more";
type Module = "bookings" | "map" | "budget" | "photos" | "readiness" | "account" | "activities" | "lostfound" | "trivia" | "plan-tools" | "companion" | "organizer-settings";
type Lang = "he" | "en";
type BookingFilter = "phase" | "today" | "current" | "flight" | "hotel" | "attraction";
type ItineraryTimeMode = "exact" | "rough" | "none";

const roughTimes = ["morning", "noon", "afternoon", "evening"] as const;
const photoReactionEmojis = ["❤️", "😂", "🔥", "👏", "😮"] as const;

const tabIcons = {
  today: Home,
  journey: Compass,
  moments: Camera,
  more: Menu,
};

// The video layout is the only layout (owner, 2026-11-21: the classic one "is now stale"), so there is no switch for it.
// The one switch left from the video release is the change marks (docs/specs/sprint-9/x-video-r1-site-look.md):
// unknown = off, and with it off the server serves no `recent_change` and the page draws nothing.
export function changeMarksOn(config?: TripConfig) { return featureOn(config, "plan_change_marks"); }

type VideoTab = "today" | "plan" | "bookings" | "photos";
const videoTabs: Array<{ id: VideoTab; en: string; he: string; icon: typeof Home }> = [
  { id: "today", en: "Today", he: "היום", icon: Home },
  { id: "plan", en: "Plan", he: "תוכנית", icon: Compass },
  { id: "bookings", en: "Bookings", he: "הזמנות", icon: TicketCheck },
  { id: "photos", en: "Photos", he: "תמונות", icon: Camera },
];

function text(value: unknown, lang: Lang) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const record = value as Record<string, string | undefined>;
  return record[lang] || record.en || record.he || "";
}

function dateLabel(date: string, lang: Lang) {
  const value = new Date(`${date}T12:00:00`);
  return value.toLocaleDateString(lang === "he" ? "he-IL" : "en-US", { weekday: "short", month: "short", day: "numeric" });
}

function daySelectorSubtitle(day: { label_he?: string | null; label_en?: string | null; phase_id: string }, lang: Lang) {
  const raw = (lang === "he" ? day.label_he || day.label_en : day.label_en || day.label_he) || day.phase_id;
  // The date is already the button title. Prefer the descriptive part after a
  // date-divider, then remove any remaining date token for compact day chips.
  const afterDivider = raw.split(/[—–]/).map((part) => part.trim()).filter(Boolean).at(-1) || raw;
  const compact = afterDivider
    .replace(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b\.?/gi, "")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g, "")
    .replace(/^\s*[-–—·,:]+|\s*[-–—·,:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return compact.length > 46 ? `${compact.slice(0, 45).trimEnd()}…` : compact || day.phase_id;
}

function copy(lang: Lang, en: string, he: string) {
  return lang === "he" ? he : en;
}

function itineraryTimeLabel(value: string | null | undefined, lang: Lang) {
  if (!value) return copy(lang, "Anytime", "בכל שעה");
  const labels: Record<(typeof roughTimes)[number], [string, string]> = {
    morning: ["Morning", "בוקר"],
    noon: ["Noon", "צהריים"],
    afternoon: ["Afternoon", "אחר הצהריים"],
    evening: ["Evening", "ערב"],
  };
  const label = labels[value as keyof typeof labels];
  return label ? (lang === "he" ? label[1] : label[0]) : value;
}

function phaseLabel(phase: string, lang: Lang) {
  const labels: Record<string, [string, string]> = {
    pre_trip: ["Getting ready", "מתארגנים לקראת הטיול"],
    flight_day: ["Flight day", "יום טיסה"],
    active_day: ["On the road", "בדרך"],
    transfer_day: ["Transfer day", "יום מעבר"],
    post_trip: ["Memory mode", "זמן לזיכרונות"],
  };
  const label = labels[phase] || ["Today", "היום"];
  return lang === "he" ? label[1] : label[0];
}

const moduleShortcuts: Array<{ id: Module; en: string; he: string }> = [
  { id: "bookings", en: "Bookings", he: "הזמנות" },
  { id: "map", en: "Map", he: "מפה" },
  { id: "budget", en: "Budget", he: "תקציב" },
  { id: "photos", en: "Photos", he: "תמונות" },
  { id: "readiness", en: "Readiness", he: "הכנות ומידע" },
  { id: "account", en: "Account", he: "חשבון" },
  { id: "activities", en: "Group activities", he: "פעילויות קבוצתיות" },
  { id: "lostfound", en: "Lost & Found", he: "אבידות ומציאות" },
  { id: "trivia", en: "Trivia", he: "טריוויה" },
  { id: "plan-tools", en: "Plan tools", he: "כלי מסלול" },
];

// The trip conversation is a page of its own in the video layout (it used to sit on Today): a module with a hash,
// listed in the header menu. It is not in `moduleShortcuts` because that list feeds the current layout's lists too.
const companionShortcut: { id: Module; en: string; he: string } = { id: "companion", en: "Trip conversation", he: "השיחה של הטיול" };
// The organizer's page of the video layout (#612): the controls that sat under More's "Appearance". Not in `moduleShortcuts`
// for the same reason as the conversation; the menu lists it for organizers only.
const organizerSettingsShortcut: { id: Module; en: string; he: string } = { id: "organizer-settings", en: "Organizer settings", he: "הגדרות מארגן" };

function moduleLabel(module: Module, lang: Lang) {
  const shortcut = [...moduleShortcuts, companionShortcut, organizerSettingsShortcut].find((item) => item.id === module);
  return shortcut ? shortcut[lang] : module;
}

function isTab(value: string): value is Tab {
  return Object.keys(tabIcons).includes(value);
}

function isModule(value: string): value is Module {
  return moduleShortcuts.some((shortcut) => shortcut.id === value) || value === companionShortcut.id || value === organizerSettingsShortcut.id;
}

export function preferredLang(): Lang {
  const stored = localStorage.getItem("tripLang");
  if (stored === "he" || stored === "en") return stored;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((language) => language?.toLowerCase().startsWith("he") || language?.toLowerCase().startsWith("iw")) ? "he" : "en";
}

function botDisplayName(config?: TripConfig, hermesName?: string, lang: Lang = "en") {
  const configured = (lang === "en" ? config?.agent?.name_en : config?.agent?.name) || config?.agent?.name;
  const statusName = hermesName && hermesName.toLowerCase() !== "hermes" ? hermesName : "";
  return configured || statusName || "Trip companion";
}

function telegramUrl(username?: string | null, message?: string) {
  if (!username) return "";
  const handle = username.replace("@", "");
  return `https://t.me/${handle}${message ? `?text=${encodeURIComponent(message)}` : ""}`;
}

function itemTitle(item: ItineraryItem, lang: Lang) {
  return lang === "he" ? item.text_he || item.text_en || "" : item.text_en || item.text_he || "";
}

function safeFileUrl(path: string, file?: string | null) {
  if (!file) return "";
  return runtimeUrl(`${path}/${encodeURIComponent(file)}`);
}

function defaultAvatarFile(username: string) {
  const normalized = username.toLowerCase();
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}.png`;
}

export function avatarUrl(username: string, avatarFile?: string | null, googlePicture?: string | null) {
  if (!avatarFile && googlePicture) {
    const external = safeExternalUrl(googlePicture);
    if (external) return external;
  }
  const file = avatarFile && /^[A-Za-z0-9._-]+$/.test(avatarFile) ? avatarFile : defaultAvatarFile(username);
  return runtimeUrl(`/avatars/${encodeURIComponent(file)}`);
}

function personName(person: Pick<CurrentUser, "username" | "name" | "name_en">, lang: Lang) {
  return lang === "he"
    ? person.name || person.name_en || person.username
    : person.name_en || person.name || person.username;
}

export function PersonAvatar({
  username,
  name,
  color,
  avatarFile,
  googlePicture,
  size = "regular",
}: {
  username: string;
  name: string;
  color?: string | null;
  avatarFile?: string | null;
  googlePicture?: string | null;
  size?: "small" | "regular";
}) {
  const [failed, setFailed] = useState(false);
  const source = avatarUrl(username, avatarFile, googlePicture);
  const initial = name.trim().charAt(0).toUpperCase() || username.charAt(0).toUpperCase();
  if (failed) return <span className={`person-avatar ${size} avatar-initial`} style={{ backgroundColor: color || "var(--kit-teal)" }} aria-label={name}>{initial}</span>;
  return <img className={`person-avatar ${size}`} src={source} alt="" onError={() => setFailed(true)} />;
}


function tripLogoUrl(value?: string) {
  if (!value) return null;
  if (value.startsWith("/")) return runtimeUrl(value);
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The logo the header shows (docs/specs/sprint-9/x-trip-logo.md): the one the site resolved (`ui.logo.url`: an
 * organizer's upload, else the trip file's logo), then a `meta.logo` that is itself an address (an https URL or a
 * /path, which is all the header ever read it as), then the Kinerary mark.
 */
export function headerLogoSource(settings: Pick<UiSettings, "logo"> | undefined, configLogo?: string) {
  if (settings?.logo?.url) return runtimeUrl(settings.logo.url);
  return tripLogoUrl(configLogo) || brandMark;
}

/**
 * The sign-in page draws before any session, so it asks the public logo route directly and falls back to the
 * Kinerary mark when the trip has none (404) or the image does not load.
 */
export function LoginLogo() {
  const [failed, setFailed] = useState(false);
  if (failed) return <img className="login-logo" src={brandLogo} alt="Kinerary" />;
  return <img className="login-logo is-trip-logo" src={runtimeUrl("/api/trip/logo")} alt="" onError={() => setFailed(true)} />;
}

function extraLinkLabel(link: NonNullable<ItineraryItem["extra_links"]>[number], lang: Lang) {
  return text(link.label, lang) || text(link.title, lang) || text(link.name, lang) || "Extra";
}

export function classicHrefForLocation(path: string, hostname: string, port: string) {
  if (!import.meta.env.DEV) return path;
  const devPreview = ["4185", "4186"].includes(port) && ["127.0.0.1", "localhost"].includes(hostname);
  return devPreview ? `http://127.0.0.1:3000${path}` : path;
}

export function classicHref() {
  return classicHrefForLocation(runtimeUrl("/classic.html"), window.location.hostname, window.location.port);
}

function todayPhaseId(config?: TripConfig, itinerary?: ActiveItinerary, today?: Awaited<ReturnType<typeof getToday>>) {
  if (!today || today.phase === "pre_trip" || today.phase === "post_trip") return "";
  const direct = today.current?.phase_id || today.next?.phase_id;
  if (direct) return direct;
  const dayPhase = itinerary?.days.find((day) => day.date === today.today)?.phase_id;
  if (dayPhase) return dayPhase;
  return config?.phases?.find((phase) => phase.start && phase.end && phase.start <= today.today && phase.end >= today.today)?.id || "";
}

function LoginScreen() {
  const lang = preferredLang();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // The roster is public and the usernames are derived, not chosen — so the
  // names go on screen and the field gets filled by tapping one. A trip whose
  // roster cannot be read still gets the plain form, which is what this was.
  const [roster, setRoster] = useState<{ username: string; name?: string; name_en?: string }[]>([]);
  useEffect(() => {
    let live = true;
    getLoginRoster()
      .then((people) => { if (live) setRoster(people); })
      .catch(() => { /* the typed field still works */ });
    return () => { live = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await login(username.trim(), password);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-label="Sign in">
        <LoginLogo />
        <h1>{copy(lang,"Open your trip","כניסה לטיול")}</h1>
        <p>{copy(lang,"Sign in to see your trip.","היכנסו לצפייה בטיול שלכם.")}</p>
        {roster.length > 0 ? (
          <div className="login-roster" aria-label={copy(lang,"Who are you?","מי אתם?")}>
            {roster.map((person) => (
              <button
                key={person.username}
                type="button"
                className={person.username === username ? "login-chip is-selected" : "login-chip"}
                aria-pressed={person.username === username}
                onClick={() => setUsername(person.username)}
              >
                {personName(person, lang)}
              </button>
            ))}
          </div>
        ) : null}

        <form onSubmit={submit}>
          <label>
            {copy(lang,"Username","שם משתמש")}
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label>
            {copy(lang,"Password","סיסמה")}
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-action" type="submit">{copy(lang,"Sign in","כניסה")}</button>
        </form>
        <GoogleSignIn lang={lang} onSuccess={()=>window.location.reload()}/>
        <a href="#lostfound">{copy(lang,"Found something belonging to this group?","מצאתם חפץ של הקבוצה?")}</a>
      </section>
    </main>
  );
}

function TimelineItem({
  item,
  compact = false,
  rsvpId,
  venueId,
  username,
  lang = "en",
  botName,
  telegramUsername,
  marks = false,
  fresh = false,
  destination = "",
}: {
  item: ItineraryItem;
  compact?: boolean;
  rsvpId?: string;
  venueId?: string;
  username?: string;
  lang?: Lang;
  botName?: string;
  telegramUsername?: string | null;
  /** plan_change_marks: the Updated / New treatment. */
  marks?: boolean;
  /** The marker arrived while this page was open: play the short highlight. */
  fresh?: boolean;
  destination?: string;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [rsvpOpen, setRsvpOpen] = useState(false);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [visitedPanels, setVisitedPanels] = useState({ rating: false, rsvp: false });
  const ratingButton = useRef<HTMLButtonElement>(null);
  const rsvpButton = useRef<HTMLButtonElement>(null);
  const Icon = item.item_type === "travel" || item.booking?.type === "flight" ? Plane : item.item_type === "meal" ? TicketCheck : MapPin;
  const title = itemTitle(item, lang);
  const confirmationUrl = safeFileUrl("/api/bookings/confirmation", item.booking?.conf_file);
  const appleWalletUrl = safeFileUrl("/api/bookings/wallet-apple", item.booking?.pkpass_file);
  const ticketUrl = safeExternalUrl(item.ticket_url);
  const websiteUrl = safeExternalUrl(item.website_url);
  const googleWalletUrl = safeExternalUrl(item.booking?.google_wallet_url);
  const itemAppleWalletUrl = safeExternalUrl(item.booking?.apple_wallet_url) || appleWalletUrl;
  const askUrl = telegramUrl(telegramUsername, `${botName || "Trip companion"}, question about this plan: ${title}`);
  const extraLinks = (item.extra_links || []).map((link) => ({
    label: extraLinkLabel(link, lang),
    url: safeExternalUrl(link.url || link.href),
  })).filter((link) => link.url);

  // A Go chip, a Booked tick, and the original-plan provenance in the item's detail (1A); the change marks (1B) when on.
  const change = marks ? changeOf(item) : undefined;
  const moved = movedFromLabel(change, lang);
  const previousTime = change?.fields.includes("time") && change.previous_time ? itineraryTimeLabel(change.previous_time, lang) : null;
  const provenanceLabel = item.provenance?.status === "updated_from_original" ? copy(lang, "Updated from original", "עודכן מהתוכנית המקורית")
    : item.provenance?.status === "added" ? copy(lang, "Added", "נוסף") : "";
  const hasDetail = Boolean(provenanceLabel);
  return (
    <article className={`timeline-item ${compact ? "compact" : ""}${changeClass(change)}${fresh ? " is-fresh" : ""}${hasDetail ? " has-detail" : ""}`}
      onClick={hasDetail ? (event) => {
        // The whole row is the control (no arrow, no separate button), but a tap on anything interactive inside it
        // (Go, Rate, RSVP, a link, the title button itself) does that thing and does not also toggle the detail.
        if ((event.target as HTMLElement).closest("a, button, input, select, textarea, label, [role='button']")) return;
        setDetailOpen((open) => !open);
      } : undefined}>
      <div className="time-rail">
        {change ? <ChangeTime time={itineraryTimeLabel(item.time, lang)} previous={previousTime} /> : <span>{itineraryTimeLabel(item.time, lang)}</span>}
        <i />
      </div>
      <div className="item-body">
        <div className="item-kicker">
          <Icon size={16} />
          <span>{itemTypeLabel(item.item_type, lang)}</span>
          <ChangeBadge change={change} lang={lang} />
          {moved ? <small className="moved-from">{moved}</small> : null}
          {item.booking ? <small className="booked-tick"><CheckCircle2 size={13} /> {copy(lang, "Booked", "הוזמן")}</small> : null}
        </div>
        <h3>{hasDetail
          ? <button className="item-title-toggle" type="button" aria-expanded={detailOpen} onClick={() => setDetailOpen((open) => !open)}>{title}</button>
          : title}</h3>
        <div className="item-meta">
          {item.booking?.confirmation ? <span><CheckCircle2 size={14} /> {copy(lang, "Confirmation stored", "אישור שמור")}</span> : null}
          {item.confirmation_state && item.confirmation_state !== "verified" ? <span><AlertTriangle size={14} /> {copy(lang, "Needs review", "נדרשת בדיקה")}</span> : null}
        </div>
        {hasGoChip(item) ? (
          <div className="item-go-bar">
            <GoChip item={item} title={title} destination={destination} lang={lang} />
          </div>
        ) : null}
        {detailOpen ? (
          <div className="item-detail">
            {provenanceLabel ? <b className="provenance-note">{provenanceLabel}</b> : null}
          </div>
        ) : null}
        <div className="item-actions" aria-label={`Actions for ${title}`}>
          {venueId && <button className="item-action" type="button" aria-expanded={ratingOpen} aria-controls={`rating-${item.item_uid}`} ref={ratingButton} onClick={() => { setVisitedPanels(p => ({ ...p, rating: true })); setRatingOpen(open => !open); }}><Star size={15} />{ratingOpen ? copy(lang, "Hide rating", "סגירת הדירוג") : copy(lang, "Rate", "דירוג")}</button>}
          {rsvpId && <button className="item-action" type="button" aria-expanded={rsvpOpen} aria-controls={`rsvp-${item.item_uid}`} ref={rsvpButton} onClick={() => { setVisitedPanels(p => ({ ...p, rsvp: true })); setRsvpOpen(open => !open); }}><CheckCircle2 size={15} />{rsvpOpen ? copy(lang, "Hide RSVP", "סגירת ההשתתפות") : copy(lang, "RSVP", "אישור השתתפות")}</button>}
          {confirmationUrl ? <AuthenticatedDocumentAction url={confirmationUrl} filename={item.booking?.conf_file || "confirmation.pdf"} label={<><ShieldCheck size={15} /> {copy(lang, "Confirmation", "אישור")}</>} /> : null}
          {confirmationUrl ? <AuthenticatedDocumentAction url={confirmationUrl} filename={item.booking?.conf_file || "confirmation.pdf"} download label={<><Download size={15} /> {copy(lang, "Download", "הורדה")}</>} /> : null}
          {ticketUrl ? <a className="item-action" href={ticketUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> {copy(lang, "Tickets", "כרטיסים")}</a> : null}
          {websiteUrl ? <a className="item-action" href={websiteUrl} target="_blank" rel="noreferrer"><Globe2 size={15} /> {copy(lang, "Site", "אתר")}</a> : null}
          {googleWalletUrl ? <a className="item-action" href={googleWalletUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Google Wallet</a> : null}
          {itemAppleWalletUrl ? (item.booking?.pkpass_file ? <AuthenticatedDocumentAction url={appleWalletUrl} filename={item.booking.pkpass_file} download label={<><TicketCheck size={15} /> Apple Wallet</>} /> : <a className="item-action" href={itemAppleWalletUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Apple Wallet</a>) : null}
          {extraLinks.map((link) => <a key={`${link.label}-${link.url}`} className="item-action" href={link.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {link.label}</a>)}
          {askUrl ? <a className="item-action companion" href={askUrl} target="_blank" rel="noreferrer"><MessageCircle size={15} /> {copy(lang, "Ask", "שאלו")}</a> : null}
        </div>
        {venueId && visitedPanels.rating && <section hidden={!ratingOpen} className="parity-panel" id={`rating-${item.item_uid}`} aria-label={copy(lang, "Activity rating and comments", "דירוג ותגובות לפעילות")}><button className="activity-panel-collapse" type="button" aria-label={copy(lang, "Collapse rating", "סגירת הדירוג")} onClick={() => { setRatingOpen(false); ratingButton.current?.focus(); }}><X size={16} /></button><VenueFeedback key={venueId} id={venueId} username={username} lang={lang} /></section>}
        {rsvpId && visitedPanels.rsvp && <section hidden={!rsvpOpen} className="parity-panel activity-rsvp-panel" id={`rsvp-${item.item_uid}`} aria-label={copy(lang, "Activity RSVP", "השתתפות בפעילות")}><button className="activity-panel-collapse" type="button" aria-label={copy(lang, "Collapse RSVP", "סגירת ההשתתפות")} onClick={() => { setRsvpOpen(false); rsvpButton.current?.focus(); }}><X size={16} /></button><ActivityRsvp key={rsvpId} id={rsvpId} lang={lang} /></section>}
      </div>
    </article>
  );
}

type JourneyFocus = {
  phaseId: string;
  date?: string;
  itemUid?: string;
};

export function TripClockPanel({
  config,
  itinerary,
  today,
  next,
  lang,
  board = false,
}: {
  config?: TripConfig;
  itinerary?: ActiveItinerary;
  today?: Awaited<ReturnType<typeof getToday>>;
  next?: ItineraryItem | null;
  lang: Lang;
  /** Video layout: the trip's announcement board. Folded to one line unless the companion has a message for today. */
  board?: boolean;
}) {
  const todaysMessage = (today?.companion_message?.date === today?.today && today?.companion_message?.[lang]) || "";
  const [boardOpen, setBoardOpen] = useState<boolean | null>(null);
  const expanded = !board || (boardOpen ?? Boolean(todaysMessage));
  const activePhaseId = next?.phase_id || today?.current?.phase_id || today?.next?.phase_id || "";
  const phase = config?.phases?.find((entry) => entry.id === activePhaseId)
    || config?.phases?.find((entry) => today?.today && entry.start && entry.end && entry.start <= today.today && entry.end >= today.today);
  const phaseDays = itinerary?.days.filter((day) => !phase?.id || day.phase_id === phase.id) || [];
  const phaseDayIndex = today?.today ? phaseDays.findIndex((day) => day.date === today.today) + 1 : 0;
  const totalIndex = today?.today ? (itinerary?.days.findIndex((day) => day.date === today.today) ?? -1) + 1 : 0;
  const totalDays = itinerary?.days.length || 0;
  const label = today ? phaseLabel(today.phase, lang) : copy(lang, "Trip clock", "שעון הטיול");
  const destination = phase ? text(phase.title, lang) || phase.id : config?.meta?.destination || config?.meta?.title || copy(lang, "the journey", "הטיול");

  const headline = today?.phase === "pre_trip" && today.countdown_days != null
    ? copy(lang, `${Math.max(today.countdown_days, 0)} days until the adventure starts`, `נותרו ${Math.max(today.countdown_days, 0)} ימים עד תחילת ההרפתקה`)
    : phaseDayIndex > 0
      ? copy(lang, `Day ${phaseDayIndex} in ${destination}`, `יום ${phaseDayIndex} ב${destination}`)
      : copy(lang, `Now tracking ${destination}`, `עוקבים עכשיו אחרי ${destination}`);
  // The board is one control, the whole of it: a tap anywhere folds or unfolds it. No arrow; aria-expanded says which.
  const boardControl = board ? {
    role: "button" as const,
    tabIndex: 0,
    "aria-expanded": expanded,
    onClick: () => setBoardOpen(!expanded),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setBoardOpen(!expanded); }
    },
  } : {};
  if (board && !expanded) {
    return (
      <section className="clock-panel clock-board is-folded" {...boardControl}>
        <Clock3 size={18} aria-hidden="true" />
        <span className="clock-board-line">{headline}</span>
      </section>
    );
  }
  return (
    <section className={board ? "clock-panel clock-board" : "clock-panel"} {...boardControl}>
      <div className="clock-orb" aria-hidden="true">
        <Clock3 size={24} />
        <span>{today?.countdown_days != null && today.countdown_days > 0 ? today.countdown_days : totalIndex || "•"}</span>
      </div>
      <div className="clock-copy">
        <span className="panel-label"><Route size={16} /> {label}</span>
        <h3>{headline}</h3>
        {totalDays > 0 && totalIndex > 0 && <p>{copy(lang, `Trip day ${totalIndex} of ${totalDays}.`, `יום ${totalIndex} מתוך ${totalDays} בטיול.`)}</p>}
        <p>{todaysMessage || copy(lang,
          "Take today at your own pace. Some of the best moments are the ones you didn't plan.",
          "קחו את היום בקצב שלכם. לפעמים הרגעים הכי יפים הם אלה שלא תכננתם.",
        )}</p>
      </div>
    </section>
  );
}

export function UpcomingActivity({ item, config, lang, onOpenItinerary }: {
  item: ItineraryItem;
  config?: TripConfig;
  lang: Lang;
  onOpenItinerary: (focus: JourneyFocus) => void;
}) {
  const title = itemTitle(item, lang);
  const phase = config?.phases?.find((entry) => entry.id === item.phase_id);
  const destination = text(phase?.title, lang);
  const mapUrl = mapUrlFor(item, title, destination);
  const wazeUrl = wazeUrlFor(item);
  const confirmationUrl = safeFileUrl("/api/bookings/confirmation", item.booking?.conf_file);
  return <article className="timeline-item compact upcoming-activity">
    <div className="time-rail"><span>{itineraryTimeLabel(item.time, lang)}</span><i /></div>
    <div className="item-body">
      <div className="item-kicker"><MapPin size={16} /><span>{copy(lang, "Up next", "הפעילות הבאה")}</span></div>
      <h3><button className="upcoming-plan-link" type="button" aria-label={copy(lang, `View ${title} in the plan`, `פתיחת ${title} בתוכנית`)} onClick={() => onOpenItinerary({ phaseId: item.phase_id, date: item.date || undefined, itemUid: item.item_uid })}>{title}</button></h3>
      <small className="upcoming-plan-hint">{copy(lang, "View in plan", "פתיחה בתוכנית")}</small>
      <div className="item-actions upcoming-actions">
        <a className="item-action" href={mapUrl} target="_blank" rel="noreferrer"><MapPin size={15} />Google Maps</a>
        {wazeUrl && <a className="item-action" href={wazeUrl} target="_blank" rel="noreferrer"><Navigation size={15} />Waze</a>}
        {confirmationUrl && <AuthenticatedDocumentAction url={confirmationUrl} filename={item.booking!.conf_file!} label={<><ShieldCheck size={15} />{copy(lang, "View confirmation", "צפייה באישור")}</>} />}
      </div>
    </div>
  </article>;
}


// ── The video layout (Release 1A/1B; docs/specs/sprint-9/x-video-r1-site-look.md) ─────────────────────────
// The video layout: the Go chip, the day card and the header. (It had a switch, `site_video_layout`, until 2026-11-21.)

/** The Go chip: opens the item's place in the navigation app the organizer chose for the trip (Google Maps by default). */
export function GoChip({ item, title, destination, lang }: { item: ItineraryItem; title: string; destination?: string; lang: Lang }) {
  const navApp = useNavApp();
  return (
    <a className="go-chip" href={navUrlFor(item, title, destination, navApp)} target="_blank" rel="noreferrer"
      aria-label={copy(lang, `Go to ${title}`, `ניווט אל ${title}`)}>
      <Navigation size={14} aria-hidden="true" />{copy(lang, "Go", "ניווט")}
    </a>
  );
}

export function DayRow({ item, config, lang, isNext, marks, fresh, onOpenItinerary }: {
  item: ItineraryItem;
  config?: TripConfig;
  lang: Lang;
  isNext: boolean;
  marks: boolean;
  fresh: boolean;
  onOpenItinerary: (focus: JourneyFocus) => void;
}) {
  const title = itemTitle(item, lang);
  const destination = text(config?.phases?.find((entry) => entry.id === item.phase_id)?.title, lang);
  const change = marks ? changeOf(item) : undefined;
  const moved = movedFromLabel(change, lang);
  const previousTime = change?.fields.includes("time") && change.previous_time ? itineraryTimeLabel(change.previous_time, lang) : null;
  return (
    <li className={`day-row${changeClass(change)}${isNext ? " is-next" : ""}${fresh ? " is-fresh" : ""}`} data-item-uid={item.item_uid}>
      <span className="day-row-time">
        {change ? <ChangeTime time={itineraryTimeLabel(item.time, lang)} previous={previousTime} /> : <bdi dir="ltr">{itineraryTimeLabel(item.time, lang)}</bdi>}
      </span>
      <div className="day-row-main">
        <button className="day-row-title" type="button" onClick={() => onOpenItinerary({ phaseId: item.phase_id, date: item.date || undefined, itemUid: item.item_uid })}>{title}</button>
        <span className="day-row-flags">
          {isNext ? <small className="next-marker">{copy(lang, "Next", "הבא")}</small> : null}
          <ChangeBadge change={change} lang={lang} />
          {moved ? <small className="moved-from">{moved}</small> : null}
          {item.booking ? <small className="booked-tick"><CheckCircle2 size={13} /> {copy(lang, "Booked", "הוזמן")}</small> : null}
        </span>
      </div>
      <div className="day-row-actions">
        {hasGoChip(item) ? <GoChip item={item} title={title} destination={destination} lang={lang} /> : null}
      </div>
    </li>
  );
}

// "Thursday · Wine Route": the plan day's own label (its descriptive part, as the day picker shows it), else the phase.
function dayCardLabel(day: ItineraryDay | undefined, phaseName: string, lang: Lang) {
  const labelled = day && (day.label_he || day.label_en) ? daySelectorSubtitle(day, lang) : "";
  return labelled && labelled !== day?.phase_id ? labelled : phaseName;
}

export function DayCard({ today, itinerary, config, lang, marks, onOpenItinerary }: {
  today: TodayContext;
  itinerary?: ActiveItinerary;
  config?: TripConfig;
  lang: Lang;
  marks: boolean;
  onOpenItinerary: (focus: JourneyFocus) => void;
}) {
  const beforeTrip = today.phase === "pre_trip";
  const date = beforeTrip ? (today.first_date || "") : today.today;
  // The day's items come from /api/today as served; a row also takes its booking from the plan, which /api/today does not join.
  const rows = useMemo(() => {
    const planned = new globalThis.Map((itinerary?.items || []).map((item) => [item.item_uid, item]));
    const served = beforeTrip ? (itinerary?.items || []).filter((item) => item.date === date) : today.events;
    return collapseSameFlight(served.map((item) => ({ ...item, booking: item.booking ?? planned.get(item.item_uid)?.booking ?? null })));
  }, [beforeTrip, date, itinerary?.items, today.events]);
  const fresh = useFreshChanges(rows);
  const day = itinerary?.days.find((entry) => entry.date === date);
  const phaseId = day?.phase_id || rows[0]?.phase_id || today.next?.phase_id || "";
  const phase = config?.phases?.find((entry) => entry.id === phaseId) || (beforeTrip ? config?.phases?.[0] : undefined);
  const label = dayCardLabel(day, phase ? text(phase.title, lang) : "", lang);
  const title = [date ? weekdayName(date, lang) : "", label].filter(Boolean).join(" · ") || copy(lang, "Today", "היום");
  const nextUid = today.next?.date === date ? today.next.item_uid : "";
  const changes = marks ? rows.map((row) => changeOf(row)).filter((change): change is NonNullable<typeof change> => Boolean(change)) : [];
  const days = Math.max(today.countdown_days ?? 0, 0);
  return (
    <>
      <section className="day-card" aria-label={title}>
        <header className="day-card-head">
          <h2>{title}</h2>
          {beforeTrip ? <p className="day-card-starts">{days === 1 ? copy(lang, "Starts tomorrow", "מתחיל מחר") : copy(lang, `Starts in ${days} days`, `מתחיל בעוד ${days} ימים`)}</p> : null}
        </header>
        {rows.length ? (
          <ol className="day-rows">
            {rows.map((row) => (
              <DayRow key={row.item_uid} item={row} config={config} lang={lang} isNext={row.item_uid === nextUid} marks={marks} fresh={fresh.has(row.item_uid)} onOpenItinerary={onOpenItinerary} />
            ))}
          </ol>
        ) : (
          <p className="empty-state">
            {copy(lang, "Nothing is planned for this day yet.", "עוד אין תוכנית ליום הזה.")}{" "}
            <a href="#journey">{copy(lang, "Open the plan", "פתיחת התוכנית")}</a>
          </p>
        )}
      </section>
      {changes.length ? (
        <UpdatedForEveryone changes={changes} lang={lang} avatars={(config?.participants || []).map((person) => (
          <PersonAvatar key={person.username} username={person.username} name={personName(person, lang)} color={person.color} size="small" />
        ))} />
      ) : null}
    </>
  );
}

// A skyline drawn in code (no raster file): gabled roofs and one church spire, for a trip with no hero photo.
function SkylineMotif({ onAnimationEnd }: { onAnimationEnd?: () => void }) {
  return (
    <svg className="skyline-motif" viewBox="0 0 600 120" preserveAspectRatio="xMidYEnd slice" aria-hidden="true" focusable="false" onAnimationEnd={onAnimationEnd}>
      <path fill="currentColor" d="M0 120V84l18-14 18 14v-8h22V62l20-16 20 16v14h18V90h26V70l16-18 16 18v20h24V76h20l20-24 20 24h18V96h28V58l8-10V28l4-14 4 14v20l8 10v38h26V80l20-16 20 16v14h24V74h18l18-18 18 18v22h26V82h20l16-14 16 14v10h28V68l22-20 22 20v26h24V86h20l16-12 16 12v34z" />
    </svg>
  );
}

function videoPlacePhaseId(config?: TripConfig, itinerary?: ActiveItinerary, today?: TodayContext) {
  const phases = config?.phases || [];
  if (!phases.length) return "";
  if (today?.phase === "pre_trip") return phases[0]!.id;
  if (today?.phase === "post_trip") return phases[phases.length - 1]!.id;
  return todayPhaseId(config, itinerary, today) || phases[0]!.id;
}

function videoTabLabel(tab: VideoTab, lang: Lang) {
  const entry = videoTabs.find((item) => item.id === tab)!;
  return lang === "he" ? entry.he : entry.en;
}

/** The header of the video layout: logo and title, "<place> · <tab>", the signed-in user and More. */
export function VideoHero({ config, settings, lang, placePhaseId, pageName, pageKey, active, openVideoTab, openMenu, openAccount, currentUser }: {
  config?: TripConfig;
  settings?: UiSettings;
  lang: Lang;
  placePhaseId: string;
  /** What the page is called after the dot: the tab, or the module when one is open. */
  pageName: string;
  /** Which page is open, in a form that does not change with the language: when it changes the first open (below) is let go. */
  pageKey?: string;
  active: VideoTab | null;
  openVideoTab: (tab: VideoTab) => void;
  openMenu: () => void;
  /** The name and picture open the Account page (#612); the More button opens the menu. */
  openAccount?: () => void;
  currentUser?: CurrentUser;
}) {
  const place = text(config?.phases?.find((phase) => phase.id === placePhaseId)?.title, lang);
  const { photo, unavailable } = useHeroPhoto(heroCandidates(config, settings?.hero.url, placePhaseId));
  const heroLogo = headerLogoSource(settings, config?.meta?.logo);
  const heroLogoAlt = config?.meta?.logoAlt || config?.meta?.title || "Trip";
  const backgroundPosition = `${(settings?.hero.focal_x ?? 0.5) * 100}% ${(settings?.hero.focal_y ?? 0.45) * 100}%`;
  // Scroll-linked header (hero-scroll.ts): shrinks to a compact bar going down, stretches when pulled at the top.
  const heroRef = useRef<HTMLElement>(null);
  // The first open (hero-scroll.ts): once per page load the header starts open, big, and the photo fades and scales in.
  // `intro` is decided when the header mounts and never again, so a tab switch (which does not remount it) and the photo
  // changing later cannot replay it. The animation itself ends on the photo's animationend; with reduced motion there is
  // none and the open header is just there.
  const [intro] = useState(() => !heroIntroSeen());
  useEffect(() => { markHeroIntroSeen(); }, []);
  const [introPlayed, setIntroPlayed] = useState(false);
  const introAnimating = intro && !introPlayed && !prefersReducedMotion();
  const compact = useHeroScroll(heroRef, { startOpen: intro, releaseKey: pageKey });
  return (
    <header ref={heroRef} className={`trip-hero video-hero${compact ? " is-compact" : ""}${introAnimating ? " is-intro" : ""}`} data-photo-state={photo ? "ready" : unavailable ? "unavailable" : "loading"}>
      {photo ? (
        <div className="video-hero-photo-frame" aria-hidden="true">
          <div key={photo} className="hero-image-layer video-hero-photo" style={{ backgroundImage: `url("${photo}")`, backgroundPosition }}
            onAnimationEnd={() => setIntroPlayed(true)} />
        </div>
      ) : <SkylineMotif onAnimationEnd={() => { if (unavailable) setIntroPlayed(true); }} />}
      <div className={`video-hero-wash ${photo ? "is-photo" : "is-skyline"}`} aria-hidden="true" />
      <nav className="topline" aria-label="Trip">
        <a className="brand-lockup" href="#today" onClick={() => openVideoTab("today")} aria-label="Kinerary home">
          <img className="hero-logo" src={heroLogo} alt={heroLogoAlt} />
          <strong>{config?.meta?.title || "Family Trip"}</strong>
        </a>
        <div className="desktop-tabs">
          {videoTabs.map((tab) => (
            <a key={tab.id} href={tab.id === "plan" ? "#journey" : `#${tab.id}`} className={active === tab.id ? "active" : ""} onClick={() => openVideoTab(tab.id)}>
              {videoTabLabel(tab.id, lang)}
            </a>
          ))}
        </div>
        {currentUser ? (
          <button className="hero-identity" type="button" onClick={openAccount ?? openMenu}
            aria-label={copy(lang, `Signed in as ${personName(currentUser, lang)} — open your account`, `מחוברים בתור ${personName(currentUser, lang)} — פתיחת החשבון`)}>
            <PersonAvatar username={currentUser.username} name={personName(currentUser, lang)} color={currentUser.color} avatarFile={currentUser.avatar_file} size="small" />
          </button>
        ) : null}
        <button className="menu-button more-button" type="button" onClick={openMenu} aria-label={copy(lang, "More", "עוד")}>
          <Menu size={20} aria-hidden="true" />
        </button>
      </nav>
      <div className="hero-copy video-hero-copy">
        <h1>{[place, pageName].filter(Boolean).join(" · ")}</h1>
      </div>
    </header>
  );
}

export function TodayView({
  itinerary,
  config,
  lang,
  isOrganizer,
  onOpenItinerary,
  onOpenBooking,
  onOpenBookings,
  marks = false,
}: {
  itinerary?: ActiveItinerary;
  config?: TripConfig;
  lang: Lang;
  isOrganizer?: boolean;
  onOpenItinerary: (focus: JourneyFocus) => void;
  /** A tapped flight or trip anchor opens its booking (the ticket) on the Bookings page; null opens the page on its flights. */
  onOpenBooking?: (bookingId: number | null) => void;
  /** The Trip anchors card's empty state links to the Bookings page, with no booking in focus. */
  onOpenBookings?: () => void;
  /** plan_change_marks. */
  marks?: boolean;
}) {
  const today = useQuery({ queryKey: ["today"], queryFn: getToday, refetchInterval: 60_000 });
  const flights = useQuery({ queryKey: ["flights"], queryFn: getFlightStatus });
  const next = today.data?.next || null;

  // After the trip there is no day to show: the page is the trip clock and what is next (and so it is while the clock is still loading).
  const dayCard = today.data && today.data.phase !== "post_trip" ? today.data : null;
  return (
    <section className="view-grid today-grid">
      {dayCard ? (
        <div className="focus-panel day-card-panel">
          <TripClockPanel board config={config} itinerary={itinerary} today={today.data} next={next} lang={lang} />
          <DayCard today={dayCard} itinerary={itinerary} config={config} lang={lang} marks={marks} onOpenItinerary={onOpenItinerary} />
        </div>
      ) : (
      <div className="focus-panel">
        <span className="panel-label">{today.data ? phaseLabel(today.data.phase, lang) : copy(lang, "Today", "היום")}</span>
        <h2>{next ? itemTitle(next, lang) : today.data ? copy(lang, "No upcoming activities scheduled.", "אין פעילויות קרובות מתוכננות.") : copy(lang, "Your trip clock is warming up.", "שעון הטיול מתכונן לצאת לדרך.")}</h2>
        {today.data?.phase === "pre_trip" && today.data.countdown_days != null ? (
          <p>{copy(lang, `${Math.max(today.data.countdown_days, 0)} days until departure.`, `נותרו ${Math.max(today.data.countdown_days, 0)} ימים ליציאה.`)}</p>
        ) : null}
        {next ? <UpcomingActivity item={next} config={config} lang={lang} onOpenItinerary={onOpenItinerary} /> : null}
        <TripClockPanel config={config} itinerary={itinerary} today={today.data} next={next} lang={lang} />
      </div>
      )}

      <aside className="ops-strip">
        <WeatherFlightsCard config={config} itinerary={itinerary} today={today.data?.today}
          flights={flights.data?.statuses || []} bookedFlights={today.data?.flights || []} lang={lang} onOpenFlight={onOpenBooking} />
      </aside>

      <TripAnchorsCard config={config} lang={lang} isOrganizer={isOrganizer} onOpenBooking={onOpenBooking} onOpenBookings={onOpenBookings} />
    </section>
  );
}

// Keep configured phases even before they have persisted itinerary days.
export function buildPhaseGroups(
  configPhases: TripConfig["phases"],
  days: ItineraryDay[],
  lang: Lang,
) {
  const config = { phases: configPhases };

    // EVERY CONFIGURED PHASE, days or not.
    //
    // Filtering on `days.length` made a trip with no day-by-day render as no
    // trip at all: five phases with dates, hotels and places, and an itinerary
    // tab showing nothing. Reported 2026-09-12 on the first organizer-run trip
    // built from an interview — "no phases, no locations, no data" — where the
    // day plan is exactly what the interview cannot produce yet. A phase with
    // places and no schedule is a real state of a real trip, not an empty one.
    const configured = (config?.phases || []).map((phase) => ({
      id: phase.id,
      title: text(phase.title, lang) || phase.id,
      days: days.filter((day) => day.phase_id === phase.id),
      venues: phase.venues || [],
      dates: phase.dates,
      calendar: datesInPhase(phase.dates || { start: phase.start, end: phase.end }),
    }));
    const configuredIds = new Set(configured.map((phase) => phase.id));
    const orphanGroups = Array.from(new Set(days.map((day) => day.phase_id).filter((id) => !configuredIds.has(id)))).map((id) => ({
      id,
      title: id,
      days: days.filter((day) => day.phase_id === id),
      venues: [] as NonNullable<NonNullable<TripConfig["phases"]>[number]["venues"]>,
      dates: undefined,
      calendar: [] as string[],
    }));
    return [...configured, ...orphanGroups];
}


// A day's date as a column: day number, month, weekday (the SmarTrip structure, in the video's colours).
function DateColumn({ date, lang, className = "date-col" }: { date: string; lang: Lang; className?: string }) {
  const value = new Date(`${date}T12:00:00`);
  const locale = lang === "he" ? "he-IL" : "en-US";
  return (
    <span className={className}>
      <strong>{value.getDate()}</strong>
      <small>{value.toLocaleDateString(locale, { month: "short" })}</small>
      <small>{value.toLocaleDateString(locale, { weekday: "short" })}</small>
    </span>
  );
}

/** The Plan's days across the top, grouped by phase — each phase is a city, so a one-city trip shows one group. */
function PlanDayStrip({ groups, activePhaseId, activeDate, lang, onSelect }: {
  groups: ReturnType<typeof buildPhaseGroups>;
  activePhaseId?: string;
  activeDate: string;
  lang: Lang;
  onSelect: (phaseId: string, date: string) => void;
}) {
  return (
    <nav className="plan-strip" aria-label={copy(lang, "Days of the trip", "ימי הטיול")}>
      {groups.map((group) => {
        const dates = mergePhaseDates(group.calendar, group.days.map((day) => day.date));
        return (
          <div className="plan-strip-group" key={group.id}>
            <h3>{group.title}</h3>
            <div className="plan-strip-days">
              {dates.length ? dates.map((date) => {
                const planned = group.days.find((entry) => entry.date === date);
                const selected = group.id === activePhaseId && date === activeDate;
                return (
                  <button key={`${group.id}-${date}`} type="button" className={selected ? "plan-day active" : "plan-day"} aria-pressed={selected} onClick={() => onSelect(group.id, date)}>
                    <DateColumn date={date} lang={lang} />
                    <span className="plan-day-label">{planned ? daySelectorSubtitle(planned, lang) : copy(lang, "open", "פנוי")}</span>
                  </button>
                );
              }) : <button type="button" className={group.id === activePhaseId ? "plan-day active" : "plan-day"} onClick={() => onSelect(group.id, "")}><span className="plan-day-label">{copy(lang, "no plan yet", "אין עדיין תוכנית")}</span></button>}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

export function JourneyView({
  itinerary,
  config,
  isOrganizer,
  username,
  lang,
  botName,
  telegramUsername,
  focus,
  today,
  marks = false,
}: {
  itinerary?: ActiveItinerary;
  config?: TripConfig;
  isOrganizer?: boolean;
  username?: string;
  lang: Lang;
  botName?: string;
  telegramUsername?: string | null;
  focus?: JourneyFocus | null;
  today?: TodayContext;
  /** plan_change_marks. */
  marks?: boolean;
}) {
  const days = itinerary?.days || [];
  const phaseGroups = useMemo(() => buildPhaseGroups(config?.phases, days, lang), [config?.phases, days, lang]);
  const [selectedPhase, setSelectedPhase] = useState(phaseGroups[0]?.id || "");
  const activePhase = phaseGroups.find((phase) => phase.id === selectedPhase) || phaseGroups[0];
  // EVERY date the phase covers, whether or not something is planned in it.
  //
  // Either/or was wrong and under-reported the trip: a Tokyo leg written
  // 19–23 September, with one day planned, showed one day and hid the other
  // four — while the leg with nothing planned at all showed its whole range.
  // Reported 2026-09-12: "Tokyo for example of the first phase is 19/9-23
  // (even written explicitly on the document) but again it shows only 1 day.
  // However last phase which is also Tokyo shows the four days."
  //
  // A planned day outside the phase's own range still appears — it exists, and
  // hiding it would lose an item somebody wrote.
  const phaseDates = useMemo(() => {
    const planned = activePhase?.days.map((day) => day.date) ?? [];
    return mergePhaseDates(activePhase?.calendar ?? [], planned);
  }, [activePhase]);
  const [selected, setSelected] = useState(phaseDates[0] || "");
  const activeDate = phaseDates.includes(selected) ? selected : phaseDates[0] || "";
  // One flight is one line on the plan, however many bookings are on it (#549);
  // Reservations keeps a row per booking.
  const dayItems = collapseSameFlight(itinerary?.items.filter((item) => item.date === activeDate && (!activePhase?.id || item.phase_id === activePhase.id)) || []);
  // Items filed under this phase with no date: an idea nobody has placed, or one a companion added without a day.
  // They belong to the phase, not to the day on screen, so they are listed apart from the day selector.
  const undatedItems = activePhase?.id ? (itinerary?.items || []).filter((item) => !item.date && item.phase_id === activePhase.id) : [];
  const activityLinks = useMemo(() => new globalThis.Map((itinerary?.items || []).map(item => [item.item_uid, {
    rsvpId: rsvpForItem(item, config, itinerary)?.id,
    venueId: venueForItem(item, config)?.id,
  }])), [config, itinerary]);
  const day = days.find((entry) => entry.date === activeDate && (!activePhase?.id || entry.phase_id === activePhase.id));
  // From the stop that covers tonight in the effective config (refetched on
  // every stop change), not only the copy stored on the day row at import.
  const tonightPlace = tonightLodging(config?.phases, day, activePhase?.id, activeDate);
  const tonight = lodgingName(tonightPlace, lang);
  // The same links the hotel has on every other screen (server/hotel-place.js).
  const tonightMapUrl = safeExternalUrl(tonightPlace?.location_url);
  const tonightWazeUrl = safeExternalUrl(tonightPlace?.waze_url);
  const fresh = useFreshChanges(marks ? itinerary?.items : undefined);
  const daySpineRef = useRef<HTMLElement>(null);
  const handledFocus = useRef<JourneyFocus | null>(null);
  const initializedForTripDate = useRef(false);

  useEffect(() => {
    if (!selectedPhase && phaseGroups[0]?.id) setSelectedPhase(phaseGroups[0].id);
  }, [phaseGroups, selectedPhase]);

  useEffect(() => {
    if (phaseDates.length && !phaseDates.includes(selected)) setSelected(phaseDates[0]!);
  }, [phaseDates, selected]);

  // Journey normally begins at day one, which remains the useful preview
  // before departure. Once the trip clock says today belongs to the itinerary,
  // use that day for Journey's first view instead. This runs once per mount so
  // changing days manually is never undone by a later query refresh.
  useEffect(() => {
    if (initializedForTripDate.current || !itinerary || !today?.today || today.phase === "pre_trip" || !phaseGroups.length) return;
    initializedForTripDate.current = true;
    const phase = phaseGroups.find((entry) => mergePhaseDates(
      entry.calendar,
      entry.days.map((day) => day.date),
    ).includes(today.today));
    if (!phase) return;
    setSelectedPhase(phase.id);
    setSelected(today.today);
  }, [itinerary, phaseGroups, today?.phase, today?.today]);

  useEffect(() => {
    if (!focus?.phaseId || handledFocus.current === focus) return;
    const phase = phaseGroups.find((entry) => entry.id === focus.phaseId);
    if (!phase) return;
    setSelectedPhase(phase.id);
    const targetDay = focus.date && phase.days.find((entry) => entry.date === focus.date);
    if (targetDay) setSelected(targetDay.date);
  }, [focus, phaseGroups]);

  useEffect(() => {
    if (!focus?.phaseId || handledFocus.current === focus || activePhase?.id !== focus.phaseId) return;
    if (focus.date && activePhase.days.some(day => day.date === focus.date) && activeDate !== focus.date) return;
    const frame = window.requestAnimationFrame(() => {
      handledFocus.current = focus;
      const target = focus.itemUid ? document.getElementById(`itinerary-item-${encodeURIComponent(focus.itemUid)}`) : null;
      (target || daySpineRef.current)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focus, activePhase?.id, activeDate, dayItems.length]);

  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ItineraryItem | null | "new">(null);
  const [draft, setDraft] = useState<ItineraryItemInput>({ phase_id: "", date: "", text_he: "", text_en: "", time: "", item_type: "activity", location_url: "" });
  const [timeMode, setTimeMode] = useState<ItineraryTimeMode>("none");
  const [enrichmentNote, setEnrichmentNote] = useState("");
  const editorRef = useRef<HTMLFormElement>(null);
  useLiveEditGuard(Boolean(editing), "itinerary");

  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  const saveMutation = useMutation({
    mutationFn: ({ itemUid, input }: { itemUid?: string; input: ItineraryItemInput }) => itemUid ? updateItineraryItem(itemUid, input) : createItineraryItem(input),
    onSuccess: (result) => {
      setEditing(null);
      setEnrichmentNote(result.enrichment?.queued
        ? copy(lang, "Saved. Kinerary is now adding the other language, location, and useful links. It can take a minute.", "נשמר. קינררי מוסיף עכשיו את השפה השנייה, מיקום וקישורים שימושיים. זה עשוי לקחת כדקה.")
        : copy(lang, "Saved.", "נשמר."));
      void queryClient.invalidateQueries({ queryKey: ["itinerary"] });
      void queryClient.invalidateQueries({ queryKey: ["today"] });
      if (result.enrichment?.queued) {
        [4_000, 12_000, 30_000].forEach((delay) => window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ["itinerary"] });
          void queryClient.invalidateQueries({ queryKey: ["today"] });
        }, delay));
      }
    },
  });
  const removeMutation = useMutation({
    mutationFn: (uid: string) => deleteItineraryItem(uid, itinerary?.revision),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["itinerary"] });
      void queryClient.invalidateQueries({ queryKey: ["today"] });
    },
  });

  const beginNew = () => {
    const fallbackPhase = config?.phases?.[0];
    setDraft({
      // The phase and day on screen, because that is the one being planned.
      // `dates.start` before `start`: the transformer writes the former, and
      // reading only the latter quietly landed every new item on today.
      expected_revision: itinerary?.revision,

      phase_id: activePhase?.id || fallbackPhase?.id || "",
      date: activeDate || fallbackPhase?.dates?.start || fallbackPhase?.start || new Date().toISOString().slice(0, 10),
      text_he: "",
      text_en: "",
      time: "",
      item_type: "activity",
      location_url: "",
    });
    setTimeMode("none");
    setEditing("new");
  };
  /**
   * A date that does not belong to the phase it is being filed under.
   *
   * Usually a slip — the day strip was on Tokyo and the date picker went to a
   * Kyoto date — and occasionally deliberate: a night train, a day trip
   * counted against the leg that paid for it. So it is a question, not a rule.
   * Asked for 2026-09-12: "he will get a warning that this does not make sense
   * and ask him to verify, but if he approves don't block".
   */
  const draftPhaseDates = phaseGroups.find((group) => group.id === draft.phase_id)?.calendar ?? [];
  const dateOutsidePhase = Boolean(
    draft.phase_id && draft.date && draftPhaseDates.length && !draftPhaseDates.includes(draft.date),
  );
  const draftPhaseName = phaseGroups.find((group) => group.id === draft.phase_id)?.title || draft.phase_id;

  const beginEdit = (item: ItineraryItem) => {
    setDraft({
      expected_revision: itinerary?.revision,
      phase_id: item.phase_id,
      date: item.date || activeDate,
      text_he: item.text_he,
      text_en: item.text_en || "",
      time: item.time || "",
      item_type: item.item_type || "activity",
      // A hotel's link resolved at serve time was never typed by anyone: saving
      // the item must not turn it into a stored one.
      location_url: item.location_derived ? "" : item.location_url || "",
    });
    setTimeMode(roughTimes.includes(item.time as (typeof roughTimes)[number]) ? "rough" : item.time ? "exact" : "none");
    setEditing(item);
  };

  return (
    <section className="journey-layout plan-video">
      <PlanDayStrip
        groups={phaseGroups}
        activePhaseId={activePhase?.id}
        activeDate={activeDate}
        lang={lang}
        onSelect={(phaseId, date) => { setSelectedPhase(phaseId); setSelected(date); }}
      />
      <section ref={daySpineRef} className="day-spine">
        <div className="day-heading">
          {activeDate ? <DateColumn date={activeDate} lang={lang} className="date-col day-date-col" /> : null}
          <div className="day-heading-top">
            <span className="panel-label">{activePhase?.title || "Journey"}</span>
            {isOrganizer && <a className="journey-settings" href="#plan-tools" aria-label={copy(lang, "Plan settings", "הגדרות מסלול")}><Settings size={20} aria-hidden="true" /></a>}
          </div>
          <h2>{(lang === "he" ? day?.label_he || day?.label_en : day?.label_en || day?.label_he) || copy(lang,"Daily itinerary","מסלול יומי")}</h2>
          {tonight ? <p className="tonight-lodging">{copy(lang,"Tonight:","הלילה:")} {tonight}
            {tonightMapUrl ? <> · <a href={tonightMapUrl} target="_blank" rel="noreferrer">{copy(lang, "Map", "מפה")}</a></> : null}
            {tonightWazeUrl ? <> · <a href={tonightWazeUrl} target="_blank" rel="noreferrer">Waze</a></> : null}
          </p> : null}
          {isOrganizer ? <button className="secondary-action journey-edit-trigger" type="button" onClick={beginNew}><Plus size={17} /> {copy(lang, "Add itinerary item", "הוספת פריט למסלול")}</button> : null}
        </div>
        {isOrganizer && editing ? (
          <form
            ref={editorRef}
            className="itinerary-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.phase_id || !draft.date || !draft.text_he.trim()) return;
              if (dateOutsidePhase && !window.confirm(copy(lang,
                `${draft.date} is not one of ${draftPhaseName}'s days. Save it there anyway?`,
                `${draft.date} אינו אחד מהימים של ${draftPhaseName}. לשמור שם בכל זאת?`))) return;
              const time = timeMode === "none" ? null : draft.time?.trim() || null;
              saveMutation.mutate({ itemUid: editing === "new" ? undefined : editing.item_uid, input: { ...draft, text_he: draft.text_he.trim(), time, location_url: draft.location_url?.trim() || null } });
            }}
          >
            <div className="editor-heading">
              <div>
                <span className="panel-label"><Pencil size={16} /> {copy(lang, "Organizer editor", "עורך למארגנים")}</span>
                <h3>{editing === "new" ? copy(lang, "Add to the active plan", "הוספת פריט לתוכנית הפעילה") : copy(lang, "Edit itinerary item", "עריכת פריט במסלול")}</h3>
              </div>
              <button className="icon-button" type="button" onClick={() => setEditing(null)} aria-label={copy(lang, "Close editor", "סגירת העורך")}><X size={18} /></button>
            </div>
            <div className="editor-fields">
              <label>{copy(lang, "Phase", "שלב")}
                <MobileSelect value={draft.phase_id} onChange={(event) => setDraft({ ...draft, phase_id: event.target.value })}>
                  {(config?.phases || phaseGroups).map((phase) => <option key={phase.id} value={phase.id}>{"title" in phase ? text(phase.title, lang) || phase.id : phase.id}</option>)}
                </MobileSelect>
              </label>
              <label>{copy(lang, "Date", "תאריך")}<input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} required /></label>
              {dateOutsidePhase ? (
                <p className="editor-warning" role="status">
                  {copy(lang,
                    `That date is not one of ${draftPhaseName}'s days — check the phase, or save anyway if you meant it.`,
                    `התאריך הזה אינו אחד מהימים של ${draftPhaseName} — בדקו את השלב, או שמרו בכל זאת אם זו הכוונה.`)}
                </p>
              ) : null}
              <label>{copy(lang, "When", "מתי")}
                <MobileSelect value={timeMode} onChange={(event) => {
                  const nextMode = event.target.value as ItineraryTimeMode;
                  setTimeMode(nextMode);
                  setDraft({ ...draft, time: nextMode === "rough" ? "morning" : "" });
                }}>
                  <option value="none">{copy(lang, "No time", "ללא שעה")}</option>
                  <option value="exact">{copy(lang, "Exact time", "שעה מדויקת")}</option>
                  <option value="rough">{copy(lang, "Part of day", "חלק מהיום")}</option>
                </MobileSelect>
              </label>
              {timeMode === "exact" ? <label>{copy(lang, "Exact time", "שעה מדויקת")}<input type="time" value={draft.time || ""} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label> : null}
              {timeMode === "rough" ? <label>{copy(lang, "Part of day", "חלק מהיום")}
                <MobileSelect value={draft.time || "morning"} onChange={(event) => setDraft({ ...draft, time: event.target.value })}>
                  {roughTimes.map((time) => <option key={time} value={time}>{itineraryTimeLabel(time, lang)}</option>)}
                </MobileSelect>
              </label> : null}
              <label>{copy(lang, "Type", "סוג")}
                <MobileSelect value={draft.item_type || "activity"} onChange={(event) => setDraft({ ...draft, item_type: event.target.value })}>
                  {ITEM_TYPES.map((type) => <option key={type} value={type}>{itemTypeLabel(type, lang)}</option>)}
                </MobileSelect>
              </label>
              <label className="editor-field-wide">{copy(lang, "Activity name", "שם הפעילות")}<input value={draft.text_he} onChange={(event) => setDraft({ ...draft, text_he: event.target.value })} required /></label>
              <p className="editor-note">{copy(lang, "Write the activity once, in Hebrew or English. After you save, Kinerary adds the other language and looks up the location, Waze, website, and tickets when available.", "כותבים את הפעילות פעם אחת, בעברית או באנגלית. לאחר השמירה קינררי מוסיף את השפה השנייה ומחפש מיקום, Waze, אתר וכרטיסים כשיש כאלה.")}</p>
              <label className="editor-field-wide">{copy(lang, "Google Maps or location link", "קישור Google Maps או מיקום")}<input type="url" value={draft.location_url || ""} onChange={(event) => setDraft({ ...draft, location_url: event.target.value })} placeholder="https://..." /></label>
            </div>
            {saveMutation.isError ? <p className="form-error">{saveMutation.error instanceof Error && saveMutation.error.message === "itinerary_changed_reload_before_retry" ? copy(lang,"The itinerary changed. Your draft is retained; cancel and reopen to review the latest version.","המסלול השתנה. הטיוטה נשמרה; בטלו ופתחו מחדש כדי לבדוק את הגרסה העדכנית.") : copy(lang,"Could not save the itinerary item. Your draft is retained.","לא ניתן לשמור את פריט המסלול. הטיוטה נשמרה.")}</p> : null}
            <div className="editor-actions">
              <button className="primary-action" type="submit" disabled={saveMutation.isPending || !draft.phase_id || !draft.date || !draft.text_he.trim()}>{saveMutation.isPending ? copy(lang, "Saving…", "שומר…") : copy(lang, "Save revision", "שמירת גרסה")}</button>
              <button className="secondary-action" type="button" onClick={() => setEditing(null)}>{copy(lang, "Cancel", "ביטול")}</button>
            </div>
          </form>
        ) : null}
        {isOrganizer && enrichmentNote ? <p className="enrichment-note"><Sparkles size={16} /> {enrichmentNote}</p> : null}
        {removeMutation.isError ? <p className="form-error">{copy(lang,"Could not remove the item. Refresh the plan before retrying.","לא ניתן להסיר את הפריט. רעננו את המסלול לפני ניסיון נוסף.")}</p> : null}
        <div className="timeline">
          {dayItems.length ? dayItems.map((item) => (
            <div className="timeline-item-wrap" id={`itinerary-item-${encodeURIComponent(item.item_uid)}`} key={item.item_uid}>
              <TimelineItem item={item} {...activityLinks.get(item.item_uid)} username={username} lang={lang} botName={botName} telegramUsername={telegramUsername}
                marks={marks} fresh={fresh.has(item.item_uid)} destination={activePhase?.title || ""} />
              {isOrganizer ? <SeedFlagNotice kind="item" id={item.item_uid} changed={item.seed_changed} removed={item.seed_removed} lang={lang} /> : null}
              {isOrganizer ? <PlanConflictNotice itemUid={item.item_uid} conflicts={item.plan_conflicts} lang={lang} /> : null}
              {isOrganizer ? <div className="timeline-editor-actions">
                <button type="button" onClick={() => beginEdit(item)}><Pencil size={15} /> {copy(lang, "Edit", "עריכה")}</button>
                <button className="danger-text" type="button" disabled={removeMutation.isPending} onClick={() => { if (window.confirm(copy(lang, "Remove this itinerary item?", "להסיר את הפריט הזה מהמסלול?"))) removeMutation.mutate(item.item_uid); }}><Trash2 size={15} /> {copy(lang, "Remove", "הסרה")}</button>
              </div> : null}
            </div>
          )) : activePhase && !activePhase.days.length ? (
            <PhasePlaces venues={activePhase.venues} lang={lang} />
          ) : <p className="empty-state">{copy(lang, "No structured items for this phase day yet.", "אין עדיין פריטים מתוזמנים ליום הזה.")}</p>}

        </div>
        <UndatedPlanItems
          items={undatedItems}
          phaseId={activePhase?.id || ""}
          dates={phaseDates}
          revision={itinerary?.revision}
          isOrganizer={isOrganizer}
          lang={lang}
          activityLinks={activityLinks}
          username={username}
          botName={botName}
          telegramUsername={telegramUsername}
          marks={marks}
          fresh={fresh}
          destination={activePhase?.title || ""}
          onEdit={beginEdit}
        />
      </section>
    </section>
  );
}

/**
 * The phase's items that are on no day yet.
 *
 * The Plan lists items per date, so an item with no date was in the itinerary and nowhere on the screen: the
 * companion filed "dinner on the first day" without a date and the organizer saw nothing. Undated is a real state
 * (an idea nobody has placed), so the group says so in words rather than hiding it, and an organizer can put an
 * item on one of the phase's days. A member sees the list and nothing to press. With no such item it renders
 * nothing at all.
 */
function UndatedPlanItems({ items, phaseId, dates, revision, isOrganizer, lang, activityLinks, username, botName, telegramUsername, marks, fresh, destination, onEdit }: {
  items: ItineraryItem[];
  phaseId: string;
  dates: string[];
  revision?: string;
  isOrganizer?: boolean;
  lang: Lang;
  activityLinks: globalThis.Map<string, { rsvpId?: string; venueId?: string }>;
  username?: string;
  botName?: string;
  telegramUsername?: string | null;
  marks: boolean;
  fresh: Set<string>;
  destination: string;
  onEdit: (item: ItineraryItem) => void;
}) {
  const queryClient = useQueryClient();
  const place = useMutation({
    mutationFn: ({ itemUid, date }: { itemUid: string; date: string }) => setItineraryItemDay(itemUid, phaseId, date, revision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["itinerary"] });
      void queryClient.invalidateQueries({ queryKey: ["today"] });
    },
  });
  if (!items.length) return null;
  const title = copy(lang, "Not on a day yet", "עדיין לא שובץ ליום");
  return (
    <section className="plan-undated" aria-label={title}>
      <h3>{title}</h3>
      <p className="plan-undated-note">{copy(lang, "These are on the plan, but no day has been chosen for them.", "הפריטים האלה בתוכנית, אבל עוד לא נבחר להם יום.")}</p>
      <div className="timeline">
        {items.map((item) => (
          <div className="timeline-item-wrap" id={`itinerary-item-${encodeURIComponent(item.item_uid)}`} key={item.item_uid}>
            <TimelineItem item={item} {...activityLinks.get(item.item_uid)} username={username} lang={lang} botName={botName} telegramUsername={telegramUsername}
              marks={marks} fresh={fresh.has(item.item_uid)} destination={destination} />
            {isOrganizer ? <div className="timeline-editor-actions plan-undated-actions">
              <label>
                <MobileSelect
                  value=""
                  disabled={place.isPending || !dates.length}
                  aria-label={copy(lang, `Put "${itemTitle(item, lang)}" on a day`, `שיבוץ "${itemTitle(item, lang)}" ליום`)}
                  onChange={(event) => { if (event.target.value) place.mutate({ itemUid: item.item_uid, date: event.target.value }); }}
                >
                  <option value="">{copy(lang, "Choose a day…", "בחירת יום…")}</option>
                  {dates.map((date) => <option key={date} value={date}>{dateLabel(date, lang)}</option>)}
                </MobileSelect>
              </label>
              <button type="button" onClick={() => onEdit(item)}><Pencil size={15} /> {copy(lang, "Edit", "עריכה")}</button>
            </div> : null}
          </div>
        ))}
      </div>
      {place.isError ? <p className="form-error">{copy(lang, "Could not put the item on a day. Refresh the plan and try again.", "לא ניתן לשבץ את הפריט ליום. רעננו את המסלול ונסו שוב.")}</p> : null}
    </section>
  );
}

/**
 * What a phase has before it has a day-by-day: the places.
 *
 * The interview captures where a leg is going — "Tokyo Skytree", "TeamLab
 * Planets" — but nothing yet turns those into dated days, so an
 * interview-built trip arrives as phases full of places and no schedule. Until
 * 2026-09-12 that rendered as nothing whatsoever. Showing the places says what
 * is actually known, and says plainly that the schedule is still open, rather
 * than implying the trip is empty.
 */
export function PhasePlaces({ venues, lang }: {
  venues: NonNullable<NonNullable<TripConfig["phases"]>[number]["venues"]>;
  lang: Lang;
}) {
  if (!venues.length) {
    return <p className="empty-state">{copy(lang, "Nothing planned for this phase yet.", "עוד לא תוכנן דבר לשלב הזה.")}</p>;
  }
  return (
    <div className="phase-places">
      <p className="empty-state">{copy(lang,
        "No day-by-day for this phase yet — here is what it is planned around.",
        "עוד אין תוכנית יומית לשלב הזה — אלה המקומות שתוכננו בו.")}</p>
      <ul>
        {venues.map((venue, index) => (
          <li key={venue.id || index}>
            <strong>{text(venue.name, lang) || venue.id}</strong>
            <span className="phase-place-links">
              <VenueLinks venue={venue} lang={lang} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A draft is the author's alone unless it came from the chat or a member's assistant, which organizers can also see (the site decides
// who is served what; this only says it). A member's own site draft stays "Private draft".
export function momentDraftLabel(moment: Moment, username: string | undefined, lang: Lang) {
  // Used only while the trip has trip_moments_capture on; with it off the label is the one the site always had.
  if (moment.author !== username) return copy(lang, `Draft by ${moment.author}`, `טיוטה של ${moment.author}`);
  if (moment.source === "chat" || moment.source === "connector") return copy(lang, "Draft — you and the organizers can see it", "טיוטה — אתם והמארגנים יכולים לראות אותה");
  return copy(lang, "Private draft", "טיוטה פרטית");
}

export function MomentsView({ todayDate, lang, isOrganizer, username, momentsOn = false }: { todayDate?: string; lang: Lang; isOrganizer?: boolean; username?: string; momentsOn?: boolean }) {

  const queryClient = useQueryClient();
  const moments = useQuery({ queryKey: ["moments"], queryFn: getMoments });
  const [caption, setCaption] = useState("");
  const publish = useMutation({
    mutationFn: (id: string) => publishMoment(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["moments"] }),
  });
  const mutation = useMutation({
    mutationFn: () => createMoment({ caption, date: todayDate, visibility: "draft" }),
    onSuccess: () => {
      setCaption("");
      queryClient.invalidateQueries({ queryKey: ["moments"] });
    },
  });

  return (
    <section className="moments-layout">
      <form className="moment-composer" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
        <span className="panel-label"><GalleryHorizontalEnd size={16} /> {copy(lang,"Moments","רגעים")}</span>
        <h2>{copy(lang,"Capture the day while it is still fresh.","שמרו את הרגעים כשהיום עוד טרי בזיכרון.")}</h2>
        <label>
          {copy(lang,"Caption","כיתוב")}
          <textarea value={caption} onChange={(event) => setCaption(event.target.value)} placeholder={copy(lang,"A small memory, a funny line, a place worth remembering…","זיכרון קטן, משפט מצחיק, מקום שכדאי לזכור…")} />
        </label>
        <button className="primary-action" type="submit" disabled={!caption.trim() || mutation.isPending}>
          <Plus size={18} /> Save draft
        </button>
      </form>
      <div className="moment-feed">
        {(moments.data || []).map((moment) => (
          <article key={moment.id} className="moment-card">
            <small>{moment.visibility === "draft" ? (momentsOn ? momentDraftLabel(moment, username, lang) : copy(lang,"Private draft","טיוטה פרטית")) : copy(lang,"Published","פורסם")} {moment.date ? `- ${moment.date}` : ""}</small>
            <h3>{moment.caption}</h3>
            {moment.body ? <p>{moment.body}</p> : null}
            {momentsOn && isOrganizer && moment.visibility === "draft" ? (
              <button type="button" className="ghost" disabled={publish.isPending} onClick={() => publish.mutate(moment.id)}>{copy(lang,"Publish","פרסום")}</button>
            ) : null}
            {momentsOn && moment.photo_ids?.length ? <small>{copy(lang,`${moment.photo_ids.length} photo(s)`,`${moment.photo_ids.length} תמונות`)}</small> : null}
          </article>
        ))}
        {!moments.data?.length ? <p className="empty-state">{copy(lang,"No moments yet.","אין רגעים עדיין.")}</p> : null}
      </div>
    </section>
  );
}

function phaseTitle(config: TripConfig | undefined, phaseId: string | null | undefined, lang: Lang) {
  if (!phaseId) return lang === "he" ? "ללא שלב" : "Unassigned";
  const phase = config?.phases?.find((entry) => entry.id === phaseId);
  return phase ? text(phase.title, lang) || phaseId : phaseId;
}

function bookingDateLine(booking: Booking, lang: Lang) {
  if (booking.date_from && booking.date_to && booking.date_from !== booking.date_to) {
    return `${dateLabel(booking.date_from, lang)} → ${dateLabel(booking.date_to, lang)}`;
  }
  if (booking.date_from) return dateLabel(booking.date_from, lang);
  if (booking.date_to) return dateLabel(booking.date_to, lang);
  return lang === "he" ? "תאריך חסר" : "Date missing";
}

function bookingState(booking: Booking) {
  if (booking.review_status === "draft") return "draft";
  if (booking.confirmation || booking.conf_file || booking.google_wallet_url || booking.apple_wallet_url || booking.pkpass_file) return "verified";
  return "needs-review";
}

// The installed (home-screen) app: both the iOS flag and the standard media
// query, as Classic's isStandaloneAppMode does. The manifest is shared, so
// Modern installs as a standalone app too.
function isStandaloneAppMode() {
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

function AuthenticatedDocumentAction({ url, filename, download, label }: { url: string; filename: string; download?: boolean; label: React.ReactNode }) {
  const [error, setError] = useState("");
  // Fetch first, then open a tab with the blob URL already in hand. Opening a
  // blank tab before the fetch and filling it in afterwards left that tab blank
  // — the bug Classic's openAuthedBlob (site/app.js) already fixed. A slow
  // fetch can outlast the click's activation, after which window.open is
  // silently blocked (and with "noopener" it returns null either way, so its
  // result says nothing), so when activation cannot be confirmed — or in the
  // installed app, where a second window is unwanted — the document opens in
  // this tab instead.
  const open = async () => {
    setError("");
    try {
      const blob = await getAuthenticatedDocument(url);
      const objectUrl = URL.createObjectURL(blob);
      if (download) {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } else if (!isStandaloneAppMode() && (navigator.userActivation?.isActive ?? false)) {
        window.open(objectUrl, "_blank", "noopener");
      } else {
        window.location.assign(objectUrl);
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not retrieve document");
    }
  };
  return <span className="document-action"><button type="button" onClick={open}>{label}</button>{error ? <small className="form-error">{error}</small> : null}</span>;
}

const SEED_FIELD_LABELS: Record<string, [string, string]> = {
  phase: ["Stop", "תחנה"], type: ["Type", "סוג"], name: ["Name", "שם"], date_from: ["Start date", "תאריך התחלה"], date_to: ["End date", "תאריך סיום"],
  passengers: ["Passengers", "נוסעים"], confirmation: ["Confirmation", "אישור"], pin: ["PIN", "קוד"], notes: ["Notes", "הערות"], cost: ["Cost", "עלות"],
  conf_file: ["Confirmation file", "קובץ אישור"], location_url: ["Map link", "קישור מפה"], date: ["Date", "תאריך"], time: ["Time", "שעה"],
  text_he: ["Text (Hebrew)", "טקסט (עברית)"], text_en: ["Text (English)", "טקסט (אנגלית)"], waze_url: ["Waze link", "קישור Waze"],
  ticket_url: ["Ticket link", "קישור כרטיסים"], extra_links: ["Links", "קישורים"],
};

/**
 * "The trip file changed this — keep mine / use the new one" (#382). A re-provision rewrote the trip file under
 * something an organizer had edited on the site: the edit stands, and this asks which one wins. Organizer-only by
 * the caller and by the server (a member never receives the flag). Pin and notes are named, never shown.
 */
export function SeedFlagNotice({ kind, id, changed, removed, lang }: { kind: "booking" | "item"; id: number | string; changed?: Record<string, unknown>; removed?: boolean; lang: Lang }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (answer: "accept" | "keep") => kind === "booking" ? answerBookingSeed(Number(id), answer) : answerItemSeed(String(id), answer),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["bookings"] }),
      queryClient.invalidateQueries({ queryKey: ["itinerary"] }),
      queryClient.invalidateQueries({ queryKey: ["today"] }),
    ]),
  });
  const entries = Object.entries(changed || {});
  if (!entries.length && !removed) return null;
  const noun = kind === "booking" ? copy(lang, "booking", "ההזמנה") : copy(lang, "item", "הפריט");
  const label = (field: string) => { const l = SEED_FIELD_LABELS[field]; return l ? copy(lang, l[0], l[1]) : field; };
  return (
    <div className="seed-flag" role="status">
      <p>{removed
        ? copy(lang, `The trip file no longer lists this ${noun}.`, `קובץ הטיול כבר לא כולל את ${noun}.`)
        : copy(lang, `The trip file changed this ${noun}.`, `קובץ הטיול שינה את ${noun}.`)}</p>
      {entries.length ? <ul>{entries.map(([field, value]) => <li key={field}>{label(field)}: {typeof value === "string" || typeof value === "number" ? String(value) : copy(lang, "(changed)", "(שונה)")}</li>)}</ul> : null}
      <div className="seed-flag-actions">
        <button type="button" className="secondary-action" disabled={mutation.isPending} onClick={() => mutation.mutate("keep")}>{copy(lang, "Keep mine", "להשאיר את שלי")}</button>
        {kind === "item" && removed ? null : <button type="button" className="secondary-action" disabled={mutation.isPending} onClick={() => mutation.mutate("accept")}>{removed ? copy(lang, "Use the new one (remove it)", "להשתמש בחדש (להסיר)") : copy(lang, "Use the new one", "להשתמש בחדש")}</button>}
      </div>
      {mutation.isError ? <p className="form-error">{copy(lang, "Could not save your choice. Try again.", "לא ניתן לשמור את הבחירה. נסו שוב.")}</p> : null}
    </div>
  );
}

/**
 * "Same time as another plan item — keep both" (#550). The server sends `plan_conflicts` to an organizer
 * only; the caller renders this for an organizer only. Keep both records the acceptance on the server (the
 * pair at these times), so it is not raised again; both items' notices go away on the refresh.
 */
export function PlanConflictNotice({ itemUid, conflicts, lang }: { itemUid: string; conflicts?: NonNullable<ItineraryItem["plan_conflicts"]>; lang: Lang }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (withUid: string) => keepBothPlanItems(itemUid, withUid),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["itinerary"] }),
      queryClient.invalidateQueries({ queryKey: ["today"] }),
    ]),
  });
  if (!conflicts?.length) return null;
  return (
    <div className="seed-flag plan-conflict" role="status">
      {conflicts.map((other) => {
        const name = (lang === "he" ? other.text_he || other.text_en : other.text_en || other.text_he) || other.item_uid;
        return (
          <div key={other.item_uid}>
            <p>{copy(lang, "Same time as", "באותה שעה כמו")} <bdi>{name}</bdi>{other.time ? <> (<bdi dir="ltr">{other.time}</bdi>)</> : null}</p>
            <div className="seed-flag-actions">
              <button type="button" className="secondary-action" disabled={mutation.isPending} onClick={() => mutation.mutate(other.item_uid)}>{copy(lang, "Keep both", "להשאיר את שניהם")}</button>
            </div>
          </div>
        );
      })}
      {mutation.isError ? <p className="form-error">{copy(lang, "Could not save your choice. Try again.", "לא ניתן לשמור את הבחירה. נסו שוב.")}</p> : null}
    </div>
  );
}

function BookingActions({ booking, lang }: { booking: Booking; lang: Lang }) {
  const confirmationUrl = safeFileUrl("/api/bookings/confirmation", booking.conf_file);
  const appleWalletUrl = safeFileUrl("/api/bookings/wallet-apple", booking.pkpass_file);
  const locationUrl = safeExternalUrl(booking.location_url) || safeExternalUrl(booking.place?.maps_url);
  const wazeUrl = safeExternalUrl(booking.place?.waze_url);
  const googleWalletUrl = safeExternalUrl(booking.google_wallet_url);
  const walletUrl = safeExternalUrl(booking.apple_wallet_url) || appleWalletUrl;
  return (
    <div className="action-strip">
      {confirmationUrl ? <AuthenticatedDocumentAction url={confirmationUrl} filename={booking.conf_file || "confirmation.pdf"} label={<><ShieldCheck size={15} /> {copy(lang,"Confirmation","אישור")}</>} /> : null}
      {confirmationUrl ? <AuthenticatedDocumentAction url={confirmationUrl} filename={booking.conf_file || "confirmation.pdf"} download label={<><Download size={15} /> {copy(lang,"Download","הורדה")}</>} /> : null}
      {locationUrl ? <a href={locationUrl} target="_blank" rel="noreferrer"><MapPin size={15} /> Google Maps</a> : null}
      {wazeUrl ? <a href={wazeUrl} target="_blank" rel="noreferrer"><Navigation size={15} /> Waze</a> : null}
      {googleWalletUrl ? <a href={googleWalletUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Google Wallet</a> : null}
      {walletUrl ? (booking.pkpass_file ? <AuthenticatedDocumentAction url={appleWalletUrl} filename={booking.pkpass_file} download label={<><TicketCheck size={15} /> Apple Wallet</>} /> : <a href={walletUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Apple Wallet</a>) : null}
    </div>
  );
}

export function BookingCreatePanel({ config, isOrganizer, lang }: { config?: TripConfig; isOrganizer?: boolean; lang: Lang }) {
  const defaultPhase = config?.phases?.[0]?.id || "";
  const [draft, setDraft] = useState({ phase: defaultPhase, type: "flight", name: "", date_from: "", date_to: "", passengers: "", confirmation: "", location_url: "", google_wallet_url: "", apple_wallet_url: "" });
  const [confirmationFile, setConfirmationFile] = useState<File | null>(null);
  const [walletFile, setWalletFile] = useState<File | null>(null);
  const [extractUrl, setExtractUrl] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [extractionError, setExtractionError] = useState("");
  const formGeneration = useRef(0);
  const savedBooking = useRef<{ id: number; input: string; confirmation: File | null; wallet: File | null } | null>(null);
  const [partiallySaved, setPartiallySaved] = useState(false);
  const queryClient = useQueryClient();
  const extractMutation = useMutation({
    mutationFn: async (generation: number) => {
      const body = new FormData();
      if (confirmationFile) body.set("file", confirmationFile);
      if (extractUrl.trim()) body.set("url", extractUrl.trim());
      return { extracted: await extractBookingDetails(body), generation };
    },
    onSuccess: ({ extracted, generation }) => {
      // Saving starts a fresh form. A late background extraction must never
      // write its old confirmation's data into that next booking.
      if (generation !== formGeneration.current) return;
      const validTypes = new Set(["flight", "hotel", "car", "attraction", "other"]);
      setDraft((current) => ({
        ...current,
        phase: extracted.phase || current.phase,
        type: extracted.type && validTypes.has(extracted.type) ? extracted.type : current.type,
        name: extracted.name || current.name,
        date_from: extracted.date_from || current.date_from,
        date_to: extracted.date_to || current.date_to,
        passengers: extracted.passengers || current.passengers,
        confirmation: extracted.confirmation || current.confirmation,
        location_url: extracted.location_url || current.location_url,
      }));
      setExtractUrl("");
      setExtractionError("");
    },
    onError: (reason) => setExtractionError(reason instanceof Error ? reason.message : (lang === "he" ? "לא ניתן לחלץ את פרטי ההזמנה" : "Could not extract booking details")),
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const input = { ...draft, phase: draft.phase || defaultPhase };
      const serialized = JSON.stringify(input);
      if (!savedBooking.current) {
        const created = await createBooking(input);
        savedBooking.current = { id: created.id, input: serialized, confirmation: null, wallet: null };
        setPartiallySaved(true);
        formGeneration.current += 1;
        void queryClient.invalidateQueries({ queryKey: ["bookings"] });
      }
      const saved = savedBooking.current;
      if (saved.input !== serialized) {
        await updateBooking(saved.id, input);
        saved.input = serialized;
      }
      if (confirmationFile && saved.confirmation !== confirmationFile) {
        await uploadBookingConfirmation(saved.id, confirmationFile);
        saved.confirmation = confirmationFile;
      }
      if (walletFile && saved.wallet !== walletFile) {
        await uploadBookingAppleWallet(saved.id, walletFile);
        saved.wallet = walletFile;
      }
      return { id: saved.id };
    },
    onSuccess: () => {
      savedBooking.current = null;
      setPartiallySaved(false);
      formGeneration.current += 1;
      setDraft({ phase: defaultPhase, type: "flight", name: "", date_from: "", date_to: "", passengers: "", confirmation: "", location_url: "", google_wallet_url: "", apple_wallet_url: "" });
      setConfirmationFile(null);
      setWalletFile(null);
      setExtractUrl("");
      setExtractionError("");
      setIsOpen(false);
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: ["bookings"] }); },
  });

  if (!isOrganizer) return null;
  if (!isOpen) return <button className="booking-add-trigger" type="button" onClick={() => setIsOpen(true)}><Plus size={18} /> {lang === "he" ? "הוספת הזמנה" : "Add booking"}</button>;
  return (
    <form className="extract-panel" onSubmit={(event) => { event.preventDefault(); if (draft.phase || defaultPhase) mutation.mutate(); }}>
      <div className="booking-form-header">
        <div>
          <span className="panel-label"><Plus size={16} /> {lang === "he" ? "הזמנה חדשה" : "New booking"}</span>
          <h3>{lang === "he" ? "כל הפרטים במקום אחד" : "Everything in one place"}</h3>
        </div>
        <button className="icon-action" type="button" onClick={() => setIsOpen(false)} aria-label={lang === "he" ? "סגירת טופס הוספת הזמנה" : "Close add booking form"}><X size={18} /></button>
      </div>
      <p>{lang === "he" ? "אפשר למלא ידנית, או לצרף אישור ולתת לנו למלא את הפרטים. לפני השמירה תמיד אפשר לעבור על הכול ולתקן." : "Fill this in yourself, or attach a confirmation and let us fill the details. You can always review and correct everything before saving."}</p>
      <div className="booking-extract-fields">
        <label>{lang === "he" ? "אישור PDF" : "Confirmation PDF"}<input type="file" accept="application/pdf" onChange={(event) => { setConfirmationFile(event.target.files?.[0] || null); setExtractionError(""); }} /></label>
        <label>{lang === "he" ? "או קישור להזמנה" : "Or booking link"}<input type="url" value={extractUrl} onChange={(event) => { setExtractUrl(event.target.value); setExtractionError(""); }} placeholder="https://..." /></label>
        <button className="secondary-action" type="button" disabled={extractMutation.isPending || (!confirmationFile && !extractUrl.trim())} onClick={() => { setExtractionError(""); extractMutation.mutate(formGeneration.current); }}>{extractMutation.isPending ? <><span className="loading-spinner" aria-hidden="true" /> {lang === "he" ? "מחלץ פרטים…" : "Extracting details…"}</> : (lang === "he" ? "חילוץ פרטים למילוי הטופס" : "Extract details into form")}</button>
      </div>
      {extractMutation.isPending ? <p className="extract-progress" role="status"><span className="loading-spinner" aria-hidden="true" />{lang === "he" ? "החילוץ עובד ברקע — אפשר להמשיך למלא ולשמור את ההזמנה." : "Extraction is working in the background — you can keep filling in and save the booking."}</p> : null}
      {extractionError ? <div className="extract-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><div><strong>{lang === "he" ? "החילוץ נכשל" : "Extraction failed"}</strong><span>{extractionError}</span></div></div> : null}
      {extractMutation.isSuccess ? <p className="saved-note">{lang === "he" ? "הפרטים חולצו — כדאי לעבור עליהם לפני השמירה." : "Details extracted — please review them before saving."}</p> : null}
      <div className="booking-create-fields">
        <label>{lang === "he" ? "שלב" : "Phase"}<MobileSelect value={draft.phase || defaultPhase} onChange={(event) => setDraft({ ...draft, phase: event.target.value })} required><option value="" disabled>{lang === "he" ? "בחירת שלב" : "Choose a phase"}</option>{(config?.phases || []).map((phase) => <option key={phase.id} value={phase.id}>{text(phase.title, lang) || phase.id}</option>)}</MobileSelect></label>
        <label>{lang === "he" ? "סוג" : "Type"}<MobileSelect value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>{BOOKING_TYPES.map((type) => <option key={type} value={type}>{bookingTypeLabel(type, lang)}</option>)}</MobileSelect></label>
        <label className="editor-field-wide">{lang === "he" ? "שם ההזמנה" : "Booking name"}<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required placeholder={lang === "he" ? "לדוגמה: טיסת JL 12" : "For example: Flight JL 12"} /></label>
        <label>{lang === "he" ? "מתאריך" : "From"}<input type="date" value={draft.date_from} onChange={(event) => setDraft({ ...draft, date_from: event.target.value })} /></label>
        <label>{lang === "he" ? "עד תאריך" : "To"}<input type="date" value={draft.date_to} onChange={(event) => setDraft({ ...draft, date_to: event.target.value })} /></label>
        <label>{lang === "he" ? "נוסעים" : "Travelers"}<input value={draft.passengers} onChange={(event) => setDraft({ ...draft, passengers: event.target.value })} /></label>
        <label>{lang === "he" ? "מספר אישור" : "Confirmation number"}<input value={draft.confirmation} onChange={(event) => setDraft({ ...draft, confirmation: event.target.value })} /></label>
        <label className="editor-field-wide">{lang === "he" ? "קישור Google Maps" : "Google Maps link"}<input type="url" value={draft.location_url} onChange={(event) => setDraft({ ...draft, location_url: event.target.value })} placeholder="https://..." /></label>
      </div>
      <details className="booking-more-fields">
        <summary>{lang === "he" ? "אפשרויות נוספות (ארנק)" : "More options (wallet)"}</summary>
        <div className="booking-create-fields">
          <label>{lang === "he" ? "קישור Google Wallet" : "Google Wallet link"}<input type="url" value={draft.google_wallet_url} onChange={(event) => setDraft({ ...draft, google_wallet_url: event.target.value })} placeholder="https://..." /></label>
          <label>{lang === "he" ? "קישור Apple Wallet" : "Apple Wallet link"}<input type="url" value={draft.apple_wallet_url} onChange={(event) => setDraft({ ...draft, apple_wallet_url: event.target.value })} placeholder="https://..." /></label>
          <label>{lang === "he" ? "קובץ Apple Wallet" : "Apple Wallet file"}<input type="file" accept=".pkpass,application/vnd.apple.pkpass" onChange={(event) => setWalletFile(event.target.files?.[0] || null)} /></label>
        </div>
      </details>
      <button className="primary-action" type="submit" disabled={mutation.isPending || !(draft.phase || defaultPhase) || !draft.name.trim()}>{mutation.isPending ? (lang === "he" ? "שומר…" : "Saving…") : (lang === "he" ? "שמירת הזמנה" : "Save booking")}</button>
      {mutation.isError ? <p className="form-error" role="alert">{partiallySaved ? copy(lang, "The booking is saved. Save again to retry the remaining changes and attachments. ", "ההזמנה נשמרה. יש לשמור שוב כדי לנסות להשלים את השינויים והקבצים שנותרו. ") : ""}{mutation.error instanceof Error ? mutation.error.message : (lang === "he" ? "לא ניתן לשמור את ההזמנה" : "Could not save the booking")}</p> : null}
      {mutation.isSuccess ? <p className="saved-note">{lang === "he" ? "ההזמנה נשמרה ומוכנה לחברי הטיול." : "Booking saved and ready for trip members."}</p> : null}
    </form>
  );
}

function bookingDraft(booking: Booking) {
  return {
    phase: booking.phase || "",
    type: booking.type,
    name: booking.name,
    date_from: booking.date_from || "",
    date_to: booking.date_to || "",
    passengers: booking.passengers || "",
    confirmation: booking.confirmation || "",
    notes: booking.notes || "",
    location_url: booking.location_url || "",
    google_wallet_url: booking.google_wallet_url || "",
    apple_wallet_url: booking.apple_wallet_url || "",
  };
}

export function BookingEditPanel({ booking, config, lang, onClose }: { booking: Booking; config?: TripConfig; lang: Lang; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => bookingDraft(booking));
  useLiveEditGuard(true, "bookings");
  const [confirmationFile, setConfirmationFile] = useState<File | null>(null);
  const [walletFile, setWalletFile] = useState<File | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidateBookingViews = () => {
    queryClient.invalidateQueries({ queryKey: ["bookings"] });
    queryClient.invalidateQueries({ queryKey: ["itinerary"] });
    queryClient.invalidateQueries({ queryKey: ["today"] });
    queryClient.invalidateQueries({ queryKey: ["confirmations"] });
  };
  const saveMutation = useMutation({
    mutationFn: async () => {
      await updateBooking(booking.id, draft);
      if (confirmationFile) await uploadBookingConfirmation(booking.id, confirmationFile);
      if (walletFile) await uploadBookingAppleWallet(booking.id, walletFile);
    },
    onSuccess: () => {
      invalidateBookingViews();
      onClose();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteBooking(booking.id),
    onSuccess: () => {
      invalidateBookingViews();
      onClose();
    },
  });

  return (
    <form className="booking-edit-panel" onSubmit={(event) => { event.preventDefault(); saveMutation.mutate(); }}>
      <div className="booking-form-header">
        <div>
          <span className="panel-label"><Pencil size={16} /> {lang === "he" ? "עריכת הזמנה" : "Edit booking"}</span>
          <h3>{booking.name}</h3>
        </div>
        <button className="icon-action" type="button" onClick={onClose} aria-label={lang === "he" ? "סגירת עריכת הזמנה" : "Close booking editor"}><X size={18} /></button>
      </div>
      <div className="booking-create-fields">
        <label>{lang === "he" ? "שלב" : "Phase"}<MobileSelect value={draft.phase} onChange={(event) => setDraft({ ...draft, phase: event.target.value })} required><option value="" disabled>{lang === "he" ? "בחירת שלב" : "Choose a phase"}</option>{(config?.phases || []).map((phase) => <option key={phase.id} value={phase.id}>{text(phase.title, lang) || phase.id}</option>)}</MobileSelect></label>
        <label>{lang === "he" ? "סוג" : "Type"}<MobileSelect value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>{BOOKING_TYPES.map((type) => <option key={type} value={type}>{bookingTypeLabel(type, lang)}</option>)}</MobileSelect></label>
        <label className="editor-field-wide">{lang === "he" ? "שם ההזמנה" : "Booking name"}<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
        <label>{lang === "he" ? "מתאריך" : "From"}<input type="date" value={draft.date_from} onChange={(event) => setDraft({ ...draft, date_from: event.target.value })} /></label>
        <label>{lang === "he" ? "עד תאריך" : "To"}<input type="date" value={draft.date_to} onChange={(event) => setDraft({ ...draft, date_to: event.target.value })} /></label>
        <label>{lang === "he" ? "נוסעים" : "Travelers"}<input value={draft.passengers} onChange={(event) => setDraft({ ...draft, passengers: event.target.value })} /></label>
        <label>{lang === "he" ? "מספר אישור" : "Confirmation number"}<input value={draft.confirmation} onChange={(event) => setDraft({ ...draft, confirmation: event.target.value })} /></label>
        <label className="editor-field-wide">{lang === "he" ? "קישור Google Maps" : "Google Maps link"}<input type="url" value={draft.location_url} onChange={(event) => setDraft({ ...draft, location_url: event.target.value })} placeholder="https://..." /></label>
        <label className="editor-field-wide">{lang === "he" ? "הערות לארגון" : "Organizer notes"}<input value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
      </div>
      <details className="booking-more-fields">
        <summary>{lang === "he" ? "ארנק וקבצים" : "Wallet and files"}</summary>
        <div className="booking-create-fields">
          <label>{lang === "he" ? "קישור Google Wallet" : "Google Wallet link"}<input type="url" value={draft.google_wallet_url} onChange={(event) => setDraft({ ...draft, google_wallet_url: event.target.value })} placeholder="https://..." /></label>
          <label>{lang === "he" ? "קישור Apple Wallet" : "Apple Wallet link"}<input type="url" value={draft.apple_wallet_url} onChange={(event) => setDraft({ ...draft, apple_wallet_url: event.target.value })} placeholder="https://..." /></label>
          <label>{lang === "he" ? "החלפת אישור PDF" : "Replace confirmation PDF"}<input type="file" accept="application/pdf" onChange={(event) => setConfirmationFile(event.target.files?.[0] || null)} /></label>
          <label>{lang === "he" ? "החלפת קובץ Apple Wallet" : "Replace Apple Wallet file"}<input type="file" accept=".pkpass,application/vnd.apple.pkpass" onChange={(event) => setWalletFile(event.target.files?.[0] || null)} /></label>
        </div>
      </details>
      <div className="booking-edit-actions">
        <button className="primary-action" type="submit" disabled={saveMutation.isPending || !draft.phase || !draft.name.trim()}>{saveMutation.isPending ? (lang === "he" ? "שומר…" : "Saving…") : (lang === "he" ? "שמירת שינויים" : "Save changes")}</button>
        {!confirmDelete ? <button className="secondary-action danger-text" type="button" onClick={() => setConfirmDelete(true)}>{lang === "he" ? "מחיקת הזמנה" : "Delete booking"}</button> : <div className="booking-delete-confirm" role="alert"><span>{lang === "he" ? "כרטיסי מסלול מקושרים יאבדו את קישורי ההזמנה. למחוק?" : "Linked Journey cards will lose their booking links. Delete it?"}</span><button className="secondary-action danger-text" type="button" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>{deleteMutation.isPending ? (lang === "he" ? "מוחק…" : "Deleting…") : (lang === "he" ? "כן, למחוק" : "Yes, delete")}</button><button className="secondary-action" type="button" onClick={() => setConfirmDelete(false)}>{lang === "he" ? "ביטול" : "Cancel"}</button></div>}
      </div>
      {saveMutation.isError ? <p className="form-error">{saveMutation.error instanceof Error ? saveMutation.error.message : (lang === "he" ? "לא ניתן לשמור את ההזמנה" : "Could not save the booking")}</p> : null}
      {deleteMutation.isError ? <p className="form-error">{deleteMutation.error instanceof Error ? deleteMutation.error.message : (lang === "he" ? "לא ניתן למחוק את ההזמנה" : "Could not delete the booking")}</p> : null}
    </form>
  );
}

export function BookingsView({ config, isOrganizer, lang, focus }: {
  config?: TripConfig; isOrganizer?: boolean; lang: Lang;
  /** Opened from a flight on Today: that booking's card is brought into view and marked; null shows the flights. */
  focus?: { bookingId: number | null } | null;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<BookingFilter>(focus && focus.bookingId === null ? "flight" : "phase");
  const [editingBookingId, setEditingBookingId] = useState<number | null>(null);
  const bookings = useQuery({ queryKey: ["bookings"], queryFn: getBookings });
  const today = useQuery({ queryKey: ["today"], queryFn: getToday, refetchInterval: 60_000 });
  const allRows = bookings.data || [];
  const activePhaseId = today.data?.current?.phase_id || today.data?.next?.phase_id || null;
  const rows = useMemo(() => allRows.filter((booking) => {
    if (filter === "phase") return true;
    if (filter === "current") return Boolean(activePhaseId) && booking.phase === activePhaseId;
    if (filter === "today") {
      const day = today.data?.today;
      return Boolean(day && booking.date_from && booking.date_from <= day && (!booking.date_to || booking.date_to >= day));
    }
    return booking.type === filter;
  }), [activePhaseId, allRows, filter, today.data?.today]);
  const grouped = useMemo(() => {
    const order = new globalThis.Map((config?.phases || []).map((phase, index) => [phase.id, index]));
    return Array.from(rows.reduce((map, booking) => {
      const key = booking.phase || "unassigned";
      map.set(key, [...(map.get(key) || []), booking]);
      return map;
    }, new globalThis.Map<string, Booking[]>()).entries()).sort(([a], [b]) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
  }, [config?.phases, rows]);
  const needsReview = rows.filter((booking) => bookingState(booking) !== "verified").length;
  // Two bookings on one flight stay two rows (#549); each says which it is.
  const sameFlight = useMemo(() => sameFlightGroups(allRows), [allRows]);
  const approveMutation = useMutation({
    mutationFn: approveBookingDraft,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bookings"] }),
  });
  const focusId = focus?.bookingId ?? null;
  const focusShown = focusId !== null && rows.some((booking) => booking.id === focusId);
  useEffect(() => {
    if (!focusShown) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(`booking-${focusId}`)?.scrollIntoView?.({ behavior: "smooth", block: "center" }));
    return () => window.cancelAnimationFrame(frame);
  }, [focus, focusId, focusShown]);

  return (
    <section className="module-layout">
      <div className="module-header">
        <span className="panel-label"><TicketCheck size={16} /> {moduleLabel("bookings", lang)}</span>
        <h2>{lang === "he" ? "הזמנות וכרטיסים במקום אחד" : "Bookings and tickets, one tap away"}</h2>
        <p>{lang === "he" ? "אישורים, ארנקים וקישורי מפה נשארים מחוץ לתקציב ומופיעים גם בכרטיסי המסלול הרלוונטיים." : "Confirmations, wallets, and map links stay separate from budget and also appear on matching journey cards."}</p>
        <div className="module-stats">
          <span>{rows.length} total</span>
          <span>{needsReview} need review</span>
        </div>
      </div>
      <div className="organizer-booking-tools"><BookingCreatePanel config={config} isOrganizer={isOrganizer} lang={lang} /></div>
      <div className="filter-row" aria-label="Booking filters">
        {([
          ["phase", lang === "he" ? "לפי שלב" : "By phase"],
          ["today", lang === "he" ? "היום" : "Today"],
          ["current", lang === "he" ? "השלב הנוכחי" : "Current phase"],
          ["flight", lang === "he" ? "טיסות" : "Flights"],
          ["hotel", lang === "he" ? "לינה" : "Stays"],
          ["attraction", lang === "he" ? "אטרקציות" : "Attractions"],
        ] as Array<[BookingFilter, string]>).map(([id, label]) => <button type="button" key={id} className={filter === id ? "filter-chip active" : "filter-chip"} onClick={() => setFilter(id)}>{label}</button>)}
      </div>
      {bookings.isError ? <p className="empty-state">Could not load bookings right now.</p> : null}
      <div className="booking-groups">
        {grouped.map(([phaseId, phaseBookings]) => (
          <section className="booking-group" key={phaseId}>
            <h3>{phaseTitle(config, phaseId, lang)}</h3>
            <div className="module-grid">
              {phaseBookings.map((booking) => (
                <article className={booking.id === focusId ? "booking-card is-focused" : "booking-card"} id={`booking-${booking.id}`} key={booking.id}>
                  <div className="booking-card-head">
                    <span className="booking-type">{bookingTypeLabel(booking.type, lang)}</span>
                    <span className={`status-pill ${bookingState(booking)}`}>{bookingState(booking) === "verified" ? "Verified" : bookingState(booking) === "draft" ? "Draft" : "Needs review"}</span>
                  </div>
                  <h4>{booking.name}</h4>
                  <p>{bookingDateLine(booking, lang)}</p>
                  {booking.passengers ? <small>{booking.passengers}</small> : null}
                  {sameFlight.get(booking.id) ? <small className="booking-same-flight">{copy(lang, `Same flight · booking ${sameFlight.get(booking.id)!.position} of ${sameFlight.get(booking.id)!.size}`, `אותה טיסה · הזמנה ${sameFlight.get(booking.id)!.position} מתוך ${sameFlight.get(booking.id)!.size}`)}</small> : null}
                  {/* Every member sees the trip's data unless the organizer asks otherwise (Dror, 2026-11-13, #555). */}
                  {booking.confirmation ? <small className="booking-reference">{copy(lang, "Reference", "מספר הזמנה")} {booking.confirmation}</small> : null}
                  <BookingActions booking={booking} lang={lang} />
                  {isOrganizer ? <SeedFlagNotice kind="booking" id={booking.id} changed={booking.seed_changed} removed={booking.seed_removed} lang={lang} /> : null}
                  {isOrganizer && booking.review_status === "draft" ? <button className="secondary-action" type="button" disabled={approveMutation.isPending} onClick={() => approveMutation.mutate(booking.id)}>{approveMutation.isPending ? "Approving..." : "Approve for members"}</button> : null}
                  {isOrganizer ? <button className="secondary-action" type="button" onClick={() => setEditingBookingId((current) => current === booking.id ? null : booking.id)}><Pencil size={15} /> {lang === "he" ? "עריכה" : "Edit"}</button> : null}
                  {isOrganizer && editingBookingId === booking.id ? <BookingEditPanel booking={booking} config={config} lang={lang} onClose={() => setEditingBookingId(null)} /> : null}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
      {!rows.length && !bookings.isLoading ? <p className="empty-state">No bookings have been added yet.</p> : null}
    </section>
  );
}

export function dailyMapStops(items: ItineraryItem[] | undefined) {
  // The same flight on two bookings is one stop (#549).
  return [...(collapseSameFlight(items) || [])]
    .filter((item) => Boolean(item.date && (item.location_url || item.waze_url)))
    .sort((a, b) => {
      const byDate = (a.date || "").localeCompare(b.date || "");
      if (byDate) return byDate;
      const byTime = (a.time_sort ?? Number.MAX_SAFE_INTEGER) - (b.time_sort ?? Number.MAX_SAFE_INTEGER);
      if (byTime) return byTime;
      return a.item_uid.localeCompare(b.item_uid);
    });
}

type MapPin = {
  id: string;
  phaseId: string;
  date?: string;
  itemUid?: string;
  lat: number;
  lng: number;
  title: string;
  subtitle: string;
  kind: "stay" | "stop";
};

function rasterMapStyle(tileUrl: string, attribution: string) {
  return {
    version: 8,
    sources: {
      raster: {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
        attribution,
      },
    },
    layers: [{ id: "raster", type: "raster", source: "raster" }],
  } satisfies import("maplibre-gl").StyleSpecification;
}

const freeMapStyle = rasterMapStyle(
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  "© OpenStreetMap contributors",
);
const satelliteTileUrl = import.meta.env.VITE_SATELLITE_TILE_URL?.trim() || "";
const satelliteAttribution = import.meta.env.VITE_SATELLITE_ATTRIBUTION?.trim() || "";
const satelliteMapStyle = satelliteTileUrl && satelliteAttribution
  ? rasterMapStyle(satelliteTileUrl, satelliteAttribution)
  : null;

/*
 * Satellite imagery is opt-in at build time. A provider's tile URL and its
 * required attribution must be supplied explicitly; trip coordinates are not
 * sent to an unreviewed third party merely because a map screen is opened.
 */
const mapModes = satelliteMapStyle ? (["raster", "3d", "satellite"] as const) : (["raster", "3d"] as const);

function validCoordinates(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function coordinatesFromLocationUrl(locationUrl: string | null | undefined) {
  if (!locationUrl) return null;
  try {
    const url = new URL(locationUrl);
    const fromPath = url.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    const candidate = fromPath?.slice(1) || (url.searchParams.get("ll") || url.searchParams.get("q") || url.searchParams.get("query") || "").match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/)?.slice(1);
    if (!candidate) return null;
    const [lat, lng] = candidate.map(Number);
    return validCoordinates(lat, lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

export function mapPins(config: TripConfig | undefined, items: ItineraryItem[] | undefined, lang: Lang): MapPin[] {
  const stopsByPhase = new globalThis.Map<string, MapPin[]>();
  dailyMapStops(items).forEach((item) => {
    const coordinates = coordinatesFromLocationUrl(item.location_url || item.waze_url);
    if (!coordinates) return;
    const stops = stopsByPhase.get(item.phase_id) || [];
    stops.push({
      id: `stop:${item.item_uid}`,
      phaseId: item.phase_id,
      date: item.date || undefined,
      itemUid: item.item_uid,
      ...coordinates,
      title: itemTitle(item, lang),
      subtitle: `${dateLabel(item.date!, lang)}${item.time ? ` · ${itineraryTimeLabel(item.time, lang)}` : ""}`,
      kind: "stop",
    });
    stopsByPhase.set(item.phase_id, stops);
  });
  const configuredPhaseIds = new Set((config?.phases || []).map((phase) => phase.id));
  const orderedPins = (config?.phases || []).flatMap((phase) => {
    const phasePins: MapPin[] = [];
    // The hotel's own coordinates (from its map link) come first; the stop's
    // town pin is only the fallback. Never a coordinate nobody supplied.
    const hotelCoordinates = coordinatesFromLocationUrl(phase.accommodation?.location_url);
    const lat = hotelCoordinates?.lat ?? phase.mapStop?.lat;
    const lng = hotelCoordinates?.lng ?? phase.mapStop?.lng;
    const phaseDate = phase.start || dailyMapStops(items).find((item) => item.phase_id === phase.id)?.date;
    if (validCoordinates(lat ?? Number.NaN, lng ?? Number.NaN)) {
      const accommodation = text(phase.accommodation?.name, lang) || phase.accommodation?.name_en || text(phase.mapStop?.name, lang) || text(phase.title, lang) || phase.id;
      phasePins.push({
        id: `stay:${phase.id}`,
        phaseId: phase.id,
        date: phaseDate || undefined,
        lat: lat!,
        lng: lng!,
        title: accommodation,
        subtitle: `${text(phase.title, lang) || phase.id} · ${copy(lang, "Accommodation", "לינה")}`,
        kind: "stay",
      });
    }
    phasePins.push(...(stopsByPhase.get(phase.id) || []));
    return phasePins;
  });
  const orphanStops = dailyMapStops(items).flatMap((item) => configuredPhaseIds.has(item.phase_id) ? [] : (stopsByPhase.get(item.phase_id) || []));
  return [...orderedPins, ...orphanStops.filter((pin, index, pins) => pins.findIndex((candidate) => candidate.id === pin.id) === index)];
}

export function wrappedMapIndex(index: number, count: number) {
  return count > 0 ? ((index % count) + count) % count : 0;
}

export function InteractiveMap({
  pins,
  lang,
  onOpenItinerary,
  focusRequest,
}: {
  pins: MapPin[];
  lang: Lang;
  onOpenItinerary: (pin: MapPin) => void;
  focusRequest?: { pinId: string; sequence: number } | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const markerRefs = useRef<Array<import("maplibre-gl").Marker>>([]);
  const markerElementRefs = useRef(new globalThis.Map<string, HTMLButtonElement>());
  const [activeIndex, setActiveIndex] = useState(0);
  const [mapMode, setMapMode] = useState<(typeof mapModes)[number]>("raster");
  const [buildingStatus, setBuildingStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const activePin = pins[activeIndex] || pins[0];

  function syncActiveMarkerLabel(pinId: string | undefined) {
    markerElementRefs.current.forEach((element, id) => {
      const active = Boolean(pinId && id === pinId);
      element.classList.toggle("active", active);
      if (active) element.setAttribute("aria-current", "location");
      else element.removeAttribute("aria-current");
    });
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pins.length) return;
    let disposed = false;
    let buildingTimeout: ReturnType<typeof setTimeout> | undefined;
    let map: import("maplibre-gl").Map | undefined;
    void Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css"), import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url")]).then(([maplibregl, , worker]) => {
      if (disposed) return;
      // v6's worker must go through Vite's worker pipeline, including its
      // shared imports. Auto-detection points at a missing file after bundling.
      maplibregl.setWorkerUrl(worker.default);
      const instance = new maplibregl.Map({
        container,
        style: mapMode === "3d" ? "https://tiles.openfreemap.org/styles/bright" : mapMode === "satellite" && satelliteMapStyle ? satelliteMapStyle : freeMapStyle,
        center: [pins[0].lng, pins[0].lat],
        zoom: pins.length === 1 ? 12 : 5,
        pitch: mapMode === "3d" ? 50 : 0,
        bearing: mapMode === "3d" ? -20 : 0,
        canvasContextAttributes: { antialias: true },
      });
      map = instance;
      mapRef.current = instance;
      if (mapMode === "3d") {
        setBuildingStatus("loading");
        buildingTimeout = setTimeout(() => setBuildingStatus("unavailable"), 15000);
      }
      instance.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
      // Install the building layer once the style is ready; trip markers
      // below do not wait for any third-party style or tiles.
      instance.on("style.load", () => {
        // Load the vector map and building data only in the opt-in 3D view.
        if (mapMode === "3d") {
          instance.on("sourcedata", (event) => {
            if (event.sourceId === "buildings" && event.isSourceLoaded) {
              clearTimeout(buildingTimeout);
              setBuildingStatus("ready");
            }
          });
          instance.addSource("buildings", { type: "vector", url: "https://tiles.openfreemap.org/planet" });
          const firstLabel = instance.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
          instance.addLayer({
            id: "trip-3d-buildings",
            type: "fill-extrusion",
            source: "buildings",
            "source-layer": "building",
            minzoom: 14,
            filter: ["!=", ["get", "hide_3d"], true],
            paint: {
              "fill-extrusion-color": "#a3bcb7",
              "fill-extrusion-height": ["coalesce", ["get", "render_height"], 3],
              "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
              "fill-extrusion-opacity": 0.85,
            },
          }, firstLabel);
        }
      });
      // Trip markers remain usable even when the basemap provider is offline.
      pins.forEach((pin) => {
        const markerButton = document.createElement("button");
        markerButton.type = "button";
        markerButton.className = "map-pin-marker";
        markerButton.setAttribute("aria-label", `${pin.title} — ${pin.subtitle}`);
        markerButton.title = pin.title;
        const dot = document.createElement("span");
        dot.className = `map-pin-dot ${pin.kind === "stay" ? "stay" : "stop"}`;
        dot.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.className = "map-pin-label";
        label.textContent = pin.title;
        markerButton.append(dot, label);
        markerButton.addEventListener("click", () => {
          const nextIndex = pins.findIndex((candidate) => candidate.id === pin.id);
          if (nextIndex >= 0) setActiveIndex(nextIndex);
          onOpenItinerary(pin);
        });
        markerElementRefs.current.set(pin.id, markerButton);
        const marker = new maplibregl.Marker({ element: markerButton, anchor: "bottom" })
          .setLngLat([pin.lng, pin.lat])
          .addTo(instance);
        markerRefs.current.push(marker);
      });
      syncActiveMarkerLabel(activePin?.id);
      if (activePin) instance.jumpTo({ center: [activePin.lng, activePin.lat], zoom: 16 });
      instance.resize();
    }).catch(() => {
      if (!disposed) setBuildingStatus("unavailable");
    });
    return () => {
      disposed = true;
      clearTimeout(buildingTimeout);
      markerRefs.current.forEach((marker) => marker.remove());
      markerRefs.current = [];
      markerElementRefs.current.clear();
      map?.remove();
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [mapMode, pins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activePin) return;
    syncActiveMarkerLabel(activePin.id);
    map.flyTo({ center: [activePin.lng, activePin.lat], zoom: 16, pitch: mapMode === "3d" ? 50 : 0, duration: 1100 });
  }, [activeIndex, activePin]);

  useEffect(() => {
    if (!focusRequest) return;
    const nextIndex = pins.findIndex((pin) => pin.id === focusRequest.pinId);
    if (nextIndex < 0) return;
    if (nextIndex !== activeIndex) {
      setActiveIndex(nextIndex);
      return;
    }
    const map = mapRef.current;
    const pin = pins[nextIndex];
    if (!map || !pin) return;
    syncActiveMarkerLabel(pin.id);
    map.flyTo({ center: [pin.lng, pin.lat], zoom: 16, pitch: mapMode === "3d" ? 50 : 0, duration: 1100 });
  }, [focusRequest, pins]);

  function moveTo(index: number) {
    setActiveIndex(wrappedMapIndex(index, pins.length));
  }

  function showAll() {
    const map = mapRef.current;
    if (!map || !pins.length) return;
    if (pins.length === 1) {
      map.flyTo({ center: [pins[0].lng, pins[0].lat], zoom: 16, pitch: mapMode === "3d" ? 50 : 0, duration: 1100 });
      return;
    }
    const west = Math.min(...pins.map((pin) => pin.lng));
    const east = Math.max(...pins.map((pin) => pin.lng));
    const south = Math.min(...pins.map((pin) => pin.lat));
    const north = Math.max(...pins.map((pin) => pin.lat));
    map.fitBounds([[west, south], [east, north]], { padding: 54, maxZoom: 5, pitch: 0, bearing: 0, duration: 1100 });
  }

  return (
    <>
      <div className="map-toolbar" aria-label={lang === "he" ? "ניווט בין נקודות" : "Location navigation"}>
        <button className="map-control-button" type="button" onClick={() => moveTo(activeIndex - 1)}>
          {lang === "he" ? <ChevronRight size={16} /> : <ChevronLeft size={16} />} {lang === "he" ? "הקודם" : "Previous"}
        </button>
        <span className="map-location-counter" aria-live="polite">{activePin ? `${activeIndex + 1} / ${pins.length} · ${activePin.title}` : ""}</span>
        <button className="map-control-button" type="button" onClick={() => moveTo(activeIndex + 1)}>
          {lang === "he" ? "הבא" : "Next"} {lang === "he" ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
        <button className="map-control-button" type="button" onClick={showAll}>
          <Globe2 size={16} /> {lang === "he" ? "הצג הכל" : "Show all"}
        </button>
        {mapModes.length > 1 ? (
          <div className="map-mode-switch" role="group" aria-label={lang === "he" ? "סגנון מפה" : "Map style"}>
            {mapModes.map((mode) => <button key={mode} className={mapMode === mode ? "active" : ""} aria-pressed={mapMode === mode} type="button" onClick={() => setMapMode(mode)}>{mode === "satellite" ? (lang === "he" ? "לוויין" : "Satellite") : mode === "3d" ? "3D" : "2D"}</button>)}
          </div>
        ) : null}
      </div>
      <div ref={containerRef} className="interactive-map" aria-label={lang === "he" ? "מפת הטיול" : "Trip map"} />
      {mapMode === "3d" && buildingStatus !== "ready" ? <p role="status">{buildingStatus === "loading" ? (lang === "he" ? "טוען מבנים בתלת־ממד…" : "Loading 3D buildings…") : (lang === "he" ? "מפת התלת־ממד מתעכבת. אפשר לעבור ל־2D ולהמשיך לצפות בנקודות הטיול." : "The 3D map is taking longer to load. Switch to 2D to keep exploring your trip stops.")}</p> : null}
    </>
  );
}

export function MapView({ config, itinerary, lang, onOpenItinerary }: { config?: TripConfig; itinerary?: ActiveItinerary; lang: Lang; onOpenItinerary: (pin: MapPin) => void }) {
  // A stop belongs here when it has a map pin OR a named hotel: a hotel the
  // companion added has links (server/hotel-place.js) even where the stop has no
  // coordinates, and used to get no card at all.
  const phaseStops = (config?.phases || []).filter((phase) => (typeof phase.mapStop?.lat === "number" && typeof phase.mapStop?.lng === "number")
    || Boolean(text(phase.accommodation?.name, "en") || phase.accommodation?.name_en));
  const dailyStops = dailyMapStops(itinerary?.items);
  const pins = useMemo(() => mapPins(config, itinerary?.items, lang), [config, itinerary?.items, lang]);
  const mapPanelRef = useRef<HTMLElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ pinId: string; sequence: number } | null>(null);

  function focusPhaseOnMap(phaseId: string) {
    setFocusRequest((current) => ({ pinId: `stay:${phaseId}`, sequence: (current?.sequence || 0) + 1 }));
    window.requestAnimationFrame(() => mapPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <section className="module-layout">
      <div className="module-header">
        <span className="panel-label"><Map size={16} /> {moduleLabel("map", lang)}</span>
        <h2>{lang === "he" ? "תחנות לינה ונקודות יומיות" : "Accommodation and daily stops"}</h2>
        <p>{lang === "he" ? "תחנות הלינה והנקודות היומיות מהמסלול מוצגות לפי הסדר, עם ניווט מהיר לקישורים שכבר אושרו." : "Accommodation anchors and dated itinerary stops appear in order, with one-tap navigation to the links already confirmed for the trip."}</p>
      </div>
      {pins.length ? (
        <section ref={mapPanelRef} className="map-canvas-panel">
          <div className="map-stop-heading">
            <h3>{lang === "he" ? "מפת הטיול" : "Trip map"}</h3>
            <p>{lang === "he" ? "ירוק: לינה. כתום: נקודה יומית עם קואורדינטות מאומתות." : "Teal: accommodation. Coral: daily stop with verified coordinates."}</p>
          </div>
          <InteractiveMap pins={pins} lang={lang} onOpenItinerary={onOpenItinerary} focusRequest={focusRequest} />
        </section>
      ) : <p className="empty-state">{lang === "he" ? "נוסיף מפה ברגע שיהיו קואורדינטות לתחנות הטיול." : "A map will appear once the trip has confirmed stop coordinates."}</p>}
      <div className="module-grid">
        {phaseStops.map((phase) => {
          const accommodationName = text(phase.accommodation?.name, lang) || phase.accommodation?.name_en || text(phase.mapStop?.name, lang) || text(phase.title, lang) || phase.id;
          // The server resolves the hotel's links (server/hotel-place.js), so
          // this card, Today, Journey and the booking all open the same place.
          // The fallbacks are for a hotel the config file itself carries.
          const hotelCoordinates = coordinatesFromLocationUrl(phase.accommodation?.location_url);
          const stopLat = hotelCoordinates?.lat ?? phase.mapStop?.lat;
          const stopLng = hotelCoordinates?.lng ?? phase.mapStop?.lng;
          const hasCoordinates = validCoordinates(stopLat ?? Number.NaN, stopLng ?? Number.NaN);
          const ll = hasCoordinates ? `${stopLat},${stopLng}` : "";
          const hotelLabel = phase.accommodation?.name_en || text(phase.accommodation?.name, "en");
          const searchText = phase.accommodation?.address || [hotelLabel, text(phase.title, "en")].filter(Boolean).join(", ") || ll || accommodationName;
          const destination = safeExternalUrl(phase.accommodation?.location_url) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchText)}`;
          const wazeDestination = safeExternalUrl(phase.accommodation?.waze) || (hasCoordinates
            ? `https://waze.com/ul?ll=${encodeURIComponent(ll)}&navigate=yes`
            : `https://waze.com/ul?q=${encodeURIComponent(searchText)}&navigate=yes`);
          return (
            <article className="map-anchor" key={phase.id}>
              <span className="booking-type">{lang === "he" ? "שלב" : "Phase"}</span>
              <button
                className="map-anchor-title"
                type="button"
                onClick={() => focusPhaseOnMap(phase.id)}
                aria-label={copy(lang, `Show ${text(phase.title, lang) || phase.id} on the map`, `הצגת ${text(phase.title, lang) || phase.id} במפה`)}
              >
                <MapPin size={18} aria-hidden="true" />
                {text(phase.title, lang) || phase.id}
              </button>
              <p>{accommodationName}{phase.accommodation?.address ? ` · ${phase.accommodation.address}` : ""}</p>
              <div className="action-strip">
                <a href={destination} target="_blank" rel="noreferrer"><MapPin size={15} /> Google Maps</a>
                <a href={wazeDestination} target="_blank" rel="noreferrer"><Navigation size={15} /> Waze</a>
              </div>
            </article>
          );
        })}
      </div>
      {!phaseStops.length ? <p className="empty-state">No phase accommodation stops have been added yet.</p> : null}
      <section className="map-stop-section">
        <div className="map-stop-heading">
          <h3>{lang === "he" ? "נקודות יומיות" : "Daily itinerary stops"}</h3>
          <p>{lang === "he" ? "מוצגים רק פריטים מתוארכים עם קישור לניווט; פריטים עם קואורדינטות מופיעים גם על המפה." : "Only dated itinerary items with a saved navigation link appear here; those with coordinates are also pinned on the map."}</p>
        </div>
        <div className="module-grid">
          {dailyStops.map((item) => (
            <article className="map-anchor" key={item.item_uid}>
              <span className="booking-type">{itemTypeLabel(item.item_type, lang)}</span>
              <h3>{itemTitle(item, lang)}</h3>
              <p>{dateLabel(item.date!, lang)}{item.time ? ` · ${itineraryTimeLabel(item.time, lang)}` : ""}</p>
              <div className="action-strip">
                {item.location_url ? <a href={item.location_url} target="_blank" rel="noreferrer"><MapPin size={15} /> Google Maps</a> : null}
                {item.waze_url ? <a href={item.waze_url} target="_blank" rel="noreferrer"><Navigation size={15} /> Waze</a> : null}
              </div>
            </article>
          ))}
        </div>
        {!dailyStops.length ? <p className="empty-state">{lang === "he" ? "עדיין אין נקודות יומיות עם קישור ניווט." : "No dated itinerary stops have a navigation link yet."}</p> : null}
      </section>
    </section>
  );
}

const budgetCategoryMeta: Record<string, { icon: string; en: string; he: string }> = {
  flight: { icon: "✈️", en: "Flights", he: "טיסות" },
  transport: { icon: "🚆", en: "Transport", he: "תחבורה" },
  car: { icon: "🚗", en: "Car", he: "רכב" },
  hotel: { icon: "🏨", en: "Lodging", he: "לינה" },
  lodging: { icon: "🏨", en: "Lodging", he: "לינה" },
  food: { icon: "🍽️", en: "Food", he: "אוכל" },
  activity: { icon: "🎟️", en: "Activities", he: "פעילויות" },
  activities: { icon: "🎟️", en: "Activities", he: "פעילויות" },
  shopping: { icon: "🛍️", en: "Shopping", he: "קניות" },
  other: { icon: "📌", en: "Other", he: "אחר" },
};

function budgetMoney(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value % 1 ? 2 : 0 }).format(value);
}

function budgetPhaseName(phaseId: string, config: TripConfig | undefined, lang: Lang) {
  if (phaseId === "intl_flights") return copy(lang, "International flights", "טיסות בינלאומיות");
  if (phaseId === "general") return copy(lang, "Whole trip", "כל הטיול");
  const phase = config?.phases?.find((item) => item.id === phaseId);
  return phase ? text(phase.title, lang) : phaseId.replace(/[_-]+/g, " ");
}

function BudgetRow({ item, lang, onSave, onDelete }: { item: BudgetItem; lang: Lang; onSave: (id: number, values: { amount: number; description: string }) => Promise<boolean>; onDelete: (id: number) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  useLiveEditGuard(editing, "budget");
  const [description, setDescription] = useState(item.description);
  const [amount, setAmount] = useState(String(item.amount));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const meta = budgetCategoryMeta[item.category] || budgetCategoryMeta.other;

  if (editing) {
    return (
      <div className="budget-row budget-row-editing">
        <span className="budget-category-icon" aria-hidden="true">{meta.icon}</span>
        <label>{copy(lang, "Description", "תיאור")}<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>{copy(lang, "Amount", "סכום")}<input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
        <div className="budget-row-actions">
          <button type="button" onClick={async () => { if (await onSave(item.id, { description: description.trim(), amount: Number(amount) })) setEditing(false); }}>{copy(lang, "Save", "שמירה")}</button>
          <button type="button" onClick={() => setEditing(false)}>{copy(lang, "Cancel", "ביטול")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className={item.is_estimate && item.amount === 0 ? "budget-row budget-row-missing" : "budget-row"}>
      <span className="budget-category-icon" title={meta[lang]}>{meta.icon}</span>
      <div className="budget-row-copy">
        <strong>{item.description}</strong>
        <small>{meta[lang]}{item.is_estimate ? ` · ${copy(lang, "estimate", "הערכה")}` : ""}</small>
      </div>
      <strong className={item.is_estimate ? "budget-estimate" : ""}>{item.is_estimate && item.amount === 0 ? "?" : `${item.is_estimate ? "~" : ""}${budgetMoney(item.amount)}`}</strong>
      <div className="budget-row-actions">
        <button type="button" onClick={() => { setDescription(item.description); setAmount(String(item.amount)); setEditing(true); }} aria-label={`${copy(lang, "Edit", "עריכה")} ${item.description}`}><Pencil size={15} /></button>
        {confirmingDelete ? (
          <>
            <button className="danger-action" type="button" onClick={async () => { if (await onDelete(item.id)) setConfirmingDelete(false); }}>{copy(lang, "Confirm", "אישור")}</button>
            <button type="button" onClick={() => setConfirmingDelete(false)}>{copy(lang, "Cancel", "ביטול")}</button>
          </>
        ) : <button type="button" onClick={() => setConfirmingDelete(true)} aria-label={`${copy(lang, "Delete", "מחיקה")} ${item.description}`}><Trash2 size={15} /></button>}
      </div>
    </div>
  );
}

export function BudgetView({ config, lang }: { config?: TripConfig; lang: Lang }) {
  const queryClient = useQueryClient();
  const budget = useQuery({ queryKey: ["budget"], queryFn: getBudget });
  const [phase, setPhase] = useState(config?.phases?.[0]?.id || "general");
  const [category, setCategory] = useState("other");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [isEstimate, setIsEstimate] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const items = budget.data || [];
  const total = items.reduce((sum, item) => sum + (item.amount || 0), 0);
  const missing = items.filter((item) => item.is_estimate && item.amount === 0);
  const travelerCount = Math.max(config?.participants?.length || 0, 1);
  const configuredOrder = new globalThis.Map((config?.phases || []).map((item, index) => [item.id, index]));
  const groups = Array.from(items.reduce((map, item) => {
    if (!map.has(item.phase)) map.set(item.phase, []);
    map.get(item.phase)!.push(item);
    return map;
  }, new globalThis.Map<string, BudgetItem[]>()).entries()).sort(([a], [b]) => {
    const rank = (value: string) => value === "intl_flights" ? -1 : configuredOrder.get(value) ?? 999;
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["budget"] });
  }

  async function addItem(event: React.FormEvent) {
    event.preventDefault();
    const parsedAmount = Number(amount);
    if (!description.trim() || !Number.isFinite(parsedAmount) || parsedAmount < 0) {
      setError(copy(lang, "Add a description and a valid amount.", "יש להוסיף תיאור וסכום תקין."));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await createBudgetItem({ phase, category, description: description.trim(), amount: parsedAmount, is_estimate: isEstimate });
      setDescription("");
      setAmount("");
      setIsEstimate(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy(lang, "Could not add expense.", "לא ניתן להוסיף הוצאה."));
    } finally {
      setSaving(false);
    }
  }

  async function saveItem(id: number, values: { amount: number; description: string }) {
    if (!values.description || !Number.isFinite(values.amount) || values.amount < 0) {
      setError(copy(lang, "Add a description and a valid amount.", "יש להוסיף תיאור וסכום תקין."));
      return false;
    }
    setError("");
    try {
      await updateBudgetItem(id, values);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : copy(lang, "Could not update expense.", "לא ניתן לעדכן את ההוצאה."));
      return false;
    }
  }

  async function removeItem(id: number) {
    setError("");
    try {
      await deleteBudgetItem(id);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : copy(lang, "Could not delete expense.", "לא ניתן למחוק את ההוצאה."));
      return false;
    }
  }

  return (
    <section className="module-layout budget-layout">
      <div className="module-header">
        <span className="panel-label"><DollarSign size={16} /> {moduleLabel("budget", lang)}</span>
        <h2>{copy(lang, "Trip budget", "תקציב הטיול")}</h2>
        <p>{copy(lang, "Known costs and working estimates, grouped by the part of the trip they belong to.", "עלויות ידועות והערכות עבודה, לפי חלקי הטיול.")}</p>
      </div>
      <section className="budget-summary" aria-label={copy(lang, "Budget summary", "סיכום תקציב")}>
        <div><small>{copy(lang, "Current total", "סה״כ נוכחי")}</small><strong>{budgetMoney(total)}</strong></div>
        <div><small>{copy(lang, "Split", "חלוקה")}</small><strong>{budgetMoney(total / travelerCount)} {copy(lang, "per traveler", "למטייל")}</strong></div>
        <div><small>{copy(lang, "Still unknown", "עדיין חסר")}</small><strong>{missing.length}</strong></div>
      </section>
      {missing.length ? <p className="module-alert"><AlertTriangle size={17} /> {copy(lang, `${missing.length} estimated ${missing.length === 1 ? "cost has" : "costs have"} no amount yet.`, `ל-${missing.length} הוצאות משוערות עדיין אין סכום.`)}</p> : null}
      <div className="budget-groups">
        {groups.map(([phaseId, phaseItems]) => (
          <section className="budget-phase-card" key={phaseId}>
            <header><div><small>{copy(lang, "Trip phase", "שלב בטיול")}</small><h3>{budgetPhaseName(phaseId, config, lang)}</h3></div><strong>{copy(lang, "Subtotal", "סיכום ביניים")} · {budgetMoney(phaseItems.reduce((sum, item) => sum + item.amount, 0))}</strong></header>
            <div>{phaseItems.map((item) => <BudgetRow key={item.id} item={item} lang={lang} onSave={saveItem} onDelete={removeItem} />)}</div>
          </section>
        ))}
        {!budget.isLoading && !groups.length ? <p className="empty-state">{copy(lang, "No costs have been added yet.", "עדיין לא נוספו עלויות.")}</p> : null}
        {budget.isLoading ? <p className="empty-state">{copy(lang, "Loading budget…", "טוען תקציב…")}</p> : null}
        {budget.isError ? <p className="form-error" role="alert">{copy(lang, "Could not load the budget.", "לא ניתן לטעון את התקציב.")}</p> : null}
      </div>
      <form className="budget-add-panel" onSubmit={addItem}>
        <div><span className="panel-label"><Plus size={15} /> {copy(lang, "Add a cost", "הוספת הוצאה")}</span><h3>{copy(lang, "Keep the shared picture current", "עדכון התמונה המשותפת")}</h3></div>
        <div className="budget-add-fields">
          <label>{copy(lang, "Trip phase", "שלב בטיול")}<MobileSelect value={phase} onChange={(event) => setPhase(event.target.value)}><option value="general">{copy(lang, "Whole trip", "כל הטיול")}</option><option value="intl_flights">{copy(lang, "International flights", "טיסות בינלאומיות")}</option>{config?.phases?.map((item) => <option key={item.id} value={item.id}>{text(item.title, lang)}</option>)}</MobileSelect></label>
          <label>{copy(lang, "Category", "קטגוריה")}<MobileSelect value={category} onChange={(event) => setCategory(event.target.value)}>{Object.entries(budgetCategoryMeta).filter(([key]) => !["lodging", "activities"].includes(key)).map(([key, meta]) => <option key={key} value={key}>{meta.icon} {meta[lang]}</option>)}</MobileSelect></label>
          <label>{copy(lang, "Description", "תיאור")}<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label>{copy(lang, "Amount (USD)", "סכום (USD)")}<input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          <label className="checkbox-field"><input type="checkbox" checked={isEstimate} onChange={(event) => setIsEstimate(event.target.checked)} /> {copy(lang, "This is an estimate", "זו הערכה")}</label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-action" type="submit" disabled={saving}>{saving ? copy(lang, "Adding…", "מוסיף…") : copy(lang, "Add expense", "הוספת הוצאה")}</button>
      </form>
    </section>
  );
}

export function PhotosView({ config, currentUser, lang }: { config?: TripConfig; currentUser?: CurrentUser; lang: Lang }) {
  const queryClient = useQueryClient();
  const photos = useQuery({ queryKey: ["photos"], queryFn: () => getPhotos() });
  const reactions = useQuery({ queryKey: ["photo-reactions"], queryFn: getPhotoReactions });
  const comments = useQuery({ queryKey: ["photo-comments"], queryFn: getPhotoComments });
  const [filter, setFilter] = useState("all");
  const [uploadPhase, setUploadPhase] = useState(config?.phases?.[0]?.id || "general");
  const [caption, setCaption] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  useLiveEditGuard(Object.values(commentDrafts).some(Boolean), "photos");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visiblePhotos = (photos.data || []).filter((photo) => filter === "all" || photo.phase === filter);

  async function refreshPhotos() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["photos"] }),
      queryClient.invalidateQueries({ queryKey: ["photo-reactions"] }),
      queryClient.invalidateQueries({ queryKey: ["photo-comments"] }),
    ]);
  }

  async function submitUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError(copy(lang, "Choose a photo first.", "יש לבחור תמונה תחילה."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await uploadPhoto(file, { phase: uploadPhase, caption: caption.trim() });
      setFile(null);
      setCaption("");
      await refreshPhotos();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy(lang, "Could not upload photo.", "לא ניתן להעלות תמונה."));
    } finally {
      setBusy(false);
    }
  }

  async function react(photoId: string, emoji: string) {
    setError("");
    try {
      await togglePhotoReaction(photoId, emoji);
      await queryClient.invalidateQueries({ queryKey: ["photo-reactions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : copy(lang, "Could not save reaction.", "לא ניתן לשמור את התגובה."));
    }
  }

  async function submitComment(photoId: string) {
    const body = commentDrafts[photoId]?.trim();
    if (!body) return;
    setError("");
    try {
      await postPhotoComment(photoId, body);
      setCommentDrafts((drafts) => ({ ...drafts, [photoId]: "" }));
      await queryClient.invalidateQueries({ queryKey: ["photo-comments"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : copy(lang, "Could not save comment.", "לא ניתן לשמור את התגובה."));
    }
  }

  async function removePhoto(photoId: string) {
    setError("");
    try {
      await deletePhoto(photoId);
      setConfirmingDelete(null);
      await refreshPhotos();
    } catch (err) {
      setError(err instanceof Error ? err.message : copy(lang, "Could not delete photo.", "לא ניתן למחוק את התמונה."));
    }
  }

  return (
    <section className="module-layout photos-layout">
      <div className="module-header">
        <span className="panel-label"><Camera size={16} /> {moduleLabel("photos", lang)}</span>
        <h2>{copy(lang, "Trip photos", "תמונות מהטיול")}</h2>
        <p>{copy(lang, "A shared gallery for the moments everyone wants to keep, with reactions and conversation together.", "גלריה משותפת לרגעים שרוצים לשמור, יחד עם תגובות ושיחה.")}</p>
      </div>
      <form className="photo-upload-panel" onSubmit={submitUpload}>
        <label className="upload-control"><Upload size={18} /><span>{file?.name || copy(lang, "Choose photo", "בחירת תמונה")}</span><input type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>
        <label>{copy(lang, "Album", "אלבום")}<MobileSelect value={uploadPhase} onChange={(event) => setUploadPhase(event.target.value)}><option value="general">{copy(lang, "General", "כללי")}</option>{config?.phases?.map((item) => <option key={item.id} value={item.id}>{text(item.title, lang)}</option>)}</MobileSelect></label>
        <label className="photo-caption-field">{copy(lang, "Caption", "כיתוב")}<input value={caption} onChange={(event) => setCaption(event.target.value)} placeholder={copy(lang, "What was happening?", "מה קרה כאן?")} /></label>
        <button className="primary-action" type="submit" disabled={busy}>{busy ? copy(lang, "Uploading…", "מעלה…") : copy(lang, "Add to gallery", "הוספה לגלריה")}</button>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </form>
      <div className="photo-filter" role="group" aria-label={copy(lang, "Photo album", "אלבום תמונות")}>
        <button className={filter === "all" ? "active" : ""} type="button" onClick={() => setFilter("all")}>{copy(lang, "All", "הכול")}</button>
        <button className={filter === "general" ? "active" : ""} type="button" onClick={() => setFilter("general")}>{copy(lang, "General", "כללי")}</button>
        {config?.phases?.map((item) => <button className={filter === item.id ? "active" : ""} key={item.id} type="button" onClick={() => setFilter(item.id)}>{text(item.title, lang)}</button>)}
      </div>
      <div className="photo-grid">
        {visiblePhotos.map((photo) => {
          const photoComments = comments.data?.[photo.id] || [];
          const photoReactions = reactions.data?.[photo.id] || {};
          const authorName = personName(photo.user, lang);
          const alt = photo.caption || copy(lang, `Photo by ${authorName}`, `תמונה מאת ${authorName}`);
          return (
            <article className="photo-card" key={photo.id}>
              <img className="photo-image" src={photo.url ? runtimeUrl(photo.url) : safeFileUrl("/api/photos/file", photo.filename)} alt={alt} loading="lazy" />
              <div className="photo-card-body">
                <div className="photo-author"><PersonAvatar username={photo.username} name={authorName} color={photo.user.color} size="small" /><div><strong>{authorName}</strong><small>{new Date(photo.uploadedAt).toLocaleDateString(lang === "he" ? "he-IL" : "en-US", { month: "short", day: "numeric", year: "numeric" })} · {budgetPhaseName(photo.phase, config, lang)}</small></div></div>
                {photo.caption ? <p className="photo-caption">{photo.caption}</p> : null}
                <div className="photo-reactions">
                  {photoReactionEmojis.map((emoji) => {
                    const users = photoReactions[emoji] || [];
                    const active = users.includes(currentUser?.username || "");
                    return <button className={active ? "active" : ""} key={emoji} type="button" onClick={() => react(photo.id, emoji)} aria-label={`${copy(lang, "React with", "תגובה עם")} ${emoji}`}>{emoji}{users.length ? <span>{users.length}</span> : null}</button>;
                  })}
                </div>
                <div className="photo-comments">
                  {photoComments.map((comment) => {
                    const commentName = personName(comment.user, lang);
                    return <div className="photo-comment" key={comment.id}><PersonAvatar username={comment.username} name={commentName} color={comment.user.color} size="small" /><div><strong>{commentName}</strong><p>{comment.body}</p></div></div>;
                  })}
                  <div className="photo-comment-form"><input aria-label={`${copy(lang, "Comment on", "תגובה על")} ${alt}`} value={commentDrafts[photo.id] || ""} onChange={(event) => setCommentDrafts((drafts) => ({ ...drafts, [photo.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitComment(photo.id); } }} placeholder={copy(lang, "Write a comment", "כתיבת תגובה")} /><button type="button" onClick={() => submitComment(photo.id)} aria-label={copy(lang, "Send comment", "שליחת תגובה")}><Send size={16} /></button></div>
                </div>
                {photo.username === currentUser?.username ? (
                  <div className="photo-delete-actions">
                    {confirmingDelete === photo.id ? <><span>{copy(lang, "Delete this photo?", "למחוק את התמונה?")}</span><button className="danger-action" type="button" onClick={() => removePhoto(photo.id)}>{copy(lang, "Delete", "מחיקה")}</button><button type="button" onClick={() => setConfirmingDelete(null)}>{copy(lang, "Cancel", "ביטול")}</button></> : <button type="button" onClick={() => setConfirmingDelete(photo.id)}><Trash2 size={15} /> {copy(lang, "Delete photo", "מחיקת תמונה")}</button>}
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
        {!photos.isLoading && !visiblePhotos.length ? <p className="empty-state">{copy(lang, "No photos in this album yet.", "עדיין אין תמונות באלבום הזה.")}</p> : null}
        {photos.isLoading || reactions.isLoading || comments.isLoading ? <p className="empty-state">{copy(lang, "Loading photos…", "טוען תמונות…")}</p> : null}
        {photos.isError || reactions.isError || comments.isError ? <p className="form-error" role="alert">{copy(lang, "Could not load the gallery.", "לא ניתן לטעון את הגלריה.")}</p> : null}
      </div>
    </section>
  );
}

/** The trip's picture, changed from a file: organizer-only at the server (`POST /api/ui-settings/hero`). Shared by the classic More page and the video layout's Organizer settings. */
function HeroPictureControl({ lang }: { lang: Lang }) {
  const [busy, setBusy] = useState(false);
  const [heroError,setHeroError] = useState(false);
  const queryClient = useQueryClient();

  async function uploadHero(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.set("hero", file);
    body.set("focal_x", "0.5");
    body.set("focal_y", "0.42");
    setBusy(true);
    setHeroError(false);
    try {
      const token = tokenStore.get();
      const response = await fetch(runtimeUrl("/api/ui-settings/hero"), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body,
      });
      if (!response.ok) throw new Error("upload failed");
      queryClient.invalidateQueries({ queryKey: ["ui"] });
    } catch {
      setHeroError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {heroError && <p role="alert">{copy(lang,"Could not upload the picture. Please try again.","לא ניתן להעלות את התמונה. נסו שוב.")}</p>}
      <label className="upload-control">
        <Upload size={18} />
        <span>{busy ? copy(lang,"Uploading…","מעלה…") : copy(lang,"Change hero picture","שינוי תמונת הטיול")}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadHero} disabled={busy} />
      </label>
    </>
  );
}

/**
 * The trip's logo, changed from a file (docs/specs/sprint-9/x-trip-logo.md): organizer-only at the server
 * (`POST` and `DELETE /api/ui-settings/logo`, behind the `trip_logo` switch). A preview of what the site shows now, "Choose
 * image", and "Use the Kinerary logo" to take an upload away. Rendered by the caller only when the switch is on.
 */
export function TripLogoControl({ lang }: { lang: Lang }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const queryClient = useQueryClient();
  const ui = useQuery({ queryKey: ["ui"], queryFn: getUiSettings });
  const logo = ui.data?.logo;

  async function send(method: "POST" | "DELETE", body?: FormData) {
    setBusy(true);
    setProblem("");
    try {
      const token = tokenStore.get();
      const response = await fetch(runtimeUrl("/api/ui-settings/logo"), {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body,
      });
      if (!response.ok) {
        setProblem(response.status === 413
          ? copy(lang, "That image is larger than 8 MB.", "התמונה גדולה מ-8 מגה-בייט.")
          : response.status === 400
            ? copy(lang, "That file is not an image the site can use. Choose a PNG, JPEG, WebP or GIF.", "הקובץ אינו תמונה שהאתר יכול להשתמש בה. בחרו PNG, JPEG, WebP או GIF.")
            : response.status === 409
              ? copy(lang, "The trip logo is not turned on for this trip.", "לוגו הטיול אינו פעיל בטיול הזה.")
              : copy(lang, "Could not change the logo. Please try again.", "לא ניתן לשנות את הלוגו. נסו שוב."));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["ui"] });
    } catch {
      setProblem(copy(lang, "Could not change the logo. Please try again.", "לא ניתן לשנות את הלוגו. נסו שוב."));
    } finally {
      setBusy(false);
    }
  }

  function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const body = new FormData();
    body.set("logo", file);
    void send("POST", body);
  }

  return (
    <div className="trip-logo-control">
      <h4>{copy(lang, "Trip logo", "לוגו הטיול")}</h4>
      <div className="trip-logo-row">
        <img className="trip-logo-preview" src={logo?.url ? runtimeUrl(logo.url) : brandMark} alt={logo?.url ? copy(lang, "The trip's logo", "לוגו הטיול") : copy(lang, "The Kinerary logo", "הלוגו של Kinerary")} />
        <p className="trip-logo-note">
          {logo?.source === "upload"
            ? copy(lang, "Your uploaded logo is showing in the header, on the sign-in page and as the app icon.", "הלוגו שהעליתם מופיע בכותרת, בדף הכניסה וכסמל האפליקציה.")
            : logo?.source === "config"
              ? copy(lang, "The logo that came with the trip is showing.", "מוצג הלוגו שהגיע עם הטיול.")
              : copy(lang, "The Kinerary logo is showing.", "מוצג הלוגו של Kinerary.")}
        </p>
      </div>
      {problem && <p role="alert">{problem}</p>}
      <label className="upload-control">
        <Upload size={18} />
        <span>{busy ? copy(lang, "Uploading…", "מעלה…") : copy(lang, "Choose image", "בחירת תמונה")}</span>
        <input type="file" aria-label={copy(lang, "Choose image", "בחירת תמונה")} accept="image/png,image/jpeg,image/webp,image/gif" onChange={choose} disabled={busy} />
      </label>
      {logo?.source === "upload" && (
        <button type="button" className="secondary-action" disabled={busy} onClick={() => void send("DELETE")}>
          {copy(lang, "Use the Kinerary logo", "שימוש בלוגו של Kinerary")}
        </button>
      )}
      <p className="trip-logo-hint">{copy(lang, "A phone that already has the app installed keeps its old icon; a new install gets the new one.", "בטלפון שכבר מותקנת בו האפליקציה הסמל הישן נשאר; התקנה חדשה תקבל את הסמל החדש.")}</p>
    </div>
  );
}

/** Everyone on the trip. On the classic More page, and on the video layout's Account page (#612). */
function TravellerList({ config, currentUser, lang }: { config?: TripConfig; currentUser?: CurrentUser; lang: Lang }) {
  return (
    <section className="participants-panel" aria-labelledby="participants-heading">
      <div className="participants-heading">
        <div>
          <span className="panel-label"><Users size={16} /> {copy(lang, "Travelers", "משתתפי הטיול")}</span>
          <h3 id="participants-heading">{copy(lang, "Who is coming", "מי משתתף בטיול")}</h3>
        </div>
        <span className="participant-count">{config?.participants?.length || 0}</span>
      </div>
      <div className="participants-grid">
        {config?.participants?.map((participant) => {
          const displayName = personName(participant, lang);
          const isCurrentUser = currentUser?.username === participant.username;
          return (
            <article className="participant-card" key={participant.username}>
              <PersonAvatar username={participant.username} name={displayName} color={participant.color} size="regular" />
              <div>
                <strong>{displayName}</strong>
                <small>{isCurrentUser ? copy(lang, "You", "את/ה") : `@${participant.username}`}</small>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The video layout's Account page (#612), top to bottom: the account's own settings (password, picture — `Account`),
 * connecting Claude or ChatGPT (organizers read and write, members read only apart from their own trip moments and photos where the trip allows it: the server decides, the block says which),
 * and who is on the trip. Everyone sees all three.
 */
export function AccountPage({ config, currentUser, lang }: { config?: TripConfig; currentUser?: CurrentUser; lang: Lang }) {
  return (
    <div className="account-page">
      <Account currentUser={currentUser} lang={lang} />
      <AssistantConnect lang={lang} momentsOn={featureOn(config, "trip_moments_capture")} tripName={typeof config?.meta?.title === "string" ? config.meta.title : undefined} />
      <TravellerList config={config} currentUser={currentUser} lang={lang} />
    </div>
  );
}

/**
 * The video layout's Organizer settings page (#612): the organizer-only controls that sat under More's "Appearance",
 * each under its own title. Organizer-only at the server too (`PATCH /api/settings`, `POST /api/ui-settings/hero`,
 * the password routes); this page only decides where the controls are.
 */
export function OrganizerSettings({ config, isOrganizer, lang }: { config?: TripConfig; isOrganizer?: boolean; lang: Lang }) {
  if (!isOrganizer) return <p>{copy(lang,"Organizer access required.","נדרשת הרשאת מארגן.")}</p>;
  return (
    <section className="more-layout organizer-settings">
      <div className="section-heading">
        <span className="panel-label"><Settings size={16} /> {copy(lang,"Organizer","מארגן")}</span>
        <h2>{copy(lang,"Organizer settings","הגדרות מארגן")}</h2>
      </div>
      <section className="organizer-tools" aria-labelledby="os-signing-in">
        <MemberLogins config={config} lang={lang} headingId="os-signing-in" />
      </section>
      {featureOn(config, "plan_change_group_line") ? (
        <section className="organizer-tools" aria-labelledby="os-notifications">
          <h3 id="os-notifications">{copy(lang,"Notifications","התראות")}</h3>
          <GroupLineToggle lang={lang} />
        </section>
      ) : null}
      {featureOn(config, "chat_photos_to_album") || featureOn(config, "trip_moments_capture") ? (
        <section className="organizer-tools" aria-labelledby="os-chat-photos">
          <h3 id="os-chat-photos">{copy(lang,"Trip photos from the chat","תמונות הטיול מהצ'אט")}</h3>
          <ChatPhotosSettings lang={lang} autosaveOn={featureOn(config, "chat_photos_to_album")} momentsOn={featureOn(config, "trip_moments_capture")} />
        </section>
      ) : null}
      <section className="organizer-tools" aria-labelledby="os-look">
        <h3 id="os-look">{copy(lang,"Trip look","מראה הטיול")}</h3>
        <HeroPictureControl lang={lang} />
        {featureOn(config, "trip_logo") ? <TripLogoControl lang={lang} /> : null}
      </section>
    </section>
  );
}

/**
 * Getting a traveller back into the site.
 *
 * Their username is derived from their name and the password was shared with
 * the whole group, so the only person who can be stuck is someone who set their
 * own and forgot it — and until now the only way back was the organizer asking
 * the assistant. This is the same two options, where the organizer already is.
 *
 * Organizer-only by the caller (`isOrganizer`), and organizer-only at the
 * server too — `organizerOrAgentRequired` refuses anyone else, which is the
 * boundary that actually matters. Hiding the panel is courtesy, not security.
 */
function MemberLogins({ config, lang, headingId }: { config?: TripConfig; lang: Lang; headingId?: string }) {
  const [pending, setPending] = useState("");
  const [result, setResult] = useState<{ username: string; text: string; link?: string } | null>(null);

  async function reset(username: string, to?: "trip_password") {
    setPending(username);
    setResult(null);
    try {
      const payload = await resetParticipantPassword(username, to);
      setResult(payload.enrollment_token
        ? {
            username,
            text: copy(lang,
              "Send them this link — it works once, and it is not for the family group.",
              "שלחו להם את הקישור הזה — הוא חד-פעמי, ולא מיועד לקבוצה המשפחתית."),
            link: `${window.location.origin}${runtimeUrl("/")}#enroll=${payload.enrollment_token}`,
          }
        : {
            username,
            text: copy(lang, "Done — they can use the trip password again.", "בוצע — הם יכולים להשתמש שוב בסיסמת הטיול."),
          });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setResult({
        username,
        text: message === "no_trip_password"
          ? copy(lang,
              "This trip has no shared password — send a one-time link instead.",
              "לטיול הזה אין סיסמה משותפת — שלחו קישור חד-פעמי במקום.")
          : copy(lang, "That did not go through. Try again.", "זה לא עבר. נסו שוב."),
      });
    } finally {
      setPending("");
    }
  }

  return (
    <div className="member-logins">
      <h3 id={headingId}>{copy(lang, "Signing in", "כניסה לאתר")}</h3>
      <p>{copy(lang,
        "Everyone signs in with their own name and the trip password. If someone set their own and forgot it, put it back here.",
        "כל אחד נכנס עם השם שלו וסיסמת הטיול. אם מישהו הגדיר סיסמה משלו ושכח אותה, אפשר להחזיר אותה כאן.")}</p>
      <ul>
        {config?.participants?.map((participant) => (
          <li key={participant.username}>
            <span><strong>{personName(participant, lang)}</strong> <small>@{participant.username}</small></span>
            <span className="member-login-actions">
              <button type="button" disabled={pending === participant.username}
                onClick={() => reset(participant.username, "trip_password")}>
                {copy(lang, "Back to the trip password", "חזרה לסיסמת הטיול")}
              </button>
              <button type="button" className="ghost" disabled={pending === participant.username}
                onClick={() => reset(participant.username)}>
                {copy(lang, "One-time link", "קישור חד-פעמי")}
              </button>
            </span>
            {result?.username === participant.username ? (
              <span className="member-login-result">
                {result.text}
                {result.link ? <code>{result.link}</code> : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AppMenu({
  open,
  lang,
  currentUser,
  isOrganizer,
  setOpen,
  setLang,
  openModule,
  openVideoTab,
}: {
  open: boolean;
  lang: Lang;
  currentUser?: CurrentUser;
  isOrganizer?: boolean;
  setOpen: (open: boolean) => void;
  setLang: (lang: Lang) => void;
  openModule: (module: Module) => void;
  /** Bookings and Photos are tabs, so the menu holds the rest, and "Organizer settings" for an organizer. */
  openVideoTab: (tab: VideoTab) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  if (!open) return null;
  const dashboardLink = dashboardHref(currentUser?.dashboard_url);
  return (
    <div className="menu-overlay" role="presentation" onClick={() => setOpen(false)}>
      <aside className="app-menu" role="dialog" aria-modal="true" aria-label="Trip menu" onClick={(event) => event.stopPropagation()}>
        <div className="menu-head">
          <img src={brandLogo} alt="Kinerary" />
          <button type="button" onClick={() => setOpen(false)} aria-label={copy(lang,"Close menu","סגירת תפריט")}><X size={20} /></button>
        </div>
        {currentUser ? (() => {
          const name = personName(currentUser, lang);
          const card = (
            <>
              <PersonAvatar
                username={currentUser.username}
                name={name}
                color={currentUser.color}
                avatarFile={currentUser.avatar_file}
                googlePicture={currentUser.google_picture}
              />
              <div>
                <strong>{name}</strong>
                <small>{currentUser.is_organizer ? copy(lang, "Trip organizer", "מארגן הטיול") : `@${currentUser.username}`}</small>
              </div>
            </>
          );
          // The card is the way to the account (#612 follow-up: the owner tapped it and nothing happened).
          return (
            <button type="button" className="signed-in-user signed-in-user-button" onClick={() => openModule("account")}
              aria-label={`${copy(lang, "Open your account", "פתיחת החשבון")} — ${name}`}>
              {card}
              <span className="signed-in-user-chevron" aria-hidden="true">{lang === "he" ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}</span>
            </button>
          );
        })() : null}
        <div className="menu-section">
          <small>{lang === "he" ? "ניווט" : "Navigation"}</small>
          {videoTabs.map((tab) => <button key={tab.id} type="button" onClick={() => openVideoTab(tab.id)}>{videoTabLabel(tab.id, lang)}</button>)}
        </div>
        <div className="menu-section">
          <small>{lang === "he" ? "כלי הטיול" : "Trip tools"}</small>
          {moduleShortcuts.filter(m=>m.id!=="plan-tools"||isOrganizer).filter(m => m.id !== "bookings" && m.id !== "photos").map((shortcut) => (
            <button key={shortcut.id} type="button" onClick={() => openModule(shortcut.id)}>{shortcut[lang]}</button>
          ))}
          <button type="button" onClick={() => openModule("companion")}>{companionShortcut[lang]}</button>
          {isOrganizer ? <button type="button" onClick={() => openModule("organizer-settings")}>{organizerSettingsShortcut[lang]}</button> : null}
        </div>
        <div className="menu-section">
          <small>{lang === "he" ? "הגדרות" : "Settings"}</small>
          <button
            type="button"
            onClick={() => {
              const next = lang === "he" ? "en" : "he";
              localStorage.setItem("tripLang", next);
              setLang(next);
            }}
          >
            {lang === "he" ? "Switch to English" : "עברית"}
          </button>
          {isOrganizer ? <a href={classicHref()}>{copy(lang,"Open Classic organizer fallback","פתיחת הגרסה הקלאסית למארגן")}</a> : null}
          {dashboardLink ?<a href={dashboardLink} data-testid="organizer-dashboard-link">{copy(lang,"Organizer dashboard","לוח המארגן")}</a> : null}
          {/* Adding and removing organizers lives on the dashboard's trip page (the control plane owns who organizes a trip), so this
              is a way THERE, offered to whoever the server gave a dashboard address: the trip's main organizer. A secondary
              organizer is sent none (#523), so they are offered neither this nor the dashboard. */}
          {dashboardLink ?<a href={`${dashboardLink}#other-organizers`} data-testid="organizer-people-link">{copy(lang,"Add or remove organizers","הוספה או הסרה של מארגנים")}</a> : null}
          <button
            type="button"
            className="danger-menu"
            onClick={async () => {
              const logout = (window as unknown as { runtimeLogout?: () => Promise<void> }).runtimeLogout;
              if (logout) {
                try { await logout(); }
                catch { window.alert("Sign out failed. Please try again."); }
                return;
              }
              tokenStore.clear();
              window.location.reload();
            }}
          >
            <LogOut size={17} /> Sign out
          </button>
        </div>
      </aside>
    </div>
  );
}

export default function App() {
  const initialHash = window.location.hash.replace("#", "");
  const [activeTab, setActiveTab] = useState<Tab>(isTab(initialHash) ? initialHash : "today");
  const [activeModule, setActiveModule] = useState<Module | null>(isModule(initialHash) ? initialHash : null);
  const [lang, setLang] = useState<Lang>(() => preferredLang());
  const [journeyFocus, setJourneyFocus] = useState<JourneyFocus | null>(null);
  const [bookingFocus, setBookingFocus] = useState<{ bookingId: number | null } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [enrollment, setEnrollment] = useState(() => initialHash.startsWith("enroll=") ? initialHash.slice(7) : "");
  // State, not a read: the session can end while the app is open — a token the
  // server refuses is cleared by `api()`, which says so. Rendering the shell
  // around a dead session is what made the site look empty rather than closed.
  const [authed, setAuthed] = useState(() => Boolean(tokenStore.get()));
  useEffect(() => {
    const ended = () => setAuthed(false);
    window.addEventListener(UNAUTHORIZED_EVENT, ended);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, ended);
  }, []);
  useTripUpdates(authed);
  const config = useQuery({ queryKey: ["config"], queryFn: getConfig, enabled: authed });
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, enabled: authed });
  const ui = useQuery({ queryKey: ["ui"], queryFn: getUiSettings, enabled: authed });
  const hermes = useQuery({ queryKey: ["hermes"], queryFn: getHermes, enabled: authed });
  const itinerary = useQuery({ queryKey: ["itinerary"], queryFn: getItinerary, enabled: authed });
  const today = useQuery({ queryKey: ["today"], queryFn: getToday, enabled: authed });

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
  }, [lang]);

  // An installed app is called for its trip, not "Kinerary" (the manifest does the same for Android and desktop;
  // iOS reads this tag at the moment a person adds the site to the home screen).
  const tripTitle = config.data?.meta?.title;
  useEffect(() => {
    const tag = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (tag && tripTitle?.trim()) tag.setAttribute("content", [...tripTitle.trim()].slice(0, 12).join("").trim());
  }, [tripTitle]);

  useEffect(() => {
    if (me.data) { const { dashboard_url: _dashboard, ...stored } = me.data; localStorage.setItem("trip-user", JSON.stringify(stored)); } // dashboard_url is per trip and per session: memory only
  }, [me.data]);

  useEffect(() => {
    const syncHash = () => {
      window.scrollTo({top:0});
      const next = window.location.hash.replace("#", "");
      setEnrollment(next.startsWith("enroll=") ? next.slice(7) : "");
      if (isTab(next)) {
        setActiveTab(next);
        setActiveModule(null);
      }
      if (isModule(next)) setActiveModule(next);
    };
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  if (enrollment) return <Enrollment token={enrollment} lang={lang}/>;
  if (!authed) return activeModule === "lostfound" ? <main className="app-content"><LostFound lang={lang} authenticated={false}/><a href="#today">{copy(lang,"Back to sign in","חזרה לכניסה")}</a></main> : <LoginScreen />;

  // The change marks are known only once the config has arrived; until then (and whenever the switch is not the literal true) there are none.
  const marks = changeMarksOn(config.data);
  const openTab = (tab: Tab) => {
    setActiveTab(tab);
    setActiveModule(null);
    window.location.hash = tab;
    setMenuOpen(false);
  };
  const openModule = (module: Module) => {
    if (module !== "bookings") setBookingFocus(null);
    setActiveModule(module);
    window.location.hash = module;
    setMenuOpen(false);
  };
  const openMapItinerary = (pin: JourneyFocus) => {
    setJourneyFocus({ phaseId: pin.phaseId, date: pin.date, itemUid: pin.itemUid });
    setActiveTab("journey");
    setActiveModule(null);
    window.location.hash = "journey";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const openBooking = (bookingId: number | null) => {
    setBookingFocus({ bookingId });
    setActiveModule("bookings");
    window.location.hash = "bookings";
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  };
  const openVideoTab = (tab: VideoTab) => {
    if (tab === "bookings") setBookingFocus(null);
    if (tab === "today") openTab("today");
    else if (tab === "plan") openTab("journey");
    else openModule(tab);
  };
  // `#moments` is Photos (Moments is a section inside it); `#journey` is Plan.
  const shownModule: Module | null = activeModule ?? (activeTab === "moments" ? "photos" : null);
  const videoActive: VideoTab | null = shownModule === "bookings" ? "bookings" : shownModule === "photos" ? "photos"
    : shownModule ? null : activeTab === "today" ? "today" : activeTab === "journey" ? "plan" : null;
  const videoPageName = shownModule ? moduleLabel(shownModule, lang) : activeTab === "more" ? moduleLabel("account", lang) : videoTabLabel(activeTab === "journey" ? "plan" : "today", lang);
  const companionName = botDisplayName(config.data, hermes.data?.identity.name, lang);
  const tabContent = {
    today: <TodayView itinerary={itinerary.data} config={config.data} lang={lang} isOrganizer={me.data?.is_organizer} onOpenItinerary={openMapItinerary} onOpenBooking={openBooking} onOpenBookings={() => openVideoTab("bookings")} marks={marks} />,
    journey: <JourneyView username={me.data?.username} itinerary={itinerary.data} config={config.data} isOrganizer={me.data?.is_organizer} lang={lang} botName={companionName} telegramUsername={hermes.data?.telegram_username} focus={journeyFocus} today={today.data} marks={marks} />,
    moments: <MomentsView todayDate={today.data?.today} lang={lang} isOrganizer={me.data?.is_organizer} username={me.data?.username} momentsOn={featureOn(config.data, "trip_moments_capture")} />,
    more: <AccountPage config={config.data} currentUser={me.data} lang={lang} />, // the old #more address: its parts live on Account now (#612)
  }[activeTab];
  const moduleContent = shownModule ? {
    bookings: <BookingsView config={config.data} isOrganizer={me.data?.is_organizer} lang={lang} focus={bookingFocus} />,
    map: <MapView config={config.data} itinerary={itinerary.data} lang={lang} onOpenItinerary={openMapItinerary} />,
    budget: <><BudgetView config={config.data} lang={lang} /><CurrencyConverter lang={lang}/></>,
    photos: <><PhotosView config={config.data} currentUser={me.data} lang={lang} /><ImmichAlbum config={config.data} lang={lang}/><MomentsView todayDate={today.data?.today} lang={lang} isOrganizer={me.data?.is_organizer} username={me.data?.username} momentsOn={featureOn(config.data, "trip_moments_capture")} /></>,
    readiness: <Readiness config={config.data} lang={lang}/>,
    account: <AccountPage config={config.data} currentUser={me.data} lang={lang} />,
    activities: <GroupActivities config={config.data} currentUser={me.data} lang={lang}/>,
    lostfound: <LostFound lang={lang}/>,
    trivia: <Trivia config={config.data} currentUser={me.data} lang={lang}/>,
    companion: <CompanionPanel name={companionName} isOrganizer={me.data?.is_organizer} lang={lang} />,
    "organizer-settings": <OrganizerSettings config={config.data} isOrganizer={me.data?.is_organizer} lang={lang} />,
    "plan-tools": me.data?.is_organizer ? <PlanTools isOrganizer config={config.data} itinerary={itinerary.data} lang={lang}/> : <p>{copy(lang,"Organizer access required.","נדרשת הרשאת מארגן.")}</p>,
  }[shownModule] : null;
  const content = moduleContent || tabContent;

  return (
    <div className="modern-trip-app video-layout">
      <VideoHero config={config.data} settings={ui.data} lang={lang} placePhaseId={videoPlacePhaseId(config.data, itinerary.data, today.data)} pageName={videoPageName} pageKey={shownModule ?? activeTab} active={videoActive} openVideoTab={openVideoTab} openMenu={() => setMenuOpen(true)} openAccount={() => openModule("account")} currentUser={me.data} />
      <main className="app-content">{content}</main>
      <AppMenu open={menuOpen} lang={lang} currentUser={me.data} isOrganizer={me.data?.is_organizer} setOpen={setMenuOpen} setLang={setLang} openModule={openModule} openVideoTab={openVideoTab} />
      <nav className="bottom-nav" aria-label="Primary">
        {videoTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <a key={tab.id} href={tab.id === "plan" ? "#journey" : `#${tab.id}`} className={videoActive === tab.id ? "active" : ""} onClick={() => openVideoTab(tab.id)}>
              <Icon size={20} />
              <span>{videoTabLabel(tab.id, lang)}</span>
            </a>
          );
        })}
      </nav>
      {(config.isError || itinerary.isError) ? (
        <div className="toast"><RefreshCw size={16} /> Offline or stale data may be shown from the app cache.</div>
      ) : null}
    </div>
  );
}
