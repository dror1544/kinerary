import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  Camera,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  CloudSun,
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
  Plane,
  Plus,
  RefreshCw,
  Route,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  Upload,
  X,
} from "lucide-react";
import brandLogo from "./assets/brand/logo.svg";
import brandLogoReversed from "./assets/brand/logo-reversed.svg";
import brandMark from "./assets/brand/mark.svg";
import {
  ActiveItinerary,
  Booking,
  approveBookingDraft,
  ItineraryItem,
  TripConfig,
  createMoment,
  extractBookingDraft,
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
} from "./api";

type Tab = "today" | "journey" | "moments" | "more";
type Module = "bookings" | "map" | "budget" | "photos";
type Lang = "he" | "en";
type BookingFilter = "phase" | "today" | "current" | "flight" | "hotel" | "attraction";

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

function phaseLabel(phase: string) {
  return {
    pre_trip: "Getting ready",
    flight_day: "Flight day",
    active_day: "On the road",
    transfer_day: "Transfer day",
    post_trip: "Memory mode",
  }[phase] || "Today";
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

function extraLinkLabel(link: NonNullable<ItineraryItem["extra_links"]>[number], lang: Lang) {
  return text(link.label, lang) || text(link.title, lang) || text(link.name, lang) || "Extra";
}

export function classicHrefForLocation(path: string, hostname: string, port: string) {
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
          <img src={brandLogoReversed} alt="Kinerary" />
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
        <span className="eyebrow"><Sparkles size={16} /> {activePhaseName || "Living journey"}</span>
        <h1>{activePhaseName || config?.meta?.destination || config?.meta?.title || "Today knows where the trip is."}</h1>
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
  const askUrl = telegramUrl(telegramUsername, `${botName || "Trip companion"}, question about this plan: ${title}`);
  const extraLinks = (item.extra_links || []).map((link) => ({
    label: extraLinkLabel(link, lang),
    url: link.url || link.href || "",
  })).filter((link) => link.url);

  return (
    <article className={`timeline-item ${compact ? "compact" : ""}`}>
      <div className="time-rail">
        <span>{item.time || "Anytime"}</span>
        <i />
      </div>
      <div className="item-body">
        <div className="item-kicker">
          <Icon size={16} />
          <span>{item.item_type.replace("_", " ")}</span>
          {item.provenance?.status === "updated_from_original" ? <b>Updated from original</b> : null}
          {item.provenance?.status === "added" ? <b>Added</b> : null}
        </div>
        <h3>{title}</h3>
        <div className="item-meta">
          {item.booking?.confirmation ? <span><CheckCircle2 size={14} /> Confirmation stored</span> : null}
          {item.location_url ? <a href={item.location_url} target="_blank" rel="noreferrer"><MapPin size={14} /> Map</a> : null}
          {item.waze_url ? <a href={item.waze_url} target="_blank" rel="noreferrer"><Navigation size={14} /> Waze</a> : null}
          {item.confirmation_state && item.confirmation_state !== "verified" ? <span><AlertTriangle size={14} /> Needs review</span> : null}
        </div>
        <div className="item-actions" aria-label={`Actions for ${title}`}>
          {confirmationUrl ? <a className="item-action" href={confirmationUrl} target="_blank" rel="noreferrer"><ShieldCheck size={15} /> Confirmation</a> : null}
          {item.ticket_url ? <a className="item-action" href={item.ticket_url} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Tickets</a> : null}
          {item.website_url ? <a className="item-action" href={item.website_url} target="_blank" rel="noreferrer"><Globe2 size={15} /> Site</a> : null}
          {item.booking?.google_wallet_url ? <a className="item-action" href={item.booking.google_wallet_url} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Google Wallet</a> : null}
          {item.booking?.apple_wallet_url || appleWalletUrl ? <a className="item-action" href={item.booking?.apple_wallet_url || appleWalletUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Apple Wallet</a> : null}
          {extraLinks.map((link) => <a key={`${link.label}-${link.url}`} className="item-action" href={link.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> {link.label}</a>)}
          {askUrl ? <a className="item-action companion" href={askUrl} target="_blank" rel="noreferrer"><MessageCircle size={15} /> Ask</a> : null}
        </div>
      </div>
    </article>
  );
}

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
  const label = today ? phaseLabel(today.phase) : "Trip clock";
  const destination = phase ? text(phase.title, lang) || phase.id : config?.meta?.destination || config?.meta?.title || "the journey";

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
            ? `${Math.max(today.countdown_days, 0)} days until the adventure starts`
            : phaseDayIndex > 0
              ? `Day ${phaseDayIndex} in ${destination}`
              : `Now tracking ${destination}`}
        </h3>
        <p>
          {totalDays && totalIndex > 0
            ? `Trip day ${totalIndex} of ${totalDays}. The page keeps following destination-local time.`
            : "Countdown, current phase, and next event all move with the trip clock."}
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
  const firstStop = config?.phases?.find((phase) => phase.mapStop?.lat && phase.mapStop?.lng)?.mapStop;
  const weather = useQuery({
    queryKey: ["weather", firstStop?.lat, firstStop?.lng, today.data?.today],
    queryFn: () => getWeather(firstStop!.lat!, firstStop!.lng!, today.data!.today),
    enabled: Boolean(firstStop?.lat && firstStop?.lng && today.data?.today),
  });
  const missing = confirmations.data?.items.filter((item) => item.state !== "verified").slice(0, 3) || [];
  const next = today.data?.next || itinerary?.items[0] || null;
  const companionName = botDisplayName(config, hermes.data?.identity.name, lang);

  return (
    <section className="view-grid today-grid">
      <div className="focus-panel">
        <span className="panel-label">{today.data ? phaseLabel(today.data.phase) : "Today"}</span>
        <h2>{next ? next.text_en || next.text_he : "Your trip clock is warming up."}</h2>
        <p>
          {today.data?.phase === "pre_trip" && today.data.countdown_days != null
            ? `${Math.max(today.data.countdown_days, 0)} days until departure.`
            : "Now and next stay current without a page reload."}
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
  lang,
  botName,
  telegramUsername,
  onHeroPhaseChange,
}: {
  itinerary?: ActiveItinerary;
  config?: TripConfig;
  lang: Lang;
  botName?: string;
  telegramUsername?: string | null;
  onHeroPhaseChange: (phaseId: string) => void;
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
      <section className="day-spine">
        <div className="day-heading">
          <span className="panel-label">{activePhase?.title || "Journey"}</span>
          <h2>{day?.label_en || day?.label_he || "Daily itinerary"}</h2>
          {day?.lodging_context?.name ? <p>Tonight: {day.lodging_context.name}</p> : null}
          <div className="day-selector" aria-label="Days in selected phase">
            {(activePhase?.days || []).map((entry) => (
              <button key={`${entry.phase_id}-${entry.date}`} className={entry.date === activeDate ? "active" : ""} onClick={() => setSelected(entry.date)}>
                <span>{dateLabel(entry.date, lang)}</span>
                <small>{entry.label_en || entry.label_he || entry.phase_id}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="timeline">
          {dayItems.length ? dayItems.map((item) => (
            <TimelineItem key={item.item_uid} item={item} lang={lang} botName={botName} telegramUsername={telegramUsername} />
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

function BookingActions({ booking }: { booking: Booking }) {
  const confirmationUrl = safeFileUrl("/api/bookings/confirmation", booking.conf_file);
  const appleWalletUrl = safeFileUrl("/api/bookings/wallet-apple", booking.pkpass_file);
  return (
    <div className="action-strip">
      {confirmationUrl ? <a href={confirmationUrl} target="_blank" rel="noreferrer"><ShieldCheck size={15} /> Confirmation</a> : null}
      {booking.location_url ? <a href={booking.location_url} target="_blank" rel="noreferrer"><MapPin size={15} /> Google Maps</a> : null}
      {booking.google_wallet_url ? <a href={booking.google_wallet_url} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Google Wallet</a> : null}
      {booking.apple_wallet_url || appleWalletUrl ? <a href={booking.apple_wallet_url || appleWalletUrl} target="_blank" rel="noreferrer"><TicketCheck size={15} /> Apple Wallet</a> : null}
    </div>
  );
}

function BookingExtractPanel({ isOrganizer }: { isOrganizer?: boolean }) {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Booking | null>(null);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      const body = new FormData();
      if (file) body.set("file", file);
      if (url.trim()) body.set("url", url.trim());
      return extractBookingDraft(body);
    },
    onSuccess: (value) => {
      setResult(value.booking);
      queryClient.invalidateQueries({ queryKey: ["bookings"] });
    },
  });

  if (!isOrganizer) return null;
  return (
    <form
      className="extract-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file && !url.trim()) return;
        mutation.mutate();
      }}
    >
      <span className="panel-label"><Upload size={16} /> Extract</span>
      <h3>Pull booking details from a PDF or URL</h3>
      <p>Creates an organizer-only draft. Check it, then approve it for trip members.</p>
      <label>
        Confirmation PDF
        <input type="file" accept="application/pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} />
      </label>
      <label>
        Or booking URL
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." />
      </label>
      <button className="primary-action" type="submit" disabled={mutation.isPending || (!file && !url.trim())}>
        {mutation.isPending ? "Extracting..." : "Create draft for review"}
      </button>
      {mutation.isError ? <p className="form-error">{mutation.error instanceof Error ? mutation.error.message : "Extraction failed"}</p> : null}
      {result ? <p className="extract-result">Draft created: <strong>{result.name}</strong>. It is visible only to organizers until approved.</p> : null}
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
      <BookingExtractPanel isOrganizer={isOrganizer} />
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

function MapView({ config, lang }: { config?: TripConfig; itinerary?: ActiveItinerary; lang: Lang }) {
  const phaseStops = (config?.phases || []).filter((phase) => typeof phase.mapStop?.lat === "number" && typeof phase.mapStop?.lng === "number");

  return (
    <section className="module-layout">
      <div className="module-header">
        <span className="panel-label"><Map size={16} /> {moduleLabel("map", lang)}</span>
        <h2>{lang === "he" ? "תחנות הלינה של שלבי הטיול" : "Journey phase accommodation stops"}</h2>
        <p>{lang === "he" ? "בשלב הראשון המפה נשארת ממוקדת: תחנת הלינה הראשונה של כל שלב, עם ניווט מהיר. נקודות יומיות יתווספו בשלב הבא." : "The first map view stays intentionally focused: the first accommodation stop for each phase, with one-tap navigation. Daily locations come in the next stage."}</p>
      </div>
      <div className="module-grid">
        {phaseStops.map((phase) => {
          const ll = `${phase.mapStop?.lat},${phase.mapStop?.lng}`;
          const accommodationName = text(phase.accommodation?.name, lang) || phase.accommodation?.name_en || text(phase.mapStop?.name, lang) || text(phase.title, lang) || phase.id;
          const destination = phase.accommodation?.location_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(phase.accommodation?.address || ll)}`;
          const wazeDestination = `https://waze.com/ul?ll=${encodeURIComponent(ll)}&navigate=yes`;
          return (
            <article className="map-anchor" key={phase.id}>
              <span className="booking-type">{lang === "he" ? "שלב" : "Phase"}</span>
              <h3>{text(phase.title, lang) || phase.id}</h3>
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
  const companionName = botDisplayName(config.data, hermes.data?.identity.name, lang);
  const heroPhaseId = !activeModule && activeTab === "journey"
    ? journeyHeroPhaseId
    : !activeModule && activeTab === "today"
      ? todayPhaseId(config.data, itinerary.data, today.data)
      : "";
  const tabContent = {
    today: <TodayView itinerary={itinerary.data} config={config.data} lang={lang} isOrganizer={me.data?.is_organizer} />,
    journey: <JourneyView itinerary={itinerary.data} config={config.data} lang={lang} botName={companionName} telegramUsername={hermes.data?.telegram_username} onHeroPhaseChange={setJourneyHeroPhaseId} />,
    moments: <MomentsView todayDate={today.data?.today} />,
    more: <MoreView config={config.data} isOrganizer={me.data?.is_organizer} openModule={openModule} />,
  }[activeTab];
  const moduleContent = activeModule ? {
    bookings: <BookingsView config={config.data} isOrganizer={me.data?.is_organizer} lang={lang} />,
    map: <MapView config={config.data} lang={lang} />,
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
