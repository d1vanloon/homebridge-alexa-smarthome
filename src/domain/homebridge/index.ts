import { Option } from 'fp-ts/lib/Option';
import { PlatformConfig } from 'homebridge';
import { AmazonDomain } from '../alexa/index';
import { Nullable } from '../index';

export interface HomebridgeAccessoryInfo {
  deviceType: string;
  uuid: string;
  altDeviceName: Option<string>;
}

export interface AlexaPlatformConfig extends PlatformConfig {
  platform: 'HomebridgeAlexaSmartHome';
  devices: Nullable<string[]>;
  excludeDevices: Nullable<string[]>;
  amazonDomain: Nullable<AmazonDomain>;
  language: Nullable<string>;
  auth: {
    proxy: {
      clientHost: string;
      port: number;
    };
    refreshInterval: Nullable<number>;
  };
  performance: Nullable<{
    cacheTTL: Nullable<number>;
    // REVIEW: backgroundRefresh added to the performance config to allow disabling periodic
    // device state polling from the Alexa cloud (e.g. for low-traffic dev instances).
    backgroundRefresh: Nullable<boolean>;
  }>;
  // REVIEW: disabledOperations changed from required to optional (`?:`) — it was previously
  // declared without `?`, requiring every platform config to include an empty or null entry.
  disabledOperations?: Nullable<
    Array<{
      deviceName: string;
      operations: Nullable<string>;
    }>
  >;
  debug: Nullable<boolean>;
}
