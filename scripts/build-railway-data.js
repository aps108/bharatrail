import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const stationInput = path.join(dataDir, 'stations.json');
const trainInput = path.join(dataDir, 'trains.json');
const stationOutput = path.join(dataDir, 'stations.compact.json');
const trainOutput = path.join(dataDir, 'trains.compact.json.gz');

const stations = JSON.parse(fs.readFileSync(stationInput, 'utf8'));
const trains = JSON.parse(fs.readFileSync(trainInput, 'utf8'));
if (!Array.isArray(stations) || !Array.isArray(trains)) {
  throw new Error('Expected station and train data files to contain JSON arrays.');
}

const compactStations = stations.map(station => [
  station.code || '', station.name || '', station.state || '', station.zone || '',
  station.coordinates?.latitude ?? null, station.coordinates?.longitude ?? null,
  station.address || ''
]);
const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const compactTrains = trains.map(train => [
  String(train.trainNumber || ''), train.trainName || '', train.type || '',
  train.source?.code || '', train.destination?.code || '',
  dayNames.map(day => train.runningDays?.[day] ? '1' : '0').join(''),
  train.overallDistanceKm ?? null,
  (train.completeOrderedRoute || []).map(stop => [
    stop.stationCode || '', stop.stationName || '', stop.arrivalTime || '',
    stop.departureTime || '', stop.journeyDay ?? null, stop.distance ?? null
  ])
]);

fs.writeFileSync(stationOutput, JSON.stringify(compactStations));
fs.writeFileSync(trainOutput, zlib.gzipSync(JSON.stringify(compactTrains), { level: 9 }));
console.log(`Built ${compactStations.length} stations (${fs.statSync(stationOutput).size} bytes)`);
console.log(`Built ${compactTrains.length} trains (${fs.statSync(trainOutput).size} gzipped bytes)`);
