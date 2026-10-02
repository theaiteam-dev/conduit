import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLORS, STATION_HUES, stationHue } from './palette';

const tokens = JSON.parse(
  readFileSync(join(import.meta.dir, '../../design/war-room/tokens.json'), 'utf-8'),
) as Record<string, Record<string, string>>;

describe('palette mirrors design/war-room/tokens.json', () => {
  test('every station hue matches its live, past and done token', () => {
    const stations = tokens['STATIONS · live / past / done']!;
    for (const hue of STATION_HUES) {
      expect(stations[`${hue.designName} live`]).toBe(hue.live);
      expect(stations[`${hue.designName} past`]).toBe(hue.past);
      expect(stations[`${hue.designName} done`]).toBe(hue.done);
    }
    expect(Object.keys(stations)).toHaveLength(STATION_HUES.length * 3);
  });

  test('state and chrome colors match their tokens', () => {
    const states = tokens['STATES']!;
    const chrome = tokens['TEXT & CHROME']!;
    expect(states['working · now-line · LIVE']).toBe(COLORS.working);
    expect(states['held fill (text #000000)']).toBe(COLORS.held);
    expect(states['scrap fill · budget line']).toBe(COLORS.scrap);
    expect(states['rework marker «']).toBe(COLORS.rework);
    expect(states['not recorded fg']).toBe(COLORS.notRecordedFg);
    expect(states['not recorded bg']).toBe(COLORS.notRecordedBg);
    expect(states['meter loud fill (≥80%)']).toBe(COLORS.meterLoud);
    expect(states['meter fill █']).toBe(COLORS.meterFill);
    expect(states['meter empty ░']).toBe(COLORS.meterEmpty);
    expect(states['done text']).toBe(COLORS.doneText);
    expect(states['waiting dots ·']).toBe(COLORS.waitingDots);
    expect(chrome['bold / primary text']).toBe(COLORS.textBold);
    expect(chrome['normal text']).toBe(COLORS.textNormal);
    expect(chrome['dim text']).toBe(COLORS.textDim);
    expect(chrome['borders · tree · faint']).toBe(COLORS.border);
    expect(chrome['background']).toBe(COLORS.background);
    expect(chrome['selected row bg']).toBe(COLORS.selectedBg);
    expect(chrome['status bar bg']).toBe(COLORS.statusBg);
    expect(chrome['CONDUIT wordmark']).toBe(COLORS.wordmark);
  });

  test('station hues cycle by flow position', () => {
    expect(stationHue(0)).toBe(STATION_HUES[0]!);
    expect(stationHue(6)).toBe(STATION_HUES[0]!);
    expect(stationHue(7)).toBe(STATION_HUES[1]!);
  });
});
