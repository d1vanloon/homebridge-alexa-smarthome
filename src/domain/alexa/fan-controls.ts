// REVIEW: New domain module for discovering and modeling fan controls (speed and direction) from
// Alexa Smart Home V2 device capabilities. Two control types are supported:
//   - Mode-based (FanModeControl): Alexa.ModeController with discrete modes (e.g. Low/Med/High/Turbo)
//     mapped to HomeKit RotationSpeed percentages or RotationDirection.
//   - Range-based (FanRangeSpeedControl): Alexa.RangeController with continuous range (min–max)
//     mapped to HomeKit RotationSpeed.
// Discovery uses a priority-ordered scheme list (vornado-transom-mode-fan first, then generic-range-speed-fan)
// to match device capabilities against known fan control patterns. Unmatched fans get power-only support.

import * as O from 'fp-ts/Option';

interface FanModeControl {
  readonly type: 'mode';
  readonly characteristic: 'RotationSpeed' | 'RotationDirection';
  readonly featureName: 'mode';
  readonly operationName: 'setMode';
  readonly instance: string;
  readonly defaultHomeKitValue: number;
  readonly alexaToHomeKit: Readonly<Record<string, number>>;
  readonly homeKitToAlexa: (value: number) => O.Option<string>;
}

interface FanRangeSpeedControl {
  readonly type: 'range';
  readonly characteristic: 'RotationSpeed';
  readonly featureName: 'range';
  readonly operationName: 'setRangeValue';
  readonly instance: string;
  readonly rangeName: string;
  readonly minimumValue: number;
  readonly maximumValue: number;
  readonly precision: number;
  readonly defaultHomeKitValue: number;
  readonly alexaToHomeKit: (value: number) => number;
  readonly homeKitToAlexa: (value: number) => O.Option<number>;
}

export type FanSpeedControl = FanModeControl | FanRangeSpeedControl;

export type FanDirectionControl = FanModeControl;

export interface FanControls {
  readonly schemeName: string;
  readonly speed: O.Option<FanSpeedControl>;
  readonly direction: O.Option<FanDirectionControl>;
}

interface FanControlScheme {
  readonly name: string;
  readonly discover: (
    capabilities: readonly AlexaCapability[],
  ) => O.Option<FanControls>;
}

interface AlexaFriendlyName {
  readonly '@type'?: 'asset' | 'text';
  readonly value: {
    readonly text?: string;
    readonly assetId?: string;
  };
}

interface AlexaModeResource {
  readonly value: string;
  readonly modeResources?: {
    readonly friendlyNames?: AlexaFriendlyName[];
  };
}

interface AlexaSupportedRange {
  readonly minimumValue: number;
  readonly maximumValue: number;
  readonly precision?: number;
}

export interface AlexaCapability {
  readonly interfaceName: string;
  readonly instance?: string;
  readonly resources?: {
    readonly friendlyNames?: AlexaFriendlyName[];
  };
  readonly configuration?: {
    readonly ordered?: boolean;
    readonly supportedModes?: AlexaModeResource[];
    readonly supportedRange?: AlexaSupportedRange;
    readonly presets?: unknown[];
  };
  readonly properties?: {
    readonly readOnly?: boolean;
    readonly supported?: ReadonlyArray<{ readonly name: string }>;
  };
}

export interface SmarthomeDeviceV2 {
  readonly friendlyName?: string;
  readonly legacyAppliance?: {
    readonly applianceKey?: string;
    readonly capabilities?: AlexaCapability[] | string;
  };
}

export const emptyFanControls: FanControls = {
  schemeName: 'none',
  speed: O.none,
  direction: O.none,
};

const normalizeFanLabel = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const friendlyNames = (capability: AlexaCapability): string[] =>
  (capability.resources?.friendlyNames ?? []).flatMap((fn) => {
    const names: string[] = [];
    if (fn.value?.text) {
      names.push(normalizeFanLabel(fn.value.text));
    }
    if (fn.value?.assetId) {
      names.push(normalizeFanLabel(fn.value.assetId));
    }
    return names;
  });

