import { useCallback } from 'react';
import { getDocument } from 'pdfjs-dist';

const DITHER_THRESHOLD = 112;
const WHITE_THRESHOLD = 250;

export function usePrintPreparation({
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
}) {
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
  }, [imageDataForPrintRef, maxPrintWidthRef, printDataCanvasRef, printDataContextRef]);

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
  }, [imageDataForPrintRef, modalPreviewCanvasRef, modalPreviewContextRef, previewCanvasRef, sourceCanvasForPrintRef]);

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
  }, [imageDataForPrintRef, modalPreviewCanvasRef, modalPreviewContextRef, preparePrintData, previewCanvasRef, previewContextRef, sourceCanvasForPrintRef, syncModalPreview]);

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
  }, [copyCanvasToPreview, maxPrintWidthRef]);

  const renderPdfData = useCallback(async (bytes) => {
    lastPdfBytesRef.current = bytes;
    lastImageDataUrlRef.current = null;
    const loadingTask = getDocument({ data: bytes });
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    await renderPdfPage(page);
  }, [lastImageDataUrlRef, lastPdfBytesRef, renderPdfPage]);

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
  }, [handleError, hideProgress, lastPdfBytesRef, renderPdfData, showProgress]);

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
  }, [handleError, hideProgress, lastImageDataUrlRef, renderImageFromDataUrl, showProgress]);

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
  }, [handleError, hideProgress, hideToast, lastImageDataUrlRef, lastPdfBytesRef, renderImageFromDataUrl, renderPdfData, showProgress, showToast]);

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
  }, [imageDataForPrintRef, modalPreviewCanvasRef, previewCanvasRef, printWidth, showToast]);

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
  }, [imageDataForPrintRef]);

  return {
    copyCanvasToPreview,
    renderImageFromDataUrl,
    reloadLastPdf,
    reloadLastImage,
    handleFileChange,
    handleDownloadPreview,
    syncModalPreview,
    getImagePrintData
  };
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
