import { CapabilityState, SupportedFeatures } from './index';

export interface FanState {
  featureName: keyof typeof FanFeatures & keyof typeof SupportedFeatures;
  value: CapabilityState['value'];
  // REVIEW: instance, name, rangeName added for multi-instance mode/range capability support.
  // Fan devices may have multiple ModeController or RangeController instances (e.g. speed vs direction);
  // these fields disambiguate which control instance a state update belongs to.`
  // REVIEW: mode and range added to FanFeatures for Alexa.ModeController and Alexa.RangeController
  // fan controls (speed/direction) — previously only 'power' was supported.
  instance?: CapabilityState['instance'];
  name?: CapabilityState['name'];
  rangeName?: CapabilityState['rangeName'];
}

export const FanFeatures = {
  power: 'power',
  mode: 'mode',
  range: 'range',
} as const;
