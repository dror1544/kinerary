import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { dismissAccountName, saveAccountName } from "../api";

/**
 * Asked once, on the dashboard, of an account that never told us its name (it was created by an invitation, a
 * Telegram signup, or before the sign-up page asked). The Telegram interview greets the organizer by this name, so
 * a name is worth one question; "Not now" is a real answer and the question is not put again.
 */
export function NamePrompt() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const done = async () => { await queryClient.invalidateQueries({ queryKey: ["me"] }); };
  const save = useMutation({ mutationFn: () => saveAccountName(name.trim()), onSuccess: done });
  const skip = useMutation({ mutationFn: dismissAccountName, onSuccess: done });
  const submit = (event: FormEvent) => { event.preventDefault(); if (name.trim()) save.mutate(); };
  return (
    <aside className="notice name-prompt" role="status">
      <form onSubmit={submit}>
        <label>What should we call you?{" "}
          <input type="text" required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>{" "}
        <button type="submit" disabled={save.isPending || !name.trim()}>Save</button>{" "}
        <button type="button" className="text-button" onClick={() => skip.mutate()} disabled={skip.isPending}>Not now</button>
        <p>The Telegram interview will greet you by it.</p>
        {(save.isError || skip.isError) && <p role="alert">{(save.error ?? skip.error)?.message}</p>}
      </form>
    </aside>
  );
}
