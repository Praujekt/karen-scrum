(function (root) {
  "use strict";
  let loading = null,
    pending = false;
  function load() {
    if (root.google?.accounts?.id) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () =>
        root.google?.accounts?.id
          ? resolve()
          : reject(new Error("Google sign-in did not load."));
      script.onerror = () => {
        loading = null;
        script.remove();
        reject(
          new Error("Google sign-in could not load. Check your connection."),
        );
      };
      document.head.appendChild(script);
    });
    return loading;
  }
  async function signIn(clientId) {
    if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId || ""))
      throw new Error("Enter the Google web client ID from the service setup.");
    if (pending) throw new Error("Google sign-in is already open.");
    pending = true;
    try {
      await load();
      return await new Promise((resolve, reject) => {
        const dialog = document.createElement("dialog");
        dialog.className = "modal google-signin-dialog";
        const content = document.createElement("div");
        content.className = "modal-body";
        const title = document.createElement("h2");
        title.textContent = "Sign in to your workspace";
        const text = document.createElement("p");
        text.className = "form-help";
        text.textContent =
          "Choose the Google account allowed by your workspace. This does not grant access to Google Drive files.";
        const buttonHost = document.createElement("div");
        buttonHost.className = "google-button-host";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "button secondary";
        cancel.textContent = "Cancel";
        const nonce = Array.from(
          crypto.getRandomValues(new Uint8Array(24)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        let settled = false;
        function finish(error, token) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          dialog.close();
          dialog.remove();
          if (error) reject(error);
          else resolve(token);
        }
        const timeout = setTimeout(
          () => finish(new Error("Google sign-in timed out. Try again.")),
          180000,
        );
        cancel.addEventListener("click", () =>
          finish(new Error("Google sign-in was cancelled.")),
        );
        dialog.addEventListener("cancel", (event) => {
          event.preventDefault();
          finish(new Error("Google sign-in was cancelled."));
        });
        content.append(title, text, buttonHost, cancel);
        dialog.append(content);
        document.body.append(dialog);
        dialog.showModal();
        root.google.accounts.id.initialize({
          client_id: clientId,
          nonce,
          auto_select: false,
          ux_mode: "popup",
          callback: (response) => {
            try {
              const token = response.credential;
              if (typeof token !== "string" || token.length > 8192)
                throw new Error();
              const claims = JSON.parse(
                atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
              );
              if (claims.nonce !== nonce) throw new Error();
              // The server verifies Google's signature and allowed account before granting access.
              finish(null, token);
            } catch (_) {
              finish(
                new Error(
                  "Google sign-in returned an invalid response. Try again.",
                ),
              );
            }
          },
        });
        root.google.accounts.id.renderButton(buttonHost, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "rectangular",
        });
      });
    } finally {
      pending = false;
    }
  }
  root.WWGoogle = { signIn };
})(window);
