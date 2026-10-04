'use client';

import { useTranslations } from 'next-intl';
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';

/** What a form needs from the pad: whether anything was drawn, and the drawing as a PNG. */
export interface SignaturePadHandle {
  isEmpty: () => boolean;
  toPng: () => Promise<Blob | null>;
  clear: () => void;
}

/**
 * An on-screen signature: a plain canvas drawn with the finger, a stylus or the mouse (pointer
 * events), exported as a PNG. The canvas keeps a white "paper" background in both themes so the
 * dark ink stays readable.
 */
export function SignaturePad({
  onReady,
  onChange,
}: {
  onReady: (handle: SignaturePadHandle) => void;
  onChange?: (empty: boolean) => void;
}) {
  const t = useTranslations('Transport');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const inked = useRef(false);
  const [empty, setEmpty] = useState(true);
  // The callbacks are read through refs, so a parent re-render never resets the drawing.
  const callbacks = useRef({ onReady, onChange });
  useEffect(() => {
    callbacks.current = { onReady, onChange };
  });

  const markEmpty = useCallback((value: boolean) => {
    inked.current = !value;
    setEmpty(value);
    callbacks.current.onChange?.(value);
  }, []);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  const clear = useCallback(() => {
    paint();
    markEmpty(true);
  }, [paint, markEmpty]);

  // Size the drawing surface to the element (and the screen's pixel density) once mounted.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    paint();
    callbacks.current.onReady({
      isEmpty: () => !inked.current,
      toPng: () =>
        new Promise((resolve) => {
          canvas.toBlob((blob) => resolve(blob), 'image/png');
        }),
      clear,
    });
  }, [paint, clear]);

  function point(event: PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  }

  function onDown(event: PointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    last.current = point(event);
  }

  function onMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const next = point(event);
    const ratio = window.devicePixelRatio || 1;
    context.strokeStyle = '#111827';
    context.lineWidth = 2.5 * ratio;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(last.current.x, last.current.y);
    context.lineTo(next.x, next.y);
    context.stroke();
    last.current = next;
    if (!inked.current) markEmpty(false);
  }

  function onUp() {
    drawing.current = false;
    last.current = null;
  }

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        aria-label={t('signature')}
        role="img"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
      />
      <div className="row">
        <span className="muted">{t('signHint')}</span>
        <button type="button" className="button small" onClick={clear} disabled={empty}>
          {t('clearSignature')}
        </button>
      </div>
    </div>
  );
}
