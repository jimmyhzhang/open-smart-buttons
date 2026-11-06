// Transport abstraction: the device driver only ever talks HID reports through this interface,
// so a real USB device (node-hid) and the simulator are interchangeable at the byte level.

export interface HidDeviceInfo {
  path: string;
  vendorId: number;
  productId: number;
  serialNumber?: string;
  product?: string;
  manufacturer?: string;
  usagePage?: number;
  usage?: number;
  kind: 'usb' | 'sim';
}

export interface HidTransport {
  readonly info: HidDeviceInfo;
  /** Output report; byte 0 is the report id. */
  write(data: Uint8Array): Promise<void>;
  /** Feature report; byte 0 is the report id. */
  sendFeatureReport(data: Uint8Array): Promise<void>;
  /** Returns the feature report including its id in byte 0. */
  getFeatureReport(reportId: number, length: number): Promise<Uint8Array>;
  onData(cb: (data: Uint8Array) => void): void;
  onError(cb: (err: Error) => void): void;
  close(): Promise<void>;
}
