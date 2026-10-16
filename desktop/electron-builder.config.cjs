// Windows installer (NSIS) for the desktop app. Build: npm run dist (in desktop/).
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
  // The backend runs in a utility process; it stays inside the asar archive (it only reads its own bundle).
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    executableName: 'TiffinPOS',
    ...(process.env.POS_PUBLISHER ? { signtoolOptions: { publisherName: [process.env.POS_PUBLISHER] } } : {}),
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
  },
  publish: updateUrl ? [{ provider: 'generic', url: updateUrl }] : null,
};
