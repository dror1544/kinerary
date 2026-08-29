import { ArrowLeft, MapPin } from "lucide-react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";

export default function NotFoundPage() {
  return <main className="not-found"><Brand /><div><MapPin /><span>404</span></div><h1>This stop isn't on the route.</h1><p>The page may have moved, or the trip link may no longer be available.</p><Link className="button button-coral" to="/"><ArrowLeft size={17} /> Back to Kinerary</Link></main>;
}
