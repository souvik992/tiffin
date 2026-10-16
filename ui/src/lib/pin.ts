// PINs in this POS are exactly 4 digits (the backend accepts 4 to 6, so older longer PINs still work there;
// an owner can reset such a PIN to 4 digits in Settings > Users).
export const PIN_LENGTH = 4;

/** Keeps digits only, at most PIN_LENGTH of them (for typing and pasting). */
export const pinDigits = (v: string): string => v.replace(/\D/g, '').slice(0, PIN_LENGTH);

export const isPin = (v: string): boolean => new RegExp(`^\\d{${PIN_LENGTH}}$`).test(v);

/** Staff sign in with a 10-digit Indian mobile number (starts with 6-9; the backend checks the same). */
export const mobileDigits = (v: string): string => v.replace(/\D/g, '').slice(0, 10);
export const isMobile = (v: string): boolean => /^[6-9]\d{9}$/.test(v);
