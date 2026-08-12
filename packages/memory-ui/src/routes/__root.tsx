import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useNavigate,
  useRouter,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StatusPage } from "~/components/status-page";
import { ANONYMOUS_SESSION } from "~/lib/api";
import { loadSession } from "~/lib/session";
import {
  AuthSessionProvider,
  useAuthSession,
} from "~/lib/use-auth-session";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  loader: () => loadSession(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Memory — Allen Labs" },
      {
        name: "description",
        content: "Search and manage your private Agent Memory collection.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFoundComponent,
});

function RootComponent() {
  const session = Route.useLoaderData();
  return (
    <AuthSessionProvider initialSession={session}>
      <RootDocument>
        <Outlet />
      </RootDocument>
    </AuthSessionProvider>
  );
}

function Navbar() {
  const { loggedIn, user, signingOut, error, signOut } = useAuthSession();
  const router = useRouter();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    const signedOut = await signOut();
    if (!signedOut) return;
    await router.invalidate();
    await navigate({ to: "/", replace: true });
  };

  return (
    <>
      <nav className="navbar" aria-label="Primary navigation">
        <Link to="/" className="nav-brand">
          Memory
        </Link>
        <div className="nav-links">
          <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "active" }}>
            All
          </Link>
          <Link to="/new" activeProps={{ className: "active" }}>
            New
          </Link>
          <Link to="/summary" activeProps={{ className: "active" }}>
            Summary
          </Link>
        </div>
        {loggedIn && (
          <div className="nav-user">
            <span className="nav-user-name">{user?.name ?? user?.email ?? "Signed in"}</span>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}
      </nav>
      {error && <div className="global-error" role="alert">{error}</div>}
    </>
  );
}

function SpaNavigationAnnouncer() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previousPath = useRef(pathname);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("#main-content")?.focus();
      setAnnouncement(`Navigated to ${document.title}`);
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  return <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>;
}

export function RootErrorComponent({ reset }: ErrorComponentProps) {
  const retry = () => {
    if (typeof reset === "function") {
      reset();
      return;
    }
    if (typeof window !== "undefined") window.location.reload();
  };
  return (
    <AuthSessionProvider initialSession={ANONYMOUS_SESSION}>
      <RootDocument showNavbar={false}>
        <StatusPage
          title="Something went wrong"
          message="Memory could not load this page. Please retry."
          retry={retry}
        />
      </RootDocument>
    </AuthSessionProvider>
  );
}

export function RootNotFoundComponent() {
  return (
    <AuthSessionProvider initialSession={ANONYMOUS_SESSION}>
      <RootDocument showNavbar={false}>
        <StatusPage
          title="Page not found"
          message="The page you requested does not exist or has moved."
        />
      </RootDocument>
    </AuthSessionProvider>
  );
}

function RootDocument({
  children,
  showNavbar = true,
}: {
  children: ReactNode;
  showNavbar?: boolean;
}) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        {showNavbar && <Navbar />}
        <main id="main-content" className="container" tabIndex={-1}>{children}</main>
        <SpaNavigationAnnouncer />
        <Scripts />
      </body>
    </html>
  );
}
