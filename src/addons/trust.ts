// Public keys whose signed add-ons this POS will run. The matching private key is kept by the publisher OUTSIDE this
// repository (default %USERPROFILE%\.tiffinpos\addon-signing\private.pem). Losing it means add-ons can no longer be updated
// for existing installs; leaking it lets anyone ship add-ons this POS trusts. Back it up offline.
export const TRUSTED_ADDON_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXhjiZMhQZXq7CfsSurYPVEuL5rEDVnlNMR9nynyCi10=
-----END PUBLIC KEY-----
`,
];
