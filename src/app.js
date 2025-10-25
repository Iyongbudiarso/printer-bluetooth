'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const progress = document.querySelector('#progress');
  const dialog = document.querySelector('#dialog');
  const dialogMessage = document.querySelector('#dialogMessage');
  const previewDialog = document.querySelector('#previewDialog');
  const fileInput = document.querySelector('#fileInput');
  const toast = document.querySelector('#toast');
  const printWidthSelect = document.querySelector('#printWidth');
  const setupButton = document.querySelector('#setupPrinter');
  const previewButton = document.querySelector('#previewButton');
  const printButton = document.querySelector('#print');
  const previewCanvas = document.querySelector('#previewCanvas');
  const previewContext = previewCanvas.getContext('2d');
  const modalPreviewCanvas = document.querySelector('#modalPreviewCanvas');
  const modalPreviewContext = modalPreviewCanvas.getContext('2d');
  const closeErrorButton = document.querySelector('#closeError');
  const dismissErrorButton = document.querySelector('#dismissError');
  const closePreviewButton = document.querySelector('#closePreview');
  const confirmPreviewClose = document.querySelector('#confirmPreviewClose');
  const downloadPreviewButton = document.querySelector('#downloadPreview');
  const printerStatusLabel = document.querySelector('#printerStatusLabel');
  const printerStatusDot = document.querySelector('#printerStatusDot');
  const printerStatusDevice = document.querySelector('#printerStatusDevice');
  const showProgress = () => {
    if (progress) {
      progress.hidden = false;
    }
  };
  const hideProgress = () => {
    if (progress) {
      progress.hidden = true;
    }
  };

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

  function getPrinterDisplayName(device) {
    if (!device) {
      return 'Belum ada perangkat terdeteksi.';
    }
    if (device.name && device.name.trim()) {
      return device.name;
    }
    return 'Nama perangkat tidak tersedia.';
  }

  function setPrinterStatus(statusKey) {
    if (!printerStatusLabel || !printerStatusDot) {
      return;
    }
    const state = PRINTER_STATUS[statusKey] || PRINTER_STATUS.disconnected;
    printerStatusLabel.textContent = state.label;
    printerStatusDot.className = `h-2.5 w-2.5 rounded-full shadow-sm ${state.dotClass}`;
  }

  function setPrinterDeviceName(nameText) {
    if (printerStatusDevice) {
      printerStatusDevice.textContent = nameText;
    }
  }

  setPrinterStatus('disconnected');
  setPrinterDeviceName('Belum ada perangkat terdeteksi.');

  const printDataCanvas = document.createElement('canvas');
  const printDataContext = printDataCanvas.getContext('2d');
  const WIDTH_TO_PIXELS = {
    '58': 384,
    '80': 576
  };
  let maxPrintWidth = WIDTH_TO_PIXELS[printWidthSelect.value] || 384;
  const BATCH_SIZE = 256;
  const DITHER_THRESHOLD = 128;
  const WHITE_THRESHOLD = 250;
  const DEFAULT_FEED_LINES = 2;
  const DEFAULT_FEED_DOTS = 50;
  const TOAST_TONE_CLASSES = {
    info: 'toast--info',
    success: 'toast--success',
    error: 'toast--error'
  };
  let toastHideTimeout = null;
  const BLE_WRITE_DELAY_MS = 10;

  let imageDataForPrint = null;
  let printCharacteristic = null;
  let connectedDevice = null;
  let transferData = null;
  let transferIndex = 0;
  let sourceCanvasForPrint = null;
  let lastPdfBytes = null;
  let lastImageDataUrl = null;
  let canWriteWithoutResponse = false;

  hideProgress();

  function hideToast() {
    if (!toast) {
      return;
    }
    if (toastHideTimeout) {
      window.clearTimeout(toastHideTimeout);
      toastHideTimeout = null;
    }
    toast.textContent = '';
    toast.classList.remove('toast--visible');
    toast.classList.remove(...Object.values(TOAST_TONE_CLASSES));
  }

  function showToast(messageText, tone = 'info', duration = 4000) {
    if (!toast || !messageText) {
      return;
    }
    const toneClass = TOAST_TONE_CLASSES[tone] || TOAST_TONE_CLASSES.info;
    toast.textContent = messageText;
    toast.classList.remove(...Object.values(TOAST_TONE_CLASSES));
    toast.classList.add(toneClass);
    toast.classList.add('toast--visible');
    if (toastHideTimeout) {
      window.clearTimeout(toastHideTimeout);
    }
    if (duration > 0) {
      toastHideTimeout = window.setTimeout(() => {
        hideToast();
      }, duration);
    }
  }

  function delay(ms) {
    return new Promise(resolve => {
      window.setTimeout(resolve, ms);
    });
  }

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.10.111/pdf.worker.min.js';
  }

  function syncModalPreview() {
    if (imageDataForPrint) {
      modalPreviewCanvas.width = imageDataForPrint.width;
      modalPreviewCanvas.height = imageDataForPrint.height;
      modalPreviewContext.putImageData(imageDataForPrint, 0, 0);
    } else {
      modalPreviewCanvas.width = previewCanvas.width;
      modalPreviewCanvas.height = previewCanvas.height;
      modalPreviewContext.clearRect(0, 0, modalPreviewCanvas.width, modalPreviewCanvas.height);
      modalPreviewContext.drawImage(previewCanvas, 0, 0);
    }
  }

  function closePreviewDialog() {
    if (!previewDialog) {
      return;
    }
    if (typeof previewDialog.close === 'function') {
      if (previewDialog.open) {
        previewDialog.close();
      }
    } else {
      previewDialog.removeAttribute('open');
    }
  }

  if (closePreviewButton) {
    closePreviewButton.addEventListener('click', closePreviewDialog);
  }
  if (confirmPreviewClose) {
    confirmPreviewClose.addEventListener('click', closePreviewDialog);
  }
  if (previewDialog) {
    previewDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closePreviewDialog();
    });
  }

  function preparePrintData(sourceCanvas) {
    if (!sourceCanvas.width || !sourceCanvas.height) {
      imageDataForPrint = null;
      return;
    }
    const rawWidth = Math.min(maxPrintWidth, sourceCanvas.width);
    const widthMultiple = Math.max(1, Math.floor(rawWidth / 8));
    const targetWidth = widthMultiple * 8;
    const scale = targetWidth / sourceCanvas.width;
    const targetHeight = Math.max(8, Math.round(sourceCanvas.height * scale));

    printDataCanvas.width = targetWidth;
    printDataCanvas.height = targetHeight;
    printDataContext.imageSmoothingEnabled = true;
    printDataContext.clearRect(0, 0, targetWidth, targetHeight);
    printDataContext.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
    let preparedImageData = printDataContext.getImageData(0, 0, targetWidth, targetHeight);
    preparedImageData = trimImageMargins(preparedImageData);
    preparedImageData = scaleImageDataToWidth(preparedImageData, targetWidth);
    applyFloydSteinbergDither(preparedImageData);
    imageDataForPrint = preparedImageData;
  }

  function copyCanvasToPreview(sourceCanvas) {
    sourceCanvasForPrint = document.createElement('canvas');
    sourceCanvasForPrint.width = sourceCanvas.width;
    sourceCanvasForPrint.height = sourceCanvas.height;
    const srcContext = sourceCanvasForPrint.getContext('2d');
    srcContext.imageSmoothingEnabled = true;
    srcContext.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    srcContext.drawImage(sourceCanvas, 0, 0);

    preparePrintData(sourceCanvasForPrint);

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
          errorBuffer[idx + 1] += error * (7 / 16);
        }
        if (y + 1 < height) {
          if (x > 0) {
            errorBuffer[idx + width - 1] += error * (3 / 16);
          }
          errorBuffer[idx + width] += error * (5 / 16);
          if (x + 1 < width) {
            errorBuffer[idx + width + 1] += error * (1 / 16);
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

    function pixelIsWhite(index) {
      const alpha = data[index + 3];
      if (alpha <= 10) {
        return true;
      }
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      return luminance >= WHITE_THRESHOLD;
    }

    function rowIsWhite(y) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        if (!pixelIsWhite((rowOffset + x) * 4)) {
          return false;
        }
      }
      return true;
    }

    function columnIsWhite(x, startY, endY) {
      if (startY > endY) {
        return true;
      }
      for (let y = startY; y <= endY; y++) {
        if (!pixelIsWhite((y * width + x) * 4)) {
          return false;
        }
      }
      return true;
    }

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

  function showError(messageText) {
    hideProgress();
    if (messageText) {
      dialogMessage.textContent = messageText;
    }
    if (dialog) {
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) {
          dialog.showModal();
        }
      } else {
        dialog.setAttribute('open', '');
      }
    } else if (dialogMessage) {
      window.alert(dialogMessage.textContent);
    }
  }

  function closeErrorDialog() {
    if (!dialog) {
      return;
    }
    if (typeof dialog.close === 'function') {
      if (dialog.open) {
        dialog.close();
      }
    } else {
      dialog.removeAttribute('open');
    }
  }

  if (closeErrorButton) {
    closeErrorButton.addEventListener('click', closeErrorDialog);
  }
  if (dismissErrorButton) {
    dismissErrorButton.addEventListener('click', closeErrorDialog);
  }
  if (dialog) {
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeErrorDialog();
    });
  }

  function handleError(error) {
    console.error(error);
    if (error && error.name === 'NotFoundError') {
      hideProgress();
      return;
    }
    const text = error && error.message ? error.message : 'Unexpected error.';
    showError(text);
    disconnectCurrentPrinter();
  }

  function removeDisconnectHandler(device) {
    if (device && device._disconnectListener) {
      device.removeEventListener('gattserverdisconnected', device._disconnectListener);
      delete device._disconnectListener;
    }
  }

  function attachDisconnectHandler(device) {
    if (!device) {
      return;
    }
    removeDisconnectHandler(device);
    const handler = () => {
      if (connectedDevice === device) {
        disconnectCurrentPrinter();
      }
    };
    device._disconnectListener = handler;
    device.addEventListener('gattserverdisconnected', handler);
  }

  function disconnectCurrentPrinter() {
    if (connectedDevice) {
      removeDisconnectHandler(connectedDevice);
      try {
        if (connectedDevice.gatt && connectedDevice.gatt.connected) {
          connectedDevice.gatt.disconnect();
        }
      } catch (disconnectError) {
        console.warn('Failed to disconnect printer', disconnectError);
      }
    }
    connectedDevice = null;
    printCharacteristic = null;
    canWriteWithoutResponse = false;
    setPrinterStatus('disconnected');
    setPrinterDeviceName('Belum ada perangkat terdeteksi.');
  }

  function connectToSelectedDevice(device) {
    if (!device) {
      return Promise.reject(new Error('No printer selected.'));
    }
    setPrinterStatus('connecting');
    setPrinterDeviceName('Menunggu pemilihan perangkat...');
    return device.gatt.connect()
    .then(server => server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb'))
    .then(service => service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb'))
    .then(characteristic => {
      if (connectedDevice && connectedDevice !== device) {
        disconnectCurrentPrinter();
      }
      connectedDevice = device;
      attachDisconnectHandler(device);
      printCharacteristic = characteristic;
      canWriteWithoutResponse = !!(characteristic.properties && characteristic.properties.writeWithoutResponse && typeof characteristic.writeValueWithoutResponse === 'function');
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(device));
      return characteristic;
    });
  }

  function ensurePrinterConnection(forceNewDevice = false) {
    if (!navigator.bluetooth) {
      return Promise.reject(new Error('Web Bluetooth is not supported in this browser.'));
    }
    if (!forceNewDevice && printCharacteristic && connectedDevice && connectedDevice.gatt && connectedDevice.gatt.connected) {
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(connectedDevice));
      return Promise.resolve(printCharacteristic);
    }
    const requestOptions = {
      filters: [{
        services: ['000018f0-0000-1000-8000-00805f9b34fb']
      }]
    };

    const connectFlow = device => connectToSelectedDevice(device);

    if (forceNewDevice || !connectedDevice) {
      return navigator.bluetooth.requestDevice(requestOptions).then(connectFlow);
    }

    return connectFlow(connectedDevice)
    .catch(() => navigator.bluetooth.requestDevice(requestOptions).then(connectFlow));
  }

  function getImagePrintData() {
    if (!imageDataForPrint) {
      return new Uint8Array([]);
    }
    const { width, height, data } = imageDataForPrint;
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
            byte |= (1 << (7 - bit));
          }
        }
        printBytes[++offset] = byte;
      }
    }
    return printBytes;
  }

  function sendNextImageDataBatch(resolve, reject) {
    if (!transferData || transferIndex >= transferData.length) {
      resolve();
      return;
    }
    const end = Math.min(transferIndex + BATCH_SIZE, transferData.length);
    const chunk = transferData.slice(transferIndex, end);
    writeChunk(chunk)
    .then(() => {
      transferIndex = end;
      if (transferIndex < transferData.length) {
        sendNextImageDataBatch(resolve, reject);
      } else {
        resolve();
      }
    })
    .catch(reject);
  }

  function sendImageData() {
    if (!imageDataForPrint) {
      return Promise.resolve();
    }
    transferData = getImagePrintData();
    if (!transferData.length || transferData.length <= 8) {
      return Promise.resolve();
    }
    transferIndex = 0;
    return new Promise((resolve, reject) => {
      sendNextImageDataBatch(resolve, reject);
    });
  }

  function sendPrinterData() {
    return sendImageData()
    .then(() => sendFeedDots(DEFAULT_FEED_DOTS))
    .then(() => sendFeedLines(DEFAULT_FEED_LINES));
  }

  function sendFeedLines(lines) {
    if (!printCharacteristic) {
      return Promise.resolve();
    }
    const count = Math.min(255, Math.max(0, lines | 0));
    if (count === 0) {
      return Promise.resolve();
    }
    const command = new Uint8Array([0x1B, 0x64, count]); // ESC d n (print and feed n lines)
    return printCharacteristic.writeValue(command);
  }

  function sendFeedDots(dots) {
    if (!printCharacteristic) {
      return Promise.resolve();
    }
    let remaining = Math.min(1020, Math.max(0, dots | 0)); // four chunks of 255 dots max
    if (remaining === 0) {
      return Promise.resolve();
    }
    const commands = [];
    while (remaining > 0) {
      const amount = Math.min(255, remaining);
      commands.push(new Uint8Array([0x1B, 0x4A, amount])); // ESC J n feed n dots
      remaining -= amount;
    }
    return commands.reduce((promise, command) => {
      return promise.then(() => printCharacteristic.writeValue(command));
    }, Promise.resolve());
  }

  function writeChunk(chunk) {
    if (!printCharacteristic) {
      return Promise.reject(new Error('Printer characteristic not available.'));
    }
    const performWrite = () => {
      if (!canWriteWithoutResponse) {
        return printCharacteristic.writeValue(chunk);
      }
      try {
        const maybePromise = printCharacteristic.writeValueWithoutResponse(chunk);
        if (maybePromise && typeof maybePromise.then === 'function') {
          return maybePromise.catch(error => {
            canWriteWithoutResponse = false;
            return printCharacteristic.writeValue(chunk);
          });
        }
        return Promise.resolve();
      } catch (error) {
        canWriteWithoutResponse = false;
        return printCharacteristic.writeValue(chunk);
      }
    };
    return performWrite()
    .then(() => {
      if (BLE_WRITE_DELAY_MS <= 0) {
        return;
      }
      return delay(BLE_WRITE_DELAY_MS);
    });
  }

  setupButton.addEventListener('click', event => {
    event.preventDefault();
    setPrinterStatus('connecting');
    setPrinterDeviceName('Menunggu pemilihan perangkat...');
    showProgress();
    ensurePrinterConnection(true)
    .then(() => {
      hideProgress();
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(connectedDevice));
    })
    .catch(error => {
      hideProgress();
      if (error && error.name === 'NotFoundError') {
        setPrinterStatus('disconnected');
        setPrinterDeviceName('Belum ada perangkat terdeteksi.');
      } else {
        setPrinterStatus('error');
        setPrinterDeviceName('Gagal membaca perangkat.');
      }
      handleError(error);
    });
  });

  previewButton.addEventListener('click', () => {
    if (!imageDataForPrint) {
      showError('Load a PDF to preview.');
      return;
    }
    syncModalPreview();
    if (previewDialog) {
      if (typeof previewDialog.showModal === 'function') {
        if (!previewDialog.open) {
          previewDialog.showModal();
        }
      } else {
        previewDialog.setAttribute('open', '');
      }
    }
  });

  if (downloadPreviewButton) {
    downloadPreviewButton.addEventListener('click', () => {
      if (!imageDataForPrint) {
        showError('Load a PDF before saving a preview.');
        return;
      }
      const sourceCanvas = modalPreviewCanvas && modalPreviewCanvas.width ? modalPreviewCanvas : previewCanvas;
      if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) {
        return;
      }
      const link = document.createElement('a');
      link.href = sourceCanvas.toDataURL('image/png');
      const widthLabel = printWidthSelect ? printWidthSelect.value : 'unknown';
      link.download = `preview-${widthLabel}mm.png`;
      link.click();
    });
  }

  printWidthSelect.addEventListener('change', event => {
    const value = event.target.value;
    maxPrintWidth = WIDTH_TO_PIXELS[value] || 384;
    if (lastPdfBytes) {
      showProgress();
      renderPdfData(lastPdfBytes)
      .then(() => {
        hideProgress();
      })
      .catch(handleError);
    } else if (lastImageDataUrl) {
      showProgress();
      renderImageFromDataUrl(lastImageDataUrl)
      .then(() => {
        hideProgress();
      })
      .catch(handleError);
    } else if (sourceCanvasForPrint) {
      copyCanvasToPreview(sourceCanvasForPrint);
    }
  });

  fileInput.addEventListener('change', event => {
    const file = event.target.files[0];
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
      reader.onload = loadEvent => {
        const arrayBuffer = loadEvent.target.result;
        const bytes = new Uint8Array(arrayBuffer);
        renderPdfData(bytes)
        .then(() => {
          hideProgress();
          lastPdfBytes = bytes;
          lastImageDataUrl = null;
          showToast(`${fileName} siap dipratinjau.`, 'success');
          event.target.value = '';
        })
        .catch(error => {
          showToast(`Gagal memuat ${fileName}.`, 'error', 5000);
          handleError(error);
        });
      };
      reader.onerror = () => {
        showToast(`Gagal membaca ${fileName}.`, 'error', 5000);
        handleError(new Error('Failed to read the selected PDF file.'));
      };
      reader.readAsArrayBuffer(file);
      return;
    }
    if (type === 'image/png' || type === 'image/jpeg') {
      showProgress();
      const reader = new FileReader();
      reader.onload = loadEvent => {
        const dataUrl = loadEvent.target.result;
        renderImageFromDataUrl(dataUrl)
        .then(() => {
          hideProgress();
          lastImageDataUrl = dataUrl;
          lastPdfBytes = null;
          showToast(`${fileName} siap dipratinjau.`, 'success');
          event.target.value = '';
        })
        .catch(error => {
          showToast(`Gagal memuat ${fileName}.`, 'error', 5000);
          handleError(error);
        });
      };
      reader.onerror = () => {
        showToast(`Gagal membaca ${fileName}.`, 'error', 5000);
        handleError(new Error('Failed to read the selected image file.'));
      };
      reader.readAsDataURL(file);
      return;
    }
    showToast('Format file tidak didukung. Pilih PDF, PNG, atau JPG.', 'error', 5000);
    showError('Format file tidak didukung. Pilih PDF, PNG, atau JPG.');
    event.target.value = '';
  });

  function renderPdfData(bytes) {
    if (!window.pdfjsLib) {
      return Promise.reject(new Error('PDF rendering library not available.'));
    }
    lastPdfBytes = bytes;
    lastImageDataUrl = null;
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    return loadingTask.promise
    .then(document => {
      return document.getPage(1);
    })
    .then(page => renderPdfPage(page));
  }

  function renderImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      if (!dataUrl) {
        reject(new Error('Image data is empty.'));
        return;
      }
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
      image.onerror = () => {
        reject(new Error('Gagal memuat gambar.'));
      };
      image.src = dataUrl;
    });
  }

  function renderPdfPage(page) {
    const viewport = page.getViewport({ scale: 1 });
    const scale = maxPrintWidth / viewport.width;
    const scaledViewport = page.getViewport({ scale: scale });
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.round(scaledViewport.width);
    tempCanvas.height = Math.round(scaledViewport.height);
    const ctx = tempCanvas.getContext('2d');
    return page.render({ canvasContext: ctx, viewport: scaledViewport }).promise
    .then(() => {
      copyCanvasToPreview(tempCanvas);
    });
  }

  printButton.addEventListener('click', () => {
    if (!imageDataForPrint) {
      showError('Load a PDF before printing.');
      return;
    }
    const needsConnection = !connectedDevice || !connectedDevice.gatt || !connectedDevice.gatt.connected;
    if (needsConnection) {
      setPrinterStatus('connecting');
      setPrinterDeviceName('Menyiapkan sambungan ke perangkat...');
    }
    showProgress();
    ensurePrinterConnection()
    .then(() => {
      setPrinterStatus('connected');
      setPrinterDeviceName(getPrinterDisplayName(connectedDevice));
      return sendPrinterData();
    })
    .then(() => {
      hideProgress();
    })
    .catch(error => {
      hideProgress();
      if (error && error.name === 'NotFoundError') {
        setPrinterStatus('disconnected');
        setPrinterDeviceName('Belum ada perangkat terdeteksi.');
      } else {
        setPrinterStatus('error');
        setPrinterDeviceName('Gagal membaca perangkat.');
      }
      handleError(error);
    });
  });
});
