import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';

// The console needs a session verified with an authenticator app (aal2). The
// server refuses every console call without it; this screen gets the person
// there: set up an authenticator the first time, enter a code every sign-in.
export default function MfaGate({ email, children }) {
  const [stage, setStage] = useState('checking'); // checking | enroll | challenge | ready | error
  const [factorId, setFactorId] = useState(null);
  const [enrollment, setEnrollment] = useState(null); // { qr, secret }
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const check = useCallback(async () => {
    setError('');
    const { data: level, error: levelError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (levelError) { setStage('error'); setError(levelError.message); return; }
    if (level.currentLevel === 'aal2') { setStage('ready'); return; }

    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) { setStage('error'); setError(factorsError.message); return; }
    const verified = (factors?.totp || []).find((factor) => factor.status === 'verified');
    if (verified) {
      setFactorId(verified.id);
      setStage('challenge');
      return;
    }
    // A half-finished setup from before cannot be reused; start a fresh one.
    for (const factor of factors?.all || []) {
      if (factor.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => {});
    }
    const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `Enora console ${new Date().toISOString().slice(0, 10)}`,
    });
    if (enrollError) {
      setStage('error');
      setError(/disabled|not enabled/i.test(enrollError.message)
        ? 'Authenticator apps are switched off for this project. In Supabase, go to Authentication → Multi-Factor and set TOTP to "Enabled".'
        : enrollError.message);
      return;
    }
    setFactorId(enrolled.id);
    setEnrollment({ qr: enrolled.totp.qr_code, secret: enrolled.totp.secret });
    setStage('enroll');
  }, []);

  useEffect(() => { check(); }, [check]);

  async function verify(event) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setWorking(true);
    setError('');
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    setWorking(false);
    if (verifyError) {
      setError(/invalid|expired/i.test(verifyError.message) ? 'That code did not work. Codes change every 30 seconds; try the current one.' : verifyError.message);
      setCode('');
      return;
    }
    setStage('ready');
  }

  if (stage === 'ready') return children;

  return (
    <div className="login-page">
      <div className="login-card console-mfa">
        <div className="login-brand"><span>Enora Labs console</span></div>
        {stage === 'checking' ? <p className="login-sub">Checking your sign-in…</p> : null}

        {stage === 'enroll' && enrollment ? (
          <>
            <h1 className="login-title">Set up two-step sign-in</h1>
            <p className="login-sub">
              The console controls every pharmacy, so it needs a code from an authenticator app as well as your password.
              Scan this with Google Authenticator, Microsoft Authenticator or Authy, then enter the 6-digit code it shows.
            </p>
            <img className="console-mfa-qr" src={enrollment.qr} alt="QR code for your authenticator app" />
            <p className="muted small">Can&apos;t scan? Enter this key in the app instead: <code className="console-mfa-secret">{enrollment.secret}</code></p>
          </>
        ) : null}

        {stage === 'challenge' ? (
          <>
            <h1 className="login-title">Enter your code</h1>
            <p className="login-sub">Open your authenticator app and enter the 6-digit code for the Enora Labs console ({email}).</p>
          </>
        ) : null}

        {stage === 'enroll' || stage === 'challenge' ? (
          <form onSubmit={verify} className="console-mfa-form">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              aria-label="6-digit code"
              autoFocus
            />
            <button type="submit" className="login-submit" disabled={working}>{working ? 'Checking…' : 'Verify'}</button>
          </form>
        ) : null}

        {error ? <p className="login-error console-mfa-error">{error}</p> : null}
        {stage === 'error' ? <button type="button" className="login-submit" onClick={check}>Try again</button> : null}
        <button type="button" className="console-mfa-signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
        {stage === 'challenge' ? (
          <p className="muted small">Lost your phone? Another console owner can reset your authenticator under Team. If you are the only owner, it has to be reset in the Supabase dashboard.</p>
        ) : null}
      </div>
    </div>
  );
}