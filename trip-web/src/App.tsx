import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CloudSun,
  Download,
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
  X,
} from "lucide-react";
import brandLogo from "./assets/brand/logo.svg";
import brandMark from "./assets/brand/mark.svg";
import {
  ActiveItinerary,
  Booking,
  approveBookingDraft,
  createBooking,
  createItineraryItem,
  deleteItineraryItem,
  ItineraryItem,
  ItineraryItemInput,
  TripConfig,
  createMoment,
  extractBookingDetails,
  getAuthenticatedDocument,
  getBookings,
  getConfig,
  getConfirmations,
  getFlightStatus,
  getHermes,
  getItinerary,
  getMe,
  getMoments,
  getToday,
  getUiSettings,
  getWeather,
  login,
  reportIssue,
  runtimeUrl,
  tokenStore,
  updateItineraryItem,
  uploadBookingAppleWallet,
  uploadBookingConfirmation,
} from "./api";

type Tab = "today" | "journey" | "moments" | "more";
type Module = "bookings" | "map" | "budget" | "photos";
type Lang = "he" | "en";
type BookingFilter = "phase" | "today" | "current" | "flight" | "hotel" | "attraction";
type ItineraryTimeMode = "exact" | "rough" | "none";

const roughTimes = ["morning", "noon", "afternoon", "evening"] as const;

const tabIcons = {
  today: Home,
  journey: Compass,
  moments: Camera,
  more: Menu,
};

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

function tabLabel(tab: Tab, lang: Lang) {
  const labels: Record<Tab, { en: string; he: string }> = {
    today: { en: "Today", he: "היום" },
    journey: { en: "Journey", he: "מסע" },
    moments: { en: "Moments", he: "רגעים" },
    more: { en: "More", he: "עוד" },
  };
  return labels[tab][lang];
}

const moduleShortcuts: Array<{ id: Module; en: string; he: string }> = [
  { id: "bookings", en: "Bookings", he: "הזמנות" },
  { id: "map", en: "Map", he: "מפה" },
  { id: "budget", en: "Budget", he: "תקציב" },
  { id: "photos", en: "Photos", he: "תמונות" },
];

function moduleLabel(module: Module, lang: Lang) {
  const shortcut = moduleShortcuts.find((item) => item.id === module);
  return shortcut ? shortcut[lang] : module;
}

function isTab(value: string): value is Tab {
  return Object.keys(tabIcons).includes(value);
}

function isModule(value: string): value is Module {
  return moduleShortcuts.some((shortcut) => shortcut.id === value);
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

export function safeExternalUrl(value?: string | null) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

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
        <img className="login-logo" src={brandLogo} alt="Kinerary" />
        <h1>Open your trip</h1>
        <p>Sign in to see today, the living itinerary, moments, and your trip companion.</p>
        <form onSubmit={submit}>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-action" type="submit">Sign in</button>
        </form>
      </section>
    </main>
  );
}

function Hero({
  config,
  settings,
  lang,
  activeTab,
  activeModule,
  heroPhaseId,
  openTab,
  openModule,
  openMenu,
}: {
  config?: TripConfig;
  settings?: { hero: { url: string | null; focal_x: number; focal_y: number } };
  lang: Lang;
  activeTab: Tab;
  activeModule: Module | null;
  heroPhaseId?: string;
  openTab: (tab: Tab) => void;
  openModule: (module: Module) => void;
  openMenu: () => void;
}) {
  const activePhase = config?.phases?.find((phase) => phase.id === heroPhaseId);
  const activePhaseName = activePhase ? text(activePhase.title, lang) : "";
  const fallback = activePhase?.hero?.photo || settings?.hero.url || config?.meta?.homePhoto || config?.phases?.[0]?.hero?.photo || config?.meta?.mapPhoto || "";
  const heroLogo = tripLogoUrl(config?.meta?.logo) || brandMark;
  const heroLogoAlt = config?.meta?.logoAlt || config?.meta?.title || "Trip";
  const visiblePhoto = useRef(fallback);
  const [departingPhoto, setDepartingPhoto] = useState<string | null>(null);
  useEffect(() => {
    if (!fallback || visiblePhoto.current === fallback) {
      visiblePhoto.current = fallback;
      return;
    }
    setDepartingPhoto(visiblePhoto.current || null);
    visiblePhoto.current = fallback;
    const timer = window.setTimeout(() => setDepartingPhoto(null), 900);
    return () => window.clearTimeout(timer);
  }, [fallback]);
  const backgroundPosition = `${(settings?.hero.focal_x ?? 0.5) * 100}% ${(settings?.hero.focal_y ?? 0.45) * 100}%`;
  return (
    <header className={departingPhoto ? "trip-hero phase-shift" : "trip-hero"}>
      {departingPhoto ? <div className="hero-image-layer hero-image-departing" aria-hidden="true" style={{ backgroundImage: `linear-gradient(180deg, rgba(16,38,58,.1), rgba(16,38,58,.54)), url("${departingPhoto}")`, backgroundPosition }} /> : null}
      <div key={fallback || "solid"} className="hero-image-layer hero-image-arriving" aria-hidden="true" style={{ backgroundImage: fallback ? `linear-gradient(180deg, rgba(16,38,58,.1), rgba(16,38,58,.54)), url("${fallback}")` : undefined, backgroundPosition }} />
      <nav className="topline" aria-label="Trip">
        <a className="brand-lockup" href="#today" onClick={() => openTab("today")} aria-label="Kinerary home">
          <img className="hero-logo" src={heroLogo} alt={heroLogoAlt} />
          <strong>{config?.meta?.title || "Family Trip"}</strong>
        </a>
        <div className="desktop-tabs">
          {(["today", "journey", "moments"] as Tab[]).map((tab) => (
            <a
              key={tab}
              href={`#${tab}`}
              className={!activeModule && activeTab === tab ? "active" : ""}
              onClick={() => openTab(tab)}
            >
              {tabLabel(tab, lang)}
            </a>
          ))}
        </div>
        <div className="desktop-shortcuts" aria-label="Modern modules">
          {moduleShortcuts.map((shortcut) => (
            <a
              key={shortcut.id}
              href={`#${shortcut.id}`}
              className={activeModule === shortcut.id ? "active" : ""}
              onClick={() => openModule(shortcut.id)}
            >
              {shortcut[lang]}
            </a>
          ))}
        </div>
        <button className="menu-button" type="button" onClick={openMenu} aria-label="Open menu">
          <Menu size={20} />
        </button>
      </nav>
      <div key={`${fallback}-${lang}`} className="hero-copy hero-copy-arriving">
        <h1>{activePhaseName || config?.meta?.destination || config?.meta?.title || copy(lang, "Today knows where the trip is.", "היום יודע איפה הטיול נמצא.")}</h1>
        <p>{lang === "he" ? "המסלול, הרגעים והעוזר זזים יחד עם השעון של הטיול." : "The itinerary, moments, and companion follow the trip clock as the day changes."}</p>
      </div>
    </header>
  );
}

