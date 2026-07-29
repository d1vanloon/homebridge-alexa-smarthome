import { Semaphore, SemaphoreInterface, withTimeout } from 'async-mutex';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TaskEither } from 'fp-ts/TaskEither';
import { match as fpMatch } from 'fp-ts/boolean';
import { constVoid, constant, pipe } from 'fp-ts/lib/function';
import { Service } from 'homebridge';
import { Pattern, match } from 'ts-pattern';
import AlexaRemote, {
  type CallbackWithErrorAndBody,
  type EntityType,
} from 'alexa-remote2';
import {
  CapabilityState,
  SupportedActionsType,
  SupportedFeatures,
} from '../domain/alexa';
import { AlexaApiError, HttpError, TimeoutError } from '../domain/alexa/errors';
import EndpointStateResponse, {
  extractStates,
} from '../domain/alexa/get-device-state.js';
import GetDeviceStatesResponse, {
  ValidStatesByDevice,
} from '../domain/alexa/get-device-states';
import {
  Endpoint,
  GetDevicesGraphQlResponse,
  SmartHomeDevice,
  validateGetDevicesSuccessful,
} from '../domain/alexa/get-devices';
import { extractRangeFeatures } from '../domain/alexa/save-device-capabilities';
// REVIEW: fan-controls imports — AlexaCapability and discovery functions for identifying
// fan speed/direction controls from getSmarthomeDevicesV2 capability data. SmarthomeDeviceV2
// provides the legacy appliance shape with raw capabilities.
import {
  AlexaCapability,
  discoverFanControls,
  FanControls,
  SmarthomeDeviceV2,
} from '../domain/alexa/fan-controls';
import SetDeviceStateResponse, {
  validateSetStateSuccessful,
} from '../domain/alexa/set-device-state.js';
import DeviceStore from '../store/device-store';
import { PluginLogger } from '../util/plugin-logger';
import {
  AirQualityQuery,
  EndpointsQuery,
  LightQuery,
  LockQuery,
  // REVIEW: ModeQuery — new GraphQL query for Alexa.ModeController state reads (fan speed/direction GET).
  ModeQuery,
  PowerQuery,
  RangeQuery,
  SetEndpointFeatures,
  TempSensorQuery,
  ThermostatQuery,
} from './graphql';

export interface DeviceStatesCache {
  lastUpdated: Date;
  cachedStates: ValidStatesByDevice;
}

// REVIEW: SetEndpointFeaturesResponse — the /nexus/v1/graphql SetEndpointFeatures mutation response shape.
// Has TWO error layers: (1) top-level errors[] for GraphQL validation errors (data is null),
// (2) nested data.setEndpointFeatures.errors[] for mutation-level errors. Both must be checked.
interface SetEndpointFeaturesResponse {
  data: {
    setEndpointFeatures: {
      featureControlResponses: unknown[];
      errors: Array<{ endpointId: string; code: string }>;
    };
  } | null;
  errors?: unknown[];
}

export class AlexaApiWrapper {
  private readonly semaphore: SemaphoreInterface;

  // REVIEW: Constructor now accepts `service: typeof Service` (Homebridge HAP Service) as the first arg.
  // Previously the Service was accessed via `this.platformAcc` in BaseAccessory — here it's needed
  // directly for service UUID matching in getDeviceStateGraphQl. Fourth arg DeviceStore no longer takes PluginLogger.
  constructor(
    private readonly service: typeof Service,
    private readonly alexaRemote: AlexaRemote,
    private readonly log: PluginLogger,
    private readonly deviceStore: DeviceStore,
  ) {
    this.semaphore = withTimeout(
      new Semaphore(2, new TimeoutError('Alexa API Timeout')),
      65_000,
    );
  }

