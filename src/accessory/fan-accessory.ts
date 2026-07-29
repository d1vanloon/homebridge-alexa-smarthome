import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { flow, identity, pipe } from 'fp-ts/lib/function';
import { CharacteristicValue, Service } from 'homebridge';
import { SupportedActionsType } from '../domain/alexa';
// REVIEW: FanControls, FanDirectionControl, FanSpeedControl imports — support the new
// fan speed (RotationSpeed) and direction (RotationDirection) HomeKit characteristics
// mapped through either Alexa.ModeController or Alexa.RangeController.
import {
  FanControls,
  FanDirectionControl,
  FanSpeedControl,
} from '../domain/alexa/fan-controls';
import { FanState } from '../domain/alexa/fan';
import * as mapper from '../mapper/fan-mapper';
import BaseAccessory from './base-accessory';

export default class FanAccessory extends BaseAccessory {
  static requiredOperations: SupportedActionsType[] = ['turnOn', 'turnOff'];
  service: Service;
  isExternalAccessory = false;

  // REVIEW: fanControls field — lazily resolved per-device fan control scheme (speed + direction)
  // from the DeviceStore. Populated during platform startup via getSmarthomeDevicesV2 discovery.
  readonly fanControls: FanControls =
    this.platform.deviceStore.getFanControlsForDevice(this.device.id);

  // REVIEW: fanControlLastUpdated — per-control-instance timestamp map for cache freshness decisions.
  // Keyed by `${featureName}:${instance}`. After a SET operation, state is considered fresh enough
  // to skip a GraphQL GET for cacheTTL milliseconds.
  private readonly fanControlLastUpdated = new Map<string, Date>();

  configureServices() {
    this.service =
      this.platformAcc.getService(this.Service.Fanv2) ||
      this.platformAcc.addService(this.Service.Fanv2, this.device.displayName);

    this.service
      .getCharacteristic(this.Characteristic.Active)
      .onGet(this.handleActiveGet.bind(this))
      .onSet(this.handleActiveSet.bind(this));

    // REVIEW: configureServices — now conditionally registers RotationSpeed and RotationDirection
    // HomeKit characteristics based on whether the FanControls scheme includes speed/direction controls.
    // Devices without fan control capabilities (emptyFanControls) have these characteristics removed
    // so they appear as simple on/off fans in HomeKit.
    pipe(
      this.fanControls.speed,
      O.match(
        () => {
          this.removeCharacteristic(this.Characteristic.RotationSpeed);
        },
        (speedControl) => {
          this.service
            .getCharacteristic(this.Characteristic.RotationSpeed)
            .onGet(this.handleRotationSpeedGet.bind(this, speedControl))
            .onSet(this.handleRotationSpeedSet.bind(this, speedControl));
        },
      ),
    );

    pipe(
      this.fanControls.direction,
      O.match(
        () => {
          this.removeCharacteristic(this.Characteristic.RotationDirection);
        },
        (directionControl) => {
          this.service
            .getCharacteristic(this.Characteristic.RotationDirection)
            .onGet(this.handleRotationDirectionGet.bind(this, directionControl))
            .onSet(
              this.handleRotationDirectionSet.bind(this, directionControl),
            );
        },
      ),
    );
  }

