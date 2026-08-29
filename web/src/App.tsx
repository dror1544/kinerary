import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

const LandingPage = lazy(() => import("./pages/LandingPage"));
const ProductApp = lazy(() => import("./pages/ProductApp"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));

function RouteFallback() {
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <span className="route-fallback-mark" />
      <span>Loading your route…</span>
    </div>
  );
}

function PageTitle() {
  const location = useLocation();
  const titles: Record<string, string> = {
    "/": "Kinerary — Keep the family trip moving",
    "/sign-in": "Sign in — Kinerary",
    "/sign-up": "Create your account — Kinerary",
    "/forgot-password": "Reset your password — Kinerary",
    "/trips": "My trips — Kinerary",
    "/trips/new": "Start a trip — Kinerary",
  };
  useEffect(() => {
    document.title = titles[location.pathname] ?? "Kinerary";
  }, [location.pathname]);
  return null;
}

export function App() {
  return (
    <>
      <PageTitle />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/sign-in" element={<ProductApp view="sign-in" />} />
          <Route path="/sign-up" element={<Navigate to="/sign-in" replace />} />
          <Route path="/forgot-password" element={<Navigate to="/sign-in" replace />} />
          <Route path="/trips" element={<ProductApp view="trips" />} />
          <Route path="/trips/new" element={<ProductApp view="new-trip" />} />
          <Route path="/trips/:tripId/setup" element={<ProductApp view="trip" />} />
          <Route path="/trips/:tripId" element={<ProductApp view="trip" />} />
          <Route path="/trips/:tripId/app" element={<ProductApp view="runtime" />} />
          <Route path="/join" element={<ProductApp view="join" />} />
          <Route path="/ops/provisioning" element={<ProductApp view="ops" />} />
          <Route path="/new-trip" element={<Navigate to="/trips/new" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </>
  );
}
