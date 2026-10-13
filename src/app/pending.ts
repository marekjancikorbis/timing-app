import { create } from 'zustand';
import type { EditorAction } from '../features/editor/editorState';

/** Hand-off from the import / record pages to the editor: applied once when the editor opens. */
interface PendingState {
  action: EditorAction | null;
  set: (action: EditorAction) => void;
  take: () => EditorAction | null;
}

export const usePending = create<PendingState>((set, get) => ({
  action: null,
  set: (action) => set({ action }),
  take: () => {
    const a = get().action;
    set({ action: null });
    return a;
  },
}));
