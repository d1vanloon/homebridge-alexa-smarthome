// REVIEW: Unit tests for the fan control discovery and scheme matching logic.
// Covers: emptyFanControls when no capabilities match, vornado-transom-mode-fan scheme
// (4-mode speed + 2-mode direction via ModeController), generic-range-speed-fan scheme
// (RangeController speed + optional ModeController direction), mode→HomeKit value mapping,
// and the homeKit→Alexa reverse mapping with discretization.

import * as O from 'fp-ts/Option';
import {
  AlexaCapability,
  discoverFanControls,
  emptyFanControls,
} from './fan-controls';

const textName = (text: string) => ({
  '@type': 'text' as const,
  value: { text },
});

const modeResource = (value: string, labels: string[]) => ({
  value,
  modeResources: {
    friendlyNames: labels.map(textName),
  },
});

const speedModeCapability = (): AlexaCapability => ({
  interfaceName: 'Alexa.ModeController',
  instance: '1',
  resources: { friendlyNames: [textName('Fan Speed'), textName('Speed')] },
  configuration: {
    ordered: true,
    supportedModes: [
      modeResource('1', ['Low', 'Minimum', 'Min']),
      modeResource('2', ['Medium']),
      modeResource('3', ['High']),
      modeResource('4', ['Turbo', 'Maximum', 'Max']),
    ],
  },
  properties: { readOnly: false, supported: [{ name: 'mode' }] },
});

const directionModeCapability = (): AlexaCapability => ({
  interfaceName: 'Alexa.ModeController',
  instance: '2',
  resources: { friendlyNames: [textName('Direction'), textName('Wind')] },
  configuration: {
    ordered: true,
    supportedModes: [
      modeResource('1', ['Exhaust', 'Outlet']),
      modeResource('2', ['Direct', 'inlet']),
    ],
  },
  properties: { readOnly: false, supported: [{ name: 'mode' }] },
});

const setTemperatureCapability = (): AlexaCapability => ({
  interfaceName: 'Alexa.RangeController',
  instance: '3',
  resources: {
    friendlyNames: [textName('Set Temperature'), textName('Temperature')],
  },
  configuration: {
    supportedRange: { minimumValue: 60, maximumValue: 90, precision: 1 },
  },
  properties: { readOnly: false },
});

const airTemperatureCapability = (): AlexaCapability => ({
  interfaceName: 'Alexa.RangeController',
  instance: '5',
  resources: { friendlyNames: [textName('Air Temperature')] },
  configuration: {
    supportedRange: { minimumValue: 0, maximumValue: 100, precision: 1 },
  },
  properties: { readOnly: true },
});

const autoToggleCapability = (): AlexaCapability => ({
  interfaceName: 'Alexa.ToggleController',
  instance: '4',
  resources: { friendlyNames: [textName('Auto'), textName('Automatic')] },
});

const bedroomFanCapabilities = (): AlexaCapability[] => [
  { interfaceName: 'Alexa.PowerController', properties: { readOnly: false } },
  speedModeCapability(),
  directionModeCapability(),
  setTemperatureCapability(),
  airTemperatureCapability(),
  autoToggleCapability(),
];

const rangeSpeedCapability = (
  instance: string,
  min: number,
  max: number,
  precision: number,
  friendlyName = 'Fan Speed',
): AlexaCapability => ({
  interfaceName: 'Alexa.RangeController',
  instance,
  resources: { friendlyNames: [textName(friendlyName)] },
  configuration: {
    supportedRange: { minimumValue: min, maximumValue: max, precision },
  },
  properties: { readOnly: false },
});

describe('discoverFanControls — Vornado mode fan', () => {
  const controls = discoverFanControls(bedroomFanCapabilities());

  test('returns vornado-transom-mode-fan scheme', () => {
    expect(controls.schemeName).toBe('vornado-transom-mode-fan');
  });

  test('discovers speed and direction', () => {
    expect(O.isSome(controls.speed)).toBe(true);
    expect(O.isSome(controls.direction)).toBe(true);
  });

  test('speed maps Alexa modes to 25/50/75/100', () => {
    const speed = controls.speed;
    if (O.isSome(speed)) {
      const ctrl = speed.value;
      expect(ctrl.type).toBe('mode');
      if (ctrl.type === 'mode') {
        expect(ctrl.alexaToHomeKit).toEqual({
          '1': 25,
          '2': 50,
          '3': 75,
          '4': 100,
        });
        expect(ctrl.instance).toBe('1');
        expect(ctrl.defaultHomeKitValue).toBe(25);
      }
    }
  });

  test('speed homeKitToAlexa maps to nearest mode', () => {
    const speed = controls.speed;
    if (O.isSome(speed) && speed.value.type === 'mode') {
      const fn = speed.value.homeKitToAlexa;
      expect(fn(1)).toStrictEqual(O.of('1'));
      expect(fn(25)).toStrictEqual(O.of('1'));
      expect(fn(37)).toStrictEqual(O.of('1'));
      expect(fn(38)).toStrictEqual(O.of('2'));
      expect(fn(62)).toStrictEqual(O.of('2'));
      expect(fn(63)).toStrictEqual(O.of('3'));
      expect(fn(87)).toStrictEqual(O.of('3'));
      expect(fn(88)).toStrictEqual(O.of('4'));
      expect(fn(100)).toStrictEqual(O.of('4'));
    }
  });

  test('speed homeKitToAlexa returns none for 0 and out of range', () => {
    const speed = controls.speed;
    if (O.isSome(speed) && speed.value.type === 'mode') {
      const fn = speed.value.homeKitToAlexa;
      expect(fn(0)).toStrictEqual(O.none);
      expect(fn(-1)).toStrictEqual(O.none);
      expect(fn(101)).toStrictEqual(O.none);
    }
  });

  test('direction maps Alexa mode 1 to 1 and mode 2 to 0', () => {
    const direction = controls.direction;
    if (O.isSome(direction) && direction.value.type === 'mode') {
      expect(direction.value.alexaToHomeKit).toEqual({ '1': 1, '2': 0 });
      expect(direction.value.instance).toBe('2');
      expect(direction.value.defaultHomeKitValue).toBe(0);
    }
  });

  test('direction homeKitToAlexa maps 0 to mode 2 and 1 to mode 1', () => {
    const direction = controls.direction;
    if (O.isSome(direction) && direction.value.type === 'mode') {
      const fn = direction.value.homeKitToAlexa;
      expect(fn(0)).toStrictEqual(O.of('2'));
      expect(fn(1)).toStrictEqual(O.of('1'));
      expect(fn(2)).toStrictEqual(O.none);
    }
  });
});

