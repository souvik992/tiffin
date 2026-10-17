// What the Android app offers the screens (window.PosAndroid, android/app/.../MainActivity.java). On Windows and in a
// browser it is absent and the usual browser ways are used.

interface PosAndroid {
  saveFile(name: string, mime: string, base64: string): string;
  print(title: string): void;
  chooseBackupFolder(): void;
  backupStatus(): string;
  copyBackupsNow(): number;
  forgetBackupFolder(): void;
  installAddon(): void;
  removeAddon(id: string): boolean;
}
declare global { interface Window { PosAndroid?: PosAndroid } }

export const androidApp = (): PosAndroid | null => (typeof window !== 'undefined' && window.PosAndroid) || null;
export const onAndroid = (): boolean => androidApp() !== null;

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(new Error('The file could not be prepared.'));
  r.readAsDataURL(blob);
});

/** Saves a file: the Downloads folder on Android, the browser's download elsewhere. Returns a message for the person. */
export async function saveFile(name: string, blob: Blob): Promise<string> {
  const a = androidApp();
  if (a) {
    const r = a.saveFile(name, blob.type, await toBase64(blob));
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

/** Print / PDF of the page: Android's print screen (with Save as PDF) in the app, the browser's print elsewhere. */
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
