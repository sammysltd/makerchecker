import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleDetail, roles, skills } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    listRoles: vi.fn(),
    getRole: vi.fn(),
    listSkills: vi.fn(),
    createRole: vi.fn(),
    createGrant: vi.fn(),
    revokeGrant: vi.fn(),
    createSodConstraint: vi.fn(),
    revokeSodConstraint: vi.fn(),
  };
});

const mocked = {
  listRoles: vi.mocked(api.listRoles),
  getRole: vi.mocked(api.getRole),
  listSkills: vi.mocked(api.listSkills),
  createRole: vi.mocked(api.createRole),
  createGrant: vi.mocked(api.createGrant),
  revokeGrant: vi.mocked(api.revokeGrant),
  createSodConstraint: vi.mocked(api.createSodConstraint),
  revokeSodConstraint: vi.mocked(api.revokeSodConstraint),
};

const SECOND_ROLE: api.RoleSummary = {
  id: "ro2",
  name: "recon-approver-role",
  description: "Approves reconciliations",
  limits: {},
  created_at: "2026-06-01T00:00:00.000Z",
  active_grant_count: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listRoles.mockResolvedValue({ roles: [roles[0]!, SECOND_ROLE] });
  mocked.getRole.mockResolvedValue(roleDetail);
  mocked.listSkills.mockResolvedValue({ skills });
});

