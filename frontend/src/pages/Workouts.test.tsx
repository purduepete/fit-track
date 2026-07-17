import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Workouts } from "./Workouts";
import { api } from "../lib/api";

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/workouts" element={<Workouts onAuthError={() => {}} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Workouts ?date= deep-link", () => {
  afterEach(() => vi.restoreAllMocks());

  it("filters to a single day and shows the active-filter chip", async () => {
    const workouts = vi.spyOn(api, "workouts").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "workoutTypes").mockResolvedValue([]);

    renderAt("/workouts?date=2026-07-16");

    await waitFor(() =>
      expect(workouts).toHaveBeenCalledWith(
        expect.objectContaining({ dateFrom: "2026-07-16", dateTo: "2026-07-16", offset: 0 }),
      ),
    );
    expect(screen.getByText(/Showing workouts on/i)).toBeInTheDocument();
    // The range dropdown is overridden by the exact-day filter.
    expect(screen.getByLabelText("Date range")).toBeDisabled();
  });

  it("ignores a malformed date param (no date_to sent)", async () => {
    const workouts = vi.spyOn(api, "workouts").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "workoutTypes").mockResolvedValue([]);

    renderAt("/workouts?date=not-a-date");

    await waitFor(() => expect(workouts).toHaveBeenCalled());
    expect(workouts).toHaveBeenCalledWith(expect.objectContaining({ dateTo: undefined }));
    expect(screen.queryByText(/Showing workouts on/i)).not.toBeInTheDocument();
  });

  it("clears the day filter when Clear is clicked", async () => {
    const workouts = vi.spyOn(api, "workouts").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "workoutTypes").mockResolvedValue([]);

    renderAt("/workouts?date=2026-07-16");
    await waitFor(() => expect(screen.getByText(/Showing workouts on/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));

    await waitFor(() =>
      expect(screen.queryByText(/Showing workouts on/i)).not.toBeInTheDocument(),
    );
    // After clearing, the most recent call must not carry a date_to bound.
    expect(workouts).toHaveBeenLastCalledWith(expect.objectContaining({ dateTo: undefined }));
  });
});
