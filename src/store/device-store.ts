import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as RR from 'fp-ts/ReadonlyRecord';
import { constVoid, constant, identity, pipe } from 'fp-ts/lib/function';
import { CapabilityState } from '../domain/alexa';
import {
  CapabilityStatesByDevice,
  ValidStatesByDevice,
} from '../domain/alexa/get-device-states';
import {
  RangeFeatures,
  RangeFeaturesByDevice,
} from '../domain/alexa/save-device-capabilities';
import { AlexaPlatformConfig } from '../domain/homebridge';
import { getOrElseNullable } from '../util/fp-util';
import { emptyFanControls, FanControls } from '../domain/alexa/fan-controls';

export interface DeviceStatesCache {
  lastUpdated: Date;
  states: ValidStatesByDevice;
}

export default class DeviceStore {
  public readonly cacheTTL: number;
  public readonly cache: DeviceStatesCache = {
    lastUpdated: new Date(0),
    states: {},
  };

  private _deviceCapabilities: RangeFeaturesByDevice = {};
  private _fanControlsByDevice: Record<string, FanControls> = {};

  constructor(performanceSettings?: AlexaPlatformConfig['performance']) {
    const cacheTTL = getOrElseNullable(
      performanceSettings?.cacheTTL,
      constant(60),
    );
    this.cacheTTL = 1_000 * cacheTTL;
  }

  get deviceCapabilities(): RangeFeaturesByDevice {
    return RR.toRecord(this._deviceCapabilities);
  }

  set deviceCapabilities(deviceCapabilities: RangeFeaturesByDevice) {
    this._deviceCapabilities = deviceCapabilities;
  }

  get fanControlsByDevice(): Record<string, FanControls> {
    return RR.toRecord(this._fanControlsByDevice);
  }

  set fanControlsByDevice(controls: Record<string, FanControls>) {
    this._fanControlsByDevice = controls;
  }

  getFanControlsForDevice(deviceId: string): FanControls {
    return this._fanControlsByDevice[deviceId] ?? emptyFanControls;
  }

  getRangeFeaturesForDevice(deviceId: string): RangeFeatures {
    return pipe(
      this.deviceCapabilities,
      RR.lookup(deviceId),
      O.match(constant({}), identity),
    );
  }

  getCacheStatesForDevice(deviceId: string): CapabilityState[] {
    return pipe(
      this.cache.states,
      RR.lookup(deviceId),
      O.match(constant([]), A.filterMap(identity)),
    );
  }

  getCacheValue(
    deviceId: string,
    {
      featureName,
      name,
      instance,
    }: Omit<CapabilityState, 'value' | 'namespace'>,
  ): Option<CapabilityState> {
    return pipe(
      this.getCacheStatesForDevice(deviceId),
      A.findFirstMap((cache) =>
        cache.featureName === featureName &&
        (!name || cache.name === name) &&
        (!instance || cache.instance === instance)
          ? O.of(cache)
          : O.none,
      ),
    );
  }

  updateCache(
    deviceIds: string[],
    statesByDevice: CapabilityStatesByDevice,
  ): ValidStatesByDevice {
    pipe(
      deviceIds,
      A.map((id) => {
        this.cache.states[id] =
          id in statesByDevice
            ? pipe(
                statesByDevice,
                RR.lookup(id),
                O.flatten,
                O.map(A.map(O.getRight)),
                O.getOrElse(constant(new Array<Option<CapabilityState>>())),
              )
            : [];
      }),
      RA.match(constVoid, () => {
        this.cache.lastUpdated = new Date();
      }),
    );
    return this.cache.states;
  }

  updateCacheValue(deviceId: string, newState: CapabilityState) {
    pipe(
      this.getCacheValue(deviceId, newState),
      O.tap((cs) => {
        cs.value = newState.value;
        return O.of(cs);
      }),
    );
    return this.cache.states;
  }

  // REVIEW: upsertCacheValue — unlike updateCacheValue (which only updates existing cache entries),
  // this method inserts OR updates a CapabilityState for a given (deviceId, featureName, instance, name)
  // tuple. Required for fan control SET operations where a mode/range state may not yet exist in cache.
  upsertCacheValue(
    deviceId: string,
    newState: CapabilityState,
  ): ValidStatesByDevice {
    const states = this.getCacheStatesForDevice(deviceId);
    const matchIndex = states.findIndex(
      (cs) =>
        cs.featureName === newState.featureName &&
        (cs.instance ?? null) === (newState.instance ?? null) &&
        (cs.name ?? null) === (newState.name ?? null),
    );
    if (matchIndex >= 0) {
      states[matchIndex] = newState;
    } else {
      states.push(newState);
    }
    this.cache.states[deviceId] = states.map((s) => O.of(s));
    return this.cache.states;
  }

  isCacheFresh = () =>
    this.cache.lastUpdated.getTime() > Date.now() - this.cacheTTL;
}
