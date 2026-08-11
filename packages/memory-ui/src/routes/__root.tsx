import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { isLoggedIn, getUserInfo, logout } from "~/lib/api";
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
  const [loggedIn, setLoggedIn] = useState(false);
  const [user, setUser] = useState<{ email?: string; name?: string } | null>(null);

  useEffect(() => {
    setLoggedIn(isLoggedIn());
    setUser(getUserInfo());
  }, []);

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
      </div>
      {loggedIn && (
        <div className="nav-user">
          {user?.name ?? user?.email ?? ""}
          <button className="btn btn-sm btn-secondary" onClick={logout}>
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
        <Navbar />
        <main className="container">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
