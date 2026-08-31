import { ArrowRight, CalendarDays, Camera, CheckCircle2, Clock3, Map, MapPin, MessageCircle, Play, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";

export default function TripsPage() {
  return (
    <div className="dashboard-shell">
      <AppHeader />
      <main className="dashboard-main">
        <div className="dashboard-title"><div><span className="preview-badge">Interface preview</span><h1>My trips</h1><p>Your plans before, during, and after the journey.</p></div><Link className="button button-coral" to="/trips/new">Start a new trip <ArrowRight size={17} /></Link></div>

        <section className="trip-shelf" aria-labelledby="active-trip-heading">
          <div className="shelf-heading"><div><span className="live-dot" /> Active now</div><span>Day 4 of 9</span></div>
          <article className="active-trip-card">
            <div className="active-trip-scene"><div className="mini-sun" /><div className="mini-island" /><span>NAXOS · GREECE</span></div>
            <div className="active-trip-content"><div className="trip-card-top"><div><span className="trip-state">Today</span><h2>Greek Islands with the family</h2><p><CalendarDays /> August 21–29 · 8 travelers</p></div><button type="button" aria-label="Trip options">•••</button></div><div className="active-next"><Clock3 /><div><small>UP NEXT · 08:45</small><strong>Leave for Naxos port</strong><p>Boat departs at 09:15 · blue tickets</p></div><ArrowRight /></div><div className="trip-quick-actions"><button type="button"><Map /> Today</button><button type="button"><MessageCircle /> Ask Kinerary</button><button type="button"><Camera /> Photos</button></div></div>
          </article>
        </section>

        <section className="trip-shelf" aria-labelledby="upcoming-heading"><div className="shelf-heading"><h2 id="upcoming-heading">Continue and upcoming</h2><span>2 trips</span></div><div className="trip-card-grid">
          <article className="small-trip-card setup-card"><div className="small-trip-visual setup-visual"><span>JAPAN</span><MapPin /></div><div className="small-trip-body"><span className="trip-state amber">Continue setup</span><h3>Japan spring adventure</h3><p>March 28–April 12, 2027</p><div className="setup-progress"><span><i style={{ width: "64%" }} /></span><small>Interview · 64%</small></div><button type="button">Continue interview <ArrowRight size={15} /></button></div></article>
          <article className="small-trip-card"><div className="small-trip-visual alps-visual"><span>SWISS ALPS</span><CheckCircle2 /></div><div className="small-trip-body"><span className="trip-state teal">Ready</span><h3>Alps with friends</h3><p>December 18–27, 2026</p><div className="upcoming-meta"><span>116 days</span><span>6 travelers</span></div><button type="button">Open trip <ArrowRight size={15} /></button></div></article>
        </div></section>

        <section className="trip-shelf past-shelf" aria-labelledby="past-heading"><div className="shelf-heading"><h2 id="past-heading">Past trips</h2><button type="button">View all</button></div><article className="past-trip-row"><div className="past-trip-cover"><span>ITALY</span></div><div><h3>Tuscany summer</h3><p>June 2025 · 12 days · 312 photos</p></div><div className="memory-actions"><button type="button"><Play /> Route movie</button><button type="button"><Sparkles /> Ask memories</button></div><button className="open-memory" type="button">Open memories <ArrowRight size={16} /></button></article></section>
      </main>
    </div>
  );
}
