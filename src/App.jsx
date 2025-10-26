import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
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

const BLE_CHUNK_SIZE_WITH_RESPONSE = 256;
const BLE_CHUNK_SIZE_WITHOUT_RESPONSE = 120;
const DITHER_THRESHOLD = 112;
const WHITE_THRESHOLD = 250;
const DEFAULT_FEED_LINES = 2;
const DEFAULT_FEED_DOTS = 50;
const BLE_WRITE_DELAY_WITH_RESPONSE_MS = 10;
const BLE_WRITE_DELAY_WITHOUT_RESPONSE_MS = 30;

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
  const printCharacteristicRef = useRef(null);
  const connectedDeviceRef = useRef(null);
  const transferDataRef = useRef(null);
  const transferIndexRef = useRef(0);
  const lastPdfBytesRef = useRef(null);
  const lastImageDataUrlRef = useRef(null);
  const canWriteWithoutResponseRef = useRef(false);
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

  const syncModalPreview = useCallback(() => {
    const modalCanvas = modalPreviewCanvasRef.current;
    if (!modalCanvas) {
      return;
    }
    let modalContext = modalPreviewContextRef.current;
    if (!modalContext || modalContext.canvas !== modalCanvas) {
      modalContext = modalCanvas.getContext('2d');
      modalPreviewContextRef.current = modalContext;
    }
    const previewCanvas = previewCanvasRef.current;
    const imageDataForPrint = imageDataForPrintRef.current;
    const sourceCanvas = sourceCanvasForPrintRef.current;

    if (!modalContext) {
      return;
    }
    if (imageDataForPrint) {
      modalCanvas.width = imageDataForPrint.width;
      modalCanvas.height = imageDataForPrint.height;
      modalContext.putImageData(imageDataForPrint, 0, 0);
    } else if (sourceCanvas && sourceCanvas.width && sourceCanvas.height) {
      modalCanvas.width = sourceCanvas.width;
      modalCanvas.height = sourceCanvas.height;
      modalContext.clearRect(0, 0, modalCanvas.width, modalCanvas.height);
      modalContext.drawImage(sourceCanvas, 0, 0);
    } else if (previewCanvas && previewCanvas.width && previewCanvas.height) {
      modalCanvas.width = previewCanvas.width;
      modalCanvas.height = previewCanvas.height;
      modalContext.clearRect(0, 0, modalCanvas.width, modalCanvas.height);
      modalContext.drawImage(previewCanvas, 0, 0);
    }
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
    if (!previewCanvas) {
      return;
    }
    let previewContext = previewContextRef.current;
    if (!previewContext || previewContext.canvas !== previewCanvas) {
      previewContext = previewCanvas.getContext('2d');
      previewContextRef.current = previewContext;
    }
    const imageDataForPrint = imageDataForPrintRef.current;
    if (!previewContext) {
      return;
    }
    const modalCanvas = modalPreviewCanvasRef.current;
    if (modalCanvas) {
      let modalContext = modalPreviewContextRef.current;
      if (!modalContext || modalContext.canvas !== modalCanvas) {
        modalContext = modalCanvas.getContext('2d');
        modalPreviewContextRef.current = modalContext;
      }
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
      image.onerror = () => reject(new Error('Failed to load image.'));
      image.src = dataUrl;
    });
  }, [copyCanvasToPreview]);

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

  const hideToast = useCallback(() => {
    if (!lastToastIdRef.current) {
      return;
    }
    dismiss(lastToastIdRef.current);
    lastToastIdRef.current = null;
  }, [dismiss]);

  const setPrinterStatus = useCallback((key) => {
    const next = PRINTER_STATUS[key] ? key : 'disconnected';
    setStatusKey(next);
  }, []);

  const setPrinterDeviceName = useCallback((nameText) => {
    setDeviceName(nameText || 'No device detected.');
  }, []);

  const closeErrorDialog = useCallback(() => setErrorMessage(''), []);

  const handleDeviceDisconnect = useCallback(() => {
    printCharacteristicRef.current = null;
    connectedDeviceRef.current = null;
    setPrinterStatus('disconnected');
    setPrinterDeviceName('No device detected.');
    showToast('Printer connection lost.', 'error', 5000);
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
      throw new Error('Device not found.');
    }
    setPrinterStatus('connecting');
    setPrinterDeviceName('Preparing device connection...');
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
      throw new Error('Web Bluetooth is not supported in this browser.');
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
    showToast(`Loading ${fileName}…`, 'info');
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
          showToast(`${fileName} is ready to preview.`, 'success');
          event.target.value = '';
        } catch (error) {
          hideProgress();
          showToast(`Failed to load ${fileName}.`, 'error', 5000);
          handleError(error);
        }
      };
      reader.onerror = () => {
        hideProgress();
        showToast(`Failed to read ${fileName}.`, 'error', 5000);
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
          showToast(`${fileName} is ready to preview.`, 'success');
          event.target.value = '';
        } catch (error) {
          hideProgress();
          showToast(`Failed to load ${fileName}.`, 'error', 5000);
          handleError(error);
        }
      };
      reader.onerror = () => {
        hideProgress();
        showToast(`Failed to read ${fileName}.`, 'error', 5000);
        handleError(new Error('Failed to read the selected image file.'));
      };
      reader.readAsDataURL(file);
      return;
    }
    showToast('Unsupported file format. Choose a PDF, PNG, or JPG.', 'error', 5000);
    handleError(new Error('Unsupported file format. Choose a PDF, PNG, or JPG.'));
    event.target.value = '';
  }, [handleError, hideProgress, hideToast, renderImageFromDataUrl, renderPdfData, showProgress, showToast]);

  const handleSetupPrinter = useCallback(async () => {
    try {
      setPrinterStatus('connecting');
      setPrinterDeviceName('Waiting for device selection...');
      showProgress();
      await ensurePrinterConnection(true);
      hideProgress();
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(connectedDeviceRef.current));
      showToast('Printer connected successfully.', 'success');
    } catch (error) {
      hideProgress();
      if (error?.name === 'NotFoundError') {
        setPrinterStatus('disconnected');
        setPrinterDeviceName('No device detected.');
      } else {
        setPrinterStatus('error');
        setPrinterDeviceName('Failed to read device.');
      }
      handleError(error);
    }
  }, [ensurePrinterConnection, getPrinterDisplayName, handleError, hideProgress, setPrinterDeviceName, setPrinterStatus, showProgress, showToast]);

  const handleDownloadPreview = useCallback(() => {
    if (!imageDataForPrintRef.current && !previewCanvasRef.current) {
      showToast('Load a PDF before saving the preview.', 'error');
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
    const valueView = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const bufferSlice =
      valueView.byteOffset === 0 && valueView.byteLength === valueView.buffer.byteLength
        ? valueView.buffer
        : valueView.buffer.slice(valueView.byteOffset, valueView.byteOffset + valueView.byteLength);
    const performWrite = async () => {
      if (!canWriteWithoutResponseRef.current) {
        await characteristic.writeValue(valueView);
        return;
      }
      try {
        const maybePromise = characteristic.writeValueWithoutResponse(bufferSlice);
        if (maybePromise?.then) {
          await maybePromise;
        }
      } catch (error) {
        canWriteWithoutResponseRef.current = false;
        await characteristic.writeValue(valueView);
      }
    };
    await performWrite();
    const delayMs = canWriteWithoutResponseRef.current
      ? BLE_WRITE_DELAY_WITHOUT_RESPONSE_MS
      : BLE_WRITE_DELAY_WITH_RESPONSE_MS;
    if (delayMs > 0) {
      await delay(delayMs);
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
        const chunkSize = canWriteWithoutResponseRef.current
          ? BLE_CHUNK_SIZE_WITHOUT_RESPONSE
          : BLE_CHUNK_SIZE_WITH_RESPONSE;
        const end = Math.min(index + chunkSize, data.length);
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
      showToast('Load a PDF before printing.', 'error');
      return;
    }
    const device = connectedDeviceRef.current;
    const needsConnection = !device?.gatt?.connected || !printCharacteristicRef.current;
    if (needsConnection) {
      setPrinterStatus('connecting');
      setPrinterDeviceName('Preparing device connection...');
    }
    showProgress();
    try {
      await ensurePrinterConnection();
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(connectedDeviceRef.current));
      await sendPrinterData();
      showToast('Data sent to the printer successfully.', 'success');
    } catch (error) {
      if (error?.name === 'NotFoundError') {
        setPrinterStatus('disconnected');
        setPrinterDeviceName('No device detected.');
      } else {
        setPrinterStatus('error');
        setPrinterDeviceName('Failed to read device.');
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
          <div className="order-1 app-grid__sidebar flex flex-col gap-6">
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

          <Card className="order-2 rounded-2xl border-border shadow-sm app-grid__preview">
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