const hasFriendlyName = (
  capability: AlexaCapability,
  keywords: readonly string[],
): boolean =>
  friendlyNames(capability).some((name) =>
    keywords.some((kw) => name.includes(normalizeFanLabel(kw))),
  );

const scaleRangeToHomeKit = (
  value: number,
  min: number,
  max: number,
): number => {
  const span = max - min;
  if (span === 0) {
    return 0;
  }
  const clamped = Math.min(Math.max(value, min), max);
  return Math.min(Math.max(Math.round(((clamped - min) / span) * 100), 0), 100);
};

const scaleHomeKitToRange = (
  value: number,
  min: number,
  max: number,
  precision: number,
): number => {
  const span = max - min;
  if (span === 0) {
    return min;
  }
  const step = precision > 0 ? precision : 1;
  const raw = min + (value / 100) * span;
  const steps = Math.round((raw - min) / step);
  return Math.min(Math.max(min + steps * step, min), max);
};

const isModeController = (c: AlexaCapability): boolean =>
  c.interfaceName === 'Alexa.ModeController';

const isNotReadOnly = (c: AlexaCapability): boolean =>
  c.properties?.readOnly !== true;

const hasInstance = (c: AlexaCapability): boolean => !!c.instance;

const matchModeSpeed = (c: AlexaCapability): boolean =>
  isModeController(c) &&
  isNotReadOnly(c) &&
  hasInstance(c) &&
  hasFriendlyName(c, ['fan speed', 'speed']) &&
  c.configuration?.ordered === true &&
  (c.configuration?.supportedModes?.length ?? 0) === 4;

const matchModeDirection = (c: AlexaCapability): boolean =>
  isModeController(c) &&
  isNotReadOnly(c) &&
  hasInstance(c) &&
  hasFriendlyName(c, ['direction', 'wind']) &&
  c.configuration?.ordered === true &&
  (c.configuration?.supportedModes?.length ?? 0) === 2;

const RANGE_EXCLUDE_KEYWORDS = [
  'temperature',
  'set temperature',
  'air temperature',
  'humidity',
  'quality',
  'carbon monoxide',
  'voc',
  'particulate',
];

const matchRangeSpeed = (c: AlexaCapability): boolean => {
  if (c.interfaceName !== 'Alexa.RangeController') {
    return false;
  }
  if (isNotReadOnly(c) === false) {
    return false;
  }
  if (!hasInstance(c)) {
    return false;
  }
  if (!hasFriendlyName(c, ['fan speed', 'speed', 'wind speed'])) {
    return false;
  }
  if (hasFriendlyName(c, RANGE_EXCLUDE_KEYWORDS)) {
    return false;
  }
  const range = c.configuration?.supportedRange;
  if (!range) {
    return false;
  }
  if (
    !Number.isFinite(range.minimumValue) ||
    !Number.isFinite(range.maximumValue)
  ) {
    return false;
  }
  if (range.minimumValue === range.maximumValue) {
    return false;
  }
  return true;
};

const buildModeSpeedControl = (c: AlexaCapability): FanModeControl => {
  const modes = c.configuration!.supportedModes!;
  const alexaToHomeKit: Record<string, number> = {};
  modes.forEach((m, i) => {
    alexaToHomeKit[m.value] = (i + 1) * 25;
  });
  const orderedModes = modes.map((m, i) => ({
    mode: m.value,
    pct: (i + 1) * 25,
  }));
  return {
    type: 'mode',
    characteristic: 'RotationSpeed',
    featureName: 'mode',
    operationName: 'setMode',
    instance: c.instance!,
    defaultHomeKitValue: 25,
    alexaToHomeKit,
    homeKitToAlexa: (value: number): O.Option<string> => {
      if (value < 0 || value > 100) {
        return O.none;
      }
      if (value === 0) {
        return O.none;
      }
      let best = orderedModes[0];
      let bestDist = Math.abs(value - best.pct);
      for (const e of orderedModes.slice(1)) {
        const dist = Math.abs(value - e.pct);
        if (dist < bestDist || (dist === bestDist && e.pct > best.pct)) {
          best = e;
          bestDist = dist;
        }
      }
      return O.of(best.mode);
    },
  };
};

