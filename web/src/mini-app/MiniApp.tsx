import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import ProductApp from "../pages/ProductApp";
import { miniAppLaunch, tripIdPattern } from "./launch";
import { miniStyles, safely, useMiniSdk } from "./sdk";
import "./mini-app.css";

export default function MiniApp() {
  const location = useLocation();
  const { tripId } = useParams();
  const navigate = useNavigate();
  const sdk = useMiniSdk();
  const [styles, setStyles] = useState(() => miniStyles(sdk));
  const launch = miniAppLaunch(location.search);
  const invalid = launch.kind === "invalid" || Boolean(tripId && !tripIdPattern.test(tripId));
  useEffect(() => {
    safely(() => sdk?.ready?.());
    safely(() => sdk?.expand?.());
    const refresh = () => setStyles(miniStyles(sdk));
    refresh();
    const back = () => navigate("/mini-app");
    const events = ["themeChanged", "safeAreaChanged", "contentSafeAreaChanged"];
    for (const event of events) safely(() => sdk?.onEvent?.(event, refresh));
    if (tripId) { safely(() => sdk?.BackButton?.onClick?.(back)); safely(() => sdk?.BackButton?.show?.()); }
    else safely(() => sdk?.BackButton?.hide?.());
    return () => {
      for (const event of events) safely(() => sdk?.offEvent?.(event, refresh));
      safely(() => sdk?.BackButton?.offClick?.(back));
      safely(() => sdk?.BackButton?.hide?.());
    };
  }, [sdk, tripId, navigate]);
  if (!invalid && !tripId && launch.kind === "trip") return <Navigate replace to={`/mini-app/trips/${launch.tripId}`} />;
  return <div className={`mini-app-shell${tripId ? " mini-app-trip" : ""}`} data-testid="mini-app-shell" style={styles}>
    <header className="mini-app-bar"><span>Your travel companion</span>{tripId && <Link to="/mini-app">My trips</Link>}</header>
    {invalid ? <main className="mini-app-unavailable"><p className="eyebrow">Kinerary</p><h1>This launch link is unavailable</h1><p>Open your personal space to choose a trip you can access.</p><Link className="button" to="/mini-app">My trips</Link></main> : <ProductApp key={tripId ?? "account"} view={tripId ? "runtime" : "trips"} />}
  </div>;
}
