import { CircleUserRound, Plus } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { Brand } from "./Brand";

export function AppHeader() {
  return (
    <header className="app-header">
      <Brand />
      <nav aria-label="Application navigation">
        <NavLink to="/trips">My trips</NavLink>
        <span className="future-nav" aria-disabled="true">Discover <small>Later</small></span>
      </nav>
      <div className="app-header-actions">
        <Link className="button button-small button-coral" to="/trips/new"><Plus size={16} /> New trip</Link>
        <Link className="profile-link" to="/sign-in" aria-label="Account"><CircleUserRound /></Link>
      </div>
    </header>
  );
}
