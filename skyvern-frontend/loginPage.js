/** Render a login form without booting the authenticated application's scripts or queries. */
export function renderLoginPage({ csrf, error }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Skyvern</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #f1f5f9; background: #020817; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100svh; display: grid; grid-template-columns: 1fr 1fr; }
    .intro { display: flex; flex-direction: column; justify-content: space-between; padding: 56px 64px; border-right: 1px solid #1e293b; background: #0f172a; }
    .brand { width: 158px; height: auto; }
    .intro h1 { max-width: 480px; margin: 64px 0 24px; font-size: clamp(36px, 4vw, 60px); font-weight: 550; line-height: 1.08; letter-spacing: -2px; }
    .intro p { max-width: 360px; color: #94a3b8; line-height: 1.65; }
    .intro footer { margin-top: 48px; font-size: 13px; color: #94a3b8; }
    main { display: flex; align-items: center; justify-content: center; padding: 40px 28px; }
    .form-wrap { width: 100%; max-width: 360px; }
    h2 { margin: 0 0 10px; font-size: 28px; font-weight: 600; letter-spacing: -0.7px; }
    .subtitle { margin: 0 0 32px; font-size: 14px; line-height: 1.6; color: #94a3b8; }
    label { display: block; margin: 22px 0 9px; font-size: 14px; font-weight: 500; }
    input { width: 100%; height: 46px; border: 1px solid #334155; border-radius: 6px; padding: 0 13px; font: inherit; color: #f1f5f9; background: #0f172a; }
    input:focus-visible, button:focus-visible { outline: 2px solid #cbd5e1; outline-offset: 3px; }
    button { width: 100%; margin-top: 28px; height: 46px; border: 0; border-radius: 6px; background: #f8fafc; color: #0f172a; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #e2e8f0; }
    .error { padding: 12px 14px; margin-bottom: 24px; border: 1px solid #7f1d1d; border-radius: 6px; color: #fecaca; background: #27101a; font-size: 14px; line-height: 1.5; }
    .note { margin: 24px 0 0; color: #94a3b8; font-size: 12px; line-height: 1.6; }
    .mobile-brand { display: none; margin-bottom: 40px; }
    @media (max-width: 760px) { body { grid-template-columns: 1fr; } .intro { display: none; } main { min-height: 100svh; } .mobile-brand { display: block; } }
  </style>
</head>
<body>
  <section class="intro" aria-label="Skyvern">
    <img class="brand" src="/logo.png" alt="Skyvern">
    <div><h1>Your browser.<br>Your workflows.</h1><p>Build, run, and manage browser automations from your Skyvern workspace.</p></div>
    <footer>Your local Skyvern workspace</footer>
  </section>
  <main>
    <div class="form-wrap">
      <img class="brand mobile-brand" src="/logo.png" alt="Skyvern">
      <h2>Welcome back</h2>
      <p class="subtitle">Sign in to your Skyvern workspace.</p>
      ${error ? `<div class="error" role="alert">${error}</div>` : ""}
      <form action="/auth/login" method="post">
        <input type="hidden" name="csrf" value="${csrf}">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" maxlength="254" required autofocus>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
        <button type="submit">Sign in</button>
      </form>
      <p class="note">Access is limited to the workspace administrator.</p>
    </div>
  </main>
</body>
</html>`;
}
