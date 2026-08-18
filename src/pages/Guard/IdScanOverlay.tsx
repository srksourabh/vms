import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCameraStream } from '../../lib/useCameraStream';
import { getEngine } from '../../lib/ai/engine';
import { parseIdDocument, type IdDocumentType } from '../../lib/ai/idParser';
import { lastFourOf, maskIdNumber } from '../../lib/ai/redact';
import { safeErrorMessage } from '../../lib/errors';
import ModalCloseButton from '../../components/ModalCloseButton';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { type IdScanResult } from './idScanTypes';
import ManualIdEntry from './ManualIdEntry';

export type { IdScanResult } from './idScanTypes';

type Props = {
  onScanned: (result: IdScanResult) => void;
  onClose: () => void;
};

const ID_TYPE_LABELS: Record<IdDocumentType, string> = {
  aadhaar: 'Aadhaar',
  pan: 'PAN',
  voter_id: 'Voter ID',
  passport: 'Passport',
  driving_licence: 'Driver Licence',
  unknown: '',
};

// Named on the camera step and repeated in the failure message, because the
// desk accepts ANY government photo ID and a guard reading "Scan ID card" over
// a live camera has no way to know which documents the reader can name. A
// visitor holding a voter card was being turned away from a scan that would
// have accepted it.
const ACCEPTED_IDS = 'Aadhaar, Voter ID, PAN, Driving Licence or Passport';

type Phase = 'camera' | 'reading' | 'review' | 'error';

// The overlay claims `fixed inset-0 z-50` — it must render at the DOCUMENT
// root, never inside another modal. A `backdrop-filter` ancestor becomes the
// containing block for fixed descendants, which silently shrinks this
// "full-screen" overlay to that modal's box and scrolls it with the modal's
// content. The portal keeps it viewport-fixed wherever it is opened from.
const SCAN_BACKDROP = 'fixed inset-0 z-50 bg-navy-950/80 flex items-center justify-center p-4';

