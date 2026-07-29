// REVIEW: Test file significantly reorganized for fan control support:
//   - Imports: removed CallbackWithErrorAndBody, DeviceResponse, GetDeviceStatesResponse/DeviceStateResponse
//     (replaced by new GraphQL-based mode/range test patterns). Added HomebridgeAPI for constructor arity fix.
//     Added BodyCallback type alias for the alexa-remote2 callback pattern used in httpsGet mocking.
//   - Constructor: AlexaApiWrapper now takes Service as first arg (needed for getDeviceStateGraphQl),
//     DeviceStore no longer takes PluginLogger.
//   - Replaced 'getDeviceStates' describe block with 'setDeviceModeGraphQl', 'setDeviceRangeGraphQl',
//     and 'getDeviceModeStatesGraphQl' describe blocks testing the new fan control methods.
//   - Error message change: "Invalid list of Alexa devices found" changed to "No Alexa devices
//     were found" (cleaner, was misleading for empty responses).
import { randomUUID } from 'crypto';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { constVoid } from 'fp-ts/lib/function';
import { HomebridgeAPI } from 'homebridge/lib/api';
import AlexaRemote from 'alexa-remote2';
import {
  HttpError,
  InvalidResponse,
  RequestUnsuccessful,
} from '../domain/alexa/errors';
import { SmartHomeDevice } from '../domain/alexa/get-devices';
import SetDeviceStateResponse from '../domain/alexa/set-device-state';
import DeviceStore from '../store/device-store';
import { PluginLogger } from '../util/plugin-logger';
import { AlexaApiWrapper } from './alexa-api-wrapper';

jest.mock('alexa-remote2');

const alexaRemoteMocks = AlexaRemote as jest.MockedClass<typeof AlexaRemote>;

// REVIEW: BodyCallback type alias — captures the alexa-remote2 callback signature used by httpsGet
// (and other remote methods) for mocking in tests. Previously imported as CallbackWithErrorAndBody
// from 'alexa-remote2', but that type doesn't exist in all versions — local alias is simpler.
type BodyCallback = (err: Error | undefined, body?: unknown) => void;

describe('setDeviceState', () => {
  test('should set state successfully', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    mockAlexa.executeSmarthomeDeviceAction.mockImplementationOnce(
      (_1, _2, _3, cb) =>
        cb(undefined, {
          controlResponses: [{ code: 'SUCCESS' }],
        } as SetDeviceStateResponse),
    );

    // when
    const actual = wrapper.setDeviceState(randomUUID(), 'turnOff')();

    // then
    await expect(actual).resolves.toStrictEqual(E.of(constVoid()));
  });

  test('should return HttpError given HTTP error', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    mockAlexa.executeSmarthomeDeviceAction.mockImplementationOnce(
      (_1, _2, _3, cb) => cb(new Error('error for setDeviceState test')),
    );

    // when
    const actual = wrapper.setDeviceState(randomUUID(), 'turnOff')();

    // then
    await expect(actual).resolves.toStrictEqual(
      E.left(
        new HttpError(
          'Error setting smart home device state. Reason: error for setDeviceState test',
        ),
      ),
    );
  });

  test('should return RequestUnsuccessful given error code in response', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    mockAlexa.executeSmarthomeDeviceAction.mockImplementationOnce(
      (_1, _2, _3, cb) =>
        cb(undefined, {
          errors: [{ code: 'TestError' }],
        } as SetDeviceStateResponse),
    );

    // when
    const actual = wrapper.setDeviceState(randomUUID(), 'turnOff')();

    // then
    await expect(actual).resolves.toStrictEqual(
      E.left(
        new RequestUnsuccessful(
          `Error setting smart home device state. Response: ${JSON.stringify(
            {
              errors: [{ code: 'TestError' }],
            },
            undefined,
            2,
          )}`,
          'TestError',
        ),
      ),
    );
  });
});

