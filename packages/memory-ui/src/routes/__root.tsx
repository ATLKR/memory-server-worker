import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
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

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
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
        </nav>
        <main className="container">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