function TimelineItem({
  item,
  compact = false,
  lang = "en",
  botName,
  telegramUsername,
}: {
  item: ItineraryItem;
  compact?: boolean;
  lang?: Lang;
  botName?: string;
  telegramUsername?: string | null;
}) {
  const Icon = item.item_type === "travel" || item.booking?.type === "flight" ? Plane : item.item_type === "meal" ? TicketCheck : MapPin;
  const title = itemTitle(item, lang);
  const confirmationUrl = safeFileUrl("/api/bookings/confirmation", item.booking?.conf_file);
  const appleWalletUrl = safeFileUrl("/api/bookings/wallet-apple", item.booking?.pkpass_file);
  const locationUrl = safeExternalUrl(item.location_url);
  const wazeUrl = safeExternalUrl(item.waze_url);
  const ticketUrl = safeExternalUrl(item.ticket_url);
  const websiteUrl = safeExternalUrl(item.website_url);
  const googleWalletUrl = safeExternalUrl(item.booking?.google_wallet_url);
  const itemAppleWalletUrl = safeExternalUrl(item.booking?.apple_wallet_url) || appleWalletUrl;
  const askUrl = telegramUrl(telegramUsername, `${botName || "Trip companion"}, question about this plan: ${title}`);
  const extraLinks = (item.extra_links || []).map((link) => ({
    label: extraLinkLabel(link, lang),
    url: safeExternalUrl(link.url || link.href),
  })).filter((link) => link.url);

  return (
    <article className={`timeline-item ${compact ? "compact" : ""}`}>
      <div className="time-rail">
        <span>{itineraryTimeLabel(item.time, lang)}</span>
        <i />
      </div>
      <div className="item-body">
        <div className="item-kicker">
          <Icon size={16} />
          <span>{item.item_type.replace("_", " ")}</span>
          {item.provenance?.status === "updated_from_original" ? <b>{copy(lang, "Updated from original", "עודכן מהתוכנית המקורית")}</b> : null}
          {item.provenance?.status === "added" ? <b>{copy(lang, "Added", "נוסף")}</b> : null}
        </div>
        <h3>{title}</h3>
        <div className="item-meta">
          {item.booking?.confirmation ? <span><CheckCircle2 size={14} /> {copy(lang, "Confirmation stored", "אישור שמור")}</span> : null}
          {locationUrl ? <a href={locationUrl} target="_blank" rel="noreferrer"><MapPin size={14} /> {copy(lang, "Map", "מפה")}</a> : null}
          {wazeUrl ? <a href={wazeUrl} target="_blank" rel="noreferrer"><Navigation size={14} /> Waze</a> : null}
          {item.confirmation_state && item.confirmation_state !== "verified" ? <span><AlertTriangle size={14} /> {copy(lang, "Needs review", "נדרשת בדיקה")}</span> : null}
        </div>
        <div className="item-actions" aria-label={`Actions for ${title}`}>
          {confirmationUrl ? <AuthenticatedDocumentAction url={confirmationUrl} filename={item.booking?.conf_file || "confirmation.pdf"} label={<><ShieldCheck size={15} /> {copy(lang, "Confirmation", "אישור")}</>} /> : null}
          {ticketUrl ? <a className="item-action" href={ticketUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> {copy(lang, "Tickets", "כרטיסים")}</a> : null}
          {websiteUrl ? <a className="item-action" href={websiteUrl} target="_blank" rel="noreferrer"><Globe2 size={15} /> {copy(lang, "Site", "אתר")}</a> : null}
          {googleWalletUrl ? <a className="item-action" href={googleWalletUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Google Wallet</a> : null}
          {itemAppleWalletUrl ? (item.booking?.pkpass_file ? <AuthenticatedDocumentAction url={appleWalletUrl} filename={item.booking.pkpass_file} download label={<><TicketCheck size={15} /> Apple Wallet</>} /> : <a className="item-action" href={itemAppleWalletUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Apple Wallet</a>) : null}
          {extraLinks.map((link) => <a key={`${link.label}-${link.url}`} className="item-action" href={link.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {link.label}</a>)}
          {askUrl ? <a className="item-action companion" href={askUrl} target="_blank" rel="noreferrer"><MessageCircle size={15} /> {copy(lang, "Ask", "שאלו")}</a> : null}
        </div>
      </div>
    </article>
  );
}

type JourneyFocus = {
  phaseId: string;
  date?: string;
  itemUid?: string;
};

function CompanionPanel({
  config,
  hermes,
  next,
  todayDate,
  isOrganizer,
  lang,
}: {
  config?: TripConfig;
  hermes?: Awaited<ReturnType<typeof getHermes>>;
  next?: ItineraryItem | null;
  todayDate?: string;
  isOrganizer?: boolean;
  lang: Lang;
}) {
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState("");
  const name = botDisplayName(config, hermes?.identity.name, lang);
  const context = next ? `About ${todayDate || "today"} - ${itemTitle(next, lang)}` : `About ${todayDate || "the trip plan"}`;
  const askHref = telegramUrl(hermes?.telegram_username, `${context}\n\n${message || "I have a question about today's plan."}`);
  const privateHref = telegramUrl(hermes?.telegram_username, `[Organizer private]\n${context}\n\n${message || "Please review this privately."}`);
  const reportMutation = useMutation({
    mutationFn: () => reportIssue({
      title: `${name} member question`,
      detail: `${context}\n\n${message}`.slice(0, 1000),
      phase_id: next?.phase_id || null,
      date: next?.date || todayDate || null,
      item_uid: next?.item_uid || null,
      severity: "info",
    }),
    onSuccess: () => {
      setSaved("Saved to the organizer issue queue.");
      setMessage("");
    },
  });

  return (
    <section className="companion-panel">
      <div className="companion-head">
        <img src={brandMark} alt="" />
        <div>
          <span className="panel-label"><Bot size={16} /> {name}</span>
          <h3>{lang === "he" ? "שאלו על התוכנית של היום" : "Ask about the day plan"}</h3>
        </div>
      </div>
      <p>{hermes?.available ? "Fresh checks are available for plan questions and confirmations." : "Telegram handoff is ready when the bot is configured; reports still reach the organizer queue."}</p>
      <label className="bot-input">
        <span>{lang === "he" ? "מה לבדוק?" : "What should the companion check?"}</span>
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder={context} />
      </label>
      <div className="bot-actions">
        {askHref ? <a className="primary-action" href={askHref} target="_blank" rel="noreferrer"><Send size={17} /> Ask in Telegram</a> : null}
        <button className="secondary-action" type="button" disabled={!message.trim() || reportMutation.isPending} onClick={() => reportMutation.mutate()}>
          <AlertTriangle size={17} /> Flag plan issue
        </button>
        {isOrganizer && privateHref ? <a className="secondary-action" href={privateHref} target="_blank" rel="noreferrer"><MessageCircle size={17} /> Private organizer chat</a> : null}
      </div>
      {saved ? <small className="saved-note">{saved}</small> : null}
    </section>
  );
}

function TripClockPanel({
  config,
  itinerary,
  today,
  next,
  lang,
}: {
  config?: TripConfig;
  itinerary?: ActiveItinerary;
  today?: Awaited<ReturnType<typeof getToday>>;
  next?: ItineraryItem | null;
  lang: Lang;
}) {
  const activePhaseId = next?.phase_id || today?.current?.phase_id || today?.next?.phase_id || "";
  const phase = config?.phases?.find((entry) => entry.id === activePhaseId)
    || config?.phases?.find((entry) => today?.today && entry.start && entry.end && entry.start <= today.today && entry.end >= today.today);
  const phaseDays = itinerary?.days.filter((day) => !phase?.id || day.phase_id === phase.id) || [];
  const phaseDayIndex = today?.today ? phaseDays.findIndex((day) => day.date === today.today) + 1 : 0;
  const totalIndex = today?.today ? (itinerary?.days.findIndex((day) => day.date === today.today) ?? -1) + 1 : 0;
  const totalDays = itinerary?.days.length || 0;
  const label = today ? phaseLabel(today.phase, lang) : copy(lang, "Trip clock", "שעון הטיול");
  const destination = phase ? text(phase.title, lang) || phase.id : config?.meta?.destination || config?.meta?.title || copy(lang, "the journey", "הטיול");

  return (
    <section className="clock-panel">
      <div className="clock-orb" aria-hidden="true">
        <Clock3 size={24} />
        <span>{today?.countdown_days != null && today.countdown_days > 0 ? today.countdown_days : totalIndex || "•"}</span>
      </div>
      <div className="clock-copy">
        <span className="panel-label"><Route size={16} /> {label}</span>
        <h3>
          {today?.phase === "pre_trip" && today.countdown_days != null
            ? copy(lang, `${Math.max(today.countdown_days, 0)} days until the adventure starts`, `נותרו ${Math.max(today.countdown_days, 0)} ימים עד תחילת ההרפתקה`)
            : phaseDayIndex > 0
              ? copy(lang, `Day ${phaseDayIndex} in ${destination}`, `יום ${phaseDayIndex} ב${destination}`)
              : copy(lang, `Now tracking ${destination}`, `עוקבים עכשיו אחרי ${destination}`)}
        </h3>
        <p>
          {totalDays && totalIndex > 0
            ? copy(lang, `Trip day ${totalIndex} of ${totalDays}. The page keeps following destination-local time.`, `יום ${totalIndex} מתוך ${totalDays} בטיול. העמוד מתעדכן לפי השעה המקומית ביעד.`)
            : copy(lang, "Countdown, current phase, and next event all move with the trip clock.", "הספירה לאחור, השלב הנוכחי והאירוע הבא מתעדכנים עם שעון הטיול.")}
        </p>
      </div>
    </section>
  );
}

function TodayView({
  itinerary,
  config,
  lang,
  isOrganizer,
}: {
  itinerary?: ActiveItinerary;
  config?: TripConfig;
  lang: Lang;
  isOrganizer?: boolean;
}) {
  const today = useQuery({ queryKey: ["today"], queryFn: getToday, refetchInterval: 60_000 });
  const confirmations = useQuery({ queryKey: ["confirmations"], queryFn: getConfirmations });
  const hermes = useQuery({ queryKey: ["hermes"], queryFn: getHermes });
  const flights = useQuery({ queryKey: ["flights"], queryFn: getFlightStatus });
  const firstStop = config?.phases?.find((phase) => Number.isFinite(phase.mapStop?.lat) && Number.isFinite(phase.mapStop?.lng))?.mapStop;
  const weather = useQuery({
    queryKey: ["weather", firstStop?.lat, firstStop?.lng, today.data?.today],
    queryFn: () => getWeather(firstStop!.lat!, firstStop!.lng!, today.data!.today),
    enabled: Boolean(Number.isFinite(firstStop?.lat) && Number.isFinite(firstStop?.lng) && today.data?.today),
  });
  const missing = confirmations.data?.items.filter((item) => item.state !== "verified").slice(0, 3) || [];
  const next = today.data?.next || itinerary?.items[0] || null;
  const companionName = botDisplayName(config, hermes.data?.identity.name, lang);

  return (
    <section className="view-grid today-grid">
      <div className="focus-panel">
        <span className="panel-label">{today.data ? phaseLabel(today.data.phase, lang) : copy(lang, "Today", "היום")}</span>
        <h2>{next ? itemTitle(next, lang) : copy(lang, "Your trip clock is warming up.", "שעון הטיול מתכונן לצאת לדרך.")}</h2>
        <p>
          {today.data?.phase === "pre_trip" && today.data.countdown_days != null
            ? copy(lang, `${Math.max(today.data.countdown_days, 0)} days until departure.`, `נותרו ${Math.max(today.data.countdown_days, 0)} ימים ליציאה.`)
            : copy(lang, "Now and next stay current without a page reload.", "האירוע הנוכחי והבא מתעדכנים בלי לרענן את העמוד.")}
        </p>
        {next ? <TimelineItem item={next} compact lang={lang} botName={companionName} telegramUsername={hermes.data?.telegram_username} /> : null}
        <TripClockPanel config={config} itinerary={itinerary} today={today.data} next={next} lang={lang} />
      </div>

      <aside className="ops-strip">
        <section className="mini-panel">
          <CloudSun size={20} />
          <h3>Weather</h3>
          <p>
            {weather.data?.temperature_max != null
              ? `${Math.round(weather.data.temperature_min || 0)}-${Math.round(weather.data.temperature_max)} C`
              : "Last known weather appears here when available."}
          </p>
          {weather.data?.stale ? <small>Stale: {weather.data.fetched_at || "not refreshed yet"}</small> : null}
        </section>
        <section className="mini-panel">
          <Plane size={20} />
          <h3>Flights</h3>
          <p>{flights.data?.statuses[0]?.facts.name || today.data?.flights[0]?.name || "Stored booking facts are the fallback."}</p>
          {flights.data?.statuses[0]?.stale ? <small>Using last known status</small> : null}
        </section>
        <section className="mini-panel">
          <Bot size={20} />
          <h3>{companionName}</h3>
          <p>{hermes.data?.available ? "Available for trip checks." : "Profile visible; live checks not configured."}</p>
          {hermes.data?.telegram_username ? <a href={telegramUrl(hermes.data.telegram_username)}>Open conversation</a> : null}
        </section>
      </aside>

      <CompanionPanel
        config={config}
        hermes={hermes.data}
        next={next}
        todayDate={today.data?.today}
        isOrganizer={isOrganizer}
        lang={lang}
      />

      <section className="section-band">
        <div className="section-heading">
          <h2>Readiness</h2>
          <p>Flights, lodging, cars, and tickets stay separate from the daily plan.</p>
        </div>
        <div className="readiness-list">
          {missing.length ? missing.map((item) => (
            <article key={item.id} className="readiness-row">
              <AlertTriangle size={18} />
              <span>{item.name}</span>
              <small>{item.next_action}</small>
            </article>
          )) : <article className="readiness-row good"><CheckCircle2 size={18} /><span>Core confirmations look complete.</span><small>Budget remains in its own module.</small></article>}
        </div>
      </section>
    </section>
  );
}

function JourneyView({
  itinerary,
  config,
  isOrganizer,
  lang,
  botName,
  telegramUsername,
  onHeroPhaseChange,
  focus,
}: {
  itinerary?: ActiveItinerary;
  config?: TripConfig;
  isOrganizer?: boolean;
  lang: Lang;
  botName?: string;
  telegramUsername?: string | null;
  onHeroPhaseChange: (phaseId: string) => void;
  focus?: JourneyFocus | null;
}) {
  const days = itinerary?.days || [];
  const phaseGroups = useMemo(() => {
    const configured = (config?.phases || []).map((phase) => ({
      id: phase.id,
      title: text(phase.title, lang) || phase.id,
      days: days.filter((day) => day.phase_id === phase.id),
    })).filter((phase) => phase.days.length);
    const configuredIds = new Set(configured.map((phase) => phase.id));
    const orphanGroups = Array.from(new Set(days.map((day) => day.phase_id).filter((id) => !configuredIds.has(id)))).map((id) => ({
      id,
      title: id,
      days: days.filter((day) => day.phase_id === id),
    }));
    return [...configured, ...orphanGroups];
  }, [config?.phases, days, lang]);
  const [selectedPhase, setSelectedPhase] = useState(phaseGroups[0]?.id || "");
  const activePhase = phaseGroups.find((phase) => phase.id === selectedPhase) || phaseGroups[0];
  const [selected, setSelected] = useState(activePhase?.days[0]?.date || "");
  const activeDate = activePhase?.days.some((day) => day.date === selected) ? selected : activePhase?.days[0]?.date || "";
  const dayItems = itinerary?.items.filter((item) => item.date === activeDate && (!activePhase?.id || item.phase_id === activePhase.id)) || [];
  const day = days.find((entry) => entry.date === activeDate && (!activePhase?.id || entry.phase_id === activePhase.id));
  const daySpineRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!selectedPhase && phaseGroups[0]?.id) setSelectedPhase(phaseGroups[0].id);
  }, [phaseGroups, selectedPhase]);

  useEffect(() => {
    if (activePhase?.id) onHeroPhaseChange(activePhase.id);
  }, [activePhase?.id, onHeroPhaseChange]);

  useEffect(() => {
    if (activePhase?.days.length && !activePhase.days.some((day) => day.date === selected)) {
      setSelected(activePhase.days[0].date);
    }
  }, [activePhase, selected]);

  useEffect(() => {
    if (!focus?.phaseId) return;
    const phase = phaseGroups.find((entry) => entry.id === focus.phaseId);
    if (!phase) return;
    setSelectedPhase(phase.id);
    const targetDay = focus.date && phase.days.find((entry) => entry.date === focus.date);
    if (targetDay) setSelected(targetDay.date);
  }, [focus, phaseGroups]);

  useEffect(() => {
    if (!focus?.phaseId || activePhase?.id !== focus.phaseId) return;
    const frame = window.requestAnimationFrame(() => {
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

  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  const saveMutation = useMutation({
    mutationFn: ({ itemUid, input }: { itemUid?: string; input: ItineraryItemInput }) => itemUid ? updateItineraryItem(itemUid, input) : createItineraryItem(input),
    onSuccess: (result) => {
      setEditing(null);
      setEnrichmentNote(result.enrichment?.configured
        ? copy(lang, "Saved. Kinerary is now adding the other language, location, and useful links. It can take a minute.", "נשמר. קינררי מוסיף עכשיו את השפה השנייה, מיקום וקישורים שימושיים. זה עשוי לקחת כדקה.")
        : copy(lang, "Saved. The other language and location links will be added automatically when the trip assistant is online.", "נשמר. השפה השנייה וקישורי המיקום יתווספו אוטומטית כשהעוזר של הטיול יהיה זמין."));
      void queryClient.invalidateQueries({ queryKey: ["itinerary"] });
      void queryClient.invalidateQueries({ queryKey: ["today"] });
      if (result.enrichment?.configured) {
        [4_000, 12_000, 30_000].forEach((delay) => window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ["itinerary"] });
          void queryClient.invalidateQueries({ queryKey: ["today"] });
        }, delay));
      }
    },
  });
  const removeMutation = useMutation({
    mutationFn: deleteItineraryItem,
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["itinerary"] });
      void queryClient.invalidateQueries({ queryKey: ["today"] });
    },
  });

  const beginNew = () => {
    const fallbackPhase = config?.phases?.[0];
    setDraft({
      phase_id: activePhase?.id || fallbackPhase?.id || "",
      date: activeDate || fallbackPhase?.start || new Date().toISOString().slice(0, 10),
      text_he: "",
      text_en: "",
      time: "",
      item_type: "activity",
      location_url: "",
    });
    setTimeMode("none");
    setEditing("new");
  };
  const beginEdit = (item: ItineraryItem) => {
    setDraft({
      phase_id: item.phase_id,
      date: item.date || activeDate,
      text_he: item.text_he,
      text_en: item.text_en || "",
      time: item.time || "",
      item_type: item.item_type || "activity",
      location_url: item.location_url || "",
    });
    setTimeMode(roughTimes.includes(item.time as (typeof roughTimes)[number]) ? "rough" : item.time ? "exact" : "none");
    setEditing(item);
  };

  return (
    <section className="journey-layout">
      <aside className="destination-rail" aria-label="Trip phases">
        <div className="rail-heading">
          <Map size={17} />
          <span>{lang === "he" ? "שלבי הטיול" : "Trip phases"}</span>
        </div>
        {phaseGroups.map((phase, index) => (
          <button
            key={phase.id}
            className={phase.id === activePhase?.id ? "active" : ""}
            onClick={() => {
              setSelectedPhase(phase.id);
              setSelected(phase.days[0]?.date || "");
            }}
          >
            <i>{index + 1}</i>
            <span>{phase.title}</span>
            <small>{phase.days.length} {phase.days.length === 1 ? "day" : "days"}</small>
          </button>
        ))}
      </aside>
      <section ref={daySpineRef} className="day-spine">
        <div className="day-heading">
          <span className="panel-label">{activePhase?.title || "Journey"}</span>
          <h2>{day?.label_en || day?.label_he || "Daily itinerary"}</h2>
          {day?.lodging_context?.name ? <p>Tonight: {day.lodging_context.name}</p> : null}
          {isOrganizer ? <button className="secondary-action journey-edit-trigger" type="button" onClick={beginNew}><Plus size={17} /> {copy(lang, "Add itinerary item", "הוספת פריט למסלול")}</button> : null}
          <div className="day-selector" aria-label="Days in selected phase">
            {(activePhase?.days || []).map((entry) => (
              <button key={`${entry.phase_id}-${entry.date}`} className={entry.date === activeDate ? "active" : ""} onClick={() => setSelected(entry.date)}>
                <span>{dateLabel(entry.date, lang)}</span>
                <small>{daySelectorSubtitle(entry, lang)}</small>
              </button>
            ))}
          </div>
        </div>
        {isOrganizer && editing ? (
          <form
            ref={editorRef}
            className="itinerary-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.phase_id || !draft.date || !draft.text_he.trim()) return;
              const time = timeMode === "none" ? null : draft.time?.trim() || null;
              saveMutation.mutate({ itemUid: editing === "new" ? undefined : editing.item_uid, input: { ...draft, text_he: draft.text_he.trim(), text_en: null, time, location_url: draft.location_url?.trim() || null } });
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
                <select value={draft.phase_id} onChange={(event) => setDraft({ ...draft, phase_id: event.target.value })}>
                  {(config?.phases || phaseGroups).map((phase) => <option key={phase.id} value={phase.id}>{"title" in phase ? text(phase.title, lang) || phase.id : phase.id}</option>)}
                </select>
              </label>
              <label>{copy(lang, "Date", "תאריך")}<input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} required /></label>
              <label>{copy(lang, "When", "מתי")}
                <select value={timeMode} onChange={(event) => {
                  const nextMode = event.target.value as ItineraryTimeMode;
                  setTimeMode(nextMode);
                  setDraft({ ...draft, time: nextMode === "rough" ? "morning" : "" });
                }}>
                  <option value="none">{copy(lang, "No time", "ללא שעה")}</option>
                  <option value="exact">{copy(lang, "Exact time", "שעה מדויקת")}</option>
                  <option value="rough">{copy(lang, "Part of day", "חלק מהיום")}</option>
                </select>
              </label>
              {timeMode === "exact" ? <label>{copy(lang, "Exact time", "שעה מדויקת")}<input type="time" value={draft.time || ""} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label> : null}
              {timeMode === "rough" ? <label>{copy(lang, "Part of day", "חלק מהיום")}
                <select value={draft.time || "morning"} onChange={(event) => setDraft({ ...draft, time: event.target.value })}>
                  {roughTimes.map((time) => <option key={time} value={time}>{itineraryTimeLabel(time, lang)}</option>)}
                </select>
              </label> : null}
              <label>{copy(lang, "Type", "סוג")}
                <select value={draft.item_type || "activity"} onChange={(event) => setDraft({ ...draft, item_type: event.target.value })}>
                  {["activity", "travel", "meal", "lodging", "free_time", "booking", "task", "note"].map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
                </select>
              </label>
              <label className="editor-field-wide">{copy(lang, "Activity name", "שם הפעילות")}<input value={draft.text_he} onChange={(event) => setDraft({ ...draft, text_he: event.target.value })} required /></label>
              <p className="editor-note">{copy(lang, "Write the activity once, in Hebrew or English. After you save, Kinerary adds the other language and looks up the location, Waze, website, and tickets when available.", "כותבים את הפעילות פעם אחת, בעברית או באנגלית. לאחר השמירה קינררי מוסיף את השפה השנייה ומחפש מיקום, Waze, אתר וכרטיסים כשיש כאלה.")}</p>
              <label className="editor-field-wide">{copy(lang, "Google Maps or location link", "קישור Google Maps או מיקום")}<input type="url" value={draft.location_url || ""} onChange={(event) => setDraft({ ...draft, location_url: event.target.value })} placeholder="https://..." /></label>
            </div>
            {saveMutation.isError ? <p className="form-error">{saveMutation.error instanceof Error ? saveMutation.error.message : copy(lang, "Could not save the itinerary item.", "לא ניתן לשמור את פריט המסלול.")}</p> : null}
            <div className="editor-actions">
              <button className="primary-action" type="submit" disabled={saveMutation.isPending || !draft.phase_id || !draft.date || !draft.text_he.trim()}>{saveMutation.isPending ? copy(lang, "Saving…", "שומר…") : copy(lang, "Save revision", "שמירת גרסה")}</button>
              <button className="secondary-action" type="button" onClick={() => setEditing(null)}>{copy(lang, "Cancel", "ביטול")}</button>
            </div>
          </form>
        ) : null}
        {isOrganizer && enrichmentNote ? <p className="enrichment-note"><Sparkles size={16} /> {enrichmentNote}</p> : null}
        <div className="timeline">
          {dayItems.length ? dayItems.map((item) => (
            <div className="timeline-item-wrap" id={`itinerary-item-${encodeURIComponent(item.item_uid)}`} key={item.item_uid}>
              <TimelineItem item={item} lang={lang} botName={botName} telegramUsername={telegramUsername} />
              {isOrganizer ? <div className="timeline-editor-actions">
                <button type="button" onClick={() => beginEdit(item)}><Pencil size={15} /> {copy(lang, "Edit", "עריכה")}</button>
                <button className="danger-text" type="button" disabled={removeMutation.isPending} onClick={() => { if (window.confirm(copy(lang, "Remove this itinerary item?", "להסיר את הפריט הזה מהמסלול?"))) removeMutation.mutate(item.item_uid); }}><Trash2 size={15} /> {copy(lang, "Remove", "הסרה")}</button>
              </div> : null}
            </div>
          )) : <p className="empty-state">No structured items for this phase day yet.</p>}
        </div>
      </section>
    </section>
  );
}