// REVIEW: setDeviceModeGraphQl tests — verify the SetEndpointFeatures GraphQL mutation payload shape
// for mode controller operations. instance is at the top level (directive-level), mode value goes
// inside payload: { mode }. Also tests dual-layer error detection (top-level errors[] when data is null).
describe('setDeviceModeGraphQl', () => {
  test('sends setMode request with top-level instance and mode payload', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    let capturedData: string | undefined;
    mockAlexa.httpsGet.mockImplementationOnce((_noCheck, _path, cb, flags) => {
      capturedData = flags?.data;
      (cb as unknown as BodyCallback)(undefined, {
        data: { setEndpointFeatures: { errors: [] } },
      });
    });

    const endpointId = 'amzn1.alexa.endpoint.test';

    // when
    const actual = wrapper.setDeviceModeGraphQl(endpointId, '1', '4')();

    // then
    await expect(actual).resolves.toStrictEqual(E.of(constVoid()));

    const parsed = JSON.parse(capturedData!);
    expect(parsed.variables.featureControlRequests).toHaveLength(1);
    expect(parsed.variables.featureControlRequests[0]).toEqual({
      endpointId,
      featureName: 'mode',
      featureOperationName: 'setMode',
      instance: '1',
      payload: { mode: '4' },
    });
  });

  test('returns error when response has validation errors', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    mockAlexa.httpsGet.mockImplementationOnce((_noCheck, _path, cb, _flags) => {
      (cb as unknown as BodyCallback)(undefined, {
        data: null,
        errors: [{ message: 'Validation error of some kind' }],
      });
    });

    const endpointId = 'amzn1.alexa.endpoint.test';

    // when
    const result = await wrapper.setDeviceModeGraphQl(endpointId, '1', '4')();

    // then
    expect(E.isLeft(result)).toBe(true);
  });
});

// REVIEW: setDeviceRangeGraphQl tests — verify the SetEndpointFeatures GraphQL mutation payload shape
// for range controller operations. Unlike setMode, instance goes inside payload alongside value.
describe('setDeviceRangeGraphQl', () => {
  test('sends setRangeValue request with instance and value in payload', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    let capturedData: string | undefined;
    mockAlexa.httpsGet.mockImplementationOnce((_noCheck, _path, cb, flags) => {
      capturedData = flags?.data;
      (cb as unknown as BodyCallback)(undefined, {
        data: { setEndpointFeatures: { errors: [] } },
      });
    });

    const endpointId = 'amzn1.alexa.endpoint.test';

    // when
    const actual = wrapper.setDeviceRangeGraphQl(endpointId, '7', 42)();

    // then
    await expect(actual).resolves.toStrictEqual(E.of(constVoid()));

    const parsed = JSON.parse(capturedData!);
    expect(parsed.variables.featureControlRequests).toHaveLength(1);
    expect(parsed.variables.featureControlRequests[0]).toEqual({
      endpointId,
      featureName: 'range',
      featureOperationName: 'setRangeValue',
      payload: { instance: '7', value: 42 },
    });
  });
});

