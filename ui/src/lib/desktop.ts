/** True inside the Windows or Mac desktop app (the screens are served on app://pos there). */
export const onDesktop = (): boolean => typeof location !== 'undefined' && location.protocol === 'app:';