function MomentsView({ todayDate }: { todayDate?: string }) {
  const queryClient = useQueryClient();
  const moments = useQuery({ queryKey: ["moments"], queryFn: getMoments });
  const [caption, setCaption] = useState("");
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
        <span className="panel-label"><GalleryHorizontalEnd size={16} /> Moments</span>
        <h2>Capture the day while it is still fresh.</h2>
        <label>
          Caption
          <textarea value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="A small memory, a funny line, a place worth remembering..." />
        </label>
        <button className="primary-action" type="submit" disabled={!caption.trim() || mutation.isPending}>
          <Plus size={18} /> Save draft
        </button>
      </form>
      <div className="moment-feed">
        {(moments.data || []).map((moment) => (
          <article key={moment.id} className="moment-card">
            <small>{moment.visibility === "draft" ? "Private draft" : "Published"} {moment.date ? `- ${moment.date}` : ""}</small>
            <h3>{moment.caption}</h3>
            {moment.body ? <p>{moment.body}</p> : null}
          </article>
        ))}
        {!moments.data?.length ? <p className="empty-state">No moments yet.</p> : null}
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

function AuthenticatedDocumentAction({ url, filename, download, label }: { url: string; filename: string; download?: boolean; label: React.ReactNode }) {
  const [error, setError] = useState("");
  const open = async () => {
    setError("");
    const documentWindow = download ? null : window.open("", "_blank");
    if (documentWindow) documentWindow.opener = null;
    try {
      const blob = await getAuthenticatedDocument(url);
      const objectUrl = URL.createObjectURL(blob);
      if (download) {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        link.click();
      } else if (documentWindow) {
        documentWindow.location.replace(objectUrl);
      } else {
        window.location.assign(objectUrl);
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (reason) {
      documentWindow?.close();
      setError(reason instanceof Error ? reason.message : "Could not retrieve document");
    }
  };
  return <span className="document-action"><button type="button" onClick={open}>{label}</button>{error ? <small className="form-error">{error}</small> : null}</span>;
}

function BookingActions({ booking }: { booking: Booking }) {
  const confirmationUrl = safeFileUrl("/api/bookings/confirmation", booking.conf_file);
  const appleWalletUrl = safeFileUrl("/api/bookings/wallet-apple", booking.pkpass_file);
  const locationUrl = safeExternalUrl(booking.location_url);
  const googleWalletUrl = safeExternalUrl(booking.google_wallet_url);
  const walletUrl = safeExternalUrl(booking.apple_wallet_url) || appleWalletUrl;
  return (
    <div className="action-strip">
      {confirmationUrl ? <AuthenticatedDocumentAction url={confirmationUrl} filename={booking.conf_file || "confirmation.pdf"} label={<><ShieldCheck size={15} /> Confirmation</>} /> : null}
      {confirmationUrl ? <AuthenticatedDocumentAction url={confirmationUrl} filename={booking.conf_file || "confirmation.pdf"} download label={<><Download size={15} /> Download</>} /> : null}
      {locationUrl ? <a href={locationUrl} target="_blank" rel="noreferrer"><MapPin size={15} /> Google Maps</a> : null}
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
      const created = await createBooking({ ...draft, phase: draft.phase || defaultPhase });
      if (confirmationFile) await uploadBookingConfirmation(created.id, confirmationFile);
      if (walletFile) await uploadBookingAppleWallet(created.id, walletFile);
      return created;
    },
    onSuccess: () => {
      formGeneration.current += 1;
      setDraft({ phase: defaultPhase, type: "flight", name: "", date_from: "", date_to: "", passengers: "", confirmation: "", location_url: "", google_wallet_url: "", apple_wallet_url: "" });
      setConfirmationFile(null);
      setWalletFile(null);
      setExtractUrl("");
      setExtractionError("");
      setIsOpen(false);
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
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
        <label>{lang === "he" ? "שלב" : "Phase"}<select value={draft.phase || defaultPhase} onChange={(event) => setDraft({ ...draft, phase: event.target.value })} required><option value="" disabled>{lang === "he" ? "בחירת שלב" : "Choose a phase"}</option>{(config?.phases || []).map((phase) => <option key={phase.id} value={phase.id}>{text(phase.title, lang) || phase.id}</option>)}</select></label>
        <label>{lang === "he" ? "סוג" : "Type"}<select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}><option value="flight">{lang === "he" ? "טיסה" : "Flight"}</option><option value="hotel">{lang === "he" ? "לינה" : "Stay"}</option><option value="car">{lang === "he" ? "רכב" : "Car"}</option><option value="attraction">{lang === "he" ? "אטרקציה" : "Attraction"}</option><option value="other">{lang === "he" ? "אחר" : "Other"}</option></select></label>
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
      {mutation.isError ? <p className="form-error">{mutation.error instanceof Error ? mutation.error.message : (lang === "he" ? "לא ניתן לשמור את ההזמנה" : "Could not save the booking")}</p> : null}
      {mutation.isSuccess ? <p className="saved-note">{lang === "he" ? "ההזמנה נשמרה ומוכנה לחברי הטיול." : "Booking saved and ready for trip members."}</p> : null}
    </form>
  );
}

function BookingsView({ config, isOrganizer, lang }: { config?: TripConfig; isOrganizer?: boolean; lang: Lang }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<BookingFilter>("phase");
  const bookings = useQuery({ queryKey: ["bookings"], queryFn: getBookings });
  const today = useQuery({ queryKey: ["today"], queryFn: getToday });
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
  const approveMutation = useMutation({
    mutationFn: approveBookingDraft,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bookings"] }),
  });

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
                <article className="booking-card" key={booking.id}>
                  <div className="booking-card-head">
                    <span className="booking-type">{booking.type}</span>
                    <span className={`status-pill ${bookingState(booking)}`}>{bookingState(booking) === "verified" ? "Verified" : bookingState(booking) === "draft" ? "Draft" : "Needs review"}</span>
                  </div>
                  <h4>{booking.name}</h4>
                  <p>{bookingDateLine(booking, lang)}</p>
                  {booking.passengers ? <small>{booking.passengers}</small> : null}
                  <BookingActions booking={booking} />
                  {isOrganizer && booking.review_status === "draft" ? <button className="secondary-action" type="button" disabled={approveMutation.isPending} onClick={() => approveMutation.mutate(booking.id)}>{approveMutation.isPending ? "Approving..." : "Approve for members"}</button> : null}
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
  return [...(items || [])]
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
const mapModes = satelliteMapStyle ? (["raster", "satellite"] as const) : (["raster"] as const);

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
    const lat = phase.mapStop?.lat;
    const lng = phase.mapStop?.lng;
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

function InteractiveMap({
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
    let map: import("maplibre-gl").Map | undefined;
    void Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")]).then(([maplibregl]) => {
      if (disposed) return;
      const instance = new maplibregl.Map({
        container,
        style: mapMode === "satellite" && satelliteMapStyle ? satelliteMapStyle : freeMapStyle,
        center: [pins[0].lng, pins[0].lat],
        zoom: pins.length === 1 ? 12 : 5,
      });
      map = instance;
      mapRef.current = instance;
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      // `load` waits for every vector tile. A slow/offline tile provider would
      // leave the controls visible but never add the authoritative pins. The
      // style is enough to render markers and fit the camera; tiles can finish
      // loading independently afterward.
      instance.on("style.load", () => {
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
      });
    });
    return () => {
      disposed = true;
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
    map.flyTo({ center: [activePin.lng, activePin.lat], zoom: 16, duration: 1100, essential: true });
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
    map.flyTo({ center: [pin.lng, pin.lat], zoom: 16, duration: 1100, essential: true });
  }, [focusRequest, pins]);

  function moveTo(index: number) {
    setActiveIndex(wrappedMapIndex(index, pins.length));
  }

  function showAll() {
    const map = mapRef.current;
    if (!map || !pins.length) return;
    if (pins.length === 1) {
      map.flyTo({ center: [pins[0].lng, pins[0].lat], zoom: 16, duration: 1100, essential: true });
      return;
    }
    const west = Math.min(...pins.map((pin) => pin.lng));
    const east = Math.max(...pins.map((pin) => pin.lng));
    const south = Math.min(...pins.map((pin) => pin.lat));
    const north = Math.max(...pins.map((pin) => pin.lat));
    map.fitBounds([[west, south], [east, north]], { padding: 54, maxZoom: 5, duration: 1100 });
  }

  return (
    <>
      <div className="map-toolbar" aria-label={lang === "he" ? "ניווט בין נקודות" : "Location navigation"}>
        <button className="map-control-button" type="button" onClick={() => moveTo(activeIndex - 1)}>
          <ChevronLeft size={16} /> {lang === "he" ? "הקודם" : "Previous"}
        </button>
        <span className="map-location-counter" aria-live="polite">{activePin ? `${activeIndex + 1} / ${pins.length} · ${activePin.title}` : ""}</span>
        <button className="map-control-button" type="button" onClick={() => moveTo(activeIndex + 1)}>
          {lang === "he" ? "הבא" : "Next"} <ChevronRight size={16} />
        </button>
        <button className="map-control-button" type="button" onClick={showAll}>
          <Globe2 size={16} /> {lang === "he" ? "הצג הכל" : "Show all"}
        </button>
        {mapModes.length > 1 ? (
          <div className="map-mode-switch" role="group" aria-label={lang === "he" ? "סגנון מפה" : "Map style"}>
            {mapModes.map((mode) => <button key={mode} className={mapMode === mode ? "active" : ""} type="button" onClick={() => setMapMode(mode)}>{mode === "satellite" ? (lang === "he" ? "לוויין" : "Satellite") : (lang === "he" ? "מפה" : "Raster")}</button>)}
          </div>
        ) : null}
      </div>
      <div ref={containerRef} className="interactive-map" aria-label={lang === "he" ? "מפת הטיול" : "Trip map"} />
    </>
  );
}

function MapView({ config, itinerary, lang, onOpenItinerary }: { config?: TripConfig; itinerary?: ActiveItinerary; lang: Lang; onOpenItinerary: (pin: MapPin) => void }) {
  const phaseStops = (config?.phases || []).filter((phase) => typeof phase.mapStop?.lat === "number" && typeof phase.mapStop?.lng === "number");
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
          const ll = `${phase.mapStop?.lat},${phase.mapStop?.lng}`;
          const accommodationName = text(phase.accommodation?.name, lang) || phase.accommodation?.name_en || text(phase.mapStop?.name, lang) || text(phase.title, lang) || phase.id;
          const destination = phase.accommodation?.location_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(phase.accommodation?.address || ll)}`;
          const wazeDestination = `https://waze.com/ul?ll=${encodeURIComponent(ll)}&navigate=yes`;
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
              <span className="booking-type">{item.item_type}</span>
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

function ModulePlaceholder({ module, lang }: { module: Module; lang: Lang }) {
  return (
    <section className="module-layout">
      <div className="module-header">
        <span className="panel-label"><Sparkles size={16} /> {moduleLabel(module, lang)}</span>
        <h2>{moduleLabel(module, lang)} is next in the Modern rebuild.</h2>
        <p>It stays visible in navigation so we can keep the structure stable while rebuilding parity slice by slice.</p>
      </div>
    </section>
  );
}

function MoreView({ config, isOrganizer, openModule }: { config?: TripConfig; isOrganizer?: boolean; openModule: (module: Module) => void }) {
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  async function uploadHero(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.set("hero", file);
    body.set("focal_x", "0.5");
    body.set("focal_y", "0.42");
    setBusy(true);
    try {
      const token = tokenStore.get();
      await fetch(runtimeUrl("/api/ui-settings/hero"), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body,
      });
      queryClient.invalidateQueries({ queryKey: ["ui"] });
    } finally {
      setBusy(false);
    }
  }

  const workflows: Array<{ label: string; module?: Module }> = [
    { label: "Bookings, PDFs and wallet", module: "bookings" },
    { label: "Maps and country info", module: "map" },
    { label: "Budget", module: "budget" },
    { label: "Photos and reactions", module: "photos" },
    { label: "Tasks and packing" },
    { label: "RSVP, ratings and comments" },
    { label: "Lost and found" },
    { label: "Trivia and leaderboard" },
  ];
  return (
    <section className="more-layout">
      <div className="section-heading">
        <span className="panel-label"><Settings size={16} /> More</span>
        <h2>Classic remains one tap away while Modern reaches parity.</h2>
        <p>{config?.meta?.title || "This trip"} keeps budget and costs outside the daily itinerary.</p>
      </div>
      {isOrganizer ? (
        <section className="organizer-tools">
          <h3>Presentation</h3>
          <label className="upload-control">
            <Upload size={18} />
            <span>{busy ? "Uploading..." : "Change hero picture"}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadHero} disabled={busy} />
          </label>
        </section>
      ) : null}
      <div className="workflow-grid">
        {isOrganizer ? (
          <a className="workflow-link organizer-only" href={classicHref()}>
            <ChevronLeft size={16} />
            <span>Open Classic organizer fallback</span>
          </a>
        ) : null}
        {workflows.map((workflow) => (
          <a
            key={workflow.label}
            className="workflow-link"
            href={workflow.module ? `#${workflow.module}` : "#more"}
            onClick={(event) => {
              if (!workflow.module) return;
              event.preventDefault();
              openModule(workflow.module);
            }}
          >
            <ChevronLeft size={16} />
            <span>{workflow.label}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function AppMenu({
  open,
  lang,
  isOrganizer,
  setOpen,
  setLang,
  openTab,
  openModule,
}: {
  open: boolean;
  lang: Lang;
  isOrganizer?: boolean;
  setOpen: (open: boolean) => void;
  setLang: (lang: Lang) => void;
  openTab: (tab: Tab) => void;
  openModule: (module: Module) => void;
}) {
  if (!open) return null;
  return (
    <div className="menu-overlay" role="presentation" onClick={() => setOpen(false)}>
      <aside className="app-menu" role="dialog" aria-modal="true" aria-label="Trip menu" onClick={(event) => event.stopPropagation()}>
        <div className="menu-head">
          <img src={brandLogo} alt="Kinerary" />
          <button type="button" onClick={() => setOpen(false)} aria-label="Close menu"><X size={20} /></button>
        </div>
        <div className="menu-section">
          <small>{lang === "he" ? "ניווט" : "Navigation"}</small>
          {(Object.keys(tabIcons) as Tab[]).map((tab) => (
            <button key={tab} type="button" onClick={() => openTab(tab)}>{tabLabel(tab, lang)}</button>
          ))}
        </div>
        <div className="menu-section">
          <small>{lang === "he" ? "כלי הטיול" : "Trip tools"}</small>
          {moduleShortcuts.map((shortcut) => (
            <button key={shortcut.id} type="button" onClick={() => openModule(shortcut.id)}>{shortcut[lang]}</button>
          ))}
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
          {isOrganizer ? <a href={classicHref()}>Open Classic organizer fallback</a> : null}
          <button
            type="button"
            className="danger-menu"
            onClick={() => {
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
  const [journeyHeroPhaseId, setJourneyHeroPhaseId] = useState("");
  const [journeyFocus, setJourneyFocus] = useState<JourneyFocus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const authed = Boolean(tokenStore.get());
  const config = useQuery({ queryKey: ["config"], queryFn: getConfig, enabled: authed });
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, enabled: authed });
  const ui = useQuery({ queryKey: ["ui"], queryFn: getUiSettings, enabled: authed });
  const hermes = useQuery({ queryKey: ["hermes"], queryFn: getHermes, enabled: authed });
  const itinerary = useQuery({ queryKey: ["itinerary"], queryFn: getItinerary, enabled: authed, refetchInterval: 60_000 });
  const today = useQuery({ queryKey: ["today"], queryFn: getToday, enabled: authed, refetchInterval: 60_000 });

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
  }, [lang]);

  useEffect(() => {
    const syncHash = () => {
      const next = window.location.hash.replace("#", "");
      if (isTab(next)) {
        setActiveTab(next);
        setActiveModule(null);
      }
      if (isModule(next)) setActiveModule(next);
    };
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  if (!authed) return <LoginScreen />;

  const tabs = Object.keys(tabIcons) as Tab[];
  const openTab = (tab: Tab) => {
    setActiveTab(tab);
    setActiveModule(null);
    window.location.hash = tab;
    setMenuOpen(false);
  };
  const openModule = (module: Module) => {
    setActiveModule(module);
    window.location.hash = module;
    setMenuOpen(false);
  };
  const openMapItinerary = (pin: MapPin) => {
    setJourneyFocus({ phaseId: pin.phaseId, date: pin.date, itemUid: pin.itemUid });
    setActiveTab("journey");
    setActiveModule(null);
    window.location.hash = "journey";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const companionName = botDisplayName(config.data, hermes.data?.identity.name, lang);
  const heroPhaseId = !activeModule && activeTab === "journey"
    ? journeyHeroPhaseId
    : !activeModule && activeTab === "today"
      ? todayPhaseId(config.data, itinerary.data, today.data)
      : "";
  const tabContent = {
    today: <TodayView itinerary={itinerary.data} config={config.data} lang={lang} isOrganizer={me.data?.is_organizer} />,
    journey: <JourneyView itinerary={itinerary.data} config={config.data} isOrganizer={me.data?.is_organizer} lang={lang} botName={companionName} telegramUsername={hermes.data?.telegram_username} onHeroPhaseChange={setJourneyHeroPhaseId} focus={journeyFocus} />,
    moments: <MomentsView todayDate={today.data?.today} />,
    more: <MoreView config={config.data} isOrganizer={me.data?.is_organizer} openModule={openModule} />,
  }[activeTab];
  const moduleContent = activeModule ? {
    bookings: <BookingsView config={config.data} isOrganizer={me.data?.is_organizer} lang={lang} />,
    map: <MapView config={config.data} itinerary={itinerary.data} lang={lang} onOpenItinerary={openMapItinerary} />,
    budget: <ModulePlaceholder module="budget" lang={lang} />,
    photos: <ModulePlaceholder module="photos" lang={lang} />,
  }[activeModule] : null;
  const content = moduleContent || tabContent;

  return (
    <div className="modern-trip-app">
      <Hero config={config.data} settings={ui.data} lang={lang} activeTab={activeTab} activeModule={activeModule} heroPhaseId={heroPhaseId} openTab={openTab} openModule={openModule} openMenu={() => setMenuOpen(true)} />
      <main className="app-content">{content}</main>
      <AppMenu open={menuOpen} lang={lang} isOrganizer={me.data?.is_organizer} setOpen={setMenuOpen} setLang={setLang} openTab={openTab} openModule={openModule} />
      <nav className="bottom-nav" aria-label="Primary">
        {tabs.map((tab) => {
          const Icon = tabIcons[tab];
          return (
            <a
              key={tab}
              href={`#${tab}`}
              className={!activeModule && activeTab === tab ? "active" : ""}
              onClick={() => openTab(tab)}
            >
              <Icon size={20} />
              <span>{tabLabel(tab, lang)}</span>
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
