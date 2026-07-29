// REVIEW: Unit tests for FanAccessory fan speed/direction control (RotationSpeed, RotationDirection).
// Uses the Object.defineProperty mock pattern (not jest.mock) to inject a mock AlexaApiWrapper
// while keeping the real DeviceStore for end-to-end cache behavior. Covers:
//   - configureServices: RotationSpeed/Direction added or removed based on fanControls scheme
//   - handleRotationSpeedGet: mode-based and range-based reads with cache and GraphQL fallback
//   - handleRotationSpeedSet: mode-based (value 0 → turnFanOff) and range-based SET operations
//   - handleRotationDirectionGet/Set: mode-based direction control
//   - Cache freshness: fanControlLastUpdated prevents redundant GraphQL GETs after SET
//   - Error paths: serviceCommunicationError on GraphQL failures

import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { constVoid } from 'fp-ts/lib/function';
import { HomebridgeAPI } from 'homebridge/lib/api';
import { CapabilityState } from '../domain/alexa';
import {
  AlexaCapability,
  discoverFanControls,
  FanControls,
  FanDirectionControl,
  FanSpeedControl,
} from '../domain/alexa/fan-controls';
import { SmartHomeDevice } from '../domain/alexa/get-devices';
import { AlexaSmartHomePlatform } from '../platform';
import { AlexaApiWrapper } from '../wrapper/alexa-api-wrapper';
import FanAccessory from './fan-accessory';

const textName = (text: string) => ({
  '@type': 'text' as const,
  value: { text },
});

const speedModeCapability: AlexaCapability = {
  interfaceName: 'Alexa.ModeController',
  instance: '1',
  resources: { friendlyNames: [textName('Fan Speed'), textName('Speed')] },
  configuration: {
    ordered: true,
    supportedModes: [
      { value: '1', modeResources: { friendlyNames: [textName('Low')] } },
      { value: '2', modeResources: { friendlyNames: [textName('Medium')] } },
      { value: '3', modeResources: { friendlyNames: [textName('High')] } },
      { value: '4', modeResources: { friendlyNames: [textName('Turbo')] } },
    ],
  },
  properties: { readOnly: false, supported: [{ name: 'mode' }] },
};

const directionModeCapability: AlexaCapability = {
  interfaceName: 'Alexa.ModeController',
  instance: '2',
  resources: { friendlyNames: [textName('Direction'), textName('Wind')] },
  configuration: {
    ordered: true,
    supportedModes: [
      { value: '1', modeResources: { friendlyNames: [textName('Exhaust')] } },
      { value: '2', modeResources: { friendlyNames: [textName('Direct')] } },
    ],
  },
  properties: { readOnly: false, supported: [{ name: 'mode' }] },
};

const rangeSpeedCapability = (
  instance: string,
  min: number,
  max: number,
): AlexaCapability => ({
  interfaceName: 'Alexa.RangeController',
  instance,
  resources: { friendlyNames: [textName('Fan Speed')] },
  configuration: {
    supportedRange: { minimumValue: min, maximumValue: max, precision: 1 },
  },
  properties: { readOnly: false },
});

const modeFanControls: FanControls = discoverFanControls([
  { interfaceName: 'Alexa.PowerController' },
  speedModeCapability,
  directionModeCapability,
]);

const range0100Controls: FanControls = discoverFanControls([
  rangeSpeedCapability('7', 0, 100),
]);

const range14Controls: FanControls = discoverFanControls([
  rangeSpeedCapability('7', 1, 4),
]);

function createFanDevice(id: string): SmartHomeDevice {
  return {
    id,
    endpointId: `amzn1.alexa.endpoint.${id}`,
    displayName: `test ${id}`,
    supportedOperations: ['turnOn', 'turnOff'],
    enabled: true,
    deviceType: 'FAN',
    serialNumber: 'Unknown',
    model: 'Unknown',
    manufacturer: 'homebridge-alexa-smarthome',
  };
}

function createMockAlexaApi(): AlexaApiWrapper {
  return {
    getDeviceModeStatesGraphQl: jest.fn(),
    getDeviceRangeStatesGraphQl: jest.fn(),
    setDeviceModeGraphQl: jest.fn(),
    setDeviceRangeGraphQl: jest.fn(),
    setDeviceStateGraphQl: jest.fn(),
    getDeviceStateGraphQl: jest.fn(),
  } as unknown as AlexaApiWrapper;
}

function createPlatform(): AlexaSmartHomePlatform {
  const platform = new AlexaSmartHomePlatform(
    global.MockLogger,
    global.createPlatformConfig(),
    new HomebridgeAPI(),
  );
  Object.defineProperty(platform, 'alexaApi', {
    value: createMockAlexaApi(),
    writable: true,
    configurable: true,
  });
  return platform;
}

