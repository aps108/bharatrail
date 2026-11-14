import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const archive = path.join(dataDir, 'community-gtfs.zip');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bharatrail-gtfs-'));

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function csvFile(directory, name) {
  const filePath = path.join(directory, name);
  if (!fs.existsSync(filePath)) throw new Error(`GTFS archive is missing ${name}.`);
  return parseCsv(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function trainType(name) {
  const text = String(name || '').toUpperCase();
  if (/CARGO|PARCEL/.test(text)) return 'Freight';
  if (/JAN.?SHATABDI/.test(text)) return 'JShtb';
  if (/SHATABDI/.test(text)) return 'Shtb';
  if (/RAJDHANI/.test(text)) return 'Raj';
  if (/DURONTO/.test(text)) return 'Drnt';
  if (/GARIB RATH/.test(text)) return 'GR';
  if (/MEMU/.test(text)) return 'MEMU';
  if (/DEMU/.test(text)) return 'DEMU';
  if (/PASSENGER/.test(text)) return 'Pass';
  if (/MAIL/.test(text)) return 'Mail';
  if (/SUPERFAST|SUF/.test(text)) return 'SF';
  return 'Exp';
}

try {
  if (!fs.existsSync(archive)) throw new Error('Download data/community-gtfs.zip first.');
  execFileSync('tar', ['-xf', archive, '-C', tempDir], { stdio: 'inherit' });

  const stationRows = csvFile(tempDir, 'stops.txt');
  const routeRows = csvFile(tempDir, 'routes.txt');
  const tripRows = csvFile(tempDir, 'trips.txt');
  const calendarRows = csvFile(tempDir, 'calendar.txt');
  const stopTimeRows = csvFile(tempDir, 'stop_times.txt');

  const stations = new Map(stationRows.map(row => {
    const code = row.stop_code || row.stop_id;
    return [row.stop_id, [code, row.stop_name || code, '', '', Number(row.stop_lat) || null, Number(row.stop_lon) || null, '']];
  }));
  const routes = new Map(routeRows.map(row => [row.route_id, row]));
  const trips = new Map(tripRows.map(row => [row.trip_id, row]));
  const calendars = new Map(calendarRows.map(row => [row.service_id, row]));
  const stopsByTrip = new Map();
  for (const stopTime of stopTimeRows) {
    const list = stopsByTrip.get(stopTime.trip_id) || [];
    list.push(stopTime);
    stopsByTrip.set(stopTime.trip_id, list);
  }

  const dayColumns = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const records = [];
  for (const trip of trips.values()) {
    const route = routes.get(trip.route_id);
    const routeStops = (stopsByTrip.get(trip.trip_id) || []).sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    if (!route || !route.route_short_name || routeStops.length < 2) continue;
    const calendar = calendars.get(trip.service_id) || {};
    let runningFlags = dayColumns.map(day => calendar[day] === '1');
    if (!runningFlags.some(Boolean)) {
      const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const serviceWeekdays = String(trip.service_id || '').split('_')[0].split('-');
      runningFlags = dayColumns.map((_, index) => serviceWeekdays.some(day => weekdayIndex[day] === index));
    }
    const runningDays = runningFlags.map(runs => runs ? '1' : '0').join('');
    let cumulativeDistanceKm = 0;
    let previousCoordinates = null;
    const completeRoute = routeStops.map(stopTime => {
      const stop = stations.get(stopTime.stop_id);
      if (!stop) return null;
      const stationCoordinates = [stop[4], stop[5]];
      if (previousCoordinates && stationCoordinates.every(Number.isFinite) && previousCoordinates.every(Number.isFinite)) {
        const radians = degrees => degrees * Math.PI / 180;
        const [lat1, lon1] = previousCoordinates.map(radians);
        const [lat2, lon2] = stationCoordinates.map(radians);
        const haversine = 2 * 6371 * Math.asin(Math.sqrt(
          Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
        ));
        // Straight-line distance is shorter than the rail path; use a documented 20% route-winding allowance.
        cumulativeDistanceKm += haversine * 1.2;
      }
      previousCoordinates = stationCoordinates;
      const parseTime = value => {
        const match = String(value || '').match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
        if (!match) return { time: '', day: null };
        const hours = Number(match[1]);
        return { time: `${String(hours % 24).padStart(2, '0')}:${match[2]}`, day: Math.floor(hours / 24) + 1 };
      };
      const arrival = parseTime(stopTime.arrival_time);
      const departure = parseTime(stopTime.departure_time);
      return [stop[0], stop[1], arrival.time, departure.time, arrival.day ?? departure.day, Math.round(cumulativeDistanceKm)];
    }).filter(Boolean);
    if (completeRoute.length < 2) continue;
    records.push([
      String(route.route_short_name), route.route_long_name || trip.trip_headsign || `Train ${route.route_short_name}`,
      trainType(route.route_long_name), completeRoute[0][0], completeRoute.at(-1)[0], runningDays,
      null, completeRoute
    ]);
  }

  const stationsOut = [...stations.values()].filter(station => station[0]);
  fs.writeFileSync(path.join(dataDir, 'stations.community.compact.json'), JSON.stringify(stationsOut));
  const compactTrains = JSON.stringify(records);
  fs.writeFileSync(path.join(dataDir, 'trains.community.compact.json'), compactTrains);
  fs.writeFileSync(path.join(dataDir, 'trains.community.compact.json.gz'), zlib.gzipSync(compactTrains, { level: 9 }));
  console.log(`Imported ${records.length} community train schedules and ${stationsOut.length} stations.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
