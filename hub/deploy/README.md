# Hosting the hub on Oracle Cloud (free)

Oracle Cloud's "Always Free" tier includes a small Linux VM that never expires. This puts the hub on it with HTTPS.

## 1. Make the setup file (on the dev PC)

```
node hub/deploy/make-cloud-init.ts
```

It writes `%USERPROFILE%\.tiffinpos\hub\oracle-cloud-init.yaml` and the admin key (`admin-key.txt` next to it). Keep
the key safe: it opens the hub admin page.

## 2. Create the Oracle account (owner only)

Sign up at https://signup.cloud.oracle.com. Oracle asks for name, email, mobile OTP and a card (a small hold that is
returned; Always Free resources are never charged). **Home region: India South (Hyderabad) or India West (Mumbai)**;
it cannot be changed later.

## 3. Create the VM

Menu > Compute > Instances > Create instance:

- **Image:** Canonical Ubuntu 24.04.
- **Shape:** Ampere `VM.Standard.A1.Flex` (1 OCPU, 6 GB is plenty), or `VM.Standard.E2.1.Micro` if Ampere says
  "out of capacity". Both are marked "Always Free eligible".
- **Networking:** create a new public subnet, "Assign a public IPv4 address" on.
- **SSH keys:** "Save private key" (keep the file; needed only for repairs).
- **Show advanced options > Management > Cloud-init script:** paste the file from step 1.

## 4. Open ports 80 and 443

Instance page > subnet link > Security List > Add Ingress Rules, twice: source `0.0.0.0/0`, TCP, destination port `80`,
then `443`.

## 5. Check it

About 5 minutes after the VM starts, open `https://<public-ip-with-dashes>.sslip.io/admin` (for IP 140.1.2.3:
`https://140-1-2-3.sslip.io/admin`) and enter the admin key. Create the store there and copy its connection link into
the POS (Settings > Online orders).

## Later (over SSH: `ssh -i <key file> ubuntu@<ip>`)

| Task | Command |
|---|---|
| Update the hub to the latest GitHub version | `sudo tiffin-hub-update` |
| Use your own domain | point its DNS A record at the VM, set `HUB_DOMAIN=` in `/etc/tiffin-hub.env`, run `sudo tiffin-hub-domain` |
| Logs | `journalctl -u tiffin-hub -f` |
| Setup log (if the page never comes up) | `sudo cat /var/log/cloud-init-output.log` |

The hub database is copied daily to `/var/backups/tiffin-hub` (14 days kept). That is on the same VM, so it does not
survive losing the VM: copy it elsewhere now and then.

Notes: the free tier stops idle VMs only if CPU stays under 20% for a week *and* the account is "Always Free" only;
upgrading to Pay As You Go (still free for these resources) avoids that. The `sslip.io` address changes if the VM's
public IP changes (only when the VM is deleted and re-created), and paired POS devices would need a new link; a real
domain avoids that.
