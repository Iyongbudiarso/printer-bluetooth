import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { AlertCircle, Bluetooth, CheckCircle2, Loader2, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useBluetoothPrinter } from '@/hooks/use-bluetooth-printer';
import { usePrintPreparation } from '@/hooks/use-print-preparation';

GlobalWorkerOptions.workerSrc = pdfWorker;

const PRINTER_STATUS = {
  disconnected: {
    label: 'Printer not connected',
    hint: 'Select the status button to pair your Bluetooth device.',
    dotClass: 'bg-destructive'
  },
  connecting: {
    label: 'Preparing printer connection…',
    hint: 'Choose a device in the browser dialog and follow the prompts.',
    dotClass: 'bg-amber-500'
  },
  connected: {
    label: 'Printer ready to use',
    hint: 'You can preview or print documents now.',
    dotClass: 'bg-emerald-500'
  },
  error: {
    label: 'Printer connection failed',
    hint: 'Check your Bluetooth device and try the setup again.',
    dotClass: 'bg-destructive'
  }
};

const WIDTH_TO_PIXELS = {
  '58': 384,
  '80': 576
};


function App() {
  const [statusKey, setStatusKey] = useState('disconnected');
  const [deviceName, setDeviceName] = useState('No device detected.');
  const [printWidth, setPrintWidth] = useState('80');
  const [isProgressVisible, setProgressVisible] = useState(false);
  const [isPreviewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const previewCanvasRef = useRef(null);
  const modalPreviewCanvasRef = useRef(null);
  const previewContextRef = useRef(null);
  const modalPreviewContextRef = useRef(null);
  const printDataCanvasRef = useRef(null);
  const printDataContextRef = useRef(null);
  const maxPrintWidthRef = useRef(WIDTH_TO_PIXELS[printWidth] || 384);

  const imageDataForPrintRef = useRef(null);
  const sourceCanvasForPrintRef = useRef(null);
  const lastPdfBytesRef = useRef(null);
  const lastImageDataUrlRef = useRef(null);
  const { toast: pushToast, dismiss } = useToast();
  const lastToastIdRef = useRef(null);

  const status = useMemo(() => PRINTER_STATUS[statusKey] || PRINTER_STATUS.disconnected, [statusKey]);
  const statusAccentClass =
    statusKey === 'connected'
      ? 'text-emerald-500'
      : statusKey === 'connecting'
        ? 'text-primary'
        : statusKey === 'error'
          ? 'text-destructive'
          : 'text-muted-foreground';
  const StatusIcon =
    statusKey === 'connected'
      ? CheckCircle2
      : statusKey === 'connecting'
        ? Loader2
        : statusKey === 'error'
          ? AlertCircle
          : Bluetooth;

  const showProgress = useCallback(() => setProgressVisible(true), []);
  const hideProgress = useCallback(() => setProgressVisible(false), []);

  const handleError = useCallback((error, messageOverride) => {
    console.error(error);
    const message = messageOverride || error?.message || 'An unknown error occurred.';
    setErrorMessage(message);
    hideProgress();
  }, [hideProgress]);

  const showToast = useCallback((message, tone = 'info', duration = 4000) => {
    if (!message) {
      return;
    }
    if (lastToastIdRef.current) {
      dismiss(lastToastIdRef.current);
      lastToastIdRef.current = null;
    }
    const variant = tone === 'error' ? 'destructive' : 'default';
    const titles = {
      success: 'Success',
      error: 'Something went wrong'
    };
    const nextToast = pushToast({
      variant,
      description: message,
      duration,
      ...(titles[tone] ? { title: titles[tone] } : {})
    });
    lastToastIdRef.current = nextToast.id;
  }, [dismiss, pushToast]);

  const hideToast = useCallback(() => {
    if (!lastToastIdRef.current) {
      return;
    }
    dismiss(lastToastIdRef.current);
    lastToastIdRef.current = null;
  }, [dismiss]);

  const {
    copyCanvasToPreview,
    renderImageFromDataUrl,
    reloadLastPdf,
    reloadLastImage,
    handleFileChange,
    handleDownloadPreview,
    syncModalPreview,
    getImagePrintData
  } = usePrintPreparation({
    previewCanvasRef,
    modalPreviewCanvasRef,
    previewContextRef,
    modalPreviewContextRef,
    printDataCanvasRef,
    printDataContextRef,
    maxPrintWidthRef,
    imageDataForPrintRef,
    sourceCanvasForPrintRef,
    lastPdfBytesRef,
    lastImageDataUrlRef,
    showToast,
    showProgress,
    hideProgress,
    hideToast,
    handleError,
    printWidth
  });

  useEffect(() => {
    if (previewCanvasRef.current && !previewContextRef.current) {
      previewContextRef.current = previewCanvasRef.current.getContext('2d');
    }
    if (modalPreviewCanvasRef.current && !modalPreviewContextRef.current) {
      modalPreviewContextRef.current = modalPreviewCanvasRef.current.getContext('2d');
    }
    if (!printDataCanvasRef.current) {
      const canvas = document.createElement('canvas');
      printDataCanvasRef.current = canvas;
      printDataContextRef.current = canvas.getContext('2d');
    }
    hideProgress();
  }, [hideProgress, isPreviewDialogOpen]);

  useEffect(() => {
    maxPrintWidthRef.current = WIDTH_TO_PIXELS[printWidth] || 384;
    if (lastPdfBytesRef.current) {
      reloadLastPdf();
    } else if (lastImageDataUrlRef.current) {
      reloadLastImage();
    } else if (sourceCanvasForPrintRef.current) {
      copyCanvasToPreview(sourceCanvasForPrintRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printWidth]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    const handleMessage = async (event) => {
      const { data } = event;
      if (!data || data.type !== 'share-target-files' || !Array.isArray(data.files) || data.files.length === 0) {
        return;
      }
      showProgress();
      try {
        for (const filePayload of data.files) {
          const blob = new Blob([filePayload.buffer], {
            type: filePayload.type || 'application/octet-stream'
          });
          const dataUrl = await blobToDataUrl(blob);
          lastImageDataUrlRef.current = dataUrl;
          lastPdfBytesRef.current = null;
          await renderImageFromDataUrl(dataUrl);
        }
        showToast('Shared image is ready to preview.', 'success');
      } catch (error) {
        showToast('Failed to load shared image.', 'error', 5000);
        handleError(error);
      } finally {
        hideProgress();
      }
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    navigator.serviceWorker.startMessages?.();
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [handleError, hideProgress, renderImageFromDataUrl, showProgress, showToast]);

  useEffect(() => {
    if (!isPreviewDialogOpen) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      syncModalPreview();
    });
    return () => cancelAnimationFrame(raf);
  }, [isPreviewDialogOpen, syncModalPreview]);

  const setPrinterStatus = useCallback((key) => {
    const next = PRINTER_STATUS[key] ? key : 'disconnected';
    setStatusKey(next);
  }, []);

  const setPrinterDeviceName = useCallback((nameText) => {
    setDeviceName(nameText || 'No device detected.');
  }, []);

  const closeErrorDialog = useCallback(() => setErrorMessage(''), []);

  const showPreviewDialog = useCallback(() => {
    if (!imageDataForPrintRef.current) {
      showToast('Load a PDF to preview.', 'error');
      return;
    }
    syncModalPreview();
    setPreviewDialogOpen(true);
  }, [showToast, syncModalPreview]);

  const closePreviewDialog = useCallback(() => {
    setPreviewDialogOpen(false);
  }, []);


  const { handleSetupPrinter, handlePrint } = useBluetoothPrinter({
    imageDataForPrintRef,
    getImagePrintData,
    showProgress,
    hideProgress,
    showToast,
    handleError,
    getPrinterDisplayName,
    setPrinterStatus,
    setPrinterDeviceName
  });

  return (
    <div className="relative min-h-screen bg-muted/40">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-6 py-6 lg:px-10">
        <header className="flex flex-col gap-3 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-muted-foreground">Web Bluetooth</p>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground lg:text-[28px]">Bluetooth Printer</h1>
          </div>
          <Button
            type="button"
            onClick={handleSetupPrinter}
            variant="outline"
            className="group relative mt-2 inline-flex items-center gap-2 rounded-full border-border bg-card/90 px-3.5 py-2 text-sm font-semibold text-foreground shadow-sm transition hover:border-primary/60 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:mt-0"
          >
            <span className={`h-2.5 w-2.5 rounded-full shadow-sm ${status.dotClass}`} />
            <span className="tracking-tight">{status.label}</span>
            <StatusIcon className={`h-3 w-3 transition ${statusAccentClass} ${statusKey === 'connecting' ? 'animate-spin' : ''} group-hover:text-primary`} />
            <div className="pointer-events-none absolute right-0 top-full z-10 mt-2 hidden min-w-[220px] rounded-xl border border-border bg-popover/95 px-3.5 py-2.5 text-left text-[0.75rem] text-muted-foreground shadow-xl group-hover:flex">
              <div className="flex flex-col">
                <span className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Active Device</span>
                <span className="mt-1 text-sm font-medium text-foreground">{deviceName}</span>
              </div>
            </div>
          </Button>
        </header>

        <main className="app-grid gap-8">
          <Card className="order-1 rounded-2xl border-border shadow-sm app-grid__preview">
            <CardHeader className="border-b border-border/60 pb-4">
              <CardTitle className="text-lg font-semibold">Print Preview</CardTitle>
              <CardDescription className="text-sm">
                Preview the monochrome output scaled to the selected paper width.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-6 px-6 py-10">
              <canvas
                ref={previewCanvasRef}
                width="240"
                height="240"
                className="aspect-square w-full max-w-xs rounded-xl border border-dashed border-border bg-background/50 shadow-inner"
              />
              <p className="text-xs text-muted-foreground">
                Select "Preview Print" after uploading a file to refresh the preview.
              </p>
            </CardContent>
          </Card>

          <div className="order-2 app-grid__sidebar flex flex-col gap-6">
            <Card className="rounded-2xl border-border shadow-sm">
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="text-base font-semibold">Print Settings</CardTitle>
                <CardDescription className="text-sm">
                  Set the paper width and upload a file to process.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6 pt-6">
                <div className="space-y-2">
                  <Label htmlFor="printWidth">Paper Width</Label>
                  <Select value={printWidth} onValueChange={setPrintWidth}>
                    <SelectTrigger id="printWidth">
                      <SelectValue placeholder="Select paper width" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="80">80 mm</SelectItem>
                      <SelectItem value="58">58 mm</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fileInput">Upload PDF or Image</Label>
                  <Input
                    id="fileInput"
                    type="file"
                    accept="application/pdf,image/png,image/jpeg"
                    onChange={handleFileChange}
                    className="cursor-pointer text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
                  />
                  <p className="text-xs text-muted-foreground">
                    Choose a PDF, PNG, or JPG. Files are converted to monochrome bitmap before printing.
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border-border shadow-sm">
              <CardHeader className="border-b border-border/60 pb-4">
                <CardTitle className="text-base font-semibold">Actions</CardTitle>
                <CardDescription className="text-sm">
                  After setup completes, use these buttons to preview and print.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 pt-6">
                <Button variant="outline" className="h-11 justify-center" onClick={showPreviewDialog}>
                  Preview Print
                </Button>
                <Button variant="secondary" className="h-11 justify-center" onClick={handleDownloadPreview}>
                  Save as PNG
                </Button>
                <Button className="h-11 justify-center uppercase tracking-[0.12em]" onClick={handlePrint}>
                  <Printer className="mr-2 h-4 w-4" />
                  Print
                </Button>
              </CardContent>
            </Card>
          </div>

          <Card className="order-4 rounded-2xl border-border shadow-sm app-grid__info">
            <CardHeader className="border-b border-border/60 pb-4">
              <CardTitle className="text-lg font-semibold">Printer Information</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 px-6 py-6 text-sm text-muted-foreground lg:grid-cols-2">
              <div>
                <p className="font-medium text-foreground">Connectivity</p>
                <p>Bluetooth Low Energy (ESC/POS).</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Format</p>
                <p>Black-and-white canvas with Floyd-Steinberg dithering.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Maximum Width</p>
                <p>576px (80 mm) or 384px (58 mm).</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Browser</p>
                <p>Ensure Web Bluetooth is available (Chrome/Edge).</p>
              </div>
            </CardContent>
          </Card>
        </main>

        {isProgressVisible && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-card px-6 py-5 shadow-xl">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="text-sm font-medium text-muted-foreground">Processing data…</p>
            </div>
          </div>
        )}

        <Dialog open={Boolean(errorMessage)} onOpenChange={(open) => !open && closeErrorDialog()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Something went wrong</DialogTitle>
              <DialogDescription>{errorMessage}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={closeErrorDialog}>Got it</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={isPreviewDialogOpen} onOpenChange={(open) => { if (!open) { closePreviewDialog(); } }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Print Preview</DialogTitle>
              <DialogDescription>The preview below is ready to send to the printer.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-muted/50 p-6">
              <canvas
                ref={modalPreviewCanvasRef}
                width="240"
                height="240"
                className="aspect-square w-full max-w-sm rounded-lg border border-border bg-background shadow-inner"
              />
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
              <Button variant="ghost" onClick={handleDownloadPreview}>
                Save as PNG
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={closePreviewDialog}>
                  Close
                </Button>
                <Button onClick={handlePrint}>
                  <Printer className="mr-2 h-4 w-4" />
                  Print
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read shared image data.'));
    reader.readAsDataURL(blob);
  });
}

function getPrinterDisplayName(device) {
  if (!device) {
    return 'No device detected.';
  }
  if (device.name && device.name.trim()) {
    return device.name;
  }
  return 'Device name unavailable.';
}

export default App;