export default function IdScanOverlay({ onScanned, onClose }: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>('camera');
  const [error, setError] = useState('');
  const [parsed, setParsed] = useState<{ typeLabel: string; masked: string; last4: string; name: string | null; dob: string | null } | null>(null);

  const { status, start: startCamera, stop: stopCamera } = useCameraStream(videoRef, { facingMode: 'environment' });

  const runOcr = useCallback(async (blob: Blob) => {
    setPhase('reading');
    try {
      const engine = await getEngine().ocr();
      const result = await engine.recognise(blob);
      const id = parseIdDocument(result.fullText);
      if (id.type === 'unknown' || !id.rawNumber) {
        setError(`No government ID recognised. ${ACCEPTED_IDS} are all accepted — try again with better lighting.`);
        setPhase('error');
        return;
      }
      setParsed({
        typeLabel: ID_TYPE_LABELS[id.type],
        masked: maskIdNumber(id.rawNumber),
        last4: lastFourOf(id.rawNumber),
        name: id.name,
        dob: id.dateOfBirth,
      });
      setPhase('review');
    } catch (err) {
      setError(safeErrorMessage(err, 'Scan failed. Please try again.'));
      setPhase('error');
    }
  }, []);

  const capture = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const { videoWidth: vw, videoHeight: vh } = video;
    if (vw === 0 || vh === 0) return;
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) void runOcr(blob);
    }, 'image/jpeg', 0.92);
  }, [runOcr]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.');
      setPhase('error');
      return;
    }
    void runOcr(file);
  }, [runOcr]);

  const retry = useCallback(() => {
    setError('');
    setParsed(null);
    setPhase('camera');
    startCamera();
  }, [startCamera]);

  const apply = useCallback(() => {
    if (!parsed) return;
    stopCamera();
    // Carry the masked number and the date of birth through as well. They were
    // shown in the review step above and then discarded, so everything the scan
    // read vanished the instant the guard accepted it.
    onScanned({
      idType: parsed.typeLabel,
      idLast4: parsed.last4,
      name: parsed.name,
      masked: parsed.masked,
      dateOfBirth: parsed.dob,
    });
  }, [parsed, onScanned, stopCamera]);

  const close = useCallback(() => {
    stopCamera();
    onClose();
  }, [onClose, stopCamera]);

  // One Escape handler for the whole overlay, regardless of which phase is
  // showing — every phase below shares the same `close`.
  useEscapeKey(close);

  if (phase === 'reading') {
    return createPortal((
      <div className={SCAN_BACKDROP} onClick={close}>
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center space-y-4 relative" onClick={(e) => e.stopPropagation()}>
          <ModalCloseButton onClose={close} />
          <div className="animate-spin h-10 w-10 border-4 border-brand-600 border-t-transparent rounded-full mx-auto" />
          <p className="font-bold text-navy-900">Reading card…</p>
          <p className="text-sm text-navy-500 dark:text-navy-400">On-device OCR — nothing leaves this machine</p>
        </div>
      </div>
    ), document.body);
  }

  if (phase === 'error') {
    return createPortal((
      <div className={SCAN_BACKDROP} onClick={close}>
        <div className="bg-white rounded-2xl p-6 max-w-sm w-full space-y-4 relative" onClick={(e) => e.stopPropagation()}>
          <ModalCloseButton onClose={close} />
          <p className="text-sm font-semibold text-danger-700 pr-8">{error}</p>
          <ManualIdEntry onSubmit={(r) => { stopCamera(); onScanned(r); }} />
          <button onClick={retry} className="w-full bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl py-2.5 text-sm">Retry</button>
        </div>
      </div>
    ), document.body);
  }

  if (phase === 'review' && parsed) {
    return createPortal((
      <div className={SCAN_BACKDROP} onClick={close}>
        <div className="bg-white rounded-2xl p-6 max-w-sm w-full space-y-4 relative" onClick={(e) => e.stopPropagation()}>
          <ModalCloseButton onClose={close} />
          <h3 className="font-bold text-navy-900 pr-8">Review scanned details</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-navy-500 dark:text-navy-400">Document</span><span className="font-semibold text-navy-900">{parsed.typeLabel}</span></div>
            <div className="flex justify-between"><span className="text-navy-500 dark:text-navy-400">ID number</span><span className="font-mono font-semibold text-navy-900">{parsed.masked}</span></div>
            <div className="flex justify-between"><span className="text-navy-500 dark:text-navy-400">Visitor Name</span><span className="font-semibold text-navy-900">{parsed.name ?? '—'}</span></div>
            <div className="flex justify-between"><span className="text-navy-500 dark:text-navy-400">Date of birth</span><span className="font-semibold text-navy-900">{parsed.dob ?? '—'}</span></div>
          </div>
          <div className="flex gap-3">
            <button onClick={apply} className="flex-1 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl py-2.5 text-sm">Use Details</button>
            <button onClick={retry} className="flex-1 bg-surface-50 hover:bg-surface-100 text-navy-700 font-bold rounded-xl py-2.5 text-sm">Retake</button>
          </div>
        </div>
      </div>
    ), document.body);
  }

  const cameraDown = status === 'denied' || status === 'error';

  return createPortal((
    <div className={SCAN_BACKDROP} onClick={close}>
      <div className="bg-white rounded-2xl p-5 max-w-sm w-full space-y-4 relative" onClick={(e) => e.stopPropagation()}>
        <ModalCloseButton onClose={close} />
        <div className="pr-8">
          <h3 className="font-bold text-navy-900">Scan ID card</h3>
          <p className="text-xs text-navy-700 mt-0.5">{ACCEPTED_IDS} — any of these is accepted.</p>
        </div>

        {cameraDown ? (
          <div className="rounded-xl border border-danger-500/20 bg-danger-50 p-5 space-y-3">
            <p className="font-semibold text-danger-700 text-sm">
              {status === 'denied' ? 'Camera access denied — allow permission and refresh.' : 'Camera unavailable.'}
            </p>
            <input type="file" accept="image/*" capture="environment" data-testid="scan-file-input" onChange={handleFileInput} className="text-sm w-full" />
          </div>
        ) : (
          <>
            <div className="relative w-full max-w-xs mx-auto">
              <video ref={videoRef} autoPlay muted playsInline data-testid="scan-video"
                className="w-full rounded-xl bg-navy-950" style={{ aspectRatio: '3/2', objectFit: 'cover' }} />
              {status === 'idle' && (
                <div className="absolute inset-0 flex items-center justify-center bg-navy-950/70 rounded-xl">
                  <div className="text-white text-sm">Starting camera…</div>
                </div>
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />
            {status === 'streaming' && (
              <button onClick={capture}
                className="w-full rounded-full bg-danger-600 hover:bg-danger-700 text-white px-8 py-3 text-sm font-bold shadow-soft transition-all active:scale-95">
                <span className="inline-flex items-center justify-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-white animate-pulse-soft" />
                  Capture Card
                </span>
              </button>
            )}
            <label className="block text-center text-xs text-navy-500 dark:text-navy-400 cursor-pointer hover:text-brand-600 transition-colors">
              <input type="file" accept="image/*" data-testid="scan-file-input" onChange={handleFileInput} className="hidden" />
              Or upload from device
            </label>
          </>
        )}
      </div>
    </div>
  ), document.body);
}
