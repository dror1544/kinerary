import { ArrowLeft, ArrowRight, CalendarDays, Check, MapPin, Users } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";

type TripIntent = {
  destination: string;
  startDate: string;
  endDate: string;
  tripType: string;
};

const emptyIntent: TripIntent = { destination: "", startDate: "", endDate: "", tripType: "family" };

function readIntent(): TripIntent {
  try {
    const stored = sessionStorage.getItem("kinerary.trip-intent");
    return stored ? { ...emptyIntent, ...JSON.parse(stored) } : emptyIntent;
  } catch {
    return emptyIntent;
  }
}

export default function NewTripPage() {
  const [intent, setIntent] = useState<TripIntent>(readIntent);
  const [stage, setStage] = useState<"basics" | "account">("basics");

  useEffect(() => {
    sessionStorage.setItem("kinerary.trip-intent", JSON.stringify(intent));
  }, [intent]);

  const update = (field: keyof TripIntent, value: string) => setIntent((current) => ({ ...current, [field]: value }));
  const submitBasics = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStage("account");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <main className="trip-start-layout">
      <header className="trip-start-header"><Brand /><Link to="/"><ArrowLeft size={16} /> Back</Link></header>
      <div className="trip-start-progress" aria-label="Trip setup progress"><span className="active"><b>1</b> Trip basics</span><i /><span className={stage === "account" ? "active" : ""}><b>2</b> Save your trip</span><i /><span><b>3</b> Interview</span></div>

      {stage === "basics" ? (
        <section className="trip-start-card">
          <span className="section-label">Start a new trip</span>
          <h1>Where are you headed?</h1>
          <p>Start with the shape of the trip. You can add bookings, travelers, and important constraints after signing in.</p>
          <form onSubmit={submitBasics}>
            <label>Destination<div className="input-wrap large-input"><MapPin /><input value={intent.destination} onChange={(event) => update("destination", event.target.value)} required placeholder="Japan, Greece, Northern Italy…" autoFocus /></div></label>
            <div className="field-row"><label>Start date<div className="input-wrap"><CalendarDays /><input type="date" value={intent.startDate} onChange={(event) => update("startDate", event.target.value)} /></div></label><label>End date<div className="input-wrap"><CalendarDays /><input type="date" min={intent.startDate || undefined} value={intent.endDate} onChange={(event) => update("endDate", event.target.value)} /></div></label></div>
            <fieldset><legend>Who's traveling?</legend><div className="trip-type-grid">{[["family", "Family", "Kids, parents, grandparents"], ["multi-family", "Multi-family", "More than one household"], ["friends", "Friends", "A group traveling together"], ["road-trip", "Road trip", "Stops, driving, and pace"]].map(([value, label, help]) => <label className={intent.tripType === value ? "selected" : ""} key={value}><input type="radio" name="tripType" value={value} checked={intent.tripType === value} onChange={() => update("tripType", value)} /><Users /><strong>{label}</strong><span>{help}</span>{intent.tripType === value && <Check className="type-check" />}</label>)}</div></fieldset>
            <button className="button button-coral trip-continue" type="submit">Continue <ArrowRight size={18} /></button>
          </form>
          <small className="privacy-note">Nothing is sent or saved to Kinerary until you sign in.</small>
        </section>
      ) : (
        <section className="trip-start-card account-gate">
          <div className="trip-intent-summary"><span><MapPin /> Your trip</span><h2>{intent.destination}</h2><p>{intent.startDate || "Dates flexible"}{intent.endDate ? ` → ${intent.endDate}` : ""} · {intent.tripType.replace("-", " ")}</p></div>
          <span className="section-label">Save and continue</span>
          <h1>Your trip needs a home.</h1>
          <p>Create an account or sign in to save this draft, start the private interview, and return whenever you need.</p>
          <Link className="button button-coral account-choice" to="/sign-up?returnTo=/trips/new">Create an account <ArrowRight size={17} /></Link>
          <Link className="button button-quiet account-choice" to="/sign-in?returnTo=/trips/new">I already have an account</Link>
          <button className="back-button" type="button" onClick={() => setStage("basics")}><ArrowLeft size={16} /> Edit trip basics</button>
        </section>
      )}
    </main>
  );
}
