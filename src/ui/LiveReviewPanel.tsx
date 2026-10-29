import { useEffect, useRef, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createLlmReviewer } from '../core/review/llm.ts';
import { preparePipeline, runPreparedPipeline } from '../core/review/pipeline.ts';
import type { ImportResult, PipelineExecutionResult, PreparedPipeline, ReviewScope } from '../core/review/pipeline.ts';
import { parseReviewRequest } from '../core/shared/wire.ts';
import type { PreviewResponse, ReviewRequest } from '../core/shared/wire.ts';
import { executeLiveReview, getSupabaseClient, previewLiveReview } from '../lib/supabase.ts';
import { errorMessage } from './helpers.ts';

interface Props {
  imported: ImportResult | null;
  scope: ReviewScope | null;
  busy: boolean;
  onBusy: (busy: boolean, cancel?: () => void) => void;
  onComplete: (result: PipelineExecutionResult, scope: ReviewScope) => void;
}

interface Preview {
  readonly imported: ImportResult;
  readonly prepared: PreparedPipeline;
  readonly requests: readonly ReviewRequest[];
  readonly responses: readonly PreviewResponse[];
  readonly withContext: boolean;
  readonly userId: string;
}

export function LiveReviewPanel({ imported, scope, busy, onBusy, onComplete }: Props) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [transferConsent, setTransferConsent] = useState(false);
  const [paidConsent, setPaidConsent] = useState(false);
  const [withContext, setWithContext] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [working, setWorking] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancel = useRef(false);
  const active = useRef(true);
  const operation = useRef(0);
  const userId = session?.user.id;

  useEffect(() => {
    active.current = true;
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    try {
      const configured = getSupabaseClient();
      setClient(configured);
      if (!configured) { setAuthReady(true); return; }
      void configured.auth.getSession().then(({ data, error: authError }) => {
        if (!mounted) return;
        if (authError) setError('The saved sign-in could not be restored. Sign in again.');
        setSession(data.session); setAuthReady(true);
      }).catch(() => { if (mounted) { setError('Could not restore sign-in.'); setAuthReady(true); } });
      const { data } = configured.auth.onAuthStateChange((_event, nextSession) => { if (mounted) { setSession(nextSession); setAuthReady(true); } });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch (cause) { setError(errorMessage(cause)); setAuthReady(true); }
    return () => { mounted = false; active.current = false; operation.current++; cancel.current = true; unsubscribe?.(); };
  }, []);

  useEffect(() => { setPreview(null); setTransferConsent(false); setPaidConsent(false); }, [imported, scope, withContext, userId]);

  async function authenticate(kind: 'send' | 'verify' | 'signout'): Promise<void> {
    if (!client) { setError('Live review is not configured. Configure the public Supabase settings first.'); return; }
    setAuthBusy(true); setError('');
    try {
      if (kind === 'signout') {
        const result = await client.auth.signOut();
        if (result.error) throw new Error('Sign out could not be completed.');
        setSession(null); setOtp(''); setOtpSent(false); setStatus('Signed out.');
      } else if (kind === 'send') {
        const result = await client.auth.signInWithOtp({ email: email.trim() });
        if (result.error) throw new Error('Could not send the email code. Check the email and authentication configuration.');
        setOtpSent(true); setStatus('Check your email for the sign-in code. Access still requires a confirmed, allowlisted address.');
      } else {
        const result = await client.auth.verifyOtp({ email: email.trim(), token: otp.trim(), type: 'email' });
        if (result.error) throw new Error('The code could not be verified. Request a new code if it expired.');
        setSession(result.data.session); setOtp(''); setStatus('Signed in. The server checks the email allowlist before any preview or paid call.');
      }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setAuthBusy(false); }
  }

  function requestStop(): void { cancel.current = true; setCancelRequested(true); setStatus('Stopping after the current request. Completed paid batches will remain reviewable.'); }

  async function obtainPreview(): Promise<void> {
    if (!client || !session || !imported || !scope || !transferConsent) { setError('Sign in, choose a valid scope, and acknowledge the backend transfer before previewing.'); return; }
    const token = ++operation.current;
    cancel.current = false; setCancelRequested(false); setWorking(true); setError(''); setPreview(null); setPaidConsent(false); onBusy(true, requestStop);
    try {
      const prepared = await preparePipeline(imported, { scope });
      if (!prepared.batches.length) throw new Error('No eligible strings are inside this review scope. Adjust the scope or import issues.');
      const requests = prepared.batches.map((batch) => parseReviewRequest({ requestId: crypto.randomUUID(), attempt: 1, schemaVersion: 1, reviewer: 'llm', withContext, items: batch.map((record) => record.mask.masked) }));
      const responses: PreviewResponse[] = [];
      for (const request of requests) {
        if (cancel.current || token !== operation.current) break;
        setStatus(`Preparing a no-charge preview: ${responses.length + 1} of ${requests.length} batches.`);
        const response = await previewLiveReview(client, request, session.user.id);
        if (response.stringCount !== request.items.length) throw new Error('The server preview did not match the requested string count.');
        responses.push(response);
      }
      if (!active.current || token !== operation.current) return;
      if (cancel.current || responses.length !== requests.length) { setStatus('Preview cancelled. No provider run was started.'); return; }
      const config = responses[0];
      if (!config || responses.some((entry) => entry.modelId !== config.modelId || entry.priceTableVersion !== config.priceTableVersion || entry.provider !== config.provider)) throw new Error('Server configuration changed during preview. Obtain a fresh preview.');
      setPreview({ imported, prepared, requests, responses, withContext, userId: session.user.id });
      setStatus('Preview ready. Review the estimate and explicitly confirm the paid run.');
    } catch (cause) { if (active.current && token === operation.current) setError(errorMessage(cause)); }
    finally { if (active.current && token === operation.current) { setWorking(false); onBusy(false); } }
  }

  async function executePreview(): Promise<void> {
    if (!client || !session || !preview || !paidConsent || session.user.id !== preview.userId || imported !== preview.imported || withContext !== preview.withContext || JSON.stringify(scope) !== JSON.stringify(preview.prepared.scope)) { setError('Obtain a current preview and confirm this paid run.'); return; }
    const frozen = preview;
    const token = ++operation.current;
    cancel.current = false; setCancelRequested(false); setWorking(true); setError(''); setPaidConsent(false); setPreview(null); onBusy(true, requestStop);
    let nextBatch = 0;
    try {
      const reviewer = createLlmReviewer({
        requestForBatch: (batch, contextOn) => {
          const request = frozen.requests[nextBatch++];
          if (!request || contextOn !== frozen.withContext || JSON.stringify(batch) !== JSON.stringify(request.items)) throw new Error('Prepared batch changed. Obtain a new preview.');
          return { requestId: request.requestId, attempt: request.attempt };
        },
        transport: async (request) => {
          const index = frozen.requests.findIndex((entry) => entry.requestId === request.requestId);
          const approved = frozen.requests[index];
          const estimate = frozen.responses[index];
          if (!approved || !estimate || request.attempt !== approved.attempt || request.withContext !== approved.withContext || JSON.stringify(request.items) !== JSON.stringify(approved.items)) throw new Error('The request no longer matches its preview.');
          return executeLiveReview(client, approved, estimate.requestHash, frozen.userId);
        },
      });
      const completed = await runPreparedPipeline(frozen.prepared, {
        reviewer, reviewOptions: { withContext: frozen.withContext }, shouldCancel: () => cancel.current,
        onProgress: (progress) => { if (active.current) setStatus(`Completed ${progress.completedBatches} of ${progress.totalBatches} live batches.${cancel.current ? ' Stopping now.' : ''}`); },
      });
      if (!active.current || token !== operation.current) return;
      onComplete(completed, frozen.prepared.scope);
      setStatus(`${completed.completion === 'complete' ? 'Live review complete' : completed.completion === 'cancelled' ? 'Live review stopped' : 'Live review failed'}: ${completed.completedBatches} of ${completed.totalBatches} batches completed. Completed results are available below.`);
      if (completed.error) setError(completed.error);
    } catch (cause) { if (active.current && token === operation.current) setError(errorMessage(cause)); }
    finally { if (active.current && token === operation.current) { setWorking(false); setTransferConsent(false); onBusy(false); } }
  }

  const total = preview?.responses.reduce((sum, response) => sum + response.estimateUsd, 0) ?? 0;
  const first = preview?.responses[0];
  return <section className="live-panel" aria-labelledby="live-title">
    <div className="section-heading"><div><span className="eyebrow">Optional / Metered review</span><h2 id="live-title">Live review, with your permission</h2></div><span className={`badge ${session ? 'badge-green' : ''}`}>{session ? 'Signed in' : client ? 'Sign-in required' : 'Not configured'}</span></div>
    <p className="muted">Live errors stay visible. A failed live run never substitutes recorded mock responses.</p>
    {!client && <p className="notice-inline">Live review requires the public Supabase URL and anon key, deployed review function, and an allowlisted email. Local review remains available.</p>}
    {session ? <div className="auth-session"><span>Signed in as <strong>{session.user.email ?? 'authenticated user'}</strong></span><button disabled={busy || authBusy} onClick={() => { void authenticate('signout'); }}>Sign out</button></div> : <form className="auth-form" onSubmit={(event) => { event.preventDefault(); void authenticate(otpSent ? 'verify' : 'send'); }}><label>Email address<input type="email" autoComplete="email" value={email} disabled={!client || busy || authBusy} required onChange={(event) => { setEmail(event.target.value); setOtpSent(false); }} /></label>{otpSent && <label>Email code<input inputMode="numeric" autoComplete="one-time-code" value={otp} required disabled={busy || authBusy} onChange={(event) => setOtp(event.target.value)} /></label>}<button type="submit" disabled={!client || !authReady || busy || authBusy}>{authBusy ? 'Please wait…' : otpSent ? 'Verify email code' : 'Send email code'}</button>{otpSent && <button type="button" className="quiet" disabled={busy || authBusy} onClick={() => { void authenticate('send'); }}>Resend code</button>}</form>}
    <label className="check-label live-context"><input type="checkbox" checked={withContext} disabled={busy || authBusy} onChange={(event) => setWithContext(event.target.checked)} />Include the masked context pack in the provider prompt</label>
    <div className="transfer-notice"><strong>Before the preview: backend transfer</strong><p>Preview sends selected masked keys, source and target wording, legends, and context to your configured Supabase backend. Masked strings still contain ordinary message wording. The backend validates and estimates the full provider request without reserving budget or contacting a provider.</p><label className="check-label"><input type="checkbox" checked={transferConsent} disabled={busy || authBusy} onChange={(event) => setTransferConsent(event.target.checked)} />I agree to send this scope to the backend for a no-charge preview.</label></div>
    <div className="button-row"><button disabled={busy || authBusy || !session || !imported || !scope || !transferConsent} onClick={() => { void obtainPreview(); }}>Prepare exact cost preview</button>{working && <button disabled={cancelRequested} onClick={requestStop}>{cancelRequested ? 'Stopping after this batch…' : 'Cancel after current request'}</button>}</div>
    {!scope && imported && <p className="notice-inline">Correct the key prefix in review scope before previewing.</p>}
    {preview && first && <div className="cost-preview"><div className="cost-head"><div><span className="eyebrow">Server-calculated preview</span><strong>${total.toFixed(6)} <small>USD estimated reservation</small></strong></div><span className="badge">{preview.requests.length} batches · {preview.requests.reduce((sum, request) => sum + request.items.length, 0)} strings</span></div><p>{first.provider} · {first.modelId} · {first.priceTableVersion}</p><p className="hint">Frozen scope: {preview.prepared.scope.locales?.join(', ') || 'all locales'} · key prefix {JSON.stringify(preview.prepared.scope.keyPrefix ?? [])} · {preview.prepared.scope.errorFreeOnly ? 'without deterministic errors' : 'all eligible strings'}</p><p className="hint">The estimate bounds this app’s accounting, not provider billing. The server enforces the daily cap. Each batch is bound to its exact request, model and pricing; changed configuration requires a new preview.</p><label className="check-label paid-consent"><input type="checkbox" checked={paidConsent} disabled={busy || authBusy} onChange={(event) => setPaidConsent(event.target.checked)} />I approve this paid run and transfer of the selected masked text to {first.provider} through the backend.</label><button className="primary" disabled={busy || authBusy || !paidConsent || !session} onClick={() => { void executePreview(); }}>Run live review</button></div>}
    <p className="hint">Batches run sequentially. Cancel stops the next batch; an in-flight request can still finish and incur cost. A timeout or unknown outcome may retain its reservation.</p>
    <p className="live-status" role="status" aria-live="polite">{status}</p>{error && <div className="error-banner" role="alert">{error}</div>}
  </section>;
}
