'use client';

import { FormEvent, useState } from 'react';

export default function LoginForm({ basePath }: { basePath: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      const response = await fetch(`${basePath}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      });
      const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as { error?: string };
      if (!response.ok) { setError(result.error ?? '登录失败'); return; }
      window.location.assign(`${basePath}/`);
    } catch {
      setError('无法连接主控，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page">
    <section className="login-card" aria-labelledby="login-title">
      <div className="brand-word login-brand">Pulse<b>DNS</b></div>
      <h1 id="login-title">登录 DDNS 控制台</h1>
      <form className="node-form" onSubmit={submit}>
        <label>用户名<input name="username" required autoComplete="username" autoFocus maxLength={32} /></label>
        <label>密码<input name="password" type="password" required autoComplete="current-password" maxLength={128} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
      </form>
    </section>
  </main>;
}
