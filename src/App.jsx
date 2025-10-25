import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';

GlobalWorkerOptions.workerSrc = pdfWorker;

const PRINTER_STATUS = {
  disconnected: {
    label: 'Printer belum tersambung',
    hint: 'Tekan Setup Printer untuk memasangkan perangkat Bluetooth Anda.',
    dotClass: 'bg-destructive'
  },
  connecting: {
    label: 'Menyiapkan koneksi printer…',
    hint: 'Pilih perangkat yang muncul pada dialog browser dan ikuti instruksinya.',
    dotClass: 'bg-amber-500'
  },
  connected: {
    label: 'Printer siap digunakan',
    hint: 'Anda dapat mempratinjau atau mencetak dokumen sekarang.',
    dotClass: 'bg-emerald-500'
  },
  error: {
    label: 'Koneksi printer gagal',
    hint: 'Periksa perangkat Bluetooth dan coba ulangi proses setup.',
    dotClass: 'bg-destructive'
  }
};

const WIDTH_TO_PIXELS = {
  '58': 384,
  '80': 576
};

const BATCH_SIZE = 256;
const DITHER_THRESHOLD = 128;
const WHITE_THRESHOLD = 250;
const DEFAULT_FEED_LINES = 2;
const DEFAULT_FEED_DOTS = 50;
const BLE_WRITE_DELAY_MS = 10;

const TOAST_TONES = {
  info: 'toast--info',
  success: 'toast--success',
  error: 'toast--error'
};

