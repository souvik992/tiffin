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

## On AWS instead

AWS's free tier runs out (6 months of credits for accounts made since mid-2025, 12 months for older ones; the public
IPv4 address is charged after that), so Oracle above is the free-for-good choice. On AWS:

1. `node hub/deploy/make-cloud-init.ts` writes `aws-cloud-init.yaml` next to the Oracle one (same admin key).
2. EC2 > **Launch instance**, region **Asia Pacific (Mumbai)**:
   - **Image:** Ubuntu Server 24.04. **Type:** the one marked "Free tier eligible" (`t3.micro`).
   - **Key pair:** create one and keep the `.pem` file (only for repairs).
   - **Network settings:** allow SSH from **My IP**, and **HTTP** and **HTTPS** from the internet.
   - **Storage:** 20-30 GB gp3.
   - **Advanced details > User data:** paste `aws-cloud-init.yaml`.
3. EC2 > **Elastic IPs** > Allocate, then Associate it with the instance, so the address never changes. Then over SSH
   (`ssh -i <key>.pem ubuntu@<elastic ip>`) run `sudo tiffin-hub-domain` once to switch to the new address.
4. Open `https://<elastic-ip-with-dashes>.sslip.io/admin` and enter the admin key; continue as in step 5 above.

Set a billing alert (Billing > Budgets) so the end of the free period is not a surprise. Everything under "Later"
works the same.

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
