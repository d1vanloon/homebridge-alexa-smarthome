// REVIEW: Test changes for fan control support:
//   - Constructor: DeviceStore() no longer takes PluginLogger (the constructor only uses
//     optional performanceSettings now). Removed the getPluginLogger() helper.
//   - Cache key migration: tests changed from 'namespace' to 'featureName' to match the
//     current CapabilityState shape (namespace was removed in a prior refactor).
//   - New upsertCacheValue describe block: tests insert (absent state), replace (same key),
//     and multi-instance (different instance = different entry) behavior of the new upsert
//     method used by fan control SET operations.
import { randomUUID } from 'crypto';
import * as O from 'fp-ts/Option';
import DeviceStore from './device-store';

describe('updateCacheValue', () => {
  test('should update given device and feature were previously cached', () => {
    // given
    const deviceId = randomUUID();
    const store = new DeviceStore();
    store.cache.states = {
      [deviceId]: [
        O.of({
          featureName: 'power',
          value: true,
        }),
      ],
    };

    // when
    const cache = store.updateCacheValue(deviceId, {
      featureName: 'power',
      value: false,
    });

    // then
    expect(cache[deviceId].length).toBe(1);
    expect(
      O.Functor.map(cache[deviceId][0], ({ value }) => value),
    ).toStrictEqual(O.of(false));
  });

  test('should not update given no previous value', () => {
    // given
    // REVIEW: Constructor arity change — DeviceStore() no longer takes PluginLogger. The logger
    // was previously used in DeviceStore but has been removed.
    const deviceId = randomUUID();
    const store = new DeviceStore();
    store.cache.states = {
      [deviceId]: [
        O.of({
          featureName: 'power',
          value: true,
        }),
      ],
    };

    // when
    const cache = store.updateCacheValue(deviceId, {
      // REVIEW: namespace → featureName migration — test key changed from 'namespace' to 'featureName'
      // to match the current CapabilityState interface shape.
      featureName: 'brightness',
      value: 100,
    });

    // then
    expect(cache[deviceId].length).toBe(1);
    expect(
      O.Functor.map(cache[deviceId][0], ({ value }) => value),
    ).toStrictEqual(O.of(true));
  });
});

// REVIEW: upsertCacheValue tests — new describe block covering the insert-or-update semantics
// needed for fan control state cache management. Unlike updateCacheValue (which only patches
// existing entries), upsertCacheValue adds entries that don't yet exist.
describe('upsertCacheValue', () => {
  test('inserts an absent mode state', () => {
    // given
    const deviceId = randomUUID();
    const store = new DeviceStore();
    store.cache.states = {
      [deviceId]: [O.of({ featureName: 'power', value: 'ON' })],
    };

    // when
    const cache = store.upsertCacheValue(deviceId, {
      featureName: 'mode',
      name: 'mode',
      instance: '1',
      value: '3',
    });

    // then
    expect(cache[deviceId].length).toBe(2);
    expect(cache[deviceId][1]).toStrictEqual(
      O.of({ featureName: 'mode', name: 'mode', instance: '1', value: '3' }),
    );
  });

  test('replaces an existing state with same featureName, instance, and name', () => {
    // given
    const deviceId = randomUUID();
    const store = new DeviceStore();
    store.cache.states = {
      [deviceId]: [
        O.of({ featureName: 'mode', name: 'mode', instance: '1', value: '2' }),
      ],
    };

    // when
    const cache = store.upsertCacheValue(deviceId, {
      featureName: 'mode',
      name: 'mode',
      instance: '1',
      value: '3',
    });

    // then
    expect(cache[deviceId].length).toBe(1);
    expect(cache[deviceId][0]).toStrictEqual(
      O.of({ featureName: 'mode', name: 'mode', instance: '1', value: '3' }),
    );
  });

  test('does not replace a different instance', () => {
    // given
    const deviceId = randomUUID();
    const store = new DeviceStore();
    store.cache.states = {
      [deviceId]: [
        O.of({ featureName: 'mode', name: 'mode', instance: '1', value: '2' }),
      ],
    };

    // when
    const cache = store.upsertCacheValue(deviceId, {
      featureName: 'mode',
      name: 'mode',
      instance: '2',
      value: '3',
    });

    // then
    expect(cache[deviceId].length).toBe(2);
  });
});
