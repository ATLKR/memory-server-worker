import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatusPage } from "./status-page";

describe("StatusPage", () => {
  it("offers an accessible retry and a reliable home navigation", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(<StatusPage title="Page not found" message="This page moved." retry={retry} />);

    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Go to memories" })).toHaveAttribute("href", "/");
  });
});
