// What the phone and tablet apps offer the screens (window.PosAndroid): the Android app (android/app/.../MainActivity.java)
// and the iPhone/iPad app (ios/TiffinPOS/PosIOS.js, which offers the same object; there saving a file and copying
// backups answer later, as a Promise, and window.PosIOS is set). On Windows and in a browser it is absent and the usual
// browser ways are used. onAndroid() means "in a phone or tablet app" (Android or iOS); onIos() only the iPhone/iPad app.

interface PosAndroid {
  saveFile(name: string, mime: string, base64: string): string | Promise<string>;
  print(title: string): void;
  chooseBackupFolder(): void;
  backupStatus(): string;
  copyBackupsNow(): number | Promise<number>;
  forgetBackupFolder(): void;
  installAddon(): void;
  removeAddon(id: string): boolean;
}
declare global { interface Window { PosAndroid?: PosAndroid; PosIOS?: boolean } }

export const androidApp = (): PosAndroid | null => (typeof window !== 'undefined' && window.PosAndroid) || null;
export const onAndroid = (): boolean => androidApp() !== null;
export const onIos = (): boolean => typeof window !== 'undefined' && window.PosIOS === true && androidApp() !== null;

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(new Error('The file could not be prepared.'));
  r.readAsDataURL(blob);
});

/** Saves a file: the Downloads folder on Android, the share sheet (Save to Files) on iOS, the browser's download elsewhere. Returns a message for the person. */
export async function saveFile(name: string, blob: Blob): Promise<string> {
  const a = androidApp();
  if (a) {
    const r = await a.saveFile(name, blob.type, await toBase64(blob));
    if (r === 'error') throw new Error('The file could not be saved.');
    return r;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `Downloaded ${name}`;
}

/** Print / PDF of the page: the phone's print screen (Android: with Save as PDF; iOS: AirPrint, share as PDF) in the app, the browser's print elsewhere. */
export function printPage(title = 'Tiffin POS'): void {
  const a = androidApp();
  if (a) a.print(title); else window.print();
}

export interface BackupCopyStatus { folder: string | null; lastCopiedAt: number; lastError: string }
export function backupCopyStatus(): BackupCopyStatus | null {
  const a = androidApp();
  if (!a) return null;
  try { return JSON.parse(a.backupStatus()) as BackupCopyStatus; } catch { return { folder: null, lastCopiedAt: 0, lastError: '' }; }
}
