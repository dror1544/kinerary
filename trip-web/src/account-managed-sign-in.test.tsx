import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Account } from "./account";

// S2c: a person who came in through a Kinerary account (a group claim or a personal invite) is refused by the site on the
// password and Google-link routes, so the page must not offer them. The site says so with `sign_in_managed` on /api/auth/me.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(currentUser: { username: string; sign_in_managed?: boolean }, lang: "en" | "he") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ googleClientId: null }), { status: 200, headers: { "content-type": "application/json" } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Account currentUser={currentUser} lang={lang} />
    </QueryClientProvider>,
  );
}

it("a managed member session is not offered a password or a Google link, and is told where its sign-in lives (English)", () => {
  mount({ username: "eve", sign_in_managed: true }, "en");
  expect(screen.queryByLabelText("New password")).toBeNull();
  expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Google account" })).toBeNull();
  expect(screen.getByText("You sign in with your Kinerary account.")).toBeInTheDocument();
  // the rest of the account page is unchanged
  expect(screen.getByText("Profile picture")).toBeInTheDocument();
});

it("the same in Hebrew", () => {
  mount({ username: "eve", sign_in_managed: true }, "he");
  expect(screen.queryByLabelText("סיסמה חדשה")).toBeNull();
  expect(screen.getByText("הכניסה שלך היא עם חשבון Kinerary.")).toBeInTheDocument();
});

it("every other session still sees both controls", () => {
  mount({ username: "eve" }, "en");
  expect(screen.getByLabelText("New password")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Google account" })).toBeInTheDocument();
  expect(screen.queryByText("You sign in with your Kinerary account.")).toBeNull();
});
