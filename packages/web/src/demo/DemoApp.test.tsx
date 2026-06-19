import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DemoApp } from "./DemoApp";

const flush = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe("DemoApp", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("walks the guided demo: report -> self-approval block -> human decision -> done", () => {
    render(<DemoApp />);

    // Beat 0 (default scenario: pharmacovigilance).
    expect(screen.getByText(/An AI agent triages safety cases/i)).toBeTruthy();

    // Next -> the agent produces the report -> beat 1.
    fireEvent.click(screen.getByRole("button", { name: /Start the run/i }));
    flush(2100);
    expect(screen.getByText(/It produced an ICSR assessment/i)).toBeTruthy();
    // The report doc's heading (the title/ref also appear in the modal copy and,
    // now, in the audit-trail payloads — so scope to the heading).
    expect(screen.getByRole("heading", { name: /ICSR Expedited-Reportability Assessment/i })).toBeTruthy();

    // Next -> the agent tries to self-approve -> blocked.
    fireEvent.click(screen.getByRole("button", { name: /Let it try to self-approve/i }));
    flush(2200);
    expect(screen.getByText(/Blocked — the maker cannot be the checker/i)).toBeTruthy();

    // Next -> hands control to the user; decision buttons go live.
    fireEvent.click(screen.getByRole("button", { name: /I'll decide it myself/i }));
    flush(200);
    expect(screen.getByText(/Decision denied/i)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /^Confirm expedited$/ });
    expect(confirm.hasAttribute("disabled")).toBe(false);

    // The human decides.
    fireEvent.click(confirm);
    flush(1800);
    expect(screen.getByText(/An agent in production, under control/i)).toBeTruthy();
    expect(screen.getByText(/approved by the medical reviewer/i)).toBeTruthy();
  });

  it("renders every scenario's report and chart via the skip path", () => {
    render(<DemoApp />);

    // Pharmacovigilance is the default scenario (bar chart with threshold).
    fireEvent.click(screen.getByRole("button", { name: /Skip the walkthrough/i }));
    expect(screen.getByText(/ICSR Expedited-Reportability Assessment/i)).toBeTruthy();

    // Cold chain (line chart).
    fireEvent.click(screen.getByRole("button", { name: /Cold chain/i }));
    fireEvent.click(screen.getByRole("button", { name: /Skip the walkthrough/i }));
    expect(screen.getByRole("heading", { name: /Cold-Chain Incident Report/i })).toBeTruthy();

    // Medical devices (bar chart).
    fireEvent.click(screen.getByRole("button", { name: /Medical devices/i }));
    fireEvent.click(screen.getByRole("button", { name: /Skip the walkthrough/i }));
    expect(screen.getByText(/Adverse-Event Reportability Assessment/i)).toBeTruthy();

    // Pharma pricing (waterfall chart).
    fireEvent.click(screen.getByRole("button", { name: /Pharma pricing/i }));
    fireEvent.click(screen.getByRole("button", { name: /Skip the walkthrough/i }));
    expect(screen.getByText(/Gross-to-Net Margin Certification/i)).toBeTruthy();

    // Financial crime (bar chart with threshold).
    fireEvent.click(screen.getByRole("button", { name: /Financial crime/i }));
    fireEvent.click(screen.getByRole("button", { name: /Skip the walkthrough/i }));
    expect(screen.getByText(/Suspicious Activity Assessment/i)).toBeTruthy();
  });

  it("advances on Enter, supports the secondary decision, and replays", () => {
    render(<DemoApp />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    flush(2100);
    expect(screen.getByText(/It produced an ICSR assessment/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Let it try to self-approve/i }));
    flush(2200);
    fireEvent.click(screen.getByRole("button", { name: /I'll decide it myself/i }));
    flush(200);

    // Secondary decision (Route to periodic).
    fireEvent.click(screen.getByRole("button", { name: /^Route to periodic$/ }));
    flush(1800);
    expect(screen.getByText(/An agent in production, under control/i)).toBeTruthy();

    // Replay resets to the first beat.
    fireEvent.click(screen.getByRole("button", { name: /Replay/i }));
    expect(screen.getByText(/An AI agent triages safety cases/i)).toBeTruthy();
  });
});