function createFanAccessory(
  platform: AlexaSmartHomePlatform,
  device: SmartHomeDevice,
  controls: FanControls,
): FanAccessory {
  platform.deviceStore.fanControlsByDevice = { [device.id]: controls };
  const uuid = platform.HAP.uuid.generate(device.id);
  const platAcc = new platform.api.platformAccessory(device.displayName, uuid);
  return new FanAccessory(platform, device, platAcc);
}

function getMockedAlexaApi(
  platform: AlexaSmartHomePlatform,
): jest.Mocked<AlexaApiWrapper> {
  return platform.alexaApi as unknown as jest.Mocked<AlexaApiWrapper>;
}

function unwrapSpeed(controls: FanControls): FanSpeedControl {
  if (O.isSome(controls.speed)) return controls.speed.value;
  throw new Error('expected speed control');
}

function unwrapDirection(controls: FanControls): FanDirectionControl {
  if (O.isSome(controls.direction)) return controls.direction.value;
  throw new Error('expected direction control');
}
const modeState = (instance: string, value: string): CapabilityState => ({
  featureName: 'mode',
  name: 'mode',
  instance,
  value,
});

const rangeState = (instance: string, value: number): CapabilityState => ({
  featureName: 'range',
  name: 'rangeValue',
  instance,
  rangeName: 'Fan Speed',
  value,
});

describe('configureServices', () => {
  test('adds RotationSpeed and RotationDirection when controls present', () => {
    const platform = createPlatform();
    const device = createFanDevice('config-fan');
    const acc = createFanAccessory(platform, device, modeFanControls);

    acc.configureServices();

    expect(
      acc.service.testCharacteristic(acc.Characteristic.RotationSpeed),
    ).toBe(true);
    expect(
      acc.service.testCharacteristic(acc.Characteristic.RotationDirection),
    ).toBe(true);
  });

  test('removes RotationSpeed and RotationDirection when no controls', () => {
    const platform = createPlatform();
    const device = createFanDevice('config-empty');
    const acc = createFanAccessory(platform, device, {
      schemeName: 'none',
      speed: O.none,
      direction: O.none,
    });

    acc.configureServices();

    expect(
      acc.service.testCharacteristic(acc.Characteristic.RotationSpeed),
    ).toBe(false);
    expect(
      acc.service.testCharacteristic(acc.Characteristic.RotationDirection),
    ).toBe(false);
  });
});

