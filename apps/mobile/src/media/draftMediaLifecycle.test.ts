import { describe, expect, it, vi } from "vitest";
import { createDraftMediaLifecycle } from "./draftMediaLifecycle";

describe("abandoned draft media cleanup", () => {
  it("deletes only uploaded IDs owned by this draft, excluding manually removed images", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const draft = createDraftMediaLifecycle({ remove, sameSession: () => true });
    draft.add("a");
    draft.add("b");
    draft.forget("b");
    await draft.dispose(false);
    expect(remove.mock.calls).toEqual([["a"]]);
  });
  it("preserves all images when a create request may have committed", async () => {
    const remove = vi.fn();
    const draft = createDraftMediaLifecycle({ remove, sameSession: () => true });
    draft.add("pending-letter-image");
    await draft.dispose(true);
    expect(remove).not.toHaveBeenCalled();
  });
  it("cleans a late successful upload after leaving the page", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const draft = createDraftMediaLifecycle({ remove, sameSession: () => true });
    await draft.dispose(false);
    draft.add("late");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("late"));
  });
  it("does not delete files during Strict Mode effect replay", async () => {
    const remove = vi.fn();
    const draft = createDraftMediaLifecycle({ remove, sameSession: () => true });
    draft.add("active");
    const pending = draft.dispose(false);
    draft.activate();
    await pending;
    expect(remove).not.toHaveBeenCalled();
  });
  it("does not send cleanup using a different account's session", async () => {
    const remove = vi.fn();
    const draft = createDraftMediaLifecycle({ remove, sameSession: () => false });
    draft.add("old-session");
    await draft.dispose(false);
    expect(remove).not.toHaveBeenCalled();
  });
  it("continues after deletion failure without rejecting page exit", async () => {
    const remove = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const draft = createDraftMediaLifecycle({ remove, sameSession: () => true });
    draft.add("a");
    draft.add("b");
    await expect(draft.dispose(false)).resolves.toBeUndefined();
    expect(remove.mock.calls).toEqual([["a"], ["b"]]);
  });
});
