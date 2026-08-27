// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AllowedDomainsSection from "./AllowedDomainsSection.js";

afterEach(cleanup);

describe("duplicate domains explain themselves instead of doing nothing", () => {
  it("tells the buyer when www. collapses onto an existing entry", () => {
    // `normalizeDomain` strips `www.`, and `isOriginAllowed` strips it from the incoming origin
    // too, so listing `kyzer.ai` genuinely covers `www.kyzer.ai` — the dedupe is correct. What was
    // wrong is that it happened in silence: the click had no visible effect and no explanation, and
    // the buyer concluded a second domain could not be added at all (03-UAT F12).
    const onChange = vi.fn();
    render(<AllowedDomainsSection domains={["kyzer.ai"]} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText("example.com"), { target: { value: "www.kyzer.ai" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    expect(onChange).not.toHaveBeenCalled();
    const msg = screen.getByTestId("domain-validation-error").textContent ?? "";
    expect(msg).toContain("already on the list");
    // The reason matters as much as the fact — without it the buyer cannot tell why two visibly
    // different strings are one entry.
    expect(msg).toContain("www.");
  });

  it("still adds a genuinely different domain", () => {
    const onChange = vi.fn();
    render(<AllowedDomainsSection domains={["kyzer.ai"]} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText("example.com"), { target: { value: "shop.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    expect(onChange).toHaveBeenCalledWith(["kyzer.ai", "shop.example.com"]);
  });
});