describe("CreateRoleForm", () => {
  it("requires a name before calling the api", async () => {
    renderApp("/roles");
    await userEvent.click(await screen.findByRole("button", { name: "Create role" }));
    expect(screen.getByText("A role name is required.")).toBeDefined();
    expect(mocked.createRole).not.toHaveBeenCalled();
  });

  it("creates a role and navigates to its detail page", async () => {
    mocked.createRole.mockResolvedValue({
      role: {
        id: "ro-new",
        name: "payments-role",
        description: "moves money",
        limits: {},
        created_at: "2026-06-17T00:00:00.000Z",
      },
    });
    const { router } = renderApp("/roles");

    await userEvent.type(await screen.findByLabelText("Role name"), "payments-role");
    await userEvent.type(screen.getByLabelText("Role description"), "moves money");
    await userEvent.click(screen.getByRole("button", { name: "Create role" }));

    expect(mocked.createRole).toHaveBeenCalledWith({
      name: "payments-role",
      description: "moves money",
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/roles/ro-new"));
  });

  it("surfaces the server error inline without crashing", async () => {
    mocked.createRole.mockRejectedValue(
      new api.ApiError(409, JSON.stringify({ error: 'role "payments-role" already exists' })),
    );
    renderApp("/roles");

    await userEvent.type(await screen.findByLabelText("Role name"), "payments-role");
    await userEvent.click(screen.getByRole("button", { name: "Create role" }));

    expect(await screen.findByText('role "payments-role" already exists')).toBeDefined();
    expect(screen.getByRole("button", { name: "Create role" })).toBeDefined();
  });
});

describe("AddGrantForm", () => {
  it("requires a skill selection", async () => {
    renderApp("/roles/ro1");
    await userEvent.click(await screen.findByRole("button", { name: "Grant skill" }));
    expect(screen.getByText("Choose a skill to grant.")).toBeDefined();
    expect(mocked.createGrant).not.toHaveBeenCalled();
  });

  it("grants a skill with the role and skill ids and refetches", async () => {
    mocked.createGrant.mockResolvedValue({
      grant: {
        id: "g-new",
        role_id: "ro1",
        skill_id: "sk2",
        created_at: "2026-06-17T00:00:00.000Z",
        revoked_at: null,
      },
    });
    renderApp("/roles/ro1");

    await screen.findByRole("option", { name: /approve-recon@2/ });
    await userEvent.selectOptions(screen.getByLabelText("Skill to grant"), "sk2");
    await userEvent.click(screen.getByRole("button", { name: "Grant skill" }));

    expect(mocked.createGrant).toHaveBeenCalledWith("ro1", "sk2");
    await waitFor(() => expect(mocked.getRole.mock.calls.length).toBeGreaterThan(1));
  });

  it("surfaces a duplicate-grant conflict inline", async () => {
    mocked.createGrant.mockRejectedValue(
      new api.ApiError(409, JSON.stringify({ error: "an active identical grant already exists" })),
    );
    renderApp("/roles/ro1");

    await screen.findByRole("option", { name: /csv-ingest@1/ });
    await userEvent.selectOptions(screen.getByLabelText("Skill to grant"), "sk1");
    await userEvent.click(screen.getByRole("button", { name: "Grant skill" }));

    expect(await screen.findByText("an active identical grant already exists")).toBeDefined();
  });
});

describe("RevokeGrantButton", () => {
  it("revokes an active grant after confirming and refetches", async () => {
    mocked.revokeGrant.mockResolvedValue({
      grant: {
        id: "g1",
        role_id: "ro1",
        skill_id: "sk1",
        created_at: "2026-06-01T00:00:00.000Z",
        revoked_at: "2026-06-17T00:00:00.000Z",
      },
    });
    renderApp("/roles/ro1");

    // The active grant (g1) renders the first Revoke control on the page.
    const revokeButtons = await screen.findAllByRole("button", { name: "Revoke" });
    await userEvent.click(revokeButtons[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(mocked.revokeGrant).toHaveBeenCalledWith("g1");
    await waitFor(() => expect(mocked.getRole.mock.calls.length).toBeGreaterThan(1));
  });

  it("surfaces an already-revoked conflict inline", async () => {
    mocked.revokeGrant.mockRejectedValue(
      new api.ApiError(409, JSON.stringify({ error: "grant already revoked" })),
    );
    renderApp("/roles/ro1");

    const revokeButtons = await screen.findAllByRole("button", { name: "Revoke" });
    await userEvent.click(revokeButtons[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(await screen.findByText("grant already revoked")).toBeDefined();
  });
});

describe("AddSodForm", () => {
  it("requires the other role", async () => {
    renderApp("/roles/ro1");
    await userEvent.click(await screen.findByRole("button", { name: "Add SoD constraint" }));
    expect(screen.getByText("Choose the other role.")).toBeDefined();
    expect(mocked.createSodConstraint).not.toHaveBeenCalled();
  });

  it("creates a SoD constraint against another role", async () => {
    mocked.createSodConstraint.mockResolvedValue({
      sodConstraint: {
        id: "sc-new",
        role_a_id: "ro1",
        role_b_id: "ro2",
        description: "no self-approval",
        created_at: "2026-06-17T00:00:00.000Z",
        revoked_at: null,
      },
    });
    renderApp("/roles/ro1");

    await screen.findByRole("option", { name: "recon-approver-role" });
    await userEvent.selectOptions(screen.getByLabelText("Other role"), "ro2");
    await userEvent.type(
      screen.getByLabelText("Constraint description"),
      "no self-approval",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add SoD constraint" }));

    expect(mocked.createSodConstraint).toHaveBeenCalledWith({
      roleAId: "ro1",
      roleBId: "ro2",
      description: "no self-approval",
    });
    await waitFor(() => expect(mocked.getRole.mock.calls.length).toBeGreaterThan(1));
  });

  it("surfaces a self-constraint error inline", async () => {
    mocked.createSodConstraint.mockRejectedValue(
      new api.ApiError(
        400,
        JSON.stringify({ error: "a role cannot be SoD-constrained against itself" }),
      ),
    );
    renderApp("/roles/ro1");

    await screen.findByRole("option", { name: "recon-approver-role" });
    await userEvent.selectOptions(screen.getByLabelText("Other role"), "ro2");
    await userEvent.click(screen.getByRole("button", { name: "Add SoD constraint" }));

    expect(
      await screen.findByText("a role cannot be SoD-constrained against itself"),
    ).toBeDefined();
  });
});

describe("RevokeSodButton", () => {
  it("revokes an active constraint after confirming", async () => {
    mocked.revokeSodConstraint.mockResolvedValue({
      sodConstraint: {
        id: "sc1",
        role_a_id: "ro1",
        role_b_id: "ro2",
        description: null,
        created_at: "2026-06-01T00:00:00.000Z",
        revoked_at: "2026-06-17T00:00:00.000Z",
      },
    });
    renderApp("/roles/ro1");

    // The active constraint (sc1) is the first Revoke control on the page.
    const revokeButtons = await screen.findAllByRole("button", { name: "Revoke" });
    await userEvent.click(revokeButtons[revokeButtons.length - 1]!);
    await userEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(mocked.revokeSodConstraint).toHaveBeenCalledWith("sc1");
    await waitFor(() => expect(mocked.getRole.mock.calls.length).toBeGreaterThan(1));
  });

  it("can be cancelled without calling the api", async () => {
    renderApp("/roles/ro1");

    const revokeButtons = await screen.findAllByRole("button", { name: "Revoke" });
    await userEvent.click(revokeButtons[revokeButtons.length - 1]!);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Confirm revoke" })).toBeNull();
    expect(mocked.revokeSodConstraint).not.toHaveBeenCalled();
  });
});