function App() {
  const [statusKey, setStatusKey] = useState('disconnected');
  const [deviceName, setDeviceName] = useState('Belum ada perangkat terdeteksi.');
  const [printWidth, setPrintWidth] = useState('80');
  const [isProgressVisible, setProgressVisible] = useState(false);
  const [isPreviewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [toastState, setToastState] = useState({ message: '', tone: 'info', visible: false, duration: 0 });

  const previewCanvasRef = useRef(null);
  const modalPreviewCanvasRef = useRef(null);
  const previewContextRef = useRef(null);
  const modalPreviewContextRef = useRef(null);
  const printDataCanvasRef = useRef(null);
  const printDataContextRef = useRef(null);
  const maxPrintWidthRef = useRef(WIDTH_TO_PIXELS[printWidth] || 384);

  const imageDataForPrintRef = useRef(null);
  const sourceCanvasForPrintRef = useRef(null);
  const printCharacteristicRef = useRef(null);
  const connectedDeviceRef = useRef(null);
  const transferDataRef = useRef(null);
  const transferIndexRef = useRef(0);
  const lastPdfBytesRef = useRef(null);
  const lastImageDataUrlRef = useRef(null);
  const canWriteWithoutResponseRef = useRef(false);
  const toastTimeoutRef = useRef(null);

  const status = useMemo(() => PRINTER_STATUS[statusKey] || PRINTER_STATUS.disconnected, [statusKey]);

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
  }, []);

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
    if (!toastState.visible && toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
  }, [toastState.visible]);


  const syncModalPreview = useCallback(() => {
    const modalCanvas = modalPreviewCanvasRef.current;
    const modalContext = modalPreviewContextRef.current;
    const previewCanvas = previewCanvasRef.current;
    const imageDataForPrint = imageDataForPrintRef.current;

    if (!modalCanvas || !modalContext) {
      return;
    }
    if (imageDataForPrint) {
      modalCanvas.width = imageDataForPrint.width;
      modalCanvas.height = imageDataForPrint.height;
      modalContext.putImageData(imageDataForPrint, 0, 0);
    } else if (previewCanvas) {
      modalCanvas.width = previewCanvas.width;
      modalCanvas.height = previewCanvas.height;
      modalContext.clearRect(0, 0, modalCanvas.width, modalCanvas.height);
      modalContext.drawImage(previewCanvas, 0, 0);
    }
  }, []);

  useEffect(() => {
    if (!isPreviewDialogOpen) {
      return;
    }
    syncModalPreview();
  }, [isPreviewDialogOpen]);

  const showProgress = useCallback(() => setProgressVisible(true), []);
  const hideProgress = useCallback(() => setProgressVisible(false), []);

  const showToast = useCallback((message, tone = 'info', duration = 4000) => {
    if (!message) {
      return;
    }
    setToastState({ message, tone, visible: true, duration });
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    if (duration > 0) {
      toastTimeoutRef.current = setTimeout(() => {
        setToastState(prev => ({ ...prev, visible: false }));
      }, duration);
    }
  }, []);

  const hideToast = useCallback(() => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    setToastState(prev => ({ ...prev, visible: false }));
  }, []);

  const setPrinterStatus = useCallback((key) => {
    const next = PRINTER_STATUS[key] ? key : 'disconnected';
    setStatusKey(next);
  }, []);

  const setPrinterDeviceName = useCallback((nameText) => {
    setDeviceName(nameText || 'Belum ada perangkat terdeteksi.');
  }, []);

  const handleError = useCallback((error, messageOverride) => {
    console.error(error);
    const message = messageOverride || error?.message || 'Terjadi kesalahan yang tidak diketahui.';
    setErrorMessage(message);
    hideProgress();
  }, [hideProgress]);

  const closeErrorDialog = useCallback(() => setErrorMessage(''), []);

  const handleDeviceDisconnect = useCallback(() => {
    printCharacteristicRef.current = null;
    connectedDeviceRef.current = null;
    setPrinterStatus('disconnected');
    setPrinterDeviceName('Belum ada perangkat terdeteksi.');
    showToast('Sambungan printer terputus.', 'error', 5000);
  }, [setPrinterDeviceName, setPrinterStatus, showToast]);

  const attachDisconnectHandler = useCallback((device) => {
    if (!device) {
      return;
    }
    device.addEventListener('gattserverdisconnected', handleDeviceDisconnect);
  }, [handleDeviceDisconnect]);

  const detachDisconnectHandler = useCallback((device) => {
    if (!device) {
      return;
    }
    device.removeEventListener('gattserverdisconnected', handleDeviceDisconnect);
  }, [handleDeviceDisconnect]);

  const disconnectDevice = useCallback((device) => {
    if (device?.gatt?.connected) {
      device.gatt.disconnect();
    }
  }, []);

  const connectToSelectedDevice = useCallback(async (device) => {
    if (!device) {
      throw new Error('Perangkat tidak ditemukan.');
    }
    setPrinterStatus('connecting');
    setPrinterDeviceName('Menyiapkan sambungan ke perangkat...');
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb');
    const characteristic = await service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb');

    if (connectedDeviceRef.current && connectedDeviceRef.current !== device) {
      detachDisconnectHandler(connectedDeviceRef.current);
      disconnectDevice(connectedDeviceRef.current);
    }

    connectedDeviceRef.current = device;
    attachDisconnectHandler(device);
    printCharacteristicRef.current = characteristic;
    canWriteWithoutResponseRef.current = !!(
      characteristic.properties?.writeWithoutResponse &&
      typeof characteristic.writeValueWithoutResponse === 'function'
    );

    setPrinterStatus('connected');
    setPrinterDeviceName(getPrinterDisplayName(device));
    return characteristic;
  }, [attachDisconnectHandler, detachDisconnectHandler, disconnectDevice, setPrinterDeviceName, setPrinterStatus]);

  const ensurePrinterConnection = useCallback(async (forceNewDevice = false) => {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth tidak didukung di browser ini.');
    }
    const currentCharacteristic = printCharacteristicRef.current;
    const currentDevice = connectedDeviceRef.current;
    if (!forceNewDevice && currentCharacteristic && currentDevice?.gatt?.connected) {
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(currentDevice));
      return currentCharacteristic;
    }

    const requestOptions = {
      filters: [
        { services: ['000018f0-0000-1000-8000-00805f9b34fb'] }
      ]
    };

    const selectDevice = async (device) => {
      const characteristic = await connectToSelectedDevice(device);
      return characteristic;
    };

    if (forceNewDevice || !currentDevice) {
      const device = await navigator.bluetooth.requestDevice(requestOptions);
      return selectDevice(device);
    }

    try {
      return await selectDevice(currentDevice);
    } catch (error) {
      const device = await navigator.bluetooth.requestDevice(requestOptions);
      return selectDevice(device);
    }
  }, [connectToSelectedDevice, setPrinterDeviceName, setPrinterStatus]);

  const preparePrintData = useCallback((sourceCanvas) => {
    if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) {
      imageDataForPrintRef.current = null;
      return;
    }
    const rawWidth = Math.min(maxPrintWidthRef.current, sourceCanvas.width);
    const widthMultiple = Math.max(1, Math.floor(rawWidth / 8));
    const targetWidth = widthMultiple * 8;
    const scale = targetWidth / sourceCanvas.width;
    const targetHeight = Math.max(8, Math.round(sourceCanvas.height * scale));

    const ctx = printDataContextRef.current;
    const canvas = printDataCanvasRef.current;
    if (!ctx || !canvas) {
      return;
    }
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);

    let preparedImageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    preparedImageData = trimImageMargins(preparedImageData);
    preparedImageData = scaleImageDataToWidth(preparedImageData, targetWidth);
    applyFloydSteinbergDither(preparedImageData);
    imageDataForPrintRef.current = preparedImageData;
  }, []);

  const copyCanvasToPreview = useCallback((sourceCanvas) => {
    if (!sourceCanvas) {
      return;
    }
    const cloned = document.createElement('canvas');
    cloned.width = sourceCanvas.width;
    cloned.height = sourceCanvas.height;
    const context = cloned.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.clearRect(0, 0, cloned.width, cloned.height);
    context.drawImage(sourceCanvas, 0, 0);
    sourceCanvasForPrintRef.current = cloned;

    preparePrintData(cloned);
    const previewCanvas = previewCanvasRef.current;
    const previewContext = previewContextRef.current;
    const imageDataForPrint = imageDataForPrintRef.current;

    if (!previewCanvas || !previewContext) {
      return;
    }

    if (imageDataForPrint) {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = imageDataForPrint.width;
      tempCanvas.height = imageDataForPrint.height;
      const tempContext = tempCanvas.getContext('2d');
      tempContext.putImageData(imageDataForPrint, 0, 0);

      const scale = Math.min(320 / imageDataForPrint.width, 1);
      const previewWidth = Math.max(8, Math.round(imageDataForPrint.width * scale));
      const previewHeight = Math.max(8, Math.round(imageDataForPrint.height * scale));

      previewCanvas.width = previewWidth;
      previewCanvas.height = previewHeight;
      previewContext.imageSmoothingEnabled = true;
      previewContext.clearRect(0, 0, previewWidth, previewHeight);
      previewContext.drawImage(tempCanvas, 0, 0, previewWidth, previewHeight);
    } else {
      previewCanvas.width = 240;
      previewCanvas.height = 240;
      previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }

    syncModalPreview();
  }, [preparePrintData, syncModalPreview]);

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

  const renderImageFromDataUrl = useCallback(async (dataUrl) => {
    if (!dataUrl) {
      throw new Error('Image data is empty.');
    }
    await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = image.width;
        tempCanvas.height = image.height;
        const tempContext = tempCanvas.getContext('2d');
        tempContext.drawImage(image, 0, 0);
        copyCanvasToPreview(tempCanvas);
        resolve();
      };
      image.onerror = () => reject(new Error('Gagal memuat gambar.'));
      image.src = dataUrl;
    });
  }, [copyCanvasToPreview]);

  const renderPdfPage = useCallback(async (page) => {
    const viewport = page.getViewport({ scale: 1 });
    const scale = maxPrintWidthRef.current / viewport.width;
    const scaledViewport = page.getViewport({ scale });
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.round(scaledViewport.width);
    tempCanvas.height = Math.round(scaledViewport.height);
    const ctx = tempCanvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    copyCanvasToPreview(tempCanvas);
  }, [copyCanvasToPreview]);

  const renderPdfData = useCallback(async (bytes) => {
    lastPdfBytesRef.current = bytes;
    lastImageDataUrlRef.current = null;
    const loadingTask = getDocument({ data: bytes });
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    await renderPdfPage(page);
  }, [renderPdfPage]);

  const reloadLastPdf = useCallback(async () => {
    if (!lastPdfBytesRef.current) {
      return;
    }
    showProgress();
    try {
      await renderPdfData(lastPdfBytesRef.current);
    } catch (error) {
      handleError(error);
    } finally {
      hideProgress();
    }
  }, [hideProgress, renderPdfData, handleError, showProgress]);

  const reloadLastImage = useCallback(async () => {
    if (!lastImageDataUrlRef.current) {
      return;
    }
    showProgress();
    try {
      await renderImageFromDataUrl(lastImageDataUrlRef.current);
    } catch (error) {
      handleError(error);
    } finally {
      hideProgress();
    }
  }, [hideProgress, handleError, renderImageFromDataUrl, showProgress]);

  const handleFileChange = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      hideToast();
      return;
    }
    const fileName = file.name || 'File';
    const { type } = file;
    showToast(`Memuat ${fileName}…`, 'info');
    if (type === 'application/pdf') {
      showProgress();
      const reader = new FileReader();
      reader.onload = async (loadEvent) => {
        try {
          const arrayBuffer = loadEvent.target.result;
          const bytes = new Uint8Array(arrayBuffer);
          await renderPdfData(bytes);
          hideProgress();
          lastPdfBytesRef.current = bytes;
          lastImageDataUrlRef.current = null;
          showToast(`${fileName} siap dipratinjau.`, 'success');
          event.target.value = '';
        } catch (error) {
          hideProgress();
          showToast(`Gagal memuat ${fileName}.`, 'error', 5000);
          handleError(error);
        }
      };
      reader.onerror = () => {
        hideProgress();
        showToast(`Gagal membaca ${fileName}.`, 'error', 5000);
        handleError(new Error('Failed to read the selected PDF file.'));
      };
      reader.readAsArrayBuffer(file);
      return;
    }
    if (type === 'image/png' || type === 'image/jpeg') {
      showProgress();
      const reader = new FileReader();
      reader.onload = async (loadEvent) => {
        try {
          const dataUrl = loadEvent.target.result;
          await renderImageFromDataUrl(dataUrl);
          hideProgress();
          lastImageDataUrlRef.current = dataUrl;
          lastPdfBytesRef.current = null;
          showToast(`${fileName} siap dipratinjau.`, 'success');
          event.target.value = '';
        } catch (error) {
          hideProgress();
          showToast(`Gagal memuat ${fileName}.`, 'error', 5000);
          handleError(error);
        }
      };
      reader.onerror = () => {
        hideProgress();
        showToast(`Gagal membaca ${fileName}.`, 'error', 5000);
        handleError(new Error('Failed to read the selected image file.'));
      };
      reader.readAsDataURL(file);
      return;
    }
    showToast('Format file tidak didukung. Pilih PDF, PNG, atau JPG.', 'error', 5000);
    handleError(new Error('Format file tidak didukung. Pilih PDF, PNG, atau JPG.'));
    event.target.value = '';
  }, [handleError, hideProgress, hideToast, renderImageFromDataUrl, renderPdfData, showProgress, showToast]);

  const handleSetupPrinter = useCallback(async () => {
    try {
      setPrinterStatus('connecting');
      setPrinterDeviceName('Menunggu pemilihan perangkat...');
      showProgress();
      await ensurePrinterConnection(true);
      hideProgress();
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(connectedDeviceRef.current));
      showToast('Printer berhasil tersambung.', 'success');
    } catch (error) {
      hideProgress();
      if (error?.name === 'NotFoundError') {
        setPrinterStatus('disconnected');
        setPrinterDeviceName('Belum ada perangkat terdeteksi.');
      } else {
        setPrinterStatus('error');
        setPrinterDeviceName('Gagal membaca perangkat.');
      }
      handleError(error);
    }
  }, [ensurePrinterConnection, getPrinterDisplayName, handleError, hideProgress, setPrinterDeviceName, setPrinterStatus, showProgress, showToast]);

  const handleDownloadPreview = useCallback(() => {
    if (!imageDataForPrintRef.current && !previewCanvasRef.current) {
      showToast('Load a PDF sebelum menyimpan pratinjau.', 'error');
      return;
    }
    const sourceCanvas =
      modalPreviewCanvasRef.current && modalPreviewCanvasRef.current.width
        ? modalPreviewCanvasRef.current
        : previewCanvasRef.current;
    if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) {
      return;
    }
    const link = document.createElement('a');
    link.href = sourceCanvas.toDataURL('image/png');
    link.download = `preview-${printWidth || 'unknown'}mm.png`;
    link.click();
  }, [printWidth, showToast]);

  const sendFeedDots = useCallback(async (dots) => {
    const characteristic = printCharacteristicRef.current;
    if (!characteristic) {
      return;
    }
    let remaining = Math.min(1020, Math.max(0, dots | 0));
    if (remaining === 0) {
      return;
    }
    while (remaining > 0) {
      const amount = Math.min(255, remaining);
      const command = new Uint8Array([0x1b, 0x4a, amount]);
      await characteristic.writeValue(command);
      remaining -= amount;
    }
  }, []);

  const sendFeedLines = useCallback(async (lines) => {
    const characteristic = printCharacteristicRef.current;
    if (!characteristic) {
      return;
    }
    const count = Math.min(255, Math.max(0, lines | 0));
    if (count === 0) {
      return;
    }
    const command = new Uint8Array([0x1b, 0x64, count]);
    await characteristic.writeValue(command);
  }, []);

  const writeChunk = useCallback(async (chunk) => {
    const characteristic = printCharacteristicRef.current;
    if (!characteristic) {
      throw new Error('Printer characteristic not available.');
    }
    const performWrite = async () => {
      if (!canWriteWithoutResponseRef.current) {
        await characteristic.writeValue(chunk);
        return;
      }
      try {
        const maybePromise = characteristic.writeValueWithoutResponse(chunk);
        if (maybePromise?.then) {
          await maybePromise;
        }
      } catch (error) {
        canWriteWithoutResponseRef.current = false;
        await characteristic.writeValue(chunk);
      }
    };
    await performWrite();
    if (BLE_WRITE_DELAY_MS > 0) {
      await delay(BLE_WRITE_DELAY_MS);
    }
  }, []);

  const sendImageData = useCallback(async () => {
    const transferData = getImagePrintData();
    transferDataRef.current = transferData;
    if (!transferData.length || transferData.length <= 8) {
      return;
    }
    transferIndexRef.current = 0;
    await new Promise((resolve, reject) => {
      const step = () => {
        const data = transferDataRef.current;
        const index = transferIndexRef.current;
        if (!data || index >= data.length) {
          resolve();
          return;
        }
        const end = Math.min(index + BATCH_SIZE, data.length);
        const chunk = data.slice(index, end);
        writeChunk(chunk)
          .then(() => {
            transferIndexRef.current = end;
            if (transferIndexRef.current < data.length) {
              step();
            } else {
              resolve();
            }
          })
          .catch(reject);
      };
      step();
    });
  }, [writeChunk]);

  const sendPrinterData = useCallback(async () => {
    await sendImageData();
    await sendFeedDots(DEFAULT_FEED_DOTS);
    await sendFeedLines(DEFAULT_FEED_LINES);
  }, [sendFeedDots, sendFeedLines, sendImageData]);

  const handlePrint = useCallback(async () => {
    if (!imageDataForPrintRef.current) {
      showToast('Load a PDF sebelum mencetak.', 'error');
      return;
    }
    const device = connectedDeviceRef.current;
    const needsConnection = !device?.gatt?.connected || !printCharacteristicRef.current;
    if (needsConnection) {
      setPrinterStatus('connecting');
      setPrinterDeviceName('Menyiapkan sambungan ke perangkat...');
    }
    showProgress();
    try {
      await ensurePrinterConnection();
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(connectedDeviceRef.current));
      await sendPrinterData();
      showToast('Data berhasil dikirim ke printer.', 'success');
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        setPrinterStatus('disconnected');
        setPrinterDeviceName('Belum ada perangkat terdeteksi.');
      } else {
        setPrinterStatus('error');
        setPrinterDeviceName('Gagal membaca perangkat.');
      }
      handleError(error);
    } finally {
      hideProgress();
    }
  }, [ensurePrinterConnection, getPrinterDisplayName, handleError, hideProgress, sendPrinterData, setPrinterDeviceName, setPrinterStatus, showProgress, showToast]);

  const getImagePrintData = useCallback(() => {
    const imageData = imageDataForPrintRef.current;
    if (!imageData) {
      return new Uint8Array([]);
    }
    const { width, height, data } = imageData;
    const bytesPerRow = width / 8;
    const total = bytesPerRow * height;
    const printBytes = new Uint8Array(total + 8);
    printBytes[0] = 29;
    printBytes[1] = 118;
    printBytes[2] = 48;
    printBytes[3] = 0;
    printBytes[4] = bytesPerRow;
    printBytes[5] = 0;
    printBytes[6] = height % 256;
    printBytes[7] = Math.floor(height / 256);

    let offset = 7;
    for (let y = 0; y < height; y++) {
      for (let xByte = 0; xByte < bytesPerRow; xByte++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = xByte * 8 + bit;
          const idx = (y * width + x) * 4;
          const red = data[idx];
          const green = data[idx + 1];
          const blue = data[idx + 2];
          const alpha = data[idx + 3];
          if (alpha === 0) {
            continue;
          }
          const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
          if (luminance < DITHER_THRESHOLD) {
            byte |= 1 << (7 - bit);
          }
        }
        printBytes[++offset] = byte;
      }
    }
    return printBytes;
  }, []);

  return (
    <div className="relative min-h-screen bg-muted/40">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-6 py-6 lg:px-10">
        <header className="flex flex-col gap-3 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-muted-foreground">Web Bluetooth</p>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground lg:text-[28px]">Bluetooth Printer</h1>
          </div>
          <button
            type="button"
            onClick={handleSetupPrinter}
            className="group relative mt-2 inline-flex items-center gap-2 rounded-full border border-border bg-card/90 px-3.5 py-2 text-sm font-medium text-foreground shadow-sm transition hover:border-primary/60 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:mt-0"
          >
            <span className={`h-2.5 w-2.5 rounded-full shadow-sm ${status.dotClass}`} />
            <span className="text-sm font-semibold tracking-tight text-foreground">{status.label}</span>
            <svg className="h-3 w-3 text-muted-foreground transition group-hover:text-primary" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.25 3.75 9.75 7l-3.5 3.25" />
            </svg>
            <div className="pointer-events-none absolute right-0 top-full z-10 mt-2 hidden min-w-[220px] rounded-xl border border-border bg-popover/95 px-3.5 py-2.5 text-left text-[0.75rem] text-muted-foreground shadow-xl group-hover:flex">
              <div className="flex flex-col">
                <span className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Perangkat Aktif</span>
                <span className="mt-1 text-sm font-medium text-foreground">{deviceName}</span>
              </div>
            </div>
          </button>
        </header>

        <main className="app-grid flex flex-col gap-8">
          <div className="order-1 flex flex-col gap-6 app-grid__sidebar">
            <article className="rounded-2xl border border-border bg-card shadow-sm">
              <div className="border-b border-border px-6 py-4">
                <h2 className="text-base font-semibold text-foreground">Pengaturan Cetak</h2>
              </div>
              <div className="space-y-5 px-6 py-6">
                <label htmlFor="printWidth" className="flex flex-col gap-2 text-sm font-medium text-foreground">
                  Paper Width
                  <select
                    id="printWidth"
                    value={printWidth}
                    onChange={(event) => setPrintWidth(event.target.value)}
                    className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="80">80 mm</option>
                    <option value="58">58 mm</option>
                  </select>
                </label>
                <label htmlFor="fileInput" className="flex flex-col gap-2 text-sm font-medium text-foreground">
                  Upload PDF atau Gambar
                  <input
                    type="file"
                    id="fileInput"
                    accept="application/pdf,image/png,image/jpeg"
                    onChange={handleFileChange}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground shadow-sm file:mr-4 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  <span className="text-xs font-normal text-muted-foreground">Pilih PDF, PNG, atau JPG. File akan dikonversi ke bitmap hitam-putih sebelum dicetak.</span>
                </label>
              </div>
            </article>
            <article className="rounded-2xl border border-border bg-card shadow-sm">
              <div className="border-b border-border px-6 py-4">
                <h2 className="text-base font-semibold text-foreground">Aksi</h2>
                <p className="mt-1 text-sm text-muted-foreground">Setelah setup selesai, gunakan tombol berikut untuk pratinjau dan mencetak.</p>
              </div>
              <div className="grid gap-3 px-6 py-6">
                <button
                  type="button"
                  onClick={showPreviewDialog}
                  className="inline-flex h-11 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Preview Print
                </button>
                <button
                  type="button"
                  onClick={handlePrint}
                  className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold uppercase tracking-[0.12em] text-primary-foreground shadow-md transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Print
                </button>
              </div>
            </article>
          </div>

          <article className="order-2 rounded-2xl border border-border bg-card shadow-sm app-grid__preview relative pb-16">
            <div className="border-b border-border px-6 py-4">
              <h2 className="text-lg font-semibold text-foreground">Print Preview</h2>
              <p className="mt-1 text-sm text-muted-foreground">Pratinjau hasil cetak monokrom yang sudah dihaluskan untuk lebar kertas yang dipilih.</p>
            </div>
            <div className="flex min-h-[320px] items-center justify-center px-6 pt-10 pb-14">
              <canvas
                ref={previewCanvasRef}
                width="240"
                height="240"
                className="aspect-square w-full max-w-xs rounded-xl border border-dashed border-border bg-background/50 shadow-inner"
              />
            </div>
            <div className="border-t border-border bg-muted/50 px-6 py-3 text-xs text-muted-foreground absolute bottom-0 left-0 right-0 rounded-b-2xl">
              Klik “Preview Print” untuk memuat ulang tampilan setelah mengunggah PDF.
            </div>
          </article>

          <article className="order-4 rounded-2xl border border-border bg-card shadow-sm app-grid__info">
            <div className="border-b border-border px-6 py-4">
              <h2 className="text-lg font-semibold text-foreground">Informasi Printer</h2>
            </div>
            <dl className="grid gap-4 px-6 py-6 text-sm text-muted-foreground lg:grid-cols-2">
              <div>
                <dt className="font-medium text-foreground">Konektivitas</dt>
                <dd>Bluetooth Low Energy (ESC/POS).</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Format</dt>
                <dd>Kanvas hitam-putih dengan dithering Floyd-Steinberg.</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Ukuran Maksimal</dt>
                <dd>576px (80 mm) atau 384px (58 mm).</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Browser</dt>
                <dd>Pastikan Web Bluetooth tersedia (Chrome/Edge).</dd>
              </div>
            </dl>
          </article>
        </main>

        {isProgressVisible && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-card px-6 py-5 shadow-xl">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-muted-foreground/30 border-t-primary" />
              <p className="text-sm font-medium text-muted-foreground">Memproses data…</p>
            </div>
          </div>
        )}

        <div
          className={`toast ${toastState.visible ? 'toast--visible' : ''} ${TOAST_TONES[toastState.tone] ?? ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          onClick={hideToast}
        >
          {toastState.message}
        </div>

        {errorMessage && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="dialog-panel w-full max-w-md">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Terjadi Kesalahan</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{errorMessage}</p>
                </div>
                <button
                  type="button"
                  onClick={closeErrorDialog}
                  className="ml-6 inline-flex h-9 w-9 items-center justify-center rounded-full border border-input text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="sr-only">Tutup</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeErrorDialog}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Mengerti
                </button>
              </div>
            </div>
          </div>
        )}

        {isPreviewDialogOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="dialog-panel w-full max-w-2xl">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">Print Preview</h2>
                  <p className="mt-2 text-sm text-muted-foreground">Gambar berikut sudah siap dikirim ke printer.</p>
                </div>
                <button
                  type="button"
                  onClick={closePreviewDialog}
                  className="ml-6 inline-flex h-9 w-9 items-center justify-center rounded-full border border-input text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="sr-only">Tutup</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="mt-6 flex items-center justify-center rounded-xl border border-dashed border-border bg-muted/50 p-6">
                <canvas
                  ref={modalPreviewCanvasRef}
                  width="240"
                  height="240"
                  className="aspect-square w-full max-w-sm rounded-lg border border-border bg-background shadow-inner"
                />
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleDownloadPreview}
                  className="inline-flex h-10 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Simpan sebagai PNG
                </button>
                <button
                  type="button"
                  onClick={closePreviewDialog}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Tutup
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function applyFloydSteinbergDither(imageData) {
  const { data, width, height } = imageData;
  const errorBuffer = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const dataIdx = idx * 4;
      const red = data[dataIdx];
      const green = data[dataIdx + 1];
      const blue = data[dataIdx + 2];
      const baseGray = 0.299 * red + 0.587 * green + 0.114 * blue;
      const adjustedGray = baseGray + errorBuffer[idx];
      const output = adjustedGray >= DITHER_THRESHOLD ? 255 : 0;
      const error = adjustedGray - output;

      data[dataIdx] = output;
      data[dataIdx + 1] = output;
      data[dataIdx + 2] = output;
      data[dataIdx + 3] = 255;

      if (x + 1 < width) {
        errorBuffer[idx + 1] += (error * 7) / 16;
      }
      if (y + 1 < height) {
        if (x > 0) {
          errorBuffer[idx + width - 1] += (error * 3) / 16;
        }
        errorBuffer[idx + width] += (error * 5) / 16;
        if (x + 1 < width) {
          errorBuffer[idx + width + 1] += (error * 1) / 16;
        }
      }
    }
  }
}

function trimImageMargins(sourceImageData) {
  if (!sourceImageData) {
    return null;
  }
  const { data, width, height } = sourceImageData;
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  const pixelIsWhite = (index) => {
    const alpha = data[index + 3];
    if (alpha <= 10) {
      return true;
    }
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
    return luminance >= WHITE_THRESHOLD;
  };

  const rowIsWhite = (y) => {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (!pixelIsWhite((rowOffset + x) * 4)) {
        return false;
      }
    }
    return true;
  };

  const columnIsWhite = (x, startY, endY) => {
    if (startY > endY) {
      return true;
    }
    for (let y = startY; y <= endY; y++) {
      if (!pixelIsWhite((y * width + x) * 4)) {
        return false;
      }
    }
    return true;
  };

  while (top < height && rowIsWhite(top)) {
    top++;
  }
  while (bottom >= top && rowIsWhite(bottom)) {
    bottom--;
  }
  while (left < width && columnIsWhite(left, top, bottom)) {
    left++;
  }
  while (right >= left && columnIsWhite(right, top, bottom)) {
    right--;
  }

  if (top > bottom || left > right) {
    return sourceImageData;
  }

  let trimWidth = right - left + 1;
  const trimHeight = bottom - top + 1;
  const remainder = trimWidth % 8;
  if (remainder !== 0) {
    const extra = 8 - remainder;
    const extraLeft = Math.floor(extra / 2);
    const extraRight = extra - extraLeft;
    left = Math.max(0, left - extraLeft);
    right = Math.min(width - 1, right + extraRight);
    trimWidth = right - left + 1;
    if (trimWidth % 8 !== 0) {
      const targetWidth = Math.min(width, Math.ceil(trimWidth / 8) * 8);
      right = Math.min(width - 1, left + targetWidth - 1);
      trimWidth = right - left + 1;
      if (trimWidth % 8 !== 0) {
        left = Math.max(0, right - targetWidth + 1);
        trimWidth = right - left + 1;
      }
    }
  }

  const trimmedCanvas = document.createElement('canvas');
  trimmedCanvas.width = trimWidth;
  trimmedCanvas.height = trimHeight;
  const ctx = trimmedCanvas.getContext('2d');
  ctx.putImageData(sourceImageData, -left, -top);
  return ctx.getImageData(0, 0, trimWidth, trimHeight);
}

function scaleImageDataToWidth(imageData, targetWidth) {
  if (!imageData) {
    return null;
  }
  if (imageData.width === targetWidth) {
    return imageData;
  }
  const scale = targetWidth / imageData.width;
  const scaledWidth = Math.min(targetWidth, Math.round(imageData.width * scale));
  const scaledHeight = Math.max(8, Math.round(imageData.height * scale));
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = imageData.width;
  sourceCanvas.height = imageData.height;
  const sourceCtx = sourceCanvas.getContext('2d');
  sourceCtx.putImageData(imageData, 0, 0);

  const scaledCanvas = document.createElement('canvas');
  scaledCanvas.width = targetWidth;
  scaledCanvas.height = scaledHeight;
  const scaledCtx = scaledCanvas.getContext('2d');
  scaledCtx.imageSmoothingEnabled = true;
  scaledCtx.fillStyle = '#ffffff';
  scaledCtx.fillRect(0, 0, scaledCanvas.width, scaledCanvas.height);
  const offsetX = Math.floor((targetWidth - scaledWidth) / 2);
  scaledCtx.drawImage(
    sourceCanvas,
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
    offsetX,
    0,
    scaledWidth,
    scaledHeight
  );

  return scaledCtx.getImageData(0, 0, scaledCanvas.width, scaledCanvas.height);
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getPrinterDisplayName(device) {
  if (!device) {
    return 'Belum ada perangkat terdeteksi.';
  }
  if (device.name && device.name.trim()) {
    return device.name;
  }
  return 'Nama perangkat tidak tersedia.';
}

export default App;
