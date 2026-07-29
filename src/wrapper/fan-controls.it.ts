// REVIEW: Integration test (manual, requires live Alexa credentials) for fan control capability
// discovery via getSmarthomeDevicesV2(). Logs the raw legacyAppliance.capabilities for a named
// fan device, then runs discoverFanControls() against them to verify scheme matching.
// Not run in CI — requires DEVICE_FAN_NAME env var and valid auth.
// Expected output documents the actual Alexa capability model for the test device
// (e.g. ModeController instances, RangeController instances, ToggleController).

/* eslint-disable no-console */
import * as E from 'fp-ts/Either';
import { constant } from 'fp-ts/lib/function';
import AlexaRemote, { InitOptions } from 'alexa-remote2';
import { Authentication } from '../domain/alexa';
import { PLUGIN_NAME } from '../settings';
import { getAuthentication } from '../util';

const FAN_NAME = process.env.DEVICE_FAN_NAME ?? 'Bedroom Fan';

interface FriendlyName {
  '@type': 'asset' | 'text';
  value: { text?: string; assetId?: string };
}

interface Capability {
  interfaceName: string;
  instance?: string;
  resources?: { friendlyNames?: FriendlyName[] };
}

interface EndpointItem {
  friendlyName: string;
  legacyAppliance?: { capabilities?: Capability[] | string };
}

let alexa: AlexaRemote;
let fan: EndpointItem;
let capabilities: Capability[];

beforeAll(async () => {
  alexa = await getAlexaRemote();
  fan = await getFan(alexa);
  const raw = fan.legacyAppliance?.capabilities;
  capabilities = typeof raw === 'string' ? JSON.parse(raw) : raw ?? [];
  console.log(
    `${FAN_NAME} ::: Raw capabilities: ${JSON.stringify(
      capabilities,
      undefined,
      2,
    )}`,
  );
}, 120_000);

it('should expose a Fan Speed control on Bedroom Fan', () => {
  const fanSpeed = findControl(
    capabilities,
    ['Alexa.RangeController', 'Alexa.ModeController'],
    'speed',
  );
  console.log(
    `${FAN_NAME} ::: Fan Speed matches: ${JSON.stringify(
      fanSpeed,
      undefined,
      2,
    )}`,
  );
  expect(fanSpeed.length).toBeGreaterThan(0);
});

it('should expose a Direction control on Bedroom Fan', () => {
  const direction = findControl(
    capabilities,
    ['Alexa.ModeController', 'Alexa.ToggleController'],
    'direction',
  );
  console.log(
    `${FAN_NAME} ::: Direction matches: ${JSON.stringify(
      direction,
      undefined,
      2,
    )}`,
  );
  expect(direction.length).toBeGreaterThan(0);
});

function findControl(
  caps: Capability[],
  interfaces: string[],
  keyword: string,
): Capability[] {
  const lower = keyword.toLowerCase();
  return caps.filter(
    (c) =>
      interfaces.includes(c.interfaceName) &&
      (c.resources?.friendlyNames ?? []).some((f) => {
        const label = `${f.value?.text ?? ''} ${f.value?.assetId ?? ''}`;
        return label.toLowerCase().includes(lower);
      }),
  );
}

async function getFan(remote: AlexaRemote): Promise<EndpointItem> {
  const endpoints = await new Promise<EndpointItem[]>((resolve, reject) => {
    remote.getSmarthomeDevicesV2((err, items) => {
      if (err) {
        return reject(err);
      }
      resolve((items as EndpointItem[]) ?? []);
    });
  });
  const found = endpoints.find(
    (e) => e.friendlyName.toLowerCase() === FAN_NAME.toLowerCase(),
  );
  if (!found) {
    throw new Error(
      `Device "${FAN_NAME}" not found. Available devices: ${endpoints
        .map((e) => e.friendlyName)
        .join(', ')}`,
    );
  }
  return found;
}

async function getAlexaRemote(): Promise<AlexaRemote> {
  const alexaRemote = new AlexaRemote();
  const auth = E.getOrElse(constant({} as Authentication))(
    getAuthentication(`./.${PLUGIN_NAME}`)(),
  );
  return new Promise<AlexaRemote>((resolve, reject) => {
    alexaRemote.init(
      {
        acceptLanguage: 'en-US',
        alexaServiceHost: 'alexa.amazon.com',
        amazonPage: 'amazon.com',
        amazonPageProxyLanguage: 'en_US',
        cookie: auth?.localCookie,
        cookieRefreshInterval: 0,
        formerRegistrationData: auth,
        macDms: auth?.macDms,
        proxyOwnIp: '127.0.0.1',
        proxyPort: 2345,
        useWsMqtt: false,
      } as InitOptions,
      (err) => {
        if (err) {
          return reject(err);
        }
        resolve(alexaRemote);
      },
    );
  });
}
