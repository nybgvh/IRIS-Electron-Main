// Authentication UI stays separate from the species and GBIF views.
window.IrisAuth = {
  init(onLoggedIn) {
    const error = document.getElementById("auth-error");
    const tabs = document.querySelectorAll(".auth-tab");
    const buttons = ["login-btn", "register-btn", "reset-password-btn", "check-verification-btn", "resend-verification-btn", "verification-back-btn"].map(id => document.getElementById(id));
    let busy = false;
    function showAuthError(message) {
      error.textContent = message;
      error.classList.remove("hidden");
    }
    function clearAuthError() { error.classList.add("hidden"); }

    function showPanel(name) {
      document.getElementById("auth-tabs").classList.toggle("hidden", name === "verification");
      ["login", "register", "verification"].forEach(panel => {
        document.getElementById(`tab-${panel}`).classList.toggle("hidden", panel !== name);
      });
      tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
    }

    function handleResult(result) {
      if (result.error) { showAuthError(result.error); return; }
      if (result.verificationRequired) {
        document.querySelectorAll("#auth-screen input[type=password]").forEach(input => { input.value = ""; });
        document.getElementById("verification-email").textContent = result.email;
        showPanel("verification");
        showAuthError(result.message);
      } else if (result.user) {
        document.querySelectorAll("#auth-screen input[type=password]").forEach(input => { input.value = ""; });
        showPanel("login");
        onLoggedIn(result.user);
      }
    }

    async function runRequest(action) {
      if (busy) return;
      busy = true;
      clearAuthError();
      buttons.forEach(button => { button.disabled = true; });
      tabs.forEach(tab => { tab.disabled = true; });
      try { await action(); }
      catch (_) { showAuthError("Unable to complete the request. Please try again."); }
      finally {
        busy = false;
        buttons.forEach(button => { button.disabled = false; });
        tabs.forEach(tab => { tab.disabled = false; });
      }
    }

    tabs.forEach(tab => tab.addEventListener("click", () => {
      if (busy) return;
      showPanel(tab.dataset.tab);
      clearAuthError();
    }));

    async function submit(mode) {
      if (busy) return;
      clearAuthError();
      const prefix = mode === "register" ? "reg" : "login";
      const email = document.getElementById(`${prefix}-username`);
      const password = document.getElementById(`${prefix}-password`);
      if (!email.value.trim() || !email.checkValidity()) {
        showAuthError("Please enter a valid email address.");
        email.focus();
        return;
      }
      if (mode !== "resetPassword" && !password.value) { showAuthError("Please enter your password."); return; }
      if (mode === "register" && password.value !== document.getElementById("reg-confirm").value) {
        showAuthError("Passwords do not match.");
        return;
      }
      await runRequest(async () => {
        const result = await window.api[mode](email.value.trim(), password.value);
        if (mode === "resetPassword" && !result.error) {
          showAuthError("If an account exists for this email, a password reset link has been sent.");
        } else {
          handleResult(result);
        }
      });
    }

    buttons[0].addEventListener("click", () => submit("login"));
    buttons[1].addEventListener("click", () => submit("register"));
    buttons[2].addEventListener("click", () => submit("resetPassword"));
    buttons[3].addEventListener("click", () => runRequest(async () => {
      handleResult(await window.api.checkVerification());
    }));
    buttons[4].addEventListener("click", () => runRequest(async () => {
      handleResult(await window.api.resendVerification());
    }));
    buttons[5].addEventListener("click", () => runRequest(async () => {
      const result = await window.api.logout();
      if (result.error) { showAuthError(result.error); return; }
      showPanel("login");
      document.getElementById("verification-email").textContent = "";
      document.querySelectorAll("#auth-screen input[type=password]").forEach(input => { input.value = ""; });
    }));
    ["login-username", "login-password", "reg-username", "reg-password", "reg-confirm"].forEach(id => {
      document.getElementById(id).addEventListener("keydown", event => {
        if (event.key === "Enter") submit(id.startsWith("reg-") ? "register" : "login");
      });
    });
    return { showAuthError, clearAuthError };
  },
};
