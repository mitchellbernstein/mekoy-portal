import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from "react-router";
import "./theme.css";
import "./styles.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#f5f5f6" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#121418" media="(prefers-color-scheme: dark)" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <MotionConfig reducedMotion="user"><Outlet /></MotionConfig>;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) && error.status === 404
    ? "This page could not be found."
    : "We couldn’t load this page. Please try again.";
  return <main className="standalone-state"><h1>{message}</h1><a className="button primary" href="/">Go to Home</a></main>;
}
