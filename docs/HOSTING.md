# Hosting the frontend

The app's `dist/` folder is a complete static website. You can host those files on GitHub Pages or another HTTPS static host. Visitors need a browser; they do not need Node.js or a server running on their laptops for case tracking.

The current canonical address is **https://karenshugeload.com/**. The GitHub Pages URL and `www.karenshugeload.com` redirect to it. The domain and HTTPS certificate are configured; see [Domain Setup](DOMAIN-SETUP.md) for DNS and data-migration details.

Hosting serves the app's HTML, CSS, JavaScript, and icon. Case records stay in IndexedDB unless you explicitly connect encrypted workspace sync. Static hosting alone does not sync records between devices or upload them to GitHub. Optional workspace sync sends encrypted records and uploaded evidence to the separately configured worker so a phone and laptop can use the same cases; see [WORKSPACE-SYNC.md](WORKSPACE-SYNC.md).

## GitHub Pages, when ready

The included `.github/workflows/pages.yml` is **manual only**. It has no push or pull-request publishing trigger. Adding this workflow to source control does not publish the app.

1. Put the project source and workflow on a GitHub repository's default branch. Keep `.env`, `.local/`, backups, patient documents, and provider credentials out of the repository.
2. In that repository, open **Settings → Pages**. Set the build source to **GitHub Actions**. [GitHub's publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) describe this setting.
3. Open **Actions → Publish static frontend to GitHub Pages → Run workflow**. Select the default branch and run it when you intend to publish. The workflow restricts deployments to that branch.
4. Wait for the workflow to finish. The `github-pages` environment shows the resulting URL. An example project URL is `https://YOUR-ACCOUNT.github.io/karen-scrum/`.
5. Open that address in the browser she will use. On first use, the fictional examples appear; remove them when she is ready to enter her own cases.

The workflow uploads **only `dist/`**. It never uploads the repository root, `server.mjs`, local reminder storage, `.env`, or `cloud-reminders/`. It uses the official checkout and Pages actions and needs no build or package installation. Action versions follow [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Treat files inside `dist/` as published material. Never place patient records, backups, API keys, or provider credentials there. A private source repository is not itself a promise that the resulting Pages website is private; verify the site's access settings before relying on them.

## Browser storage and moving addresses

Keep using the same browser profile and address. A different device, browser profile, hostname, protocol, or port has a separate workspace. For example, local `http://127.0.0.1:…`, a GitHub Pages address, and a custom domain do not share records. Clearing browser site data removes locally stored cases and uploaded copies.

To move from local hosting to Pages, or from Pages to a custom domain:

1. Download a backup from the old workspace. It includes cases, notes, the activity template, and uploaded evidence.
2. Open the new address in the intended browser and restore that backup. Restore replaces the destination workspace.
3. Check a case and download one of its evidence files before removing the old copy.
4. Configure reminders separately at the new address. Reminder credentials and service connections are not case synchronization.

Backups contain patient information and are not encrypted. Store them in an approved location. A reference to a local path records only that location; it does not transfer the original document to another laptop.

### GitHub Pages shares an origin across project paths

`https://YOUR-ACCOUNT.github.io/project-a/` and `/project-b/` have the same browser origin. A folder path is not a security boundary for IndexedDB. Scripts served from another project under that same origin can access that origin's browser storage. This follows the browser's [same-origin storage rules](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy#cross-origin_data_storage_access).

For a patient workspace, prefer a dedicated origin, such as a custom subdomain used only for Karen's Load, and control who can change the JavaScript served there. This version keeps the original `weekwise-local` database at the host root and namespaces subpath copies by their base path, preventing accidental collisions between project copies. That naming cannot isolate records from other scripts on the same origin. Moving between base paths also needs a backup and restore unless you reconnect the same shared workspace.

## Reminders with a hosted frontend

GitHub Pages hosts static files; it cannot execute the Node reminder service or a scheduled cloud worker. [GitHub describes Pages as static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

For scheduled reminders that continue when the laptop is off, deploy the separate worker in `cloud-reminders/` and connect it through the app's reminder settings. Follow the worker's setup documentation for its endpoint, access token, allowed frontend origin, provider secrets, and scheduling. Keep provider credentials in the worker's secret storage, never in `dist/` or browser-delivered JavaScript. The reminder scheduler reads only delivery settings and deadline counts/dates. If encrypted workspace sync is also connected, that worker separately stores encrypted records and evidence for sharing between devices.

The browser must sync updated deadline information to the reminder service after case changes. A cloud schedule does not give the worker access to browser-only records while the browser is closed. Case tracking remains usable without a reminder service connection.

For reminders that depend on the local laptop instead, use **Start Karens Load.cmd** and the local address; see [REMINDERS.md](REMINDERS.md). Node.js is needed for that local service, not for visiting a hosted static frontend.

## Other static hosts

Upload the contents of `dist/` as the web root, retain relative paths, and serve over HTTPS. Hosting under a path such as `/karen-scrum/` works; hash navigation does not need server-side route rewrites. Redirect the path without a trailing slash to the same path with one so relative assets resolve correctly. Publish no backend files or secrets.

The optional browser check `node --test tests/static-host.browser.test.mjs` verifies the frontend under `/karen-scrum/` using a plain static server with no reminder API.
