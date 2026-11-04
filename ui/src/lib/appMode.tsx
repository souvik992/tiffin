import { createContext, useContext } from 'react';
import type { ComponentType } from 'react';

/**
 * Which app the shared screens run in. The POS (default) shows its own side bar; Tiffin Data Manager
 * (ui/src/manager) gives its own side bar and hides what only the counter does (reprints, refunds, cancelling).
 */
export interface NavItem { to: string; label: string; icon: ComponentType<{ className?: string }> }
export interface AppMode { manager: boolean; nav: NavItem[] | null; /** the letter at the top of the side bar */ mark?: string }

const ModeCtx = createContext<AppMode>({ manager: false, nav: null });
export const AppModeProvider = ModeCtx.Provider;
export const useAppMode = (): AppMode => useContext(ModeCtx);