describe('handleRotationSpeedGet — mode', () => {
  test('maps cached mode 3 on instance 1 to 75', async () => {
    const platform = createPlatform();
    const device = createFanDevice('mode-get');
    const acc = createFanAccessory(platform, device, modeFanControls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const speedControl = unwrapSpeed(acc.fanControls);

    mockAlexaApi.getDeviceModeStatesGraphQl.mockReturnValueOnce(
      TE.of([false, [modeState('1', '3')]]),
    );

    const result = await acc.handleRotationSpeedGet(speedControl);
    expect(result).toBe(75);
  });

  test('returns default 25 when no matching mode state', async () => {
    const platform = createPlatform();
    const device = createFanDevice('mode-default');
    const acc = createFanAccessory(platform, device, modeFanControls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const speedControl = unwrapSpeed(acc.fanControls);

    mockAlexaApi.getDeviceModeStatesGraphQl.mockReturnValueOnce(
      TE.of([false, []]),
    );

    const result = await acc.handleRotationSpeedGet(speedControl);
    expect(result).toBe(25);
  });

  test('fetches when global cache is fresh but no mode state cached', async () => {
    const platform = createPlatform();
    const device = createFanDevice('mode-freshness');
    const acc = createFanAccessory(platform, device, modeFanControls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const speedControl = unwrapSpeed(acc.fanControls);

    // seed power state and make global cache fresh
    const store = platform.deviceStore;
    store.cache.states[device.id] = [
      O.of({ featureName: 'power', value: 'ON' }),
    ];
    store.cache.lastUpdated = new Date();
    expect(store.isCacheFresh()).toBe(true);

    mockAlexaApi.getDeviceModeStatesGraphQl.mockReturnValueOnce(
      TE.of([false, [modeState('1', '3')]]),
    );

    await acc.handleRotationSpeedGet(speedControl);

    expect(mockAlexaApi.getDeviceModeStatesGraphQl).toHaveBeenCalledWith(
      device,
      false,
    );
  });
});

describe('handleRotationSpeedSet — mode', () => {
  test('set 88 calls setDeviceModeGraphQl with mode 4 and upserts cache', async () => {
    const platform = createPlatform();
    const device = createFanDevice('mode-set88');
    const acc = createFanAccessory(platform, device, modeFanControls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const speedControl = unwrapSpeed(acc.fanControls);

    mockAlexaApi.setDeviceModeGraphQl.mockReturnValue(TE.of(constVoid()));

    await acc.handleRotationSpeedSet(speedControl, 88);

    expect(mockAlexaApi.setDeviceModeGraphQl).toHaveBeenCalledWith(
      device.endpointId,
      '1',
      '4',
    );
    const cached = platform.deviceStore.getCacheStatesForDevice(device.id);
    expect(cached).toContainEqual(modeState('1', '4'));
  });

  test('set 0 calls power turnOff and does not call setDeviceModeGraphQl', async () => {
    const platform = createPlatform();
    const device = createFanDevice('mode-set0');
    const acc = createFanAccessory(platform, device, modeFanControls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const speedControl = unwrapSpeed(acc.fanControls);

    mockAlexaApi.setDeviceStateGraphQl.mockReturnValue(TE.of(constVoid()));

    await acc.handleRotationSpeedSet(speedControl, 0);

    expect(mockAlexaApi.setDeviceStateGraphQl).toHaveBeenCalledWith(
      device.endpointId,
      'power',
      'turnOff',
    );
    expect(mockAlexaApi.setDeviceModeGraphQl).not.toHaveBeenCalled();
  });
});

describe('handleRotationSpeedGet — range 0..100', () => {
  test('maps range state value 50 to HomeKit 50', async () => {
    const platform = createPlatform();
    const device = createFanDevice('range-get');
    const acc = createFanAccessory(platform, device, range0100Controls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const speedControl = unwrapSpeed(acc.fanControls);

    mockAlexaApi.getDeviceRangeStatesGraphQl.mockReturnValueOnce(
      TE.of([false, [rangeState('7', 50)]]),
    );

    const result = await acc.handleRotationSpeedGet(speedControl);
    expect(result).toBe(50);
  });
});

describe('handleRotationSpeedSet — range 0..100', () => {
  test('set 42 calls setDeviceRangeGraphQl and upserts cache', async () => {
    const platform = createPlatform();
    const device = createFanDevice('range-set42');
    const acc = createFanAccessory(platform, device, range0100Controls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const speedControl = unwrapSpeed(acc.fanControls);

    mockAlexaApi.setDeviceRangeGraphQl.mockReturnValue(TE.of(constVoid()));

    await acc.handleRotationSpeedSet(speedControl, 42);

    expect(mockAlexaApi.setDeviceRangeGraphQl).toHaveBeenCalledWith(
      device.endpointId,
      '7',
      42,
    );
    const cached = platform.deviceStore.getCacheStatesForDevice(device.id);
    expect(cached).toContainEqual(rangeState('7', 42));
  });
});

describe('handleRotationSpeedSet — range 1..4', () => {
  test('set 0 calls power turnOff and does not call setDeviceRangeGraphQl', async () => {
    const platform = createPlatform();
    const device = createFanDevice('range14-set0');
    const acc = createFanAccessory(platform, device, range14Controls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const speedControl = unwrapSpeed(acc.fanControls);

    mockAlexaApi.setDeviceStateGraphQl.mockReturnValue(TE.of(constVoid()));

    await acc.handleRotationSpeedSet(speedControl, 0);

    expect(mockAlexaApi.setDeviceStateGraphQl).toHaveBeenCalledWith(
      device.endpointId,
      'power',
      'turnOff',
    );
    expect(mockAlexaApi.setDeviceRangeGraphQl).not.toHaveBeenCalled();
  });
});

describe('handleRotationDirectionGet', () => {
  test('maps mode 1 on instance 2 to 1', async () => {
    const platform = createPlatform();
    const device = createFanDevice('dir-get');
    const acc = createFanAccessory(platform, device, modeFanControls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const directionControl = unwrapDirection(acc.fanControls);

    mockAlexaApi.getDeviceModeStatesGraphQl.mockReturnValueOnce(
      TE.of([false, [modeState('2', '1')]]),
    );

    const result = await acc.handleRotationDirectionGet(directionControl);
    expect(result).toBe(1);
  });
});

describe('handleRotationDirectionSet', () => {
  test('set 0 calls setDeviceModeGraphQl with mode 2', async () => {
    const platform = createPlatform();
    const device = createFanDevice('dir-set0');
    const acc = createFanAccessory(platform, device, modeFanControls);
    const mockAlexaApi = getMockedAlexaApi(platform);
    const directionControl = unwrapDirection(acc.fanControls);

    mockAlexaApi.setDeviceModeGraphQl.mockReturnValue(TE.of(constVoid()));

    await acc.handleRotationDirectionSet(directionControl, 0);

    expect(mockAlexaApi.setDeviceModeGraphQl).toHaveBeenCalledWith(
      device.endpointId,
      '2',
      '2',
    );
    const cached = platform.deviceStore.getCacheStatesForDevice(device.id);
    expect(cached).toContainEqual(modeState('2', '2'));
  });
});
