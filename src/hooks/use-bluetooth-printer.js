import { useCallback, useRef } from 'react';

const BLE_CHUNK_SIZE_WITH_RESPONSE = 20;
const BLE_CHUNK_SIZE_WITHOUT_RESPONSE = 120;
const BLE_WRITE_DELAY_WITH_RESPONSE_MS = 2;
const BLE_WRITE_DELAY_WITHOUT_RESPONSE_MS = 10;
const DEFAULT_FEED_LINES = 2;
const DEFAULT_FEED_DOTS = 50;
const PRINTER_RESET_COMMAND = new Uint8Array([0x1b, 0x40]);

function delay(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function useBluetoothPrinter({
  imageDataForPrintRef,
  getImagePrintData,
  showProgress,
  hideProgress,
  showToast,
  handleError,
  getPrinterDisplayName,
  setPrinterStatus,
  setPrinterDeviceName
}) {
  const printCharacteristicRef = useRef(null);
  const connectedDeviceRef = useRef(null);
  const transferDataRef = useRef(null);
  const transferIndexRef = useRef(0);
  const canWriteWithoutResponseRef = useRef(false);

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
  }, [attachDisconnectHandler, detachDisconnectHandler, disconnectDevice, getPrinterDisplayName, setPrinterDeviceName, setPrinterStatus]);

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
      filters: [{ services: ['000018f0-0000-1000-8000-00805f9b34fb'] }]
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
  }, [connectToSelectedDevice, getPrinterDisplayName, setPrinterDeviceName, setPrinterStatus]);

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
  }, [getImagePrintData, writeChunk]);

  const sendPrinterData = useCallback(async () => {
    await writeChunk(PRINTER_RESET_COMMAND);
    await sendImageData();
    await sendFeedDots(DEFAULT_FEED_DOTS);
    await sendFeedLines(DEFAULT_FEED_LINES);
  }, [sendFeedDots, sendFeedLines, sendImageData, writeChunk]);

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
  }, [ensurePrinterConnection, getPrinterDisplayName, handleError, hideProgress, imageDataForPrintRef, sendPrinterData, setPrinterDeviceName, setPrinterStatus, showProgress, showToast]);

  return {
    handleSetupPrinter,
    handlePrint
  };
}
