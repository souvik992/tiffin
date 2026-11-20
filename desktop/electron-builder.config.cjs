// Windows installer (NSIS) and Mac disk image (DMG) for the desktop app. Build: npm run dist (Windows) or
// npm run dist:mac (only on a Mac; CI builds it on GitHub's Mac machines).
// Optional, from the environment at build time:
//   POS_UPDATE_URL   where the auto-updater looks for latest.yml (an HTTPS folder you upload release files to)
//   CSC_LINK, CSC_KEY_PASSWORD   the code-signing certificate (.pfx) and its password; without them the build is unsigned
//   POS_PUBLISHER    the certificate's subject name (CN), so the updater only accepts installers signed by you
const updateUrl = process.env.POS_UPDATE_URL;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'co.palletnow.tiffinpos',
  productName: 'Tiffin POS',
  copyright: 'Copyright © 2026',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', '!dist/**/*.map', 'package.json'],
  asar: true,
  // Smaller, faster installs on low-end PCs: only the English Chromium strings (the POS screens carry their own text)
  // and no WebGPU shader compilers (scripts/after-pack.cjs).
  electronLanguages: ['en-US'],
  afterPack: './scripts/after-pack.cjs',
  // The backend runs in a utility process; it stays inside the asar archive (it only reads its own bundle).
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    executableName: 'TiffinPOS',
    ...(process.env.POS_PUBLISHER ? { signtoolOptions: { publisherName: [process.env.POS_PUBLISHER] } } : {}),
  },
  // Mac: one disk image per chip (Apple M1/M2/M3/M4 = arm64, older Intel Macs = x64); drag the app to Applications.
  // Without an Apple Developer ID certificate (CSC_LINK) the app is ad-hoc signed: Apple chips refuse unsigned apps,
  // and the shop opens it once with System Settings > Privacy & Security > Open Anyway. Hardened runtime is only
  // needed for Apple's notarisation, which needs that certificate too.
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: 'build/icon.png',
    category: 'public.app-category.business',
    ...(process.env.CSC_LINK ? {} : { identity: '-', hardenedRuntime: false }),
  },
  dmg: {
    artifactName: 'TiffinPOS-${version}-mac-${arch}.${ext}',
    title: 'Tiffin POS ${version}',
  },
  nsis: {
    oneClick: false,
    perMachine: false, // installs for the current Windows user: no administrator needed
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'Tiffin POS',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // bills and backups (in %LOCALAPPDATA%\TiffinPOS) are never deleted by uninstalling
    artifactName: 'TiffinPOS-Setup-${version}.${ext}',
    // zip (deflate) instead of LZMA: about twice as fast to install on one CPU core (measured 21-26 s against 41-53 s),
    // for a ~131 MB instead of ~112 MB installer. zip needs differentialPackage off, so updates download the whole
    // installer rather than only the changed blocks. See docs/DECISIONS.md.
    include: 'build/installer.nsh', // waits for a closing POS before saying it is open
    useZip: true,
    differentialPackage: false,
  },
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
};
