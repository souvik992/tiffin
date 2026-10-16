// The POS's toolbox for add-on screens (see ui/src/addonHost.ts). Present before this script runs.
import type { PosHost } from '../../../ui/src/addonHost.ts';

export const host: PosHost = (window as unknown as { __POS__: PosHost }).__POS__;
export const BASE = '/addons/ods';