  async handleActiveGet(): Promise<boolean> {
    const determinePowerState = flow(
      A.findFirst<FanState>(({ featureName }) => featureName === 'power'),
      O.tap(({ value }) =>
        O.of(this.logWithContext('debug', `Get power result: ${value}`)),
      ),
      O.map(({ value }) => value === 'ON'),
    );

    return pipe(
      this.getStateGraphQl(determinePowerState),
      TE.match((e) => {
        this.logWithContext('errorT', 'Get power', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handleActiveSet(value: CharacteristicValue): Promise<void> {
    this.logWithContext('debug', `Triggered set power: ${value}`);
    if (typeof value !== 'number') {
      throw this.invalidValueError;
    }
    const action = mapper.mapHomeKitPowerToAlexaAction(
      value,
      this.Characteristic,
    );
    return pipe(
      this.platform.alexaApi.setDeviceStateGraphQl(
        this.device.endpointId,
        'power',
        action,
      ),
      TE.match(
        (e) => {
          this.logWithContext('errorT', 'Set power', e);
          throw this.serviceCommunicationError;
        },
        () => {
          this.updateCacheValue({
            value: mapper.mapHomeKitPowerToAlexaValue(
              value,
              this.Characteristic,
            ),
            featureName: 'power',
          });
        },
      ),
    )();
  }

  // REVIEW: handleRotationSpeedGet — reads fan speed state from GraphQL (mode or range query)
  // and maps it back to HomeKit 0–100% via the control's alexaToHomeKit mapping. Falls back
  // to defaultHomeKitValue when no live state is available.
  async handleRotationSpeedGet(control: FanSpeedControl): Promise<number> {
    const states = await this.getFanControlStates(control);
    if (control.type === 'mode') {
      const state = states.find(
        (s) =>
          s.featureName === 'mode' &&
          s.name === 'mode' &&
          s.instance === control.instance,
      );
      if (
        state &&
        typeof state.value === 'string' &&
        state.value in control.alexaToHomeKit
      ) {
        return control.alexaToHomeKit[state.value];
      }
    } else {
      const state = states.find(
        (s) => s.featureName === 'range' && s.instance === control.instance,
      );
      if (state && typeof state.value === 'number') {
        return control.alexaToHomeKit(state.value);
      }
    }
    this.logWithContext(
      'debug',
      `Get rotation speed: using default ${control.defaultHomeKitValue}`,
    );
    return control.defaultHomeKitValue;
  }

  // REVIEW: handleRotationSpeedSet — converts HomeKit 0–100% to Alexa mode string or range value
  // via homeKitToAlexa, calls setDeviceModeGraphQl or setDeviceRangeGraphQl, then upserts
  // the new state into cache with a fresh timestamp. Value 0 on mode-controlled fans triggers fan off.
  async handleRotationSpeedSet(
    control: FanSpeedControl,
    value: CharacteristicValue,
  ): Promise<void> {
    this.logWithContext('debug', `Triggered set rotation speed: ${value}`);
    if (typeof value !== 'number' || value < 0 || value > 100) {
      throw this.invalidValueError;
    }
    if (control.type === 'mode') {
      if (value === 0) {
        await this.turnFanOff('Set rotation speed');
        return;
      }
      const alexaModeOpt = control.homeKitToAlexa(value);
      if (O.isNone(alexaModeOpt)) {
        throw this.invalidValueError;
      }
      const alexaMode = alexaModeOpt.value;
      await pipe(
        this.platform.alexaApi.setDeviceModeGraphQl(
          this.device.endpointId,
          control.instance,
          alexaMode,
        ),
        TE.match(
          (e) => {
            this.logWithContext('errorT', 'Set rotation speed', e);
            throw this.serviceCommunicationError;
          },
          () => {
            this.platform.deviceStore.upsertCacheValue(this.device.id, {
              featureName: 'mode',
              name: 'mode',
              instance: control.instance,
              value: alexaMode,
            });
            this.fanControlLastUpdated.set(
              this.fanControlKey(control),
              new Date(),
            );
          },
        ),
      )();
    } else {
      const alexaValueOpt = control.homeKitToAlexa(value);
      if (O.isNone(alexaValueOpt)) {
        await this.turnFanOff('Set rotation speed');
        return;
      }
      const alexaValue = alexaValueOpt.value;
      await pipe(
        this.platform.alexaApi.setDeviceRangeGraphQl(
          this.device.endpointId,
          control.instance,
          alexaValue,
        ),
        TE.match(
          (e) => {
            this.logWithContext('errorT', 'Set rotation speed', e);
            throw this.serviceCommunicationError;
          },
          () => {
            this.platform.deviceStore.upsertCacheValue(this.device.id, {
              featureName: 'range',
              name: 'rangeValue',
              instance: control.instance,
              rangeName: control.rangeName,
              value: alexaValue,
            });
            this.fanControlLastUpdated.set(
              this.fanControlKey(control),
              new Date(),
            );
          },
        ),
      )();
    }
  }

  // REVIEW: handleRotationDirectionGet — analogous to speed get but for RotationDirection (0=clockwise, 1=counter-clockwise)
  // mapped through the direction control's alexaToHomeKit lookup table.
  async handleRotationDirectionGet(
    control: FanDirectionControl,
  ): Promise<number> {
    const states = await this.getFanControlStates(control);
    const state = states.find(
      (s) =>
        s.featureName === 'mode' &&
        s.name === 'mode' &&
        s.instance === control.instance,
    );
    if (
      state &&
      typeof state.value === 'string' &&
      state.value in control.alexaToHomeKit
    ) {
      return control.alexaToHomeKit[state.value];
    }
    this.logWithContext(
      'debug',
      `Get rotation direction: using default ${control.defaultHomeKitValue}`,
    );
    return control.defaultHomeKitValue;
  }

  // REVIEW: handleRotationDirectionSet — converts HomeKit direction (0 or 1) to Alexa mode string
  // and calls setDeviceModeGraphQl, then caches the result.
  async handleRotationDirectionSet(
    control: FanDirectionControl,
    value: CharacteristicValue,
  ): Promise<void> {
    this.logWithContext('debug', `Triggered set rotation direction: ${value}`);
    if (typeof value !== 'number' || (value !== 0 && value !== 1)) {
      throw this.invalidValueError;
    }
    const alexaModeOpt = control.homeKitToAlexa(value);
    if (O.isNone(alexaModeOpt)) {
      throw this.invalidValueError;
    }
    const alexaMode = alexaModeOpt.value;
    await pipe(
      this.platform.alexaApi.setDeviceModeGraphQl(
        this.device.endpointId,
        control.instance,
        alexaMode,
      ),
      TE.match(
        (e) => {
          this.logWithContext('errorT', 'Set rotation direction', e);
          throw this.serviceCommunicationError;
        },
        () => {
          this.platform.deviceStore.upsertCacheValue(this.device.id, {
            featureName: 'mode',
            name: 'mode',
            instance: control.instance,
            value: alexaMode,
          });
          this.fanControlLastUpdated.set(
            this.fanControlKey(control),
            new Date(),
          );
        },
      ),
    )();
  }

  private fanControlKey(
    control: FanSpeedControl | FanDirectionControl,
  ): string {
    return `${control.featureName}:${control.instance}`;
  }

  private hasCachedFanControlState(
    control: FanSpeedControl | FanDirectionControl,
  ): boolean {
    return O.isSome(
      this.platform.deviceStore.getCacheValue(this.device.id, {
        featureName: control.featureName,
        instance: control.instance,
        name: control.featureName === 'mode' ? 'mode' : 'rangeValue',
      }),
    );
  }

  private shouldUseFanControlCache(
    control: FanSpeedControl | FanDirectionControl,
  ): boolean {
    return (
      this.hasCachedFanControlState(control) &&
      Date.now() -
        (
          this.fanControlLastUpdated.get(this.fanControlKey(control)) ??
          new Date(0)
        ).getTime() <
        this.platform.deviceStore.cacheTTL
    );
  }

  // REVIEW: getFanControlStates — dispatches to getDeviceModeStatesGraphQl (mode controls) or
  // getDeviceRangeStatesGraphQl (range controls), with cache short-circuit when a recent SET
  // made the state fresh enough. On error, falls back to cached states.
  private async getFanControlStates(
    control: FanSpeedControl | FanDirectionControl,
  ): Promise<FanState[]> {
    const useCache = this.shouldUseFanControlCache(control);
    const result =
      control.type === 'mode'
        ? this.platform.alexaApi.getDeviceModeStatesGraphQl(
            this.device,
            useCache,
          )
        : this.platform.alexaApi.getDeviceRangeStatesGraphQl(
            this.device,
            useCache,
          );
    return pipe(
      result,
      TE.match(
        (e) => {
          this.logWithContext('errorT', 'Get fan control state', e);
          return this.platform.deviceStore.getCacheStatesForDevice(
            this.device.id,
          ) as FanState[];
        },
        ([fromCache, states]) => {
          if (!fromCache) {
            this.fanControlLastUpdated.set(
              this.fanControlKey(control),
              new Date(),
            );
          }
          return states as FanState[];
        },
      ),
    )();
  }

  // REVIEW: turnFanOff — sends a power OFF command via setDeviceStateGraphQl and caches the OFF state.
  // Called when RotationSpeed is set to 0 on mode-controlled fans (since 0 means "off" in HomeKit, but
  // Alexa's mode list only maps 1..N to specific speeds).
  private async turnFanOff(errorContext: string): Promise<void> {
    await pipe(
      this.platform.alexaApi.setDeviceStateGraphQl(
        this.device.endpointId,
        'power',
        'turnOff',
      ),
      TE.match(
        (e) => {
          this.logWithContext('errorT', errorContext, e);
          throw this.serviceCommunicationError;
        },
        () => {
          this.platform.deviceStore.upsertCacheValue(this.device.id, {
            featureName: 'power',
            value: 'OFF',
          });
        },
      ),
    )();
  }
}
