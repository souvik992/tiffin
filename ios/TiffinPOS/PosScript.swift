/// What the POS screens can ask of the iPhone/iPad app: the same window.PosAndroid object as the Android app offers
/// (ui/src/lib/android.ts), so the screens need no iOS-only paths except where iOS differs. Saving a file and copying
/// backups answer later (a Promise). window.PosIOS tells the screens it is the iOS app (no USB printers, Files folders).
/// Also fits the page to the phone: no zooming in when a text box is tapped (iOS zooms into small text otherwise).
enum PosScript {
    static let source = #"""
(() => {
  if (window.PosAndroid) return;
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pos;
  if (!h) return;
  const call = (op, args) => h.postMessage(Object.assign({ op }, args || {}));
  let backup = { folder: null, lastCopiedAt: 0, lastError: '' };
  Object.defineProperty(window, '__posIosBackup', { value: (s) => { backup = s; }, writable: false });
  Object.defineProperty(window, 'PosIOS', { value: true, writable: false });
  const api = {
    saveFile: (name, mime, base64) => call('saveFile', { name: String(name), mime: String(mime || ''), base64: String(base64) }),
    print: (title) => { void call('print', { title: String(title || 'Tiffin POS') }); },
    chooseBackupFolder: () => { void call('chooseBackupFolder'); },
    backupStatus: () => JSON.stringify(backup),
    copyBackupsNow: () => call('copyBackupsNow').then((n) => Number(n)),
    forgetBackupFolder: () => { backup = { folder: null, lastCopiedAt: 0, lastError: '' }; void call('forgetBackupFolder'); },
    installAddon: () => {}, // the screens install add-ons themselves on iOS (DeviceSettings.tsx)
    removeAddon: () => false,
  };
  Object.defineProperty(window, 'PosAndroid', { value: Object.freeze(api), writable: false });
  void call('backupStatus').then((s) => { try { backup = JSON.parse(s); } catch (e) { /* keep the empty status */ } });
  const fit = () => {
    const m = document.querySelector('meta[name=viewport]');
    if (m) m.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fit); else fit();
})();
"""#
}