// REVIEW: getDeviceModeStatesGraphQl tests — verify mode state fetching via ModeQuery GraphQL,
// including merge behavior (mode states don't evict power states from cache) and cache fallback
// on GraphQL errors.
describe('getDeviceModeStatesGraphQl', () => {
  test('merges mode states with existing cache without evicting power', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    const device: SmartHomeDevice = {
      id: 'mode-fan-id',
      endpointId: 'amzn1.alexa.endpoint.mode-fan-id',
      displayName: 'test mode fan',
      supportedOperations: ['turnOn', 'turnOff'],
      enabled: true,
      deviceType: 'FAN',
      serialNumber: 'Unknown',
      model: 'Unknown',
      manufacturer: 'homebridge-alexa-smarthome',
    };

    // seed power state in cache
    const store = wrapper['deviceStore'] as DeviceStore;
    store.cache.states = {
      [device.id]: [O.of({ featureName: 'power', value: 'ON' })],
    };

    mockAlexa.httpsGet.mockImplementationOnce((_noCheck, _path, cb, _flags) => {
      (cb as unknown as BodyCallback)(undefined, {
        data: {
          endpoint: {
            features: [
              {
                name: 'mode',
                instance: '1',
                properties: [{ name: 'mode', modeValue: { value: '3' } }],
              },
            ],
          },
        },
      });
    });

    // when
    const result = await wrapper.getDeviceModeStatesGraphQl(device, false)();

    // then
    expect(E.isRight(result)).toBe(true);
    if (E.isRight(result)) {
      const [, states] = result.right;
      expect(states).toContainEqual({
        featureName: 'mode',
        name: 'mode',
        instance: '1',
        value: '3',
      });
    }

    const cached = store.getCacheStatesForDevice(device.id);
    expect(cached).toContainEqual({ featureName: 'power', value: 'ON' });
    expect(cached).toContainEqual({
      featureName: 'mode',
      name: 'mode',
      instance: '1',
      value: '3',
    });
  });

  test('returns cached states when mode query fails', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    const device: SmartHomeDevice = {
      id: 'mode-fan-id2',
      endpointId: 'amzn1.alexa.endpoint.mode-fan-id2',
      displayName: 'test mode fan 2',
      supportedOperations: ['turnOn', 'turnOff'],
      enabled: true,
      deviceType: 'FAN',
      serialNumber: 'Unknown',
      model: 'Unknown',
      manufacturer: 'homebridge-alexa-smarthome',
    };

    const store = wrapper['deviceStore'] as DeviceStore;
    store.cache.states = {
      [device.id]: [O.of({ featureName: 'power', value: 'ON' })],
    };

    mockAlexa.httpsGet.mockImplementationOnce((_noCheck, _path, cb, _flags) => {
      (cb as unknown as BodyCallback)(new Error('fragment not found'));
    });

    // when
    const result = await wrapper.getDeviceModeStatesGraphQl(device, false)();

    // then
    expect(E.isRight(result)).toBe(true);
    if (E.isRight(result)) {
      const [fromCache, states] = result.right;
      expect(fromCache).toBe(true);
      expect(states).toContainEqual({ featureName: 'power', value: 'ON' });
    }
  });
  test('returns cached states when response has null data (unverified fragment)', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    const device: SmartHomeDevice = {
      id: 'mode-fan-id3',
      endpointId: 'amzn1.alexa.endpoint.mode-fan-id3',
      displayName: 'test mode fan 3',
      supportedOperations: ['turnOn', 'turnOff'],
      enabled: true,
      deviceType: 'FAN',
      serialNumber: 'Unknown',
      model: 'Unknown',
      manufacturer: 'homebridge-alexa-smarthome',
    };

    const store = wrapper['deviceStore'] as DeviceStore;
    store.cache.states = {
      [device.id]: [O.of({ featureName: 'power', value: 'ON' })],
    };

    // GraphQL returns { data: null } when the ... on Mode fragment is invalid
    mockAlexa.httpsGet.mockImplementationOnce((_noCheck, _path, cb, _flags) => {
      (cb as unknown as BodyCallback)(undefined, { data: null });
    });

    // when — must not throw
    const result = await wrapper.getDeviceModeStatesGraphQl(device, false)();

    // then — returns Right with cache preserved (no mode states, power intact)
    expect(E.isRight(result)).toBe(true);
    if (E.isRight(result)) {
      const [fromCache, states] = result.right;
      expect(fromCache).toBe(true);
      expect(states).toContainEqual({ featureName: 'power', value: 'ON' });
    }
  });
});

describe('getDevices', () => {
  test('should return error given empty response', async () => {
    // given
    const wrapper = getAlexaApiWrapper();
    const mockAlexa = getMockedAlexaRemote();
    mockAlexa.httpsGet.mockImplementationOnce((_noCheck, _path, cb, _flags) => {
      (cb as unknown as BodyCallback)(undefined, undefined);
    });

    // when
    const actual = wrapper.getDevices()();

    // then
    await expect(actual).resolves.toStrictEqual(
      E.left(
        new InvalidResponse(
          'No Alexa devices were found for the current Alexa account',
        ),
      ),
    );
  });
});

// REVIEW: getAlexaApiWrapper factory — now creates HomebridgeAPI().hap.Service for the new constructor
// first argument, and DeviceStore() without PluginLogger arg (matching new constructor signature).
function getAlexaApiWrapper(): AlexaApiWrapper {
  const log = new PluginLogger(
    global.MockLogger,
    global.createPlatformConfig(),
  );
  const Service = new HomebridgeAPI().hap.Service;
  return new AlexaApiWrapper(
    Service,
    new AlexaRemote(),
    log,
    new DeviceStore(),
  );
}

function getMockedAlexaRemote(): jest.Mocked<AlexaRemote> {
  return alexaRemoteMocks.mock.instances[0] as jest.Mocked<AlexaRemote>;
}
