# Connect karenshugeload.com

The application is hosted by GitHub Pages at `https://praujekt.github.io/karen-scrum/`. The intended new address is `https://karenshugeload.com/`, with `www.karenshugeload.com` redirecting to it.

DNS inspection on October 27, 2026 found Squarespace nameservers (`nsc1.squarespacedns.com` through `nsc4.squarespacedns.com`). The apex currently has Squarespace's four parking A records, and `www` points to `ext-sq.squarespace.com`. No apex AAAA or MX records were returned; an existing TXT record is `v=spf1 -all`. The available connections do not include Squarespace DNS access, so changing these records requires the domain owner's Squarespace account.

## Before switching addresses

Download a case backup from the working GitHub Pages address first. Browser records belong to that origin and base path; they will not automatically appear at the new domain. After the new address works, restore the backup there. Keep the backup until you have checked a case and downloaded an attached evidence file.

Prepare the DNS edits below before starting the cutover. GitHub recommends binding the domain to the repository before pointing DNS at GitHub. Coordinate those two actions together so the current trial does not redirect to a still-parked domain for an extended period. [GitHub custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

GitHub also recommends ownership verification. In the **Praujekt account settings → Pages → Add a domain**, add `karenshugeload.com`, then copy GitHub's generated TXT challenge into Squarespace exactly as shown. Its host will be `_github-pages-challenge-Praujekt`; do not invent the TXT value. Verify it in GitHub and retain that record. This happens in account settings, separately from repository settings. [GitHub domain verification](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages).

## Squarespace DNS edits

Open [Squarespace Domains](https://account.squarespace.com/domains), select `karenshugeload.com`, then open **DNS → DNS Settings**. Replace the default website/parking records with these records. The host `@` means the bare domain. Leave the domain's nameservers and unrelated MX/TXT records alone. [Squarespace DNS editing guide](https://support.squarespace.com/hc/en-us/articles/360002101888-Adding-DNS-records-to-your-domain).

| Host | Type | Value |
| --- | --- | --- |
| `@` | A | `185.199.108.153` |
| `@` | A | `185.199.109.153` |
| `@` | A | `185.199.110.153` |
| `@` | A | `185.199.111.153` |
| `www` | CNAME | `praujekt.github.io` |

Remove the four old apex A records (`198.185.159.144`, `198.185.159.145`, `198.49.23.144`, and `198.49.23.145`) and replace the existing `www` CNAME. Do not add a slash or repository path to the CNAME target. No wildcard record is needed.

IPv6 is optional. No apex AAAA records were found. If enabling IPv6, use all four GitHub values below; remove any conflicting apex AAAA records:

| Host | Type | Value |
| --- | --- | --- |
| `@` | AAAA | `2606:50c0:8000::153` |
| `@` | AAAA | `2606:50c0:8001::153` |
| `@` | AAAA | `2606:50c0:8002::153` |
| `@` | AAAA | `2606:50c0:8003::153` |

## GitHub Pages cutover and HTTPS

In **Praujekt/karen-scrum → Settings → Pages**, set **Custom domain** to `karenshugeload.com` immediately before applying the prepared DNS edits. This project uses an Actions publishing workflow, so a source `CNAME` file is not required and does not configure the domain.

After DNS resolves to GitHub, wait for certificate provisioning and enable **Enforce HTTPS** when available. DNS propagation and HTTPS availability can take up to 24 hours. Check both the apex and `www` before treating the new address as ready. The app has not moved successfully merely because the repository setting was saved.

The following PowerShell checks are read-only:

```powershell
Resolve-DnsName karenshugeload.com -Type A
Resolve-DnsName karenshugeload.com -Type AAAA
Resolve-DnsName www.karenshugeload.com -Type CNAME
```

Shared storage and Google sign-in are not activated yet. When configuring them later, set the worker's `ALLOWED_ORIGIN` and Google's authorized JavaScript origin to `https://karenshugeload.com` (without a path). Use the canonical apex address consistently on her laptop and phone.
