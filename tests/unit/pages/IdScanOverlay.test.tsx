import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import IdScanOverlay from '../../../src/pages/Guard/IdScanOverlay';

const mockUseCameraStream = vi.hoisted(() => vi.fn());
const mockGetEngine = vi.hoisted(() => vi.fn());
const mockRecognise = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/useCameraStream', () => ({ useCameraStream: mockUseCameraStream }));
vi.mock('../../../src/lib/ai/engine', () => ({ getEngine: mockGetEngine }));

const camera = { status: 'streaming', errorMessage: '', start: vi.fn(), stop: vi.fn() };

function setupOcrEngine() {
  mockGetEngine.mockReturnValue({
    id: 'browser-wasm',
    ocr: vi.fn().mockResolvedValue({ recognise: mockRecognise }),
    face: vi.fn(),
  });
}

const PAN_TEXT = [
  'INCOME TAX DEPARTMENT',
  'PERMANENT ACCOUNT NUMBER',
  'ABCDE1234F',
  'Name: Rahul Verma',
].join('\n');

beforeEach(() => {
  mockUseCameraStream.mockReturnValue(camera);
  setupOcrEngine();
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, value: 1280 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, value: 720 });
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['frame'], { type: 'image/jpeg' }));
  };
  HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage: vi.fn() } as any;
  };
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
  mockRecognise.mockResolvedValue({ lines: [{ text: PAN_TEXT, confidence: 0.9 }], fullText: PAN_TEXT });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('M-AI-OCR-UI: IdScanOverlay camera capture', () => {
  it('renders live camera preview and capture button while streaming', () => {
    render(<IdScanOverlay onScanned={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('scan-video')).toBeInTheDocument();
    expect(screen.getByText('Capture Card')).toBeInTheDocument();
  });

  it('capture draws the frame and runs OCR, then shows the review', async () => {
    const onScanned = vi.fn();
    render(<IdScanOverlay onScanned={onScanned} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Capture Card'));
    await waitFor(() => {
      expect(mockRecognise).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText('PAN')).toBeInTheDocument();
      expect(screen.getByText(/XXXXXX234F/)).toBeInTheDocument();
      expect(screen.getByText('Rahul Verma')).toBeInTheDocument();
    });
  });

  // The masked number and the date of birth travel with the result now. They
  // were shown in this dialog and then dropped, so the card behind it could
  // only render a one-line verdict — see CheckInScanSummary.
  it('Use Details calls onScanned with type label, last-4, name, masked number and DOB', async () => {
    const onScanned = vi.fn();
    render(<IdScanOverlay onScanned={onScanned} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Capture Card'));
    fireEvent.click(await screen.findByText('Use Details'));
    expect(onScanned).toHaveBeenCalledWith(
      expect.objectContaining({ idType: 'PAN', idLast4: '234F', name: 'Rahul Verma' }),
    );
    const result = onScanned.mock.calls[0][0];
    // Masked, never the raw number: only the last four are ever persisted.
    expect(result.masked).toBeTruthy();
    expect(result.masked).not.toContain('ABCDE1234F');
    expect(result.masked).toContain('234F');
    expect(result).toHaveProperty('dateOfBirth');
  });

  it('Camera denied shows the file fallback', () => {
    mockUseCameraStream.mockReturnValue({ status: 'denied', errorMessage: '', start: vi.fn(), stop: vi.fn() });
    render(<IdScanOverlay onScanned={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Camera access denied/)).toBeInTheDocument();
    expect(screen.getByTestId('scan-file-input')).toBeInTheDocument();
  });

  it('file input runs OCR on the selected image', async () => {
    render(<IdScanOverlay onScanned={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByTestId('scan-file-input') as HTMLInputElement;
    const file = new File(['x'], 'card.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(mockRecognise).toHaveBeenCalled());
    expect(await screen.findByText('PAN')).toBeInTheDocument();
  });

  it('rejects non-image files without touching the engine', async () => {
    render(<IdScanOverlay onScanned={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByTestId('scan-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'doc.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => {
      expect(screen.getByText(/image file/)).toBeInTheDocument();
    });
    expect(mockRecognise).not.toHaveBeenCalled();
  });
});

describe('M-AI-OCR-UI: IdScanOverlay failures', () => {
  it('shows an error when the OCR engine cannot be loaded', async () => {
    mockGetEngine.mockReturnValue({
      id: 'browser-wasm',
      ocr: vi.fn().mockRejectedValue(new Error('WASM download failed')),
      face: vi.fn(),
    });
    render(<IdScanOverlay onScanned={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Capture Card'));
    await waitFor(() => {
      expect(screen.getByText(/WASM download failed/)).toBeInTheDocument();
    });
  });

  it('shows an error when OCR fails', async () => {
    mockRecognise.mockRejectedValue(new Error('Inference crashed'));
    render(<IdScanOverlay onScanned={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Capture Card'));
    await waitFor(() => {
      expect(screen.getByText(/Inference crashed/)).toBeInTheDocument();
    });
  });

  it('reports when no government ID document is recognised', async () => {
    mockRecognise.mockResolvedValue({ lines: [{ text: 'hello world', confidence: 0.5 }], fullText: 'hello world' });
    render(<IdScanOverlay onScanned={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Capture Card'));
    await waitFor(() => {
      expect(screen.getByText(/no government ID/i)).toBeInTheDocument();
    });
  });

  it('Retry returns to the camera preview after an error', async () => {
    mockRecognise.mockRejectedValueOnce(new Error('Inference crashed'));
    render(<IdScanOverlay onScanned={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Capture Card'));
    await waitFor(() => expect(screen.getByText(/Inference crashed/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Retry'));
    expect(screen.getByText('Capture Card')).toBeInTheDocument();
  });
});

describe('M-AI-OCR-UI: IdScanOverlay close', () => {
  it('renders a corner Close button in every phase', () => {
    const onClose = vi.fn();
    render(<IdScanOverlay onScanned={vi.fn()} onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('the corner Close button calls onClose and stops the camera', () => {
    const onClose = vi.fn();
    render(<IdScanOverlay onScanned={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(camera.stop).toHaveBeenCalled();
  });

  it('Escape closes the overlay', () => {
    const onClose = vi.fn();
    render(<IdScanOverlay onScanned={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop closes the overlay, clicking inside the card does not', () => {
    const onClose = vi.fn();
    render(<IdScanOverlay onScanned={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('Scan ID card'));
    expect(onClose).not.toHaveBeenCalled();
    // The overlay portals to document.body (a backdrop-filter ancestor would
    // otherwise become the containing block of its `fixed inset-0`), so the
    // backdrop lives outside the render container.
    fireEvent.click(document.querySelector('.fixed.inset-0')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('the error phase still offers a Close button alongside Retry', async () => {
    mockRecognise.mockRejectedValue(new Error('Inference crashed'));
    const onClose = vi.fn();
    render(<IdScanOverlay onScanned={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('Capture Card'));
    await waitFor(() => expect(screen.getByText(/Inference crashed/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('error phase lets the guard type the card when OCR cannot read it', async () => {
    mockRecognise.mockRejectedValue(new Error('Inference crashed'));
    const onScanned = vi.fn();
    render(<IdScanOverlay onScanned={onScanned} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Capture Card'));
    await waitFor(() => expect(screen.getByText(/Inference crashed/)).toBeInTheDocument());
    expect(screen.getByText('Enter details from the card')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. 9012'), { target: { value: '9012' } });
    fireEvent.change(screen.getByPlaceholderText('As on the ID card'), { target: { value: 'Rahul Menon' } });
    fireEvent.click(screen.getByRole('button', { name: /Use these details/i }));
    expect(onScanned).toHaveBeenCalledWith(expect.objectContaining({
      idType: 'Aadhaar', idLast4: '9012', name: 'Rahul Menon',
    }));
  });

  it('the review phase offers a Close button alongside Use Details/Retake', async () => {
    const onClose = vi.fn();
    render(<IdScanOverlay onScanned={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('Capture Card'));
    await screen.findByText('Use Details');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
