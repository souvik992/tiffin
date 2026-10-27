// Windows installer for Tiffin Data Manager (NSIS). Build: npm run dist:manager (in desktop/).
// A separate app from the POS (own id, name, folder and shortcut), so it installs, updates and uninstalls on its own,
// on a computer with or without the POS. Raise `version` here for each release.
const version = '1.0.0';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'co.palletnow.tiffindatamanager',
  productName: 'Tiffin Data Manager',
  copyright: 'Copyright © 2026',
  extraMetadata: { name: 'tiffin-data-manager', version, main: 'dist-manager/main.cjs', description: 'Tiffin POS data: dashboard, every table, owner edits, backup and restore.' },
  directories: { output: 'release-manager', buildResources: 'build' },
  files: ['dist-manager/**/*', '!dist-manager/**/*.map', 'package.json'],
  asar: true,
  electronLanguages: ['en-US'],
  afterPack: './scripts/after-pack.cjs',
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'build/manager-icon.png', executableName: 'TiffinData' },
  nsis: {
    oneClick: false,
    perMachine: false, // per Windows user, no administrator needed (like the POS)
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'Tiffin Data Manager',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // it never owns the shop's data; the POS data folder is not touched either way
    artifactName: 'TiffinDataManager-Setup-${version}.${ext}',
    useZip: true,
    differentialPackage: false,
  },
  publish: null,
};
