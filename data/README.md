# Indian railway timetable snapshots

The original community backup was downloaded on 2026-11-12 from the `main` branch of [prasenjit-27/Indian-Railway-Data](https://github.com/prasenjit-27/Indian-Railway-Data):

- `stations.json`: 8,990 station records.
- `trains.json`: 5,208 train records and their stored station-by-station schedules.
- `stations.compact.json` and `trains.compact.json.gz`: generated compact copies used by the website.

An additional GTFS snapshot was published by [Neo2308/indianrailways-gtfs](https://github.com/Neo2308/indianrailways-gtfs):

- `community-gtfs.zip`: the source feed, version `2026-08-30-02-22-43`, with service dates from 2026-08-30 through 2026-09-30.
- `stations.community.compact.json` and `trains.community.compact.json.gz`: generated compact copies of its 8,550 stations and 10,594 train schedules. The uncompressed train JSON is included as a fallback for browsers without gzip stream support.
- GTFS has no route mileage, so the importer estimates each segment from station coordinates with a 20% allowance for rail-route winding. Fares shown without a live provider quote use the clearly marked class-rate assumptions in `fare-estimates.json`; they are indicative base-fare estimates, not official ticket prices.
- The site merges schedules by train number, preferring this newer snapshot where both datasets contain the same number. The current combined count is 12,980 unique train numbers and 9,885 station codes.

Regenerate the added compact files after replacing `community-gtfs.zip` with a newer feed by running `node scripts/import-community-gtfs.js`. The script uses the system `tar` command to unpack the feed into a temporary folder. The feed's one-month service calendar and its community provenance mean it should be treated as a reference snapshot, not a current official timetable. The repository does not include a separate data license for this GTFS feed.

The original upstream repository describes its dataset as MIT licensed and permits commercial reuse. The included `LICENSE` preserves its copyright and license terms. Neither timetable source is published by Indian Railways. The combined schedules may be incomplete or outdated; they contain no live train positions, current seat inventory, official fares, or booking confirmation.

The estimate rates are local assumptions. Official fare revisions describe per-kilometre changes, while actual tickets also depend on distance slabs, train type, class, minimum fares, surcharges, taxes, quota and other rules. See the Ministry of Railways' [December 2025 fare-rationalisation notice](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2208532&lang=1&reg=1). A configured live fare provider can replace the estimate for a selected train, route, class, date and quota.

Regenerate the compact files after updating the raw JSON with `node scripts/build-railway-data.js`.
