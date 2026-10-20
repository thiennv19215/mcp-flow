import { AsyncLocalStorage } from "node:async_hooks";

export type DeviceContext = { userId: string; deviceId: string };
const storage = new AsyncLocalStorage<DeviceContext>();

export const runWithDeviceContext = <T>(context: DeviceContext, work: () => T): T => storage.run(context, work);
export const currentDeviceContext = (): DeviceContext | undefined => storage.getStore();
