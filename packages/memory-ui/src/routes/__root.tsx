import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { logout } from "~/lib/api";
import { useAuthSession } from "~/lib/use-auth-session";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Memory — Allen Labs" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function Navbar() {
  const { loggedIn, user } = useAuthSession();

  return (
    <nav className="navbar">
      <Link to="/" className="nav-brand">
        Memory
      </Link>
      <div className="nav-links">
        <Link to="/" activeProps={{ className: "active" }}>
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
          <span className="nav-user-name">{user?.name ?? user?.email ?? ""}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <Navbar />
        <main id="main-content" className="container">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
