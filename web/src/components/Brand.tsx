import { Link } from "react-router-dom";
import kineraryLogoReversed from "../assets/brand/logo-reversed.svg";
import kineraryLogo from "../assets/brand/logo.svg";
import kineraryMarkCompact from "../assets/brand/mark-compact.svg";
import kineraryMarkReversed from "../assets/brand/mark-reversed.svg";

type BrandProps = {
  compact?: boolean;
  reversed?: boolean;
};

export function Brand({ compact = false, reversed = false }: BrandProps) {
  const logo = reversed ? kineraryLogoReversed : kineraryLogo;
  const mark = reversed ? kineraryMarkReversed : kineraryMarkCompact;

  return (
    <Link
      className={`brand${compact ? " brand-compact" : ""}${reversed ? " brand-reversed" : ""}`}
      to="/"
      aria-label="Kinerary home"
    >
      {!compact && <img className="brand-lockup" src={logo} alt="" />}
      {compact && <img className="brand-mark" src={mark} alt="" />}
    </Link>
  );
}
