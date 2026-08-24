import {
  ArrowRight,
  BellRing,
  Check,
  Clock3,
  CloudRain,
  Coffee,
  Compass,
  LockKeyhole,
  MapPin,
  Route as RouteIcon,
  ShieldCheck,
  Sparkles,
  UtensilsCrossed,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";
import { SiteHeader } from "../components/SiteHeader";

type ScenarioKey = "rain" | "tired" | "dinner";

const scenarios: Record<ScenarioKey, {
  icon: typeof CloudRain;
  label: string;
  signal: string;
  title: string;
  copy: string;
  action: string;
  protectedAnchor: string;
}> = {
  rain: {
    icon: CloudRain,
    label: "Rain starts",
    signal: "Heavy rain from 14:00",
    title: "Move the outdoor stop, keep dinner safe.",
    copy: "Kinerary finds a nearby indoor option and leaves a 45-minute buffer before the fixed reservation.",
    action: "Museum at 14:30",
    protectedAnchor: "Dinner · 20:30",
  },
  tired: {
    icon: Coffee,
    label: "Energy drops",
    signal: "The group needs a slower afternoon",
    title: "Shorten the route without losing the highlight.",
    copy: "The optional market moves to tomorrow. The waterfront stop stays, with an earlier return to the hotel.",
    action: "Waterfront at 16:00",
    protectedAnchor: "Hotel rest · 18:00",
  },
  dinner: {
    icon: UtensilsCrossed,
    label: "Dinner moves",
    signal: "Reservation changed to 20:30",
    title: "One update, everyone aligned.",
    copy: "Kinerary checks driving time, keeps the boat booking untouched, and prepares one short family update.",
    action: "Leave hotel at 19:50",
    protectedAnchor: "Dinner · 20:30",
  },
};

function HeroStage() {
  const [approved, setApproved] = useState(false);

  return (
    <div className="hero-stage" aria-label="A live Kinerary trip update">
      <div className="sun" />
      <div className="coast coast-back" />
      <div className="coast coast-front" />
      <div className="route-line" aria-hidden="true"><i /><i /><i /><b /></div>

      <article className="today-card glass-card">
        <div className="card-kicker"><Clock3 size={15} /> Today in Naxos</div>
        <strong>Boat leaves at 09:15</strong>
        <p>Bring swimsuits and the blue tickets.</p>
        <div className="avatar-row" aria-hidden="true"><span>DE</span><span>ME</span><span>+4</span></div>
      </article>

      <article className={`change-card glass-card${approved ? " change-approved" : ""}`}>
        <span className="status-dot" />
        <div>
          <small>{approved ? "Shared with family" : "Plan change"}</small>
          <strong>Dinner moved to 20:30</strong>
          <p>{approved ? "Everyone has the latest plan" : "No anchor conflicts · ready to share"}</p>
        </div>
        <button type="button" onClick={() => setApproved(true)} disabled={approved}>
          {approved ? <><Check size={14} /> Shared</> : "Approve"}
        </button>
      </article>

      <div className="family-message glass-card"><span>Family</span>“What time do we leave?”</div>
    </div>
  );
}

function DualView() {
  const [view, setView] = useState<"organizer" | "family">("organizer");

  return (
    <section className="dual-view section-pad" id="why-kinerary" aria-labelledby="dual-title">
      <div className="section-heading centered-heading">
        <span className="section-label">One trip · two calm views</span>
        <h2 id="dual-title">The planner keeps control.<br />The family gets clarity.</h2>
        <p>Not everyone needs the machinery. Kinerary gives each person the right amount of trip.</p>
      </div>

      <div className="view-switcher" role="tablist" aria-label="Choose a Kinerary view">
        <button type="button" role="tab" aria-selected={view === "organizer"} onClick={() => setView("organizer")}>Organizer view</button>
        <button type="button" role="tab" aria-selected={view === "family"} onClick={() => setView("family")}>Family view</button>
      </div>

      <div className="product-frame">
        <div className="product-sidebar">
          <Brand compact reversed />
          <span className="side-active">Today</span>
          <span>Itinerary</span>
          <span>Map</span>
          <span>{view === "organizer" ? "Changes" : "Photos"}</span>
        </div>

        {view === "organizer" ? (
          <div className="product-content organizer-content" role="tabpanel">
            <div className="product-topline"><div><small>Tuesday · Day 4</small><h3>Today in Naxos</h3></div><span className="private-pill"><LockKeyhole size={13} /> Organizer only</span></div>
            <div className="product-grid">
              <div className="timeline-card">
                <span className="timeline-time">09:15</span><div><strong>Boat to Koufonisia</strong><p>Fixed anchor · tickets confirmed</p></div>
                <span className="timeline-time">14:30</span><div><strong>Beach or pottery studio</strong><p>Weather decision at 12:00</p></div>
                <span className="timeline-time">20:30</span><div><strong>Dinner · To Elliniko</strong><p>Changed · family update pending</p></div>
              </div>
              <div className="approval-panel"><span>Needs your approval</span><h4>Dinner moved by 30 minutes</h4><p>No conflicts. Suggested departure: 19:50.</p><button type="button">Review change <ArrowRight size={15} /></button></div>
            </div>
          </div>
        ) : (
          <div className="product-content family-content" role="tabpanel">
            <div className="product-topline"><div><small>Tuesday · Day 4</small><h3>Good morning, family</h3></div><span className="weather-pill">26° · Sunny</span></div>
            <div className="family-today-grid">
              <div className="next-card"><span>Up next</span><Clock3 /><h4>Leave at 08:45</h4><p>The boat departs at 09:15 from Naxos port.</p></div>
              <div className="bring-card"><span>Bring today</span><p>Swimsuits</p><p>Blue tickets</p><p>Sun hats</p></div>
              <div className="changed-card"><BellRing /><div><span>What changed?</span><p>Dinner is now at 20:30. Leave the hotel at 19:50.</p></div></div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ScenarioSection() {
  const [active, setActive] = useState<ScenarioKey>("rain");
  const scenario = scenarios[active];
  const ScenarioIcon = scenario.icon;

  return (
    <section className="scenario-section section-pad" aria-labelledby="scenario-title">
      <div className="scenario-copy">
        <span className="section-label on-dark">When reality changes</span>
        <h2 id="scenario-title">The plan is easy.<br />Reality is the hard part.</h2>
        <p>See how Kinerary protects the important parts without turning every change into group-chat chaos.</p>
        <div className="scenario-tabs" role="tablist" aria-label="Choose a trip change">
          {(Object.keys(scenarios) as ScenarioKey[]).map((key) => {
            const item = scenarios[key];
            const Icon = item.icon;
            return <button type="button" role="tab" aria-selected={active === key} onClick={() => setActive(key)} key={key}><Icon size={17} /> {item.label}</button>;
          })}
        </div>
      </div>

      <div className="scenario-board" role="tabpanel">
        <div className="scenario-signal"><ScenarioIcon /><span>{scenario.signal}</span></div>
        <h3>{scenario.title}</h3>
        <p>{scenario.copy}</p>
        <div className="scenario-route">
          <div><MapPin /><span><small>Adjusted</small>{scenario.action}</span></div>
          <i />
          <div><ShieldCheck /><span><small>Protected anchor</small>{scenario.protectedAnchor}</span></div>
        </div>
        <div className="scenario-ready"><Check /> Ready for organizer approval</div>
      </div>
    </section>
  );
}

export default function LandingPage() {
  return (
    <div className="app-shell">
      <SiteHeader />
      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <span className="eyebrow"><span /> Built for real family trips</span>
            <h1 id="hero-title">Keep your family trip moving—even when plans change.</h1>
            <p>One private place for plans, bookings, questions, and changes. The organizer stays in control; everyone else gets the simple answer they need.</p>
            <div className="hero-actions">
              <Link className="button button-coral" to="/trips/new">Start a trip <ArrowRight size={18} /></Link>
              <a className="button button-quiet" href="#how-it-works">See how it works</a>
            </div>
            <div className="trust-line">
              <span><ShieldCheck size={17} /> Private by default</span>
              <span><Check size={17} /> Organizer-approved changes</span>
            </div>
          </div>
          <HeroStage />
        </section>

        <section className="proof-strip" aria-label="Kinerary product principles">
          <span>Living itinerary</span><span>Family-ready answers</span><span>Private organizer control</span><span>Realistic buffers</span>
        </section>

        <DualView />
        <ScenarioSection />

        <section className="how-section section-pad" id="how-it-works" aria-labelledby="how-title">
          <div className="section-heading">
            <span className="section-label">How it works</span>
            <h2 id="how-title">From first idea to<br />the middle of the trip.</h2>
          </div>
          <div className="steps-grid">
            <article><span className="step-number">01</span><Compass /><h3>Start your trip</h3><p>Add the destination, dates, travelers, pace, and the things your family needs.</p></article>
            <article><span className="step-number">02</span><RouteIcon /><h3>Bring the plan together</h3><p>Keep bookings, places, anchors, and family suggestions in one living itinerary.</p></article>
            <article><span className="step-number">03</span><Users /><h3>Travel aligned</h3><p>Everyone sees today, what changed, what to bring, and when to leave—without chasing the planner.</p></article>
          </div>
        </section>

        <section className="privacy-section section-pad" id="privacy" aria-labelledby="privacy-title">
          <div className="privacy-mark"><LockKeyhole /></div>
          <div><span className="section-label on-dark">Private by design</span><h2 id="privacy-title">The family sees what helps.<br />Private details stay private.</h2></div>
          <div className="privacy-copy"><p>Organizer notes, booking references, and personal constraints stay scoped to the people who should see them.</p><ul><li><Check /> Suggestions need organizer approval</li><li><Check /> Sharing is explicit and revocable</li><li><Check /> Kinerary works with the tools you already use</li></ul></div>
        </section>

        <section className="final-cta">
          <div className="final-route" aria-hidden="true"><i /><i /><i /><b /></div>
          <Sparkles />
          <h2>Less repeating.<br />More being there.</h2>
          <p>Start the family trip everyone can actually follow.</p>
          <div><Link className="button button-coral" to="/trips/new">Start a trip <ArrowRight size={18} /></Link><Link className="button button-dark-quiet" to="/sign-in">Sign in</Link></div>
        </section>
      </main>

      <footer className="site-footer">
        <Brand />
        <p>Kinerary keeps family trips aligned when plans change.</p>
        <nav aria-label="Footer navigation"><a href="#how-it-works">How it works</a><a href="#privacy">Privacy</a><span>Terms</span><span>Help</span></nav>
        <small>© 2026 Kinerary</small>
      </footer>
    </div>
  );
}
