import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Brand } from "./Brand";

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="site-header">
      <Brand />

      <nav className="desktop-nav" aria-label="Primary navigation">
        <a href="#how-it-works">How it works</a>
        <a href="#why-kinerary">Why Kinerary</a>
        <a href="#privacy">Privacy</a>
      </nav>

      <div className="header-actions">
        <Link className="text-link" to="/sign-in">Sign in</Link>
        <Link className="button button-small button-coral" to="/trips/new">Start a trip</Link>
        <button
          className="menu-button"
          type="button"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X /> : <Menu />}
        </button>
      </div>

      {menuOpen && (
        <nav className="mobile-menu" id="mobile-menu" aria-label="Mobile navigation">
          <a href="#how-it-works" onClick={closeMenu}>How it works</a>
          <a href="#why-kinerary" onClick={closeMenu}>Why Kinerary</a>
          <a href="#privacy" onClick={closeMenu}>Privacy</a>
          <Link to="/sign-in" onClick={closeMenu}>Sign in</Link>
        </nav>
      )}
    </header>
  );
}
