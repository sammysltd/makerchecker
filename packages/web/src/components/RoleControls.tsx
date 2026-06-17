import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  apiErrorMessage,
  createGrant,
  createRole,
  createSodConstraint,
  listRoles,
  listSkills,
  revokeGrant,
  revokeSodConstraint,
} from "../lib/api";

const inputClass = "w-full rounded border border-line bg-paper px-2.5 py-1.5 text-sm";
const affirmBtn =
  "rounded border border-verified bg-verified px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50";
const destructiveBtn =
  "rounded border border-blocked bg-white px-3 py-1.5 text-xs font-medium text-blocked disabled:opacity-50";

function MutationError({ error }: { error: unknown }) {
  return (
    <p className="mt-1 text-xs font-medium text-blocked" role="alert">
      {apiErrorMessage(error)}
    </p>
  );
}

/** Create a role, then navigate to its detail page so grants can be added. */
export function CreateRoleForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      createRole({
        name: name.trim(),
        ...(description.trim() === "" ? {} : { description: description.trim() }),
      }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      setName("");
      setDescription("");
      void navigate({ to: "/roles/$roleId", params: { roleId: res.role.id } });
    },
  });

  const submit = () => {
    if (name.trim() === "") {
      setValidationError("A role name is required.");
      return;
    }
    setValidationError(null);
    mut.mutate();
  };

  return (
    <div className="mt-3 max-w-md space-y-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Role name (e.g. recon-approver-role)"
        aria-label="Role name"
        className={inputClass}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        aria-label="Role description"
        rows={2}
        className={inputClass}
      />
      {validationError && (
        <p className="text-xs font-medium text-blocked" role="alert">
          {validationError}
        </p>
      )}
      {mut.isError && <MutationError error={mut.error} />}
      <button type="button" disabled={mut.isPending} onClick={submit} className={affirmBtn}>
        Create role
      </button>
    </div>
  );
}

/** Grant a skill to a role: pick a published skill, POST /grants, refresh the detail. */
export function AddGrantForm({ roleId }: { roleId: string }) {
  const queryClient = useQueryClient();
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: listSkills });
  const [skillId, setSkillId] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => createGrant(roleId, skillId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["role", roleId] });
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      setSkillId("");
    },
  });

  const submit = () => {
    if (skillId === "") {
      setValidationError("Choose a skill to grant.");
      return;
    }
    setValidationError(null);
    mut.mutate();
  };

  const skills = skillsQuery.data?.skills ?? [];

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <select
        value={skillId}
        onChange={(e) => setSkillId(e.target.value)}
        aria-label="Skill to grant"
        className={`${inputClass} max-w-xs`}
      >
        <option value="">Select a skill…</option>
        {skills.map((skill) => (
          <option key={skill.id} value={skill.id}>
            {skill.name}@{skill.version} ({skill.risk_tier} risk)
          </option>
        ))}
      </select>
      <button type="button" disabled={mut.isPending} onClick={submit} className={affirmBtn}>
        Grant skill
      </button>
      {validationError && (
        <p className="w-full text-xs font-medium text-blocked" role="alert">
          {validationError}
        </p>
      )}
      {mut.isError && (
        <div className="w-full">
          <MutationError error={mut.error} />
        </div>
      )}
    </div>
  );
}

/** A two-step inline revoke control — no DELETE, grants are revoked, never deleted. */
export function RevokeGrantButton({ roleId, grantId }: { roleId: string; grantId: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const mut = useMutation({
    mutationFn: () => revokeGrant(grantId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["role", roleId] });
      await queryClient.invalidateQueries({ queryKey: ["roles"] });
      setConfirming(false);
    },
  });

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs font-medium text-blocked underline-offset-2 hover:underline"
      >
        Revoke
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className={destructiveBtn}>
        Confirm revoke
      </button>
      <button
        type="button"
        disabled={mut.isPending}
        onClick={() => setConfirming(false)}
        className="text-xs font-medium text-stone-500 underline-offset-2 hover:underline"
      >
        Cancel
      </button>
      {mut.isError && <MutationError error={mut.error} />}
    </span>
  );
}

/** Add a SoD constraint between this role and another. */
export function AddSodForm({ roleId, roleName }: { roleId: string; roleName: string }) {
  const queryClient = useQueryClient();
  const rolesQuery = useQuery({ queryKey: ["roles"], queryFn: listRoles });
  const [otherRoleId, setOtherRoleId] = useState("");
  const [description, setDescription] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      createSodConstraint({
        roleAId: roleId,
        roleBId: otherRoleId,
        ...(description.trim() === "" ? {} : { description: description.trim() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["role", roleId] });
      setOtherRoleId("");
      setDescription("");
    },
  });

  const submit = () => {
    if (otherRoleId === "") {
      setValidationError("Choose the other role.");
      return;
    }
    setValidationError(null);
    mut.mutate();
  };

  const otherRoles = (rolesQuery.data?.roles ?? []).filter((r) => r.id !== roleId);

  return (
    <div className="mt-3 max-w-md space-y-2">
      <p className="text-xs text-stone-500">
        Constrain {roleName} against another role so no actor can hold both on one run.
      </p>
      <select
        value={otherRoleId}
        onChange={(e) => setOtherRoleId(e.target.value)}
        aria-label="Other role"
        className={inputClass}
      >
        <option value="">Select the other role…</option>
        {otherRoles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        aria-label="Constraint description"
        className={inputClass}
      />
      {validationError && (
        <p className="text-xs font-medium text-blocked" role="alert">
          {validationError}
        </p>
      )}
      {mut.isError && <MutationError error={mut.error} />}
      <button type="button" disabled={mut.isPending} onClick={submit} className={affirmBtn}>
        Add SoD constraint
      </button>
    </div>
  );
}

/** Two-step inline revoke for a SoD constraint. */
export function RevokeSodButton({ roleId, constraintId }: { roleId: string; constraintId: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const mut = useMutation({
    mutationFn: () => revokeSodConstraint(constraintId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["role", roleId] });
      setConfirming(false);
    },
  });

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-xs font-medium text-blocked underline-offset-2 hover:underline"
      >
        Revoke
      </button>
    );
  }

  return (
    <span className="mt-1 inline-flex flex-wrap items-center gap-2">
      <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className={destructiveBtn}>
        Confirm revoke
      </button>
      <button
        type="button"
        disabled={mut.isPending}
        onClick={() => setConfirming(false)}
        className="text-xs font-medium text-stone-500 underline-offset-2 hover:underline"
      >
        Cancel
      </button>
      {mut.isError && <MutationError error={mut.error} />}
    </span>
  );
}
