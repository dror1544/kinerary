import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

const LandingPage = lazy(() => import("./pages/LandingPage"));
const SignInPage = lazy(() => import("./pages/SignInPage"));
const SignUpPage = lazy(() => import("./pages/SignUpPage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));
const NewTripPage = lazy(() => import("./pages/NewTripPage"));
const TripsPage = lazy(() => import("./pages/TripsPage"));
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
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/sign-up" element={<SignUpPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/trips" element={<TripsPage />} />
          <Route path="/trips/new" element={<NewTripPage />} />
          <Route path="/new-trip" element={<Navigate to="/trips/new" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </>
  );
}
