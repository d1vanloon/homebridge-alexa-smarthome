// REVIEW: Unit tests for the new mode state extraction arm in extractStates().
// Verifies that a GraphQL ModeController feature response with modeValue { value } is
// correctly parsed into a CapabilityState with string value and instance. Required for
// fan speed/direction mode reads via ModeQuery.

import { extractStates } from './get-device-state';
import { Endpoint } from './get-devices';

type Feature = Endpoint['features'][number];

const modeFeature = (
  instance: string,
  modeValue: { value: string },
): Feature => ({
  name: 'mode',
  instance,
  operations: null,
  properties: [{ name: 'mode', modeValue } as Feature['properties'][number]],
  configuration: null,
});

describe('extractStates — mode', () => {
  test('extracts mode value from a mode feature', () => {
    const features = [modeFeature('1', { value: '3' })];
    const states = extractStates(features);
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual({
      featureName: 'mode',
      name: 'mode',
      instance: '1',
      value: '3',
    });
  });

  test('skips mode feature with no modeValue', () => {
    const features: Feature[] = [
      {
        name: 'mode',
        instance: '1',
        operations: null,
        properties: [
          { name: 'mode', modeValue: null } as Feature['properties'][number],
        ],
        configuration: null,
      },
    ];
    const states = extractStates(features);
    expect(states).toHaveLength(0);
  });
});
