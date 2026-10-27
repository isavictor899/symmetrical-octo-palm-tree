import React, { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function Login({ recoveryMode = false, onRecoveryComplete }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mode, setMode] = useState(recoveryMode ? 'update' : 'login');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (recoveryMode) {
      setMode('update');
      setError(null);
      setMessage(null);
    }
  }, [recoveryMode]);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    }
    // On success, the onAuthStateChange listener in App.jsx picks up the
    // new session and swaps the screen automatically — nothing more to do here.
  }

  async function handleResetRequest(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (error) setError(error.message);
    else setMessage('If an account exists for that email, a password reset link is on its way.');
    setLoading(false);
  }

  async function handlePasswordUpdate(e) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (password.length < 6) {
      setError('Your password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    await supabase.auth.signOut();
    onRecoveryComplete?.();
    setLoading(false);
    setMode('login');
    setPassword('');
    setConfirmPassword('');
    setMessage('Your password has been updated. Sign in with your new password.');
  }

  const isUpdate = mode === 'update';
  const isResetRequest = mode === 'reset';
  const title = isUpdate ? 'Choose a new password' : isResetRequest ? 'Reset your password' : 'Sign in';

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={isUpdate ? handlePasswordUpdate : isResetRequest ? handleResetRequest : handleSubmit}>
        <div className="login-brand">
          <span className="brand-mark">+</span>
          <span>Pharmacy POS</span>
        </div>
        <h1 className="login-title">{title}</h1>
        <p className="login-sub">{isUpdate ? 'Enter and confirm your new password.' : isResetRequest ? 'Enter your staff email and we’ll send a reset link.' : 'Use your staff login to open the till.'}</p>

        {!isUpdate && <label className="field">
          <span>Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>}

        {!isUpdate && !isResetRequest && <label className="field">
          <span>Password</span>
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>}

        {isUpdate && <>
          <label className="field"><span>New password</span><input type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label className="field"><span>Confirm new password</span><input type="password" required minLength={6} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></label>
        </>}

        {error && <div className="login-error" role="alert">{error}</div>}
        {message && <div className="login-message" role="status">{message}</div>}

        <button type="submit" className="login-submit" disabled={loading}>
          {loading ? 'Please wait…' : isUpdate ? 'Update password' : isResetRequest ? 'Send reset link' : 'Sign in'}
        </button>
        {!isUpdate && <button type="button" className="login-link" onClick={() => { setMode(isResetRequest ? 'login' : 'reset'); setError(null); setMessage(null); }}>
          {isResetRequest ? 'Back to sign in' : 'Forgot password?'}
        </button>}
      </form>
    </div>
  );
}