describe('discoverFanControls — range speed fan (0..100)', () => {
  const controls = discoverFanControls([rangeSpeedCapability('7', 0, 100, 1)]);

  test('returns generic-range-speed-fan scheme', () => {
    expect(controls.schemeName).toBe('generic-range-speed-fan');
  });

  test('discovers range speed', () => {
    expect(O.isSome(controls.speed)).toBe(true);
    expect(O.isSome(controls.direction)).toBe(false);
  });

  test('speed type is range', () => {
    const speed = controls.speed;
    if (O.isSome(speed)) {
      expect(speed.value.type).toBe('range');
    }
  });

  test('speed maps Alexa 0/50/100 directly to HomeKit 0/50/100', () => {
    const speed = controls.speed;
    if (O.isSome(speed) && speed.value.type === 'range') {
      expect(speed.value.alexaToHomeKit(0)).toBe(0);
      expect(speed.value.alexaToHomeKit(50)).toBe(50);
      expect(speed.value.alexaToHomeKit(100)).toBe(100);
    }
  });

  test('speed maps HomeKit 0/50/100 directly to Alexa 0/50/100', () => {
    const speed = controls.speed;
    if (O.isSome(speed) && speed.value.type === 'range') {
      expect(speed.value.homeKitToAlexa(0)).toStrictEqual(O.of(0));
      expect(speed.value.homeKitToAlexa(50)).toStrictEqual(O.of(50));
      expect(speed.value.homeKitToAlexa(100)).toStrictEqual(O.of(100));
    }
  });
});

describe('discoverFanControls — range speed fan (1..4)', () => {
  const controls = discoverFanControls([rangeSpeedCapability('7', 1, 4, 1)]);

  test('speed homeKitToAlexa returns none for 0 (min > 0)', () => {
    const speed = controls.speed;
    if (O.isSome(speed) && speed.value.type === 'range') {
      expect(speed.value.homeKitToAlexa(0)).toStrictEqual(O.none);
    }
  });

  test('speed maps HomeKit 25/50/75/100 to Alexa 2/3/3/4', () => {
    const speed = controls.speed;
    if (O.isSome(speed) && speed.value.type === 'range') {
      expect(speed.value.homeKitToAlexa(25)).toStrictEqual(O.of(2));
      expect(speed.value.homeKitToAlexa(50)).toStrictEqual(O.of(3));
      expect(speed.value.homeKitToAlexa(75)).toStrictEqual(O.of(3));
      expect(speed.value.homeKitToAlexa(100)).toStrictEqual(O.of(4));
    }
  });

  test('speed maps Alexa 1/4 to HomeKit 0/100', () => {
    const speed = controls.speed;
    if (O.isSome(speed) && speed.value.type === 'range') {
      expect(speed.value.alexaToHomeKit(1)).toBe(0);
      expect(speed.value.alexaToHomeKit(4)).toBe(100);
    }
  });
});

describe('discoverFanControls — rejects non-speed ranges', () => {
  test('rejects Set Temperature range', () => {
    const controls = discoverFanControls([setTemperatureCapability()]);
    expect(controls).toBe(emptyFanControls);
  });

  test('rejects Air Temperature range even with 0..100', () => {
    const controls = discoverFanControls([airTemperatureCapability()]);
    expect(controls).toBe(emptyFanControls);
  });
});

describe('discoverFanControls — partial controls', () => {
  test('missing speed, direction only', () => {
    const controls = discoverFanControls([
      { interfaceName: 'Alexa.PowerController' },
      directionModeCapability(),
    ]);
    expect(controls.schemeName).toBe('vornado-transom-mode-fan');
    expect(O.isSome(controls.speed)).toBe(false);
    expect(O.isSome(controls.direction)).toBe(true);
  });

  test('speed only, missing direction', () => {
    const controls = discoverFanControls([
      { interfaceName: 'Alexa.PowerController' },
      speedModeCapability(),
    ]);
    expect(controls.schemeName).toBe('vornado-transom-mode-fan');
    expect(O.isSome(controls.speed)).toBe(true);
    expect(O.isSome(controls.direction)).toBe(false);
  });
});

describe('discoverFanControls — range speed + mode direction', () => {
  test('uses generic range scheme, not Vornado, when speed is range-based', () => {
    const controls = discoverFanControls([
      { interfaceName: 'Alexa.PowerController' },
      rangeSpeedCapability('7', 0, 100, 1),
      directionModeCapability(),
    ]);
    expect(controls.schemeName).toBe('generic-range-speed-fan');
    expect(O.isSome(controls.speed)).toBe(true);
    expect(O.isSome(controls.direction)).toBe(true);
    if (O.isSome(controls.speed)) {
      expect(controls.speed.value.type).toBe('range');
    }
  });
});
