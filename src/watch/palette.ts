/**
 * War Room TUI colors (issue #89), copied from design/war-room/tokens.json.
 * The design directory is not shipped with the binary, so the values live
 * here; palette.test.ts fails if the two drift apart.
 *
 * Station hues are assigned by a station's position in the flow, not by name:
 * the design's six names (decompose ... deliver) belong to its mock flow, and a
 * real flow's stations are arbitrary strings. The seventh station reuses the
 * first hue.
 */

export interface StationHue {
  /** The design's name for this hue, used only to match tokens.json. */
  designName: string;
  live: string;
  past: string;
  done: string;
}

export const STATION_HUES: readonly StationHue[] = [
  { designName: 'decompose', live: '#E8967A', past: '#744B3D', done: '#462D25' },
  { designName: 'test', live: '#EC4F8E', past: '#762847', done: '#47182B' },
  { designName: 'implement', live: '#9D6CF5', past: '#4F367B', done: '#2F204A' },
  { designName: 'review', live: '#4C7BF4', past: '#263E7A', done: '#172549' },
  { designName: 'probe', live: '#00BFFF', past: '#006080', done: '#00394D' },
  { designName: 'deliver', live: '#2DD4BF', past: '#176A60', done: '#0E4039' },
];

export const COLORS = {
  working: '#3BE37A',
  held: '#F5B940',
  heldText: '#000000',
  scrap: '#FF6B6B',
  rework: '#FF6B6B',
  doneText: '#5B6475',
  waitingDots: '#3A4150',
  notRecordedFg: '#94A3B8',
  notRecordedBg: '#1A1E27',
  meterLoud: '#F5B940',
  meterFill: '#7B8599',
  meterEmpty: '#2F3542',
  textBold: '#E2E8F0',
  textNormal: '#94A3B8',
  textDim: '#5B6475',
  border: '#2F3542',
  background: '#000000',
  selectedBg: '#0F1018',
  statusBg: '#141824',
  wordmark: '#00BFFF',
} as const;

/** The hue for the station at `index` in flow order. */
export function stationHue(index: number): StationHue {
  const n = STATION_HUES.length;
  return STATION_HUES[((index % n) + n) % n]!;
}