const buildModeDirectionControl = (c: AlexaCapability): FanDirectionControl => {
  const modes = c.configuration!.supportedModes!;
  const firstMode = modes[0].value;
  const secondMode = modes[1].value;
  const alexaToHomeKit: Record<string, number> = {
    [firstMode]: 1,
    [secondMode]: 0,
  };
  return {
    type: 'mode',
    characteristic: 'RotationDirection',
    featureName: 'mode',
    operationName: 'setMode',
    instance: c.instance!,
    defaultHomeKitValue: 0,
    alexaToHomeKit,
    homeKitToAlexa: (value: number): O.Option<string> => {
      if (value === 0) {
        return O.of(secondMode);
      }
      if (value === 1) {
        return O.of(firstMode);
      }
      return O.none;
    },
  };
};

const resolveRangeName = (c: AlexaCapability): string => {
  const fns = c.resources?.friendlyNames ?? [];
  const firstText = fns.find((fn) => fn['@type'] === 'text' && fn.value?.text);
  if (firstText) {
    return firstText.value.text!;
  }
  const firstAsset = fns.find(
    (fn) => fn['@type'] === 'asset' && fn.value?.assetId,
  );
  if (firstAsset) {
    return firstAsset.value.assetId!;
  }
  return c.instance ?? '';
};

const buildRangeSpeedControl = (c: AlexaCapability): FanRangeSpeedControl => {
  const range = c.configuration!.supportedRange!;
  const min = range.minimumValue;
  const max = range.maximumValue;
  const precision = range.precision ?? 1;
  return {
    type: 'range',
    characteristic: 'RotationSpeed',
    featureName: 'range',
    operationName: 'setRangeValue',
    instance: c.instance!,
    rangeName: resolveRangeName(c),
    minimumValue: min,
    maximumValue: max,
    precision,
    defaultHomeKitValue: scaleRangeToHomeKit(min, min, max),
    alexaToHomeKit: (value: number): number =>
      scaleRangeToHomeKit(value, min, max),
    homeKitToAlexa: (value: number): O.Option<number> => {
      if (value < 0 || value > 100) {
        return O.none;
      }
      if (value === 0 && min > 0) {
        return O.none;
      }
      return O.of(scaleHomeKitToRange(value, min, max, precision));
    },
  };
};

export const vornadoTransomModeFanScheme: FanControlScheme = {
  name: 'vornado-transom-mode-fan',
  discover: (capabilities) => {
    const speedCap = capabilities.find(matchModeSpeed);
    const directionCap = capabilities.find(matchModeDirection);
    if (!speedCap && !directionCap) return O.none;
    if (!speedCap && directionCap && capabilities.some(matchRangeSpeed))
      return O.none;
    return O.of({
      schemeName: 'vornado-transom-mode-fan',
      speed: speedCap ? O.of(buildModeSpeedControl(speedCap)) : O.none,
      direction: directionCap
        ? O.of(buildModeDirectionControl(directionCap))
        : O.none,
    });
  },
};

export const genericRangeSpeedFanScheme: FanControlScheme = {
  name: 'generic-range-speed-fan',
  discover: (capabilities) => {
    const speedCap = capabilities.find(matchRangeSpeed);
    if (!speedCap) {
      return O.none;
    }
    const directionCap = capabilities.find(matchModeDirection);
    return O.of({
      schemeName: 'generic-range-speed-fan',
      speed: O.of(buildRangeSpeedControl(speedCap)),
      direction: directionCap
        ? O.of(buildModeDirectionControl(directionCap))
        : O.none,
    });
  },
};

export const fanControlSchemes = [
  vornadoTransomModeFanScheme,
  genericRangeSpeedFanScheme,
] as const;

export const discoverFanControls = (
  capabilities: readonly AlexaCapability[],
): FanControls => {
  for (const scheme of fanControlSchemes) {
    const result = scheme.discover(capabilities);
    if (O.isSome(result)) {
      return result.value;
    }
  }
  return emptyFanControls;
};