  getDevices(): TaskEither<AlexaApiError, SmartHomeDevice[]> {
    const excludeHomebridgeAlexaPluginDevices = (e: Endpoint) =>
      !(Array.isArray(e.endpointReports) ? e.endpointReports : []).some(
        ({ reporter }) =>
          (reporter?.skillStage?.toLowerCase() === 'development' &&
            reporter.id ===
              'amzn1.ask.skill.a28c43e1-cba6-4aac-93ca-509e8c7ce39b') ||
          (reporter?.skillStage?.toLowerCase() === 'live' &&
            reporter.id ===
              'amzn1.ask.skill.2af008bb-2bb0-4bef-b131-e191f944a87e'),
      );
    return pipe(
      TE.tryCatch(
        () =>
          this.executeGraphQlQuery<GetDevicesGraphQlResponse>(EndpointsQuery),
        (reason) =>
          new HttpError(
            `Error getting smart home devices. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
      TE.flatMapEither(validateGetDevicesSuccessful),
      TE.map(A.filter(([e]) => excludeHomebridgeAlexaPluginDevices(e))),
      TE.tapIO((devices) => {
        this.deviceStore.deviceCapabilities = extractRangeFeatures(devices);
        devices.forEach(([e, d]) => {
          this.log.debug(
            `${d.displayName} ::: Raw device features: ${JSON.stringify(
              e.features,
              undefined,
              2,
            )}`,
          )();
          const states = extractStates(e.features);
          this.log.debug(
            `${d.displayName} ::: Device states: ${JSON.stringify(
              states,
              undefined,
              2,
            )}`,
          );
          this.deviceStore.updateCache([d.id], {
            [d.id]: O.of(states.map(E.right)),
          });
        });
        return this.log.debug(
          'Successfully obtained devices and their capabilities',
        );
      }),
      // REVIEW: TE.tap block — after getDevices() resolves, queries getSmarthomeDevicesV2() for fan control
      // capability data. On failure, logs a warning and continues with power-only support (graceful degradation).
      // On success, calls discoverAndStoreFanControls to populate DeviceStore.fanControlsByDevice.
      TE.tap((devices) =>
        pipe(
          this.getSmarthomeDevicesV2(),
          TE.orElse((e) => {
            this.log.warn(
              `Failed to get smarthome devices v2 for fan control discovery, continuing with power-only support: ${e.message}`,
            )();
            return TE.of([] as SmarthomeDeviceV2[]);
          }),
          TE.map((v2Devices) =>
            this.discoverAndStoreFanControls(devices, v2Devices),
          ),
        ),
      ),
      TE.map(A.map(([, d]) => d)),
    );
  }

  getDeviceStateGraphQl(
    device: SmartHomeDevice,
    service: Service,
    useCache: boolean,
  ): TaskEither<AlexaApiError, [boolean, CapabilityState[]]> {
    const {
      AirQualitySensor,
      CarbonMonoxideSensor,
      HumiditySensor,
      Lightbulb,
      LockMechanism,
      TemperatureSensor,
      Thermostat,
    } = this.service;
    return pipe(
      TE.tryCatch(
        () => this.semaphore.acquire(),
        (e) => e as TimeoutError,
      ),
      TE.map((_) => useCache),
      TE.flatMap(
        fpMatch(
          () =>
            pipe(
              TE.of(
                match(service.UUID)
                  .with(AirQualitySensor.UUID, constant(AirQualityQuery))
                  .with(Lightbulb.UUID, constant(LightQuery))
                  .with(LockMechanism.UUID, constant(LockQuery))
                  .with(TemperatureSensor.UUID, constant(TempSensorQuery))
                  .with(Thermostat.UUID, constant(ThermostatQuery))
                  .with(
                    Pattern.union(
                      CarbonMonoxideSensor.UUID,
                      HumiditySensor.UUID,
                    ),
                    constant(RangeQuery),
                  )
                  .otherwise(constant(PowerQuery)),
              ),
              TE.tapIO((query) =>
                this.log.debug(
                  `Querying for changes to ${
                    device.displayName
                  } using ${query.substring(0, query.indexOf('('))}`,
                ),
              ),
              TE.flatMap((query) =>
                TE.tryCatch(
                  () =>
                    this.executeGraphQlQuery<EndpointStateResponse>(query, {
                      endpointId: device.endpointId,
                    }),
                  (reason) =>
                    new HttpError(
                      `Error getting smart home device state for ${
                        device.displayName
                      }. Reason: ${(reason as Error).message}`,
                    ),
                ),
              ),
              TE.map((_) => extractStates(_.data.endpoint.features)),
              TE.map((states) => {
                this.deviceStore.updateCache([device.id], {
                  [device.id]: O.of(states.map(E.right)),
                });
                return [false, states] as [boolean, CapabilityState[]];
              }),
            ),
          () =>
            pipe(
              TE.of([
                true,
                this.deviceStore.getCacheStatesForDevice(device.id),
              ] as [boolean, CapabilityState[]]),
              TE.tapIO(() =>
                this.log.debug('Obtained device state from cache'),
              ),
            ),
        ),
      ),
      TE.mapBoth(
        (e) => {
          this.semaphore.release();
          return e;
        },
        (res) => {
          this.semaphore.release();
          return res;
        },
      ),
    );
  }

  // REVIEW: getDeviceModeStatesGraphQl — fetches mode controller state (e.g. fan speed/direction modes)
  // from the GraphQL endpoint using ModeQuery. Delegates to the shared getDeviceFeatureStatesGraphQl
  // which handles caching, error recovery, and merging with existing cache states.
  getDeviceModeStatesGraphQl(
    device: SmartHomeDevice,
    useCache: boolean,
  ): TaskEither<AlexaApiError, [boolean, CapabilityState[]]> {
    return this.getDeviceFeatureStatesGraphQl(
      device,
      useCache,
      ModeQuery,
      'mode',
    );
  }

  // REVIEW: getDeviceRangeStatesGraphQl — fetches range controller state (e.g. continuous fan speed)
  // via the existing RangeQuery. Same caching/error recovery pattern as getDeviceModeStatesGraphQl.
  getDeviceRangeStatesGraphQl(
    device: SmartHomeDevice,
    useCache: boolean,
  ): TaskEither<AlexaApiError, [boolean, CapabilityState[]]> {
    return this.getDeviceFeatureStatesGraphQl(
      device,
      useCache,
      RangeQuery,
      'range',
    );
  }

  // REVIEW: getDeviceFeatureStatesGraphQl — shared helper for mode/range GraphQL queries. Short-circuits
  // to cache when useCache is true. Handles malformed responses with a try-catch (TE.map callback throws
  // are not caught by TE.orElse — need explicit try-catch). On query failure, falls back to cache.
  // Merges incoming states with existing cache via mergeCapabilityStates so modes from one query
  // don't clobber power state from another.
  private getDeviceFeatureStatesGraphQl(
    device: SmartHomeDevice,
    useCache: boolean,
    query: string,
    featureLabel: string,
  ): TaskEither<AlexaApiError, [boolean, CapabilityState[]]> {
    if (useCache) {
      return TE.of([
        true,
        this.deviceStore.getCacheStatesForDevice(device.id),
      ] as [boolean, CapabilityState[]]);
    }
    return pipe(
      TE.tryCatch(
        () =>
          this.executeGraphQlQuery<EndpointStateResponse>(query, {
            endpointId: device.endpointId,
          }),
        (reason) =>
          new HttpError(
            `Error getting ${featureLabel} state for ${
              device.displayName
            }. Reason: ${(reason as Error).message}`,
          ),
      ),
      TE.flatMap((_) => {
        try {
          return TE.of(extractStates(_.data.endpoint.features));
        } catch {
          this.log.warn(
            `Malformed ${featureLabel} query response for ${
              device.displayName
            }, falling back to cache. Response: ${JSON.stringify(_)}`,
          )();
          return TE.left(
            new HttpError(
              `Malformed ${featureLabel} query response for ${device.displayName}`,
            ),
          );
        }
      }),
      TE.map((states) => {
        const merged = this.mergeCapabilityStates(
          this.deviceStore.getCacheStatesForDevice(device.id),
          states,
        );
        this.deviceStore.updateCache([device.id], {
          [device.id]: O.of(merged.map(E.right)),
        });
        return [false, merged] as [boolean, CapabilityState[]];
      }),
      TE.orElse((e) => {
        this.log.warn(
          `${featureLabel} query failed for ${device.displayName}, falling back to cache: ${e.message}`,
        )();
        return TE.of([
          true,
          this.deviceStore.getCacheStatesForDevice(device.id),
        ] as [boolean, CapabilityState[]]);
      }),
    );
  }

  // REVIEW: setEndpointFeature — unified SET helper for all setEndpointFeatures GraphQL mutations.
  // Replaces the old setDeviceStateGraphQl's inline TE.map(constVoid) with TE.flatMapEither that
  // checks BOTH error layers: top-level resp.errors (GraphQL validation) AND nested
  // resp.data.setEndpointFeatures.errors (mutation-level). Both previously silently discarded.
  private setEndpointFeature(
    request: Record<string, unknown>,
  ): TaskEither<AlexaApiError, void> {
    return pipe(
      TE.tryCatch(
        () =>
          this.executeGraphQlQuery<SetEndpointFeaturesResponse>(
            SetEndpointFeatures,
            { featureControlRequests: [request] },
          ),
        (reason) =>
          new HttpError(
            `Error setting smart home device state. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
      TE.flatMapEither((resp) => {
        const setErrors = resp?.data?.setEndpointFeatures?.errors;
        const graphqlErrors = resp?.errors;
        if (
          !resp?.data ||
          (setErrors && setErrors.length > 0) ||
          (graphqlErrors && graphqlErrors.length > 0)
        ) {
          this.log.warn(
            `SetEndpointFeatures returned errors. Request: ${JSON.stringify(
              request,
            )}, Response: ${JSON.stringify(resp)}`,
          )();
          return E.left(
            new HttpError(
              `Error setting smart home device state. Response: ${JSON.stringify(
                resp,
              )}`,
            ),
          );
        }
        return E.right(constVoid());
      }),
    );
  }

  // REVIEW: setDeviceStateGraphQl — refactored to delegate to setEndpointFeature. Builds the
  // featureControlRequests payload with endpointId, featureName, featureOperationName, and optional payload.
  setDeviceStateGraphQl(
    endpointId: string,
    featureName: SupportedFeatures,
    featureOperationName: SupportedActionsType,
    payload: Record<string, unknown> = {},
  ): TaskEither<AlexaApiError, void> {
    const request = {
      endpointId,
      featureOperationName,
      featureName,
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    };
    return this.setEndpointFeature(request);
  }

  // REVIEW: setDeviceModeGraphQl — sends a setMode operation with `instance` at the top level
  // (matching the Alexa Smart Home API directive format) and `payload: { mode }` for the mode value.
  // NOTE: instance is a directive-level field, NOT inside payload.
  setDeviceModeGraphQl(
    endpointId: string,
    instance: string,
    mode: string,
  ): TaskEither<AlexaApiError, void> {
    return this.setEndpointFeature({
      endpointId,
      featureName: 'mode',
      featureOperationName: 'setMode',
      instance,
      payload: { mode },
    });
  }

  // REVIEW: setDeviceRangeGraphQl — sends a setRangeValue operation. Unlike setDeviceModeGraphQl,
  // instance goes inside payload alongside value, matching the RangeController directive format.
  setDeviceRangeGraphQl(
    endpointId: string,
    instance: string,
    value: number,
  ): TaskEither<AlexaApiError, void> {
    return this.setEndpointFeature({
      endpointId,
      featureName: 'range',
      featureOperationName: 'setRangeValue',
      payload: { instance, value },
    });
  }

  setDeviceState(
    deviceId: string,
    action: SupportedActionsType,
    parameters: Record<string, string> = {},
    entityType: EntityType = 'APPLIANCE',
  ): TaskEither<AlexaApiError, void> {
    return pipe(
      TE.tryCatch(
        () =>
          this.changeDeviceState(
            deviceId,
            { action, ...parameters },
            entityType,
          ),
        (reason) =>
          new HttpError(
            `Error setting smart home device state. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
      TE.flatMapEither(validateSetStateSuccessful),
      TE.map(constVoid),
    );
  }

  private async executeGraphQlQuery<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const flags = {
      method: 'POST',
      data: JSON.stringify({
        query,
        variables,
      }),
    };
    return AlexaApiWrapper.toPromise<T>((cb) =>
      this.alexaRemote.httpsGet(false, '/nexus/v1/graphql', cb, flags),
    );
  }

  private changeDeviceState(
    entityId: string,
    parameters: Record<string, string>,
    entityType: EntityType = 'APPLIANCE',
  ): Promise<SetDeviceStateResponse> {
    return AlexaApiWrapper.toPromise<SetDeviceStateResponse>(
      this.alexaRemote.executeSmarthomeDeviceAction.bind(
        this.alexaRemote,
        [entityId],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters as any,
        entityType,
      ),
    );
  }

  private static async toPromise<T>(
    fn: (cb: CallbackWithErrorAndBody) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) =>
      fn((error, body) =>
        pipe(
          !!error,
          fpMatch(
            () => resolve(body as T),
            () => reject(error),
          ),
        ),
      ),
    );
  }

  private queryDeviceStates(
    entityIds: string[],
    entityType: string,
  ): TE.TaskEither<HttpError, GetDeviceStatesResponse> {
    return TE.tryCatch(
      () =>
        AlexaApiWrapper.toPromise<GetDeviceStatesResponse>(
          this.alexaRemote.querySmarthomeDevices.bind(
            this.alexaRemote,
            entityIds,
            entityType as EntityType,
          ),
        ),
      (reason) =>
        new HttpError(
          `Error getting smart home device state. Reason: ${
            (reason as Error).message
          }`,
        ),
    );
  }

  private doesCacheContainAllIds = (cachedIds: string[], queryIds: string[]) =>
    queryIds.every((id) => {
      return cachedIds.includes(id);
    });

  // REVIEW: getSmarthomeDevicesV2 — fetches Smart Home V2 device data including legacy appliance
  // capabilities JSON. This is the ONLY source of ModeController/RangeController capability info
  // (not available in the V1 EndpointsQuery). Used for fan control discovery at startup.
  private getSmarthomeDevicesV2(): TaskEither<
    AlexaApiError,
    SmarthomeDeviceV2[]
  > {
    return TE.tryCatch(
      () =>
        AlexaApiWrapper.toPromise<SmarthomeDeviceV2[]>((cb) =>
          this.alexaRemote.getSmarthomeDevicesV2(cb),
        ),
      (reason) =>
        new HttpError(
          `Error getting smarthome devices v2. Reason: ${
            (reason as Error).message
          }`,
        ),
    );
  }

  // REVIEW: discoverAndStoreFanControls — iterates devices of type FAN, looks up their V2 data,
  // parses legacyAppliances.capabilities (handles both string-JSON and already-parsed), runs
  // discoverFanControls() to match against known schemes, and populates deviceStore.fanControlsByDevice.
  private discoverAndStoreFanControls(
    devices: [Endpoint, SmartHomeDevice][],
    v2Devices: SmarthomeDeviceV2[],
  ): void {
    const controlsByDevice: Record<string, FanControls> = {};
    for (const [, device] of devices) {
      if (device.deviceType !== 'FAN') continue;
      const v2 = this.findV2Device(v2Devices, device);
      const raw = v2?.legacyAppliance?.capabilities;
      if (!raw) continue;
      let capabilities: AlexaCapability[];
      if (typeof raw === 'string') {
        try {
          capabilities = JSON.parse(raw) as AlexaCapability[];
        } catch {
          this.log.warn(
            `Failed to parse fan capabilities JSON for ${device.displayName}, treating as power-only`,
          )();
          continue;
        }
      } else {
        capabilities = raw;
      }
      controlsByDevice[device.id] = discoverFanControls(capabilities);
    }
    this.deviceStore.fanControlsByDevice = controlsByDevice;
  }

  // REVIEW: findV2Device — matches V2 devices to V1 devices by legacyAppliance.applianceKey first,
  // then falls back to case-insensitive friendlyName matching.
  private findV2Device(
    v2Devices: SmarthomeDeviceV2[],
    device: SmartHomeDevice,
  ): SmarthomeDeviceV2 | undefined {
    return (
      v2Devices.find((v) => v.legacyAppliance?.applianceKey === device.id) ??
      v2Devices.find(
        (v) =>
          v.friendlyName?.toLowerCase() === device.displayName.toLowerCase(),
      )
    );
  }

  // REVIEW: mergeCapabilityStates — merges incoming capability states with existing cache, keeping
  // states for feature/instance combinations not present in the incoming set. Prevents one feature
  // query (e.g. mode) from wiping states from another (e.g. power). Keyed by featureName|instance|name.
  private mergeCapabilityStates(
    existing: CapabilityState[],
    incoming: CapabilityState[],
  ): CapabilityState[] {
    const key = (cs: CapabilityState): string =>
      `${cs.featureName}|${cs.instance ?? null}|${cs.name ?? null}`;
    const incomingKeys = new Set(incoming.map(key));
    return [
      ...existing.filter((cs) => !incomingKeys.has(key(cs))),
      ...incoming,
    ];
  }
}
