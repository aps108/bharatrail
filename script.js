// Bharatrail - Indian Railway Train Search & Booking
// Live running status is requested from the server-side railway data proxy.

let STATIONS = [];
let TRAINS = [];
let BACKUP_TRAIN_RECORDS = [];
let FARE_ESTIMATE_CONFIG = null;
let railwayDataReady = false;
let railwayDataError = null;
let railwayDataPromise = null;

async function readTrainApiResponse(response, action = 'Train data') {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    if (body.includes('<?php') || response.headers.get('content-type')?.includes('text/html')) {
      throw new Error(`The ${action.toLowerCase()} endpoint is returning PHP source instead of JSON. Open the site through the Node server at http://127.0.0.1:8082, or deploy the API routes to a server that executes them.`);
    }
    throw new Error(`${action} returned an invalid response. Please try again later.`);
  }
}

function apiUrl(path) {
  const localHost = window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const host = window.location.hostname || '127.0.0.1';
  return localHost ? `http://${host}:8082${path}` : path;
}

async function fetchCompressedJSON(compressedPath, fallbackPath) {
  if (typeof DecompressionStream === 'undefined') {
    const fallback = await fetch(fallbackPath);
    if (!fallback.ok) throw new Error('Nationwide train backup could not be loaded.');
    return fallback.json();
  }
  const response = await fetch(compressedPath);
  if (!response.ok || !response.body) throw new Error('Nationwide train backup could not be loaded.');
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

async function loadRailwayBackup() {
  if (railwayDataPromise) return railwayDataPromise;
  railwayDataPromise = (async () => {
    try {
      const [stations, communityStations] = await Promise.all([
        fetch('data/stations.compact.json').then(response => {
          if (!response.ok) throw new Error('Station backup could not be loaded.');
          return response.json();
        }),
        fetch('data/stations.community.compact.json').then(response => {
          if (!response.ok) throw new Error('Community station backup could not be loaded.');
          return response.json();
        })
      ]);
      if (!Array.isArray(stations) || !stations.length || !Array.isArray(communityStations)) {
        throw new Error('The station backup is empty or invalid.');
      }
      const mergedStations = new Map();
      for (const station of [...stations, ...communityStations]) {
        const [code, name, state, zone, latitude, longitude, address] = station;
        if (code && !mergedStations.has(code)) mergedStations.set(code, [code, name, state, zone, latitude, longitude, address]);
      }
      STATIONS = [...mergedStations.values()].map(([code, name, state, zone, latitude, longitude, address]) => ({
        code, name, state, city: address?.split(',')[0]?.trim() || state || '', address, zone, latitude, longitude
      }));
      const [trains, communityTrains, fareEstimates] = await Promise.all([
        fetchCompressedJSON('data/trains.compact.json.gz', 'data/trains.json'),
        fetchCompressedJSON('data/trains.community.compact.json.gz', 'data/trains.community.compact.json'),
        fetch('data/fare-estimates.json').then(response => {
          if (!response.ok) throw new Error('Fare estimate data could not be loaded.');
          return response.json();
        })
      ]);
      if (![trains, communityTrains].every(Array.isArray) || !trains.length || !communityTrains.length) {
        throw new Error('The railway data backup is empty or invalid.');
      }
      const mergedTrains = new Map(trains.map(record => [String(record[0]), record]));
      for (const record of communityTrains) mergedTrains.set(String(record[0]), record);
      const allTrains = [...mergedTrains.values()];
      BACKUP_TRAIN_RECORDS = allTrains;
      TRAINS = allTrains.map(record => ({ number: record[0], name: record[1] || `Train ${record[0]}`, classes: [] }));
      FARE_ESTIMATE_CONFIG = fareEstimates;
      railwayDataReady = true;
      railwayDataError = null;
      const trainStat = $('train-count-stat');
      const stationStat = $('station-count-stat');
      if (trainStat) trainStat.textContent = allTrains.length.toLocaleString('en-IN');
      if (stationStat) stationStat.textContent = STATIONS.length.toLocaleString('en-IN');
      renderStationModalList([]);
      renderStations($('station-search')?.value || '');
      return true;
    } catch (error) {
      railwayDataError = error;
      return false;
    }
  })();
  return railwayDataPromise;
}

function getSnapshotType(type) {
  return String(type || 'Unspecified');
}

function snapshotTrainSegment(record, fromIndex, toIndex) {
  const route = record[7];
  const fromStop = route[fromIndex];
  const toStop = route[toIndex];
  const departure = (fromStop[3] || fromStop[2] || '').slice(0, 5);
  const arrival = (toStop[2] || toStop[3] || '').slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(departure) || !/^\d{2}:\d{2}$/.test(arrival)) return null;
  const dayGap = Math.max(0, Number(toStop[4] || 1) - Number(fromStop[4] || 1));
  const [departureHours, departureMinutes] = departure.split(':').map(Number);
  const [arrivalHours, arrivalMinutes] = arrival.split(':').map(Number);
  let durationMinutes = dayGap * 1440 + arrivalHours * 60 + arrivalMinutes - departureHours * 60 - departureMinutes;
  if (durationMinutes < 0) durationMinutes += 1440;
  const arrivalDate = parseISODate(selectedJourneyISO);
  arrivalDate.setDate(arrivalDate.getDate() + dayGap);
  let distance = Math.max(0, Number(toStop[5] || 0) - Number(fromStop[5] || 0));
  if (!distance) {
    const earthRadiusKm = 6371;
    let coordinateDistance = 0;
    for (let i = fromIndex + 1; i <= toIndex; i++) {
      const a = getStationByCode(route[i - 1][0]);
      const b = getStationByCode(route[i][0]);
      if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(value => Number.isFinite(Number(value)) && Number(value) !== 0)) continue;
      const radians = value => Number(value) * Math.PI / 180;
      const [lat1, lon1, lat2, lon2] = [a.latitude, a.longitude, b.latitude, b.longitude].map(radians);
      const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
      coordinateDistance += 2 * earthRadiusKm * Math.asin(Math.sqrt(h)) * 1.2;
    }
    distance = coordinateDistance;
  }
  if (!distance && Number(record[6]) > 0 && route.length > 1) {
    distance = Number(record[6]) * (toIndex - fromIndex) / (route.length - 1);
  }
  if (!distance) distance = Math.max(30, durationMinutes * 50 / 60);
  return {
    number: record[0], name: record[1] || `Train ${record[0]}`, type: getSnapshotType(record[2]), rawType: record[2],
    from: fromStop[0], to: toStop[0], departure, arrival,
    duration: `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`,
    distance: Math.round(distance),
    segmentStops: toIndex - fromIndex - 1,
    departureDate: dateLabel(parseISODate(selectedJourneyISO)), arrivalDate: dateLabel(arrivalDate),
    classes: [], snapshot: true
  };
}

function estimateTicketFare(distanceKm, classCode) {
  const fareClass = FARE_ESTIMATE_CONFIG?.classes?.[String(classCode || '').toUpperCase()];
  const distance = Number(distanceKm);
  if (!fareClass || !Number.isFinite(distance) || distance <= 0) return null;
  const rawEstimate = Math.max(Number(fareClass.minimum) || 0, distance * Number(fareClass.ratePerKm));
  return Math.ceil(rawEstimate / 5) * 5;
}

function refreshCardFareEstimates() {
  const classCode = $('train-class')?.value || '';
  document.querySelectorAll('.train-card').forEach(card => {
    const price = card.querySelector('.fare-card-price');
    const classLabel = card.querySelector('.class-code');
    const bookingButton = card.querySelector('.train-book-now');
    if (!price) return;
    const estimate = estimateTicketFare(card.dataset.distance, classCode);
    price.textContent = estimate === null ? 'Estimate unavailable' : `Est. ₹${estimate.toLocaleString('en-IN')}`;
    if (classLabel) classLabel.textContent = classCode || 'Selected class';
    if (bookingButton) bookingButton.dataset.class = classCode;
  });
}

function updateDepartureAvailability() {
  const now = Date.now();
  document.querySelectorAll('.departure-availability').forEach(button => {
    const departureAt = new Date(`${button.dataset.date}T${button.dataset.time}:00`).getTime();
    const notDeparted = Number.isFinite(departureAt) && now < departureAt;
    button.textContent = notDeparted ? 'Available' : 'Not available';
    button.classList.toggle('departure-not-available', !notDeparted);
    button.title = notDeparted
      ? 'Scheduled departure has not passed. Seat availability is not confirmed.'
      : 'Scheduled departure time has passed. This schedule may not reflect live delays.';
    button.setAttribute('aria-label', `${button.textContent}. ${button.title}`);
  });
  document.querySelectorAll('.class-departure-state').forEach(status => {
    const available = isDepartureAvailable(status.dataset.date, status.dataset.time, now);
    status.textContent = available ? 'Available' : 'Not available';
    status.classList.toggle('unavailable', !available);
    status.title = available
      ? 'The scheduled departure is still ahead. Seat availability is not confirmed.'
      : 'The scheduled departure has passed or is outside the allowed booking dates.';
    status.setAttribute('aria-label', available
      ? 'Scheduled departure has not passed. Seat availability is not confirmed.'
      : 'Scheduled departure time has passed or is outside the booking window.');
    const bookButton = status.closest('.class-option-card')?.querySelector('.train-book-now');
    if (bookButton) bookButton.disabled = !available;
  });
}

function isDepartureAvailable(date, time, now = Date.now()) {
  if (!isJourneyDateAllowed(date) || !/^\d{2}:\d{2}$/.test(String(time || ''))) return false;
  const departureAt = new Date(`${date}T${time}:00`).getTime();
  return Number.isFinite(departureAt) && departureAt > now;
}

// ================= State =================
let currentRoute = null;       // { from, to } station codes after a search
let selectedJourneyDate = '';  // label such as "11 Nov"
let selectedJourneyISO = '';
let currentBooking = null;     // { number, name, classCode, price }
let paymentSession = null;
sessionStorage.removeItem('bharatrailAdminToken');
let adminToken = null;
let activeProofUpload = null;
let bookingResultLocked = false;
const trainClassCompositionCache = new Map();
let sectionHistory = [];
let restoringSection = false;
let travellers = [];
let currentStationField = null;
let searchTimer = null, toastTimer = null, countdownTimer = null, successTimer = null, paymentStatusTimer = null;

const MAX_TRAVELLERS = 6;
const GST_RATE = 0.18;
const IRCT_CHARGE_PER_PERSON = 20;
const SECTION_IDS = ['home', 'home-search', 'home-partners', 'search', 'customer-support', 'train-status', 'pnr', 'stations', 'loading-page', 'travel-details'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ================= Helpers =================
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');

const HINDI_TRANSLATIONS = {
  'Your ticket is being processed. Please allow about one minute. We will send it to your WhatsApp and Gmail, and you can download it here when ready.': 'आपका टिकट तैयार हो रहा है। कृपया लगभग एक मिनट प्रतीक्षा करें। टिकट आपके WhatsApp और Gmail पर भेजा जाएगा; तैयार होने पर यहाँ से डाउनलोड करें।',
  'Bharatrail - Indian Railway Train Search & Booking': 'भारतरेल - भारतीय रेल ट्रेन खोज और बुकिंग',
  'Home': 'होम', 'Search Trains': 'ट्रेन खोजें', 'Train Status': 'ट्रेन की स्थिति',
  'PNR Status': 'पीएनआर स्थिति', 'Stations': 'स्टेशन', 'Search': 'खोजें', 'Trains': 'ट्रेनें',
  'Across India': 'पूरे भारत में', 'Explore train routes, scheduled stops, live status, fares, and seat availability across India.': 'भारत भर के ट्रेन मार्ग, निर्धारित स्टॉप, लाइव स्थिति, किराया और सीटों की उपलब्धता देखें।',
  'Journey Support': 'यात्रा सहायता', 'Find Your Train': 'अपनी ट्रेन खोजें',
  'From Station': 'प्रस्थान स्टेशन', 'To Station': 'गंतव्य स्टेशन',
  'Enter station name or code': 'स्टेशन का नाम या कोड लिखें', 'Date of Journey': 'यात्रा की तारीख',
  'Class': 'श्रेणी', 'Quota': 'कोटा', 'Sleeper (SL)': 'स्लीपर (SL)', 'AC 3-Tier (3A)': 'एसी 3-टियर (3A)',
  'AC 2-Tier (2A)': 'एसी 2-टियर (2A)', 'AC 1-Tier (1A)': 'एसी 1-टियर (1A)',
  'AC Chair Car (CC)': 'एसी चेयर कार (CC)', 'Second Seating (2S)': 'सेकंड सीटिंग (2S)',
  'General (GN)': 'सामान्य (GN)', 'Ladies (LD)': 'महिला (LD)', 'Senior Citizen': 'वरिष्ठ नागरिक',
  'Divyangjan': 'दिव्यांगजन', 'Tatkal': 'तत्काल', 'Premium Tatkal': 'प्रीमियम तत्काल',
  'Vip Quota': 'वीआईपी कोटा', 'Foreign Tourist': 'विदेशी पर्यटक',
  'Search Trains': 'ट्रेन खोजें', 'Bharatrail is finding trains for you': 'आपके लिए ट्रेनें खोजी जा रही हैं',
  'Please wait while we search the best trains for your journey': 'आपकी यात्रा के लिए ट्रेनें खोजी जा रही हैं',
  'Checking routes and availability...': 'रूट और उपलब्धता जाँची जा रही है...',
  'Train Type': 'ट्रेन प्रकार', 'Rajdhani Express': 'राजधानी एक्सप्रेस',
  'Shatabdi Express': 'शताब्दी एक्सप्रेस', 'Duronto Express': 'दुरंतो एक्सप्रेस',
  'Superfast Express': 'सुपरफास्ट एक्सप्रेस', 'Express': 'एक्सप्रेस', 'Sort by': 'क्रमबद्ध करें',
  'Departure': 'प्रस्थान', 'Arrival': 'आगमन', 'Duration': 'अवधि', 'Price': 'किराया',
  'No trains found': 'कोई ट्रेन नहीं मिली', 'This backup has no matching train for these stations and running day. Confirm with a current timetable provider.': 'इस बैकअप में इन स्टेशनों और दिन के लिए ट्रेन नहीं है। वर्तमान समय-सारणी प्रदाता से पुष्टि करें।',
  'Book': 'बुक करें', 'Check': 'जाँचें', 'Check availability': 'उपलब्धता देखें', 'Schedule': 'समय-सारणी',
  'Live Train Running Status': 'ट्रेन की लाइव स्थिति', 'Train Number': 'ट्रेन नंबर',
  'Enter 5-digit train number': '5 अंकों का ट्रेन नंबर लिखें', 'Date': 'तारीख', 'Check Status': 'स्थिति देखें',
  'PNR Number': 'पीएनआर नंबर', 'Enter 10-digit PNR': '10 अंकों का पीएनआर लिखें',
  'PNR is a 10-digit number found on your ticket': 'पीएनआर टिकट पर दिया गया 10 अंकों का नंबर है',
  'Check PNR Status': 'पीएनआर स्थिति देखें', 'Search stations...': 'स्टेशन खोजें...',
  'Select From station': 'प्रस्थान स्टेशन चुनें', 'Select To station': 'गंतव्य स्टेशन चुनें',
  'All Stations': 'सभी स्टेशन', 'Search station...': 'स्टेशन खोजें...',
  'Travel Details': 'यात्रा विवरण', 'Add traveller details': 'यात्री का विवरण जोड़ें',
  'Full Name': 'पूरा नाम', 'Full Name as per Govt ID Proof': 'सरकारी पहचान पत्र के अनुसार पूरा नाम',
  'Age': 'उम्र', 'Nationality': 'राष्ट्रीयता', 'India': 'भारत', 'Other': 'अन्य',
  'Birth Preference': 'बर्थ की पसंद', 'No Preference': 'कोई प्राथमिकता नहीं',
  'Lower Berth': 'निचली बर्थ', 'Middle Berth': 'बीच की बर्थ', 'Upper Berth': 'ऊपरी बर्थ',
  'Save Traveller': 'यात्री सहेजें', '+ Add New Traveller': '+ नया यात्री जोड़ें',
  'Contact details': 'संपर्क विवरण', 'Your ticket will be sent to mobile number and email ID': 'टिकट आपके मोबाइल नंबर और ईमेल पर भेजा जाएगा',
  'Mobile Number': 'मोबाइल नंबर', 'Enter mobile number': 'मोबाइल नंबर लिखें',
  'Email ID': 'ईमेल आईडी', 'Enter email ID': 'ईमेल आईडी लिखें', 'Proceed to Book': 'बुकिंग जारी रखें',
  'Booking Summary': 'बुकिंग सारांश', 'Cancel': 'रद्द करें', 'Total Amount': 'कुल राशि',
  'Ticket Fare': 'टिकट किराया', 'GST (18%)': 'जीएसटी (18%)', 'Scan to pay': 'भुगतान के लिए स्कैन करें',
  'Preparing secure payment QR...': 'सुरक्षित भुगतान क्यूआर तैयार हो रहा है...',
  'Upload payment proof': 'भुगतान का प्रमाण अपलोड करें', 'PNG, JPG, or PDF up to 5 MB': '5 MB तक की PNG, JPG या PDF फ़ाइल',
  'Submit Payment Proof': 'भुगतान प्रमाण जमा करें', 'Uploading...': 'अपलोड हो रहा है...',
  'Ticket Booking in Process': 'टिकट बुकिंग जारी है',
  'Your ticket is being processed. You will receive it on WhatsApp or Gmail, or you can download it here when it is ready.': 'आपका टिकट तैयार किया जा रहा है। टिकट WhatsApp या Gmail पर मिलेगा; तैयार होने पर यहाँ से डाउनलोड भी कर सकते हैं।',
  'Download ticket': 'टिकट डाउनलोड करें', 'Open WhatsApp': 'WhatsApp खोलें', 'OK': 'ठीक है',
  'Submitting Payment Proof': 'भुगतान प्रमाण जमा हो रहा है',
  'Please wait while we submit your screenshot and confirm your booking request.': 'स्क्रीनशॉट जमा करने और बुकिंग अनुरोध की पुष्टि होने तक प्रतीक्षा करें।',
  'Cancel upload': 'अपलोड रद्द करें',
  'Payment Proof Not Submitted': 'भुगतान प्रमाण जमा नहीं हुआ',
  'We could not submit your payment screenshot. Check your connection and try again.': 'भुगतान स्क्रीनशॉट जमा नहीं हो सका। कनेक्शन जाँचें और फिर कोशिश करें।',
  'Try Again': 'फिर कोशिश करें',
  'Not provided': 'नहीं दिया गया',
  'WhatsApp:': 'WhatsApp:',
  'Gmail:': 'Gmail:',
  'Please upload your payment screenshot before submitting.': 'जमा करने से पहले भुगतान का स्क्रीनशॉट अपलोड करें।',
  'Please upload your payment proof first.': 'पहले भुगतान का प्रमाण अपलोड करें।',
  'Upload your payment screenshot before submitting.': 'जमा करने से पहले भुगतान का स्क्रीनशॉट अपलोड करें।',
  'File is too large. Choose a file under 5 MB.': 'फ़ाइल बहुत बड़ी है। 5 MB से छोटी फ़ाइल चुनें।',
  'Choose an image or PDF file.': 'इमेज या PDF फ़ाइल चुनें।',
  'Could not upload payment proof. Please try again.': 'भुगतान प्रमाण अपलोड नहीं हुआ। फिर कोशिश करें।',
  'Payment could not be verified. Please try again.': 'भुगतान की पुष्टि नहीं हो सकी। कृपया फिर कोशिश करें।',
  'Choose a valid payment screenshot or PDF before submitting.': 'जमा करने से पहले भुगतान का सही स्क्रीनशॉट या PDF चुनें।',
  'Enter your From and To stations to see trains': 'ट्रेन देखने के लिए प्रस्थान और गंतव्य स्टेशन चुनें।',
  'Please select a train and class first': 'पहले ट्रेन और श्रेणी चुनें।',
  'Please enter valid station names or codes': 'कृपया सही स्टेशन का नाम या कोड लिखें।',
  'From and To stations must be different': 'प्रस्थान और गंतव्य स्टेशन अलग होने चाहिए।',
  'Please enter a valid 5-digit train number': 'कृपया सही 5 अंकों का ट्रेन नंबर लिखें।',
  'Please enter a valid 10-digit PNR': 'कृपया सही 10 अंकों का पीएनआर लिखें।',
  'No train was found for this number.': 'इस नंबर की ट्रेन नहीं मिली।',
  'Please enter a valid 10-digit mobile number': 'कृपया सही 10 अंकों का मोबाइल नंबर लिखें',
  'Please enter a valid email ID': 'कृपया सही ईमेल आईडी लिखें',
  'Please enter valid station names or codes': 'कृपया सही स्टेशन का नाम या कोड लिखें',
  'From and To stations must be different': 'प्रस्थान और गंतव्य स्टेशन अलग होने चाहिए',
  'Please enter a valid 5-digit train number': 'कृपया सही 5 अंकों का ट्रेन नंबर लिखें',
  'Please enter a valid 10-digit PNR': 'कृपया सही 10 अंकों का पीएनआर लिखें',
  'No station match your search': 'आपकी खोज से कोई स्टेशन नहीं मिला',
  'No stations match your search': 'आपकी खोज से कोई स्टेशन नहीं मिला',
  'Powered By Partner Institutions': 'सहयोगी संस्थानों द्वारा संचालित',
  'IRCT': 'IRCT', 'PAYTM': 'PAYTM', 'UPI': 'UPI', 'BHMI': 'BHMI',
  'Check Status': 'स्थिति देखें', 'Source': 'प्रस्थान स्टेशन', 'Destination': 'गंतव्य स्टेशन',
  'Journey Date': 'यात्रा की तारीख', 'Train Schedule:': 'ट्रेन समय-सारणी:',
  'Running status is available when the railway tracking service responds.': 'रेलवे ट्रैकिंग सेवा से जानकारी मिलने पर चलने की स्थिति यहाँ दिखेगी।',
  'PNR details are temporarily unavailable. Please try again later.': 'पीएनआर जानकारी अभी उपलब्ध नहीं है। कृपया बाद में फिर कोशिश करें।',
  'No train was found for this number.': 'इस नंबर की ट्रेन नहीं मिली।',
  'Payment service is temporarily unavailable. Please try again later.': 'भुगतान सेवा अभी उपलब्ध नहीं है। कृपया बाद में फिर कोशिश करें।',
  'The payment QR could not be loaded. Please try again.': 'भुगतान क्यूआर लोड नहीं हुआ। कृपया फिर कोशिश करें।',
  'Could not check availability. Please try again.': 'उपलब्धता नहीं जाँची जा सकी। कृपया फिर कोशिश करें।',
  'All travellers saved successfully': 'सभी यात्रियों का विवरण सहेज लिया गया।',
  'Please enter a valid mobile number': 'कृपया सही मोबाइल नंबर लिखें।',
  'Please enter a valid age': 'कृपया सही उम्र लिखें।',
  'Please enter name': 'कृपया नाम लिखें।',
  'Please select a train and class first': 'पहले ट्रेन और श्रेणी चुनें।',
  'Traveller removed': 'यात्री हटाया गया।',
  'Maximum 6 travellers allowed': 'अधिकतम 6 यात्रियों की अनुमति है।',
  'Toggle Navigation Menu': 'नेविगेशन मेनू खोलें या बंद करें',
  'Browse from stations': 'प्रस्थान स्टेशन देखें', 'Browse to stations': 'गंतव्य स्टेशन देखें',
  'Remove traveller': 'यात्री हटाएँ', 'Close': 'बंद करें',
  'Train Type': 'ट्रेन प्रकार', 'Class': 'श्रेणी', 'Sort by': 'क्रमबद्ध करें',
  'Destination': 'गंतव्य स्टेशन', 'Duration': 'अवधि', 'Available': 'उपलब्ध',
  'Unavailable': 'उपलब्ध नहीं', 'Book Now': 'अभी बुक करें',
  'Ticket Fare (': 'टिकट किराया (', 'IRCT Charges': 'IRCT शुल्क',
  'GST': 'जीएसटी', 'Traveller': 'यात्री', 'Travellers': 'यात्री',
  'Please enter a valid age for Traveller': 'यात्री की सही उम्र लिखें',
  'Please enter name for Traveller': 'यात्री का नाम लिखें',
  'Maximum': 'अधिकतम', 'travellers allowed': 'यात्रियों की अनुमति है',
  'Please enter a valid mobile number': 'कृपया सही मोबाइल नंबर लिखें',
  'Ticket confirmation will be sent through Gmail or WhatsApp': 'टिकट की पुष्टि Gmail या WhatsApp पर भेजी जाएगी',
  'Go back': 'वापस जाएँ', 'Change language to Hindi': 'भाषा हिंदी में बदलें', 'English': 'अंग्रेज़ी', 'हिन्दी': 'हिंदी'
};
let currentLanguage = 'en';
const originalTextNodes = new WeakMap();
const originalAttributes = new WeakMap();
let languageObserver = null;

function translateValue(value, language) {
  if (language !== 'hi') return value;
  const trimmed = value.trim();
  let translated = HINDI_TRANSLATIONS[trimmed];
  if (!translated) {
    let match = trimmed.match(/^Train Schedule: (.+)$/);
    if (match) translated = `ट्रेन समय-सारणी: ${match[1]}`;
    match = trimmed.match(/^Traveller (\d+): (.+)$/);
    if (!translated && match) translated = `यात्री ${match[1]}: ${match[2]}`;
    match = trimmed.match(/^(\d+) Traveller(s?) · (.+) \((.+)\)$/);
    if (!translated && match) translated = `${match[1]} यात्री · ${match[3]} (${match[4]})`;
    match = trimmed.match(/^Please enter name for Traveller (\d+)$/);
    if (!translated && match) translated = `यात्री ${match[1]} का नाम लिखें`;
    match = trimmed.match(/^Please enter a valid age for Traveller (\d+)$/);
    if (!translated && match) translated = `यात्री ${match[1]} की सही उम्र लिखें`;
    match = trimmed.match(/^Maximum (\d+) travellers allowed$/);
    if (!translated && match) translated = `अधिकतम ${match[1]} यात्रियों की अनुमति है`;
    match = trimmed.match(/^(.+) \(([^)]+)\) selected$/);
    if (!translated && match) translated = `${match[1]} (${match[2]}) चुनी गई`;
    match = trimmed.match(/^Ticket Fare \((\d+) × ₹([\d,]+)\)$/);
    if (!translated && match) translated = `टिकट किराया (${match[1]} × ₹${match[2]})`;
    match = trimmed.match(/^IRCT Charges \((\d+) × ₹([\d,]+)\)$/);
    if (!translated && match) translated = `IRCT शुल्क (${match[1]} × ₹${match[2]})`;
    match = trimmed.match(/^Scan to pay (.+)$/);
    if (!translated && match) translated = `भुगतान के लिए स्कैन करें ${match[1]}`;
    match = trimmed.match(/^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/);
    if (!translated && match) {
      const months = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
      translated = `${match[1]} ${months[MONTHS.indexOf(match[2])]}`;
    }
    match = trimmed.match(/^(\d{1,2}) (Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
    if (!translated && match) {
      const days = ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'];
      translated = `${match[1]} ${days[WEEKDAYS.indexOf(match[2])]}`;
    }
  }
  if (!translated) return value;
  const leading = value.match(/^\s*/)?.[0] || '';
  const trailing = value.match(/\s*$/)?.[0] || '';
  return `${leading}${translated}${trailing}`;
}

function applyLanguage(language) {
  currentLanguage = language;
  document.documentElement.lang = language === 'hi' ? 'hi' : 'en';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script,style,#language-toggle')) continue;
    if (!originalTextNodes.has(node)) originalTextNodes.set(node, node.nodeValue);
    const original = originalTextNodes.get(node);
    const next = translateValue(original, language);
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  const attributeNames = ['placeholder', 'aria-label', 'title'];
  document.querySelectorAll('input,button,a,[title]').forEach(element => {
    if (!originalAttributes.has(element)) originalAttributes.set(element, {});
    const originals = originalAttributes.get(element);
    attributeNames.forEach(name => {
      if (!element.hasAttribute(name)) return;
      if (!(name in originals)) originals[name] = element.getAttribute(name);
      const next = translateValue(originals[name], language);
      if (element.getAttribute(name) !== next) element.setAttribute(name, next);
    });
  });

  document.title = language === 'hi'
    ? HINDI_TRANSLATIONS['Bharatrail - Indian Railway Train Search & Booking']
    : 'Bharatrail - Indian Railway Train Search & Booking';
  const languageButton = $('language-toggle');
  if (languageButton) {
    const label = language === 'en' ? 'हिन्दी' : 'English';
    if (languageButton.textContent !== label) languageButton.textContent = label;
    languageButton.setAttribute('aria-label', language === 'en' ? 'Change language to Hindi' : 'भाषा अंग्रेज़ी में बदलें');
  }
}

function setupLanguageToggle() {
  const button = $('language-toggle');
  if (!button) return;
  button.addEventListener('click', () => {
    const next = currentLanguage === 'en' ? 'hi' : 'en';
    applyLanguage(next);
    try { localStorage.setItem('bharatrail-language', next); } catch (error) { /* Storage may be unavailable in private mode. */ }
  });
  try {
    const saved = localStorage.getItem('bharatrail-language');
    if (saved === 'hi') currentLanguage = 'hi';
  } catch (error) { /* Keep English when storage is unavailable. */ }
  applyLanguage(currentLanguage);
  if (!languageObserver) {
    languageObserver = new MutationObserver(() => applyLanguage(currentLanguage));
    languageObserver.observe(document.body, { childList: true, subtree: true });
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function toISODate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateLabel(date) {
  if (currentLanguage === 'hi') {
    const months = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
    return `${date.getDate()} ${months[date.getMonth()]}`;
  }
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function durationToMinutes(text) {
  const m = String(text).match(/(\d+)h\s*(\d+)m/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function getStation(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return null;
  return STATIONS.find(s =>
    s.code.toLowerCase() === q || s.name.toLowerCase() === q || (s.city || '').toLowerCase() === q) || null;
}

function getStationByCode(code) {
  return STATIONS.find(s => s.code === code) || null;
}

function filterStations(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return STATIONS;
  return STATIONS.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.code.toLowerCase().includes(q) ||
    (s.city || '').toLowerCase().includes(q) ||
    (s.state || '').toLowerCase().includes(q));
}

function lockScroll(lock) {
  document.body.style.overflow = lock ? 'hidden' : '';
}

function showToast(message, type = 'info') {
  let toast = $('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:var(--dark);color:var(--white);padding:15px 25px;border-radius:8px;box-shadow:var(--shadow-lg);z-index:2000;display:flex;align-items:center;gap:12px;max-width:calc(100% - 32px);text-align:center;font-size:0.9rem';
    toast.innerHTML = '<i id="toast-icon"></i><span id="toast-message"></span>';
    document.body.appendChild(toast);
  }
  $('toast-message').textContent = message;
  $('toast-icon').className = type === 'success' ? 'fas fa-check-circle'
    : type === 'error' ? 'fas fa-exclamation-circle' : 'fas fa-info-circle';
  toast.style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

async function adminApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (adminToken) headers.set('Authorization', `Bearer ${adminToken}`);
  const response = await fetch(apiUrl(path), { ...options, headers });
  const result = await readTrainApiResponse(response, 'Admin service');
  if (!response.ok || result.success !== true) throw new Error(result.message || 'Admin request failed.');
  return result;
}

function closeAdminPanel() {
  document.querySelector('.admin-popup')?.remove();
  lockScroll(false);
}

function showAdminSettings(popup, qrCode = '') {
  const content = popup.querySelector('.admin-popup-content');
  content.innerHTML = `
    <div class="booking-header"><h2>Payment QR Settings</h2><button type="button" class="booking-close" data-admin-action="close" aria-label="Close">&times;</button></div>
    <div class="admin-settings-body">
      <p>Upload the payment QR travelers should see at checkout.</p>
      <label class="admin-qr-upload" for="admin-qr-file">Choose QR image (PNG, JPG, WebP; up to 3 MB)</label>
      <input id="admin-qr-file" type="file" accept="image/png,image/jpeg,image/webp">
      <img id="admin-qr-preview" class="admin-qr-preview" alt="Configured payment QR" ${qrCode ? `src="${qrCode}"` : 'hidden'}>
      <p id="admin-qr-status" class="form-hint" role="status">${qrCode ? 'Current payment QR is saved.' : 'No payment QR is configured yet.'}</p>
      <div class="admin-panel-actions"><button type="button" class="booking-cancel-btn" data-admin-action="logout">Log out</button><button type="button" class="booking-pay-btn" id="admin-save-qr" disabled>Save payment QR</button></div>
    </div>`;
  const input = popup.querySelector('#admin-qr-file');
  const preview = popup.querySelector('#admin-qr-preview');
  const save = popup.querySelector('#admin-save-qr');
  const status = popup.querySelector('#admin-qr-status');
  let qrData = '';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    qrData = '';
    save.disabled = true;
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 3 * 1024 * 1024) {
      status.textContent = 'Choose a PNG, JPG, or WebP image smaller than 3 MB.';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      qrData = String(reader.result || '');
      preview.src = qrData;
      preview.hidden = false;
      save.disabled = !qrData;
      status.textContent = file.name;
    };
    reader.onerror = () => { status.textContent = 'Could not read that image. Please choose it again.'; };
    reader.readAsDataURL(file);
  });
  save.addEventListener('click', async () => {
    if (!qrData) return;
    save.disabled = true;
    status.textContent = 'Saving payment QR…';
    try {
      await adminApi('/api/admin/payment-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrCode: qrData })
      });
      qrData = '';
      status.textContent = 'Payment QR saved. Travelers will see this QR at checkout.';
      showToast('Payment QR saved.', 'success');
    } catch (error) {
      status.textContent = error.message;
      save.disabled = false;
    }
  });
}

function openAdminPanel() {
  closeAdminPanel();
  const popup = document.createElement('div');
  popup.className = 'booking-popup admin-popup';
  popup.innerHTML = `<div class="booking-popup-overlay" data-admin-action="close"></div>
    <div class="booking-popup-content admin-popup-content">
      <div class="booking-header"><h2>Admin Login</h2><button type="button" class="booking-close" data-admin-action="close" aria-label="Close">&times;</button></div>
      <form id="admin-login-form" class="admin-login-form">
        <label for="admin-password">Admin password</label>
        <input id="admin-password" type="password" inputmode="numeric" autocomplete="current-password" required>
        <p id="admin-login-error" class="form-hint" role="alert"></p>
        <button type="submit" class="booking-pay-btn">Sign in</button>
      </form>
    </div>`;
  popup.addEventListener('click', e => {
    const action = e.target.closest('[data-admin-action]')?.dataset.adminAction;
    if (action === 'close') closeAdminPanel();
    if (action === 'logout') { adminToken = null; sessionStorage.removeItem('bharatrailAdminToken'); openAdminPanel(); }
  });
  popup.querySelector('#admin-login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const errorNode = popup.querySelector('#admin-login-error');
    submit.disabled = true;
    errorNode.textContent = 'Signing in…';
    try {
      const login = await adminApi('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: popup.querySelector('#admin-password').value })
      });
      adminToken = login.token;
      const settings = await adminApi('/api/admin/payment-settings');
      showAdminSettings(popup, settings.qrCode || '');
    } catch (error) {
      errorNode.textContent = error.message;
      submit.disabled = false;
    }
  });
  document.body.appendChild(popup);
  lockScroll(true);
  popup.querySelector('#admin-password').focus();
}

// ================= Navigation =================
const SECTION_NAV_IDS = { home: 'home', search: 'search', 'train-status': 'train-status', pnr: 'pnr', stations: 'stations' };

function showSection(sectionId) {
  const currentSection = SECTION_IDS.find(id =>
    !['home-search', 'home-partners'].includes(id) &&
    $(id) && window.getComputedStyle($(id)).display !== 'none');
  if (!restoringSection && currentSection && currentSection !== sectionId &&
      currentSection !== 'loading-page') sectionHistory.push(currentSection);
  SECTION_IDS.forEach(id => { const el = $(id); if (el) el.style.display = 'none'; });
  const target = $(sectionId);
  if (target) target.style.display = 'block';
  if (sectionId === 'home') {
    ['home-search', 'home-partners'].forEach(id => { const el = $(id); if (el) el.style.display = 'block'; });
  }
  if (sectionId === 'travel-details') initTravellers();
  updateBackButton();
  window.scrollTo(0, 0);
}

function updateBackButton() {
  const button = $('global-back');
  if (button) button.disabled = sectionHistory.length === 0;
}

function goBack() {
  if (activeProofUpload || bookingResultLocked) return;
  if (document.querySelector('.birth-pref-menu:not([hidden])')) {
    closeBirthPreferenceMenus();
    return;
  }
  if ($('station-modal')?.style.display === 'block') {
    closeStationModal();
    return;
  }
  if (document.querySelector('.booking-popup')) {
    closeBookingPopup();
    return;
  }
  const previous = sectionHistory.pop();
  if (!previous) return;
  restoringSection = true;
  showSection(previous);
  restoringSection = false;
  setActiveNav(previous);
  if (previous === 'stations') renderStations($('station-search')?.value || '');
}

function setActiveNav(sectionId) {
  const navId = SECTION_NAV_IDS[sectionId] || '';
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.getAttribute('href') === '#' + navId);
  });
}

function resetMenuIcon() {
  const menu = $('nav-menu');
  const btn = $('mobile-menu');
  if (menu) menu.classList.remove('active');
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'fas fa-bars';
  }
}

function navigateTo(target) {
  resetMenuIcon();
  if (target === 'about') target = 'home';

  // Search results only exist after a search, so send the user to the form first
  if (target === 'search' && !currentRoute) {
    showSection('home');
    setActiveNav('home');
    showToast('Enter your From and To stations to see trains', 'info');
    $('from-station')?.focus();
    return;
  }

  showSection(target);
  setActiveNav(target);
  if (target === 'stations') renderStations($('station-search')?.value || '');
}

function setupNavigation() {
  document.querySelectorAll('.nav-link, .premium-support-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(link.getAttribute('href').slice(1));
    });
  });
}

function setupMobileMenu() {
  const btn = $('mobile-menu');
  const menu = $('nav-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', () => {
    const open = menu.classList.toggle('active');
    btn.setAttribute('aria-expanded', String(open));
    const icon = btn.querySelector('i');
    if (icon) icon.className = open ? 'fas fa-times' : 'fas fa-bars';
  });
}

function setupNavbarShadow() {
  const navbar = $('navbar');
  if (!navbar) return;
  window.addEventListener('scroll', () => {
    navbar.style.boxShadow = window.scrollY > 50
      ? '0 4px 20px rgba(0,0,0,0.15)' : 'var(--shadow)';
  }, { passive: true });
}

// ================= Dates =================
function initDate() {
  const { today, max } = getJourneyDateBounds();
  const journey = $('journey-date');
  if (journey) {
    journey.min = today;
    journey.max = max;
    if (!isJourneyDateAllowed(journey.value)) journey.value = today;
  }
  const statusDate = $('status-date');
  if (statusDate) {
    statusDate.min = today;
    if (!statusDate.value) statusDate.value = today;
  }
}

function addMonthsClamped(date, months) {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

function getJourneyDateBounds() {
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  return { today: toISODate(todayDate), max: toISODate(addMonthsClamped(todayDate, 2)) };
}

function isJourneyDateAllowed(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const date = parseISODate(iso);
  if (Number.isNaN(date.getTime()) || toISODate(date) !== iso) return false;
  const { today, max } = getJourneyDateBounds();
  return iso >= today && iso <= max;
}

function buildDateBar(startDate) {
  const bar = $('date-bar');
  if (!bar) return;
  const { today, max } = getJourneyDateBounds();
  let firstDate = new Date(startDate);
  const startISO = toISODate(firstDate);
  if (startISO < today || startISO > max) firstDate = parseISODate(today);
  bar.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const d = new Date(firstDate);
    d.setDate(firstDate.getDate() + i);
    if (toISODate(d) > max) break;
    const label = dateLabel(d);
    const item = document.createElement('div');
    item.dataset.date = toISODate(d);
    item.className = 'date-item' + (toISODate(d) === toISODate(firstDate) ? ' active' : '');
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.innerHTML = `<div class="date-main">${d.getDate()} ${WEEKDAYS[d.getDay()]}</div>`;
    item.addEventListener('click', () => selectDate(item, label));
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDate(item, label); } });
    bar.appendChild(item);
  }
  selectedJourneyDate = dateLabel(firstDate);
  selectedJourneyISO = toISODate(firstDate);
  if ($('journey-date')) $('journey-date').value = selectedJourneyISO;
}

function selectDate(element, label) {
  if (!isJourneyDateAllowed(element.dataset.date)) return;
  document.querySelectorAll('#date-bar .date-item').forEach(item =>
    item.classList.toggle('active', item === element));
  selectedJourneyDate = label;
  selectedJourneyISO = element.dataset.date || selectedJourneyISO;
  if ($('journey-date')) $('journey-date').value = selectedJourneyISO;
  applyFilters();
}

// ================= Station fields =================
function renderSuggestions(input, box) {
  const query = input.value.trim();
  const results = query ? filterStations(query).slice(0, 12) : [];
  if (!results.length) {
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  box.innerHTML = results.map(s => `
    <div class="suggestion-item" role="option" data-name="${escapeHtml(s.name)}">
      <span class="station-name">${escapeHtml(s.name)}</span>
      <span class="station-code">${escapeHtml(s.code)}</span>
    </div>`).join('');
  box.style.display = 'block';
}

function setupStationFields() {
  [
    { field: 'from', inputId: 'from-station', boxId: 'from-suggestions' },
    { field: 'to', inputId: 'to-station', boxId: 'to-suggestions' }
  ].forEach(({ field, inputId, boxId }) => {
    const input = $(inputId);
    const box = $(boxId);
    if (!input || !box) return;

    input.addEventListener('input', () => renderSuggestions(input, box));
    input.addEventListener('keydown', e => { if (e.key === 'Escape') box.style.display = 'none'; });

    box.addEventListener('click', e => {
      const item = e.target.closest('.suggestion-item');
      if (!item) return;
      input.value = item.dataset.name;
      box.style.display = 'none';
    });

    document.addEventListener('click', e => {
      if (!input.contains(e.target) && !box.contains(e.target)) box.style.display = 'none';
    });

    // Map-pin icon opens the full station picker
    const icon = input.parentElement?.querySelector('.form-icon');
    if (icon) {
      icon.classList.add('station-trigger');
      icon.setAttribute('role', 'button');
      icon.setAttribute('aria-label', `Browse ${field} stations`);
      icon.addEventListener('click', () => openStationModal(field));
    }
  });
}

// ================= Station modal =================
function renderStationModalList(list, query = '') {
  const box = $('station-modal-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = query
      ? '<p class="no-results">No stations match your search</p>'
      : '<p class="no-results">Type a station name or code to search the nationwide station list.</p>';
    return;
  }
  const results = list.slice(0, 60);
  box.innerHTML = results.map(s => `
    <div class="station-item" data-code="${escapeHtml(s.code)}">
      <div class="station-item-info">
        <div class="station-item-name">${escapeHtml(s.name)}</div>
        <div class="station-item-city">${escapeHtml(s.city)}</div>
      </div>
      <div class="station-item-code">${escapeHtml(s.code)}</div>
    </div>`).join('') + (list.length > results.length
      ? '<p class="no-results">Showing 60 matches. Add more letters to narrow the list.</p>'
      : '');
}

function openStationModal(field) {
  const modal = $('station-modal');
  if (!modal) return;
  currentStationField = field;
  $('station-modal-type').textContent = field === 'from' ? 'Select From station' : 'Select To station';
  $('station-modal-search').value = '';
  renderStationModalList([]);
  modal.style.display = 'block';
  lockScroll(true);
  $('station-modal-search').focus();
}

function closeStationModal() {
  const modal = $('station-modal');
  if (!modal || modal.style.display !== 'block') return;
  modal.style.display = 'none';
  currentStationField = null;
  lockScroll(false);
}
window.closeStationModal = closeStationModal;

function setupStationModal() {
  $('station-modal-search')?.addEventListener('input', e => {
    const query = e.target.value.trim();
    renderStationModalList(query ? filterStations(query) : [], query);
  });

  $('station-modal-list')?.addEventListener('click', e => {
    const item = e.target.closest('.station-item');
    if (!item) return;
    const station = getStationByCode(item.dataset.code);
    const input = $(currentStationField === 'to' ? 'to-station' : 'from-station');
    if (station && input) input.value = station.name;
    closeStationModal();
  });
}

// ================= Train search and results =================
function getFilteredTrains(ignoreRunningDay = false) {
  if (!currentRoute || !railwayDataReady) return [];

  const type = $('filter-train-type')?.value || 'all';
  const sort = $('sort-trains')?.value || 'all';
  const dayIndex = parseISODate(selectedJourneyISO).getDay();
  const list = [];
  for (const record of BACKUP_TRAIN_RECORDS) {
    const route = record[7];
    let fromIndex = -1;
    let toIndex = -1;
    for (let i = 0; i < route.length; i++) {
      if (fromIndex < 0 && route[i][0] === currentRoute.from) fromIndex = i;
      if (fromIndex >= 0 && i > fromIndex && route[i][0] === currentRoute.to) {
        toIndex = i;
        break;
      }
    }
    if (fromIndex < 0 || toIndex < 0) continue;
    if (!ignoreRunningDay && record[5] && record[5][dayIndex] !== '1') continue;
    const train = snapshotTrainSegment(record, fromIndex, toIndex);
    if (!train) continue;
    if (type !== 'all' && train.rawType !== type) continue;
    list.push(train);
  }
  const sorters = {
    departure: (a, b) => a.departure.localeCompare(b.departure),
    arrival: (a, b) => a.arrival.localeCompare(b.arrival),
    duration: (a, b) => durationToMinutes(a.duration) - durationToMinutes(b.duration)
  };
  return list.sort(sorters[sort] || sorters.departure);
}

function applyFilters() {
  let trains = getFilteredTrains();
  if (!trains.length) {
    trains = getFilteredTrains(true).map(train => ({ ...train, runningDayUnconfirmed: true }));
  }
  renderTrains(trains);
}

function renderTrains(trains) {
  const container = $('train-list');
  if (!container) return;

  if (!trains.length) {
    container.innerHTML = `
      <div class="no-trains">
        <i class="fas fa-exclamation-triangle"></i>
        <h3>No train schedule found</h3>
        <p>Our timetable may be incomplete, or search demand may be high. Contact customer support and an agent can help check your journey.</p>
        <div class="support-contact-actions"><button type="button" class="support-contact-button" data-support-channel="whatsapp"><i class="fab fa-whatsapp" aria-hidden="true"></i> WhatsApp support</button><button type="button" class="support-contact-button support-call-button" data-support-channel="call"><i class="fas fa-phone" aria-hidden="true"></i> Call support</button></div>
        <form class="support-contact-form" hidden><label for="support-customer-phone">Your phone number (with country code)</label><div><input id="support-customer-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91 98765 43210" required><button type="submit" class="support-contact-button">Continue</button></div><input type="hidden" name="channel"><small>Your number will be saved with the support agent number you are connected to.</small></form>
        <p class="support-contact-status" role="status" aria-live="polite"></p>
      </div>`;
    return;
  }

  container.innerHTML = trains.map((train, index) => {
    const from = getStationByCode(train.from);
    const to = getStationByCode(train.to);

    const preferredClass = $('train-class')?.value || '';
    const classCards = `<div class="classes-grid train-classes" data-train-number="${escapeHtml(train.number)}" data-date="${escapeHtml(selectedJourneyISO)}" data-selected-class="${escapeHtml(preferredClass)}">
      <div class="class-list-status" role="status">Loading train classes…</div>
    </div>`;


    return `
      <div class="train-card" style="--card-index:${index}" data-distance="${escapeHtml(train.distance)}" data-type="${escapeHtml(train.type || '')}" data-from="${escapeHtml(train.from)}" data-to="${escapeHtml(train.to)}" data-departure="${escapeHtml(train.departure)}" data-arrival="${escapeHtml(train.arrival)}" data-duration="${escapeHtml(train.duration)}">
        <div class="train-header">
          <div class="train-info">
            <h3><span class="train-name">${escapeHtml(train.name)}</span><span class="train-number"> · ${escapeHtml(train.number)}</span></h3>
          </div>
          <button type="button" class="schedule-link" data-number="${escapeHtml(train.number)}">Schedule <i class="fas fa-chevron-right" aria-hidden="true"></i></button>
        </div>
        <div class="train-row">
          <div class="station-info departure">
            <div class="time">${escapeHtml(train.departure)}</div>
            <div class="date">${escapeHtml(train.departureDate)}</div>
            <div class="station-name">${escapeHtml(from ? from.name : train.from)}</div>
          </div>
          <div class="duration-info">
            <div class="route-distance">${Number(train.distance).toLocaleString('en-IN')} km</div>
            <div class="duration-line"></div>
            <div class="duration">${escapeHtml(train.duration)}</div>
          </div>
          <div class="station-info arrival">
            <div class="time">${escapeHtml(train.arrival)}</div>
            <div class="date">${escapeHtml(train.arrivalDate)}</div>
            <div class="station-name">${escapeHtml(to ? to.name : train.to)}</div>
          </div>
        </div>
        ${classCards}
      </div>`;
  }).join('');
  updateDepartureAvailability();
  observeTrainClassLists(container);
}

function observeTrainClassLists(container) {
  const lists = container.querySelectorAll('.train-classes');
  const load = list => {
    if (!list.isConnected || list.dataset.loading === 'true' || list.dataset.loaded === 'true') return;
    list.dataset.loading = 'true';
    const card = list.closest('.train-card');
    loadTrainClassOptions(list, {
      number: list.dataset.trainNumber,
      name: card?.querySelector('.train-name')?.textContent || '',
      type: card?.dataset.type || '',
      date: list.dataset.date || '',
      distance: card?.dataset.distance || '',
      departure: card?.dataset.departure || '',
      arrival: card?.dataset.arrival || '',
      duration: card?.dataset.duration || '',
      from: card?.dataset.from || '',
      to: card?.dataset.to || ''
    }, list.dataset.selectedClass || '');
  };
  if (!('IntersectionObserver' in window)) {
    lists.forEach(load);
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      load(entry.target);
    });
  }, { rootMargin: '300px 0px' });
  lists.forEach(list => observer.observe(list));
}

async function loadTrainClassOptions(list, train, selectedClass) {
  const classOrder = ['1A', '2A', '3A', '3E', 'SL', '2S', 'CC', 'EC', 'EA', 'FC', 'EV', 'VC'];
  const supportedClasses = new Set(classOrder);
  const acOnlyTrain = /\b(RAJDHANI|SHATABDI|VANDE BHARAT|TEJAS|GATIMAAN|AC)\b/i.test(`${train.name} ${train.type}`);
  const renderOptions = classes => {
    list.innerHTML = classes.map(classCode => {
      const price = estimateTicketFare(Number(train.distance), classCode);
      return `<article class="class-card class-option-card${classCode === selectedClass ? ' selected' : ''}">
        <div class="class-card-top"><strong class="class-code">${escapeHtml(classCode)}</strong><span class="class-price">${price === null ? '' : `Est. ₹${price.toLocaleString('en-IN')}`}</span></div>
        <div class="class-card-bottom"><span class="class-departure-state" data-date="${escapeHtml(train.date)}" data-time="${escapeHtml(train.departure)}">Checking…</span><button type="button" class="book-quick-btn train-book-now" data-number="${escapeHtml(train.number)}" data-name="${escapeHtml(train.name)}" data-from="${escapeHtml(train.from)}" data-to="${escapeHtml(train.to)}" data-departure="${escapeHtml(train.departure)}" data-arrival="${escapeHtml(train.arrival)}" data-duration="${escapeHtml(train.duration)}" data-class="${escapeHtml(classCode)}">Book Now</button></div>
      </article>`;
    }).join('');
    updateDepartureAvailability();
  };
  const renderFallback = () => {
    const fallbackClasses = train.type === 'Freight'
      ? []
      : [...document.querySelectorAll('#train-class option')]
        .map(option => option.value.trim().toUpperCase())
        .filter(code => supportedClasses.has(code) && !(acOnlyTrain && code === 'SL'));
    renderOptions(fallbackClasses.length ? fallbackClasses : (selectedClass ? [selectedClass] : []));
  };

  try {
    let request = trainClassCompositionCache.get(train.number);
    if (!request) {
      const query = new URLSearchParams({ type: 'coaches', number: train.number, date: train.date || selectedJourneyISO || toISODate(new Date()) });
      request = fetch(apiUrl(`/api/trains.php?${query}`), { headers: { Accept: 'application/json' } })
        .then(async response => {
          const payload = await readTrainApiResponse(response, 'Train class service');
          if (!response.ok || payload?.status !== 'SUCCESS') throw new Error(payload?.error?.message || 'Train class list is unavailable.');
          const rake = payload?.data?.rake;
          if (!Array.isArray(rake)) throw new Error('Train class list is unavailable.');
          return [...new Set(rake.filter(coach => coach && coach.hasSeats !== false)
            .map(coach => String(coach.classType || '').trim().toUpperCase())
            .filter(code => supportedClasses.has(code)))]
            .sort((a, b) => classOrder.indexOf(a) - classOrder.indexOf(b));
        }).then(classes => {
          if (!classes.length) throw new Error('Train class list is unavailable.');
          return classes;
        }).catch(error => {
          trainClassCompositionCache.delete(train.number);
          throw error;
        });
      trainClassCompositionCache.set(train.number, request);
    }
    const classes = await request;
    if (!list.isConnected) return;
    list.dataset.loading = 'false';
    list.dataset.loaded = 'true';
    renderOptions(classes);
  } catch {
    if (!list.isConnected) return;
    list.dataset.loading = 'false';
    list.dataset.loaded = 'true';
    renderFallback();
  }
}

async function loadTrainFares(button) {
  const card = button.closest('.train-card');
  const price = card?.querySelector('.fare-card-price');
  const status = card?.querySelector('.fare-card-status');
  if (!price || !status || button.disabled) return;
  button.disabled = true;
  button.textContent = 'Checking…';
  price.textContent = 'Checking…';
  status.textContent = 'Requesting live fare';
  const number = button.dataset.number;
  const source = button.dataset.source;
  const destination = button.dataset.destination;
  const quota = $('train-quota')?.value || 'GN';
  const preferredClass = $('train-class')?.value || '';
  const classLabel = card.querySelector('.class-code');
  const bookingButton = card.querySelector('.train-book-now');
  if (classLabel) classLabel.textContent = preferredClass || 'Selected class';
  if (bookingButton) bookingButton.dataset.class = preferredClass;
  const date = selectedJourneyISO || $('journey-date')?.value || toISODate(new Date());

  async function requestFareApi(params) {
    const query = new URLSearchParams(params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(apiUrl(`/api/trains.php?${query}`), {
        headers: { Accept: 'application/json' }, signal: controller.signal
      });
      const payload = await readTrainApiResponse(response, 'Fare service');
      if (!response.ok || !['SUCCESS', 'STALE_DATA'].includes(payload?.status)) {
        throw new Error(payload?.error?.message || 'Fare data is unavailable.');
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    const fareResult = await requestFareApi({ type: 'fare', number, source, destination, class: preferredClass, quota, date });
    const fareData = fareResult.data || {};
    const totalFare = fareData.breakdown?.totalFare;
    if (totalFare === null || totalFare === undefined || !Number.isFinite(Number(totalFare))) {
      throw new Error('The provider did not report a fare for this class and route.');
    }
    price.textContent = `₹${Number(totalFare).toLocaleString('en-IN')}`;
    const observed = fareData.observedAt || fareResult.meta?.freshness?.observedAt || fareResult.meta?.generatedAt;
    const freshness = fareResult.meta?.freshness?.state || (fareResult.status === 'STALE_DATA' ? 'STALE' : 'CURRENT');
    const observedText = observed && !Number.isNaN(Date.parse(observed))
      ? new Date(observed).toLocaleString()
      : 'time not supplied';
    status.textContent = `${freshness} provider quote · ${observedText}`;
    status.title = `${preferredClass} · ${quota} quota · ${dateLabel(parseISODate(date))}`;
    status.classList.remove('fare-card-error');
    button.textContent = 'Refresh fare';
  } catch (error) {
    const fallbackEstimate = estimateTicketFare(button.dataset.distance, preferredClass);
    price.textContent = fallbackEstimate === null ? 'Estimate unavailable' : `Est. ₹${fallbackEstimate.toLocaleString('en-IN')}`;
    status.textContent = error.message || 'Live fare unavailable';
    status.classList.add('fare-card-error');
    button.textContent = 'Retry fare';
  } finally {
    button.disabled = false;
  }
}

async function handleTrainSearch(e) {
  e.preventDefault();
  if (!railwayDataReady && !(await loadRailwayBackup())) {
    showToast(railwayDataError?.message || 'Train data is unavailable right now.', 'error');
    return;
  }
  const fromStation = getStation($('from-station').value);
  const toStation = getStation($('to-station').value);

  if (!fromStation || !toStation) {
    showToast('Please enter valid station names or codes', 'error');
    return;
  }
  if (fromStation.code === toStation.code) {
    showToast('From and To stations must be different', 'error');
    return;
  }

  const requestedDate = $('journey-date').value || toISODate(new Date());
  if (!isJourneyDateAllowed(requestedDate)) {
    showToast('Choose a journey date from today through the next two months.', 'error');
    initDate();
    return;
  }
  const start = parseISODate(requestedDate);
  buildDateBar(start);
  currentRoute = { from: fromStation.code, to: toStation.code };

  showSection('loading-page');
  clearTimeout(searchTimer);
  showSection('search');
  setActiveNav('search');
  applyFilters();
  $('search')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function positionFixedMenu(trigger, menu, preferredHeight = 240) {
  const rect = trigger.getBoundingClientRect();
  const maxHeight = Math.max(96, Math.min(preferredHeight, window.innerHeight - 24));
  const menuHeight = Math.min(menu.scrollHeight, maxHeight);
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow < menuHeight + 8 && rect.top > spaceBelow
    ? Math.max(12, rect.top - menuHeight - 8)
    : Math.min(window.innerHeight - menuHeight - 12, rect.bottom + 8);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.width = `${Math.min(rect.width, window.innerWidth - 24)}px`;
  menu.style.maxHeight = `${maxHeight}px`;
}

function closeFilterMenus(except = null) {
  document.querySelectorAll('.filter-options:not([hidden])').forEach(menu => {
    if (menu === except) return;
    menu.hidden = true;
    menu.closest('.filter-dropdown')?.querySelector('.filter-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

function setupFilters() {
  ['filter-train-type', 'filter-class', 'sort-trains'].forEach(id => {
    const select = $(id);
    if (!select) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'filter-dropdown';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'filter-trigger';
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.options[0]?.textContent.trim() || 'Filter');
    const label = document.createElement('span');
    label.className = 'filter-current';
    label.textContent = select.selectedOptions[0]?.textContent.trim() || '';
    const icon = document.createElement('i');
    icon.className = 'fas fa-chevron-down';
    icon.setAttribute('aria-hidden', 'true');
    trigger.append(label, icon);

    const menu = document.createElement('div');
    menu.className = 'filter-options';
    menu.id = `${id}-options`;
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    Array.from(select.options).forEach(option => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'filter-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.value === select.value));
      item.dataset.value = option.value;
      item.dataset.label = option.textContent.trim();
      item.disabled = option.disabled;
      item.textContent = option.textContent.trim();
      menu.appendChild(item);
    });

    select.classList.add('filter-native-select');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    select.parentNode.insertBefore(wrapper, select);
    wrapper.append(select, trigger, menu);
    select.addEventListener('change', () => {
      if (id === 'filter-class') {
        const classSelector = $('train-class');
        if (classSelector) classSelector.value = select.value;
        refreshCardFareEstimates();
      }
      applyFilters();
    });

    trigger.addEventListener('click', () => {
      const shouldOpen = menu.hidden;
      closeFilterMenus(menu);
      closeBirthPreferenceMenus();
      menu.hidden = !shouldOpen;
      trigger.setAttribute('aria-expanded', String(shouldOpen));
      if (shouldOpen) positionFixedMenu(trigger, menu);
    });
    menu.addEventListener('click', e => {
      const item = e.target.closest('.filter-option');
      if (!item || item.disabled) return;
      select.value = item.dataset.value;
      menu.querySelectorAll('.filter-option').forEach(option =>
        option.setAttribute('aria-selected', String(option === item)));
      label.textContent = item.dataset.label;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.filter-dropdown')) closeFilterMenus();
  });
  window.addEventListener('resize', () => closeFilterMenus());
  window.addEventListener('scroll', () => closeFilterMenus(), true);
}

// ================= Booking flow =================
function bookTrain(number, classCode, price) {
  const train = TRAINS.find(t => t.number === number);
  if (!train?.classes?.some(cls => cls.code === classCode && cls.available)) {
    showToast('Live ticket availability is not connected yet. No booking was started.', 'error');
    return;
  }
  currentBooking = { number, name: train.name, classCode, price };
  showToast(`${train.name} (${classCode}) selected`, 'success');
  showSection('travel-details');
}

function startTravellerBooking(button) {
  const journeyISO = selectedJourneyISO || $('journey-date')?.value || '';
  if (!isJourneyDateAllowed(journeyISO)) {
    showToast('Choose a journey date from today through the next two months.', 'error');
    return;
  }
  if (button.disabled || !isDepartureAvailable(journeyISO, button.dataset.departure || '')) {
    showToast('This train has already departed and cannot be booked for this journey date.', 'error');
    return;
  }
  const number = button.dataset.number || '';
  const from = getStationByCode(button.dataset.from || '');
  const to = getStationByCode(button.dataset.to || '');
  const estimatedPrice = estimateTicketFare(button.closest('.train-card')?.dataset.distance, button.dataset.class || $('train-class')?.value);
  currentBooking = {
    number,
    name: button.dataset.name || `Train ${number}`,
    classCode: button.dataset.class || '',
    price: estimatedPrice,
    from: from?.name || button.dataset.from || '',
    to: to?.name || button.dataset.to || '',
    departure: button.dataset.departure || '',
    arrival: button.dataset.arrival || '',
    duration: button.dataset.duration || '',
    distance: button.closest('.train-card')?.dataset.distance || '',
    quota: $('train-quota')?.value || 'GN',
    journeyDate: journeyISO
  };
  const summary = $('booking-train-summary');
  if (summary) {
    summary.innerHTML = `<h3>Selected train</h3>
      <p class="booking-train-name">${escapeHtml(currentBooking.name)} <span>(${escapeHtml(number)})</span></p>
      <p class="booking-train-route">${escapeHtml(currentBooking.from)} <strong>${escapeHtml(currentBooking.departure)}</strong> <span aria-hidden="true">→</span> ${escapeHtml(currentBooking.to)} <strong>${escapeHtml(currentBooking.arrival)}</strong></p>
      <p class="booking-train-meta">${escapeHtml(currentBooking.journeyDate)} · ${escapeHtml(currentBooking.duration)} · Preferred class ${escapeHtml(currentBooking.classCode || 'not selected')}</p>
      <p class="booking-train-note">Add traveler and contact details below. Seat confirmation depends on the ticketing provider.</p>`;
    summary.hidden = false;
  }
  showSection('travel-details');
}

function newTraveller() {
  return { name: '', age: '', gender: '', nationality: 'India', birthPref: 'No Preference' };
}

function initTravellers() {
  travellers = [newTraveller()];
  renderTravellers();
}

function renderTravellers() {
  const container = $('travellers-container');
  if (!container) return;
  container.innerHTML = '';

  travellers.forEach((t, index) => {
    const card = document.createElement('div');
    card.className = 'traveller-card';
    card.dataset.index = index;
    card.innerHTML = `
      <div class="traveller-header">
        <h4>Traveller ${index + 1}</h4>
        ${index > 0 ? '<button type="button" class="remove-traveller" aria-label="Remove traveller">&times;</button>' : ''}
      </div>
      <div class="form-group">
        <label>Full Name</label>
        <input type="text" placeholder="Full Name as per Govt ID Proof" value="${escapeHtml(t.name)}" data-field="name">
      </div>
      <div class="form-group">
        <label>Age</label>
        <input type="number" min="1" max="120" placeholder="Age" value="${escapeHtml(t.age)}" data-field="age">
      </div>
      <div class="form-group">
        <label>Gender</label>
        <select data-field="gender">
          <option value="" ${t.gender ? '' : 'selected'}>Select gender</option>
          ${['Female', 'Male', 'Other'].map(value => `<option value="${value}" ${t.gender === value ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Nationality</label>
        <div class="birth-pref-select" data-field="nationality">
          <button type="button" class="birth-pref-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="nationality-menu-${index}">
            <span>${escapeHtml(t.nationality)}</span><i class="fas fa-chevron-down" aria-hidden="true"></i>
          </button>
          <div class="birth-pref-menu" id="nationality-menu-${index}" role="listbox" hidden>
            ${['India', 'Other'].map(opt =>
              `<button type="button" role="option" aria-selected="${t.nationality === opt}" class="birth-pref-option" data-value="${opt}">${opt}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>Birth Preference</label>
        <div class="birth-pref-select" data-field="birthPref">
          <button type="button" class="birth-pref-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="birth-pref-menu-${index}">
            <span>${escapeHtml(t.birthPref)}</span><i class="fas fa-chevron-down" aria-hidden="true"></i>
          </button>
          <div class="birth-pref-menu" id="birth-pref-menu-${index}" role="listbox" hidden>
            ${['No Preference', 'Lower Berth', 'Middle Berth', 'Upper Berth'].map(opt =>
              `<button type="button" role="option" aria-selected="${t.birthPref === opt}" class="birth-pref-option" data-value="${opt}">${opt}</button>`).join('')}
          </div>
        </div>
      </div>`;
    container.appendChild(card);
  });

  if (travellers.length < MAX_TRAVELLERS) {
    const wrap = document.createElement('div');
    wrap.className = 'add-traveller-btn-container';
    wrap.innerHTML = '<button type="button" class="add-traveller-btn">+ Add New Traveller</button>';
    container.appendChild(wrap);
  }
}

function setupTravellers() {
  const container = $('travellers-container');
  if (!container) return;

  const syncField = el => {
    const card = el.closest('.traveller-card');
    const field = el.dataset.field;
    if (!card || !field) return;
    const t = travellers[Number(card.dataset.index)];
    if (t) t[field] = el.value;
  };
  container.addEventListener('input', e => syncField(e.target));
  container.addEventListener('change', e => syncField(e.target));

  container.addEventListener('click', e => {
    if (e.target.closest('.remove-traveller')) {
      const card = e.target.closest('.traveller-card');
      removeTraveller(Number(card.dataset.index));
    } else if (e.target.closest('.add-traveller-btn')) {
      addTraveller();
    } else if (e.target.closest('.birth-pref-trigger')) {
      toggleBirthPreference(e.target.closest('.birth-pref-trigger'));
    } else if (e.target.closest('.birth-pref-option')) {
      const option = e.target.closest('.birth-pref-option');
      const card = option.closest('.traveller-card');
      const index = Number(card?.dataset.index);
      const field = option.closest('[data-field]')?.dataset.field;
      if (!Number.isNaN(index) && travellers[index] && ['birthPref', 'nationality'].includes(field)) {
        travellers[index][field] = option.dataset.value;
        renderTravellers();
      }
    }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.birth-pref-select')) closeBirthPreferenceMenus();
  });
  window.addEventListener('resize', () => closeBirthPreferenceMenus());
  window.addEventListener('scroll', () => closeBirthPreferenceMenus(), true);
}

function closeBirthPreferenceMenus(except = null) {
  document.querySelectorAll('.birth-pref-menu:not([hidden])').forEach(menu => {
    if (menu === except) return;
    menu.hidden = true;
    menu.closest('.birth-pref-select')?.querySelector('.birth-pref-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

function toggleBirthPreference(trigger) {
  const menu = trigger.parentElement?.querySelector('.birth-pref-menu');
  if (!menu) return;
  const shouldOpen = menu.hidden;
  closeBirthPreferenceMenus(menu);
  if (!shouldOpen) {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    return;
  }

  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  const rect = trigger.getBoundingClientRect();
  const maxHeight = Math.min(192, window.innerHeight - 24);
  const menuHeight = Math.min(menu.scrollHeight, maxHeight);
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow < menuHeight + 8 && rect.top > spaceBelow
    ? Math.max(12, rect.top - menuHeight - 8)
    : Math.min(window.innerHeight - menuHeight - 12, rect.bottom + 8);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.width = `${rect.width}px`;
  menu.style.maxHeight = `${maxHeight}px`;
}

async function checkTrainAvailability(card) {
  const trainNumber = card.dataset.number;
  const classCode = card.dataset.class;
  const action = card.querySelector('.check-quick-btn');
  if (!trainNumber || !classCode || !action || action.disabled) return;
  action.disabled = true;
  action.innerHTML = 'Checking <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>';
  try {
    const query = new URLSearchParams({
      trainNumber,
      classCode,
      journeyDate: selectedJourneyISO
    });
    const response = await fetch(apiUrl(`/api/trains/availability?${query}`));
    const result = await readTrainApiResponse(response, 'Train status service');
    if (!response.ok || result.success !== true) throw new Error('Availability unavailable');
    const train = TRAINS.find(item => item.number === trainNumber);
    const cls = train?.classes?.find(item => item.code === classCode);
    if (!cls) throw new Error('Class unavailable');
    cls.available = Boolean(result.available) && Number(result.seatsAvailable) > 0;
    cls.seatsAvailable = Number(result.seatsAvailable) || 0;
    if (Number.isFinite(Number(result.fare))) cls.price = Number(result.fare);
    applyFilters();
  } catch (error) {
    action.disabled = false;
    action.innerHTML = 'Check availability <i class="fas fa-rotate" aria-hidden="true"></i>';
    showToast('Could not check availability. Please try again.', 'error');
  }
}

function addTraveller() {
  if (travellers.length >= MAX_TRAVELLERS) {
    showToast(`Maximum ${MAX_TRAVELLERS} travellers allowed`, 'error');
    return;
  }
  travellers.push(newTraveller());
  renderTravellers();
}

function removeTraveller(index) {
  travellers.splice(index, 1);
  renderTravellers();
  showToast('Traveller removed', 'success');
}

function validateTravellers() {
  for (let i = 0; i < travellers.length; i++) {
    const t = travellers[i];
    if (!String(t.name || '').trim()) {
      showToast(`Please enter name for Traveller ${i + 1}`, 'error');
      return false;
    }
    const age = Number(t.age);
    if (!age || age < 1 || age > 120) {
      showToast(`Please enter a valid age for Traveller ${i + 1}`, 'error');
      return false;
    }
    if (!t.gender) {
      showToast(`Please select gender for Traveller ${i + 1}`, 'error');
      return false;
    }
  }
  return true;
}

function validateContact() {
  const mobile = $('contact-mobile').value.trim();
  const email = $('contact-email').value.trim();
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    showToast('Please enter a valid 10-digit mobile number', 'error');
    return false;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Please enter a valid email ID', 'error');
    return false;
  }
  return true;
}

function saveTraveller() {
  if (validateTravellers() && validateContact()) {
    showToast('All travellers saved successfully', 'success');
  }
}

function proceedToBook() {
  if (!currentBooking) {
    showToast('Please select a train and class first', 'error');
    return;
  }
  if (!isJourneyDateAllowed(selectedJourneyISO || currentBooking.journeyDate)) {
    showToast('Choose a journey date from today through the next two months.', 'error');
    return;
  }
  if (!isDepartureAvailable(currentBooking.journeyDate, currentBooking.departure)) {
    showToast('This train has already departed and cannot be booked for this journey date.', 'error');
    return;
  }
  if (!validateTravellers() || !validateContact()) return;
  showBookingSummary();
}

function showBookingSummary() {
  if (!currentBooking) return;
  closeBookingPopup();
  paymentSession = null;

  const count = travellers.length;
  const fare = currentBooking.price;
  const hasFare = Number.isFinite(fare) && fare > 0;
  const subtotal = hasFare ? count * fare : null;
  const gst = hasFare ? Math.round(subtotal * GST_RATE) : null;
  const irct = hasFare ? count * IRCT_CHARGE_PER_PERSON : null;
  const total = hasFare ? subtotal + gst + irct : null;

  const rows = travellers.map((t, i) =>
    `<div class="traveller-summary-item"><span>Traveller ${i + 1}: ${escapeHtml(t.name)}</span><span>${hasFare ? `₹${fare}` : ''}</span></div>`
  ).join('');

  const popup = document.createElement('div');
  popup.className = 'booking-popup';
  popup.innerHTML = `
    <div class="booking-popup-overlay" data-action="close"></div>
    <div class="booking-popup-content">
      <div class="booking-header">
        <h2>Booking Summary</h2>
        <button type="button" class="booking-close" data-action="close" aria-label="Close">&times;</button>
      </div>
      <div class="booking-body">
        <p class="form-hint">All amounts below are estimates based on the selected class and route. Final railway fare, taxes, and charges must be confirmed by an authorized ticketing provider.</p>
        <div class="travellers-summary">
          <h3>${count} Traveller${count > 1 ? 's' : ''} · ${escapeHtml(currentBooking.name)} (${escapeHtml(currentBooking.classCode)})</h3>
          ${rows}
        </div>
        ${hasFare ? `<div class="booking-breakdown">
          <div class="breakdown-row"><span>Ticket Fare (${count} × ₹${fare})</span><span>₹${subtotal}</span></div>
          <div class="breakdown-row"><span>GST (18%)</span><span>₹${gst}</span></div>
          <div class="breakdown-row"><span>IRCT Charges (${count} × ₹${IRCT_CHARGE_PER_PERSON})</span><span>₹${irct}</span></div>
          <div class="breakdown-row total-row"><span>Total Amount</span><span>₹${total}</span></div>
        </div>` : ''}
        <div class="qr-code-section">
          <p class="qr-hint" id="payment-status">Preparing secure payment QR...</p>
          <img id="payment-qr" class="payment-qr" alt="Secure payment QR code" hidden>
          <div class="countdown-timer" id="payment-countdown" role="timer" aria-live="polite" hidden><span>05:00</span><p>Time left to pay</p></div>
          <button type="button" class="booking-cancel-btn" data-action="change-payment-qr">Change payment account</button>
          <p class="form-hint">Amount includes the estimate, GST, and service charge shown above. Confirm the payable amount in your payment app.</p>
          <div class="support-contact-actions"><button type="button" class="support-contact-button" data-support-channel="whatsapp"><i class="fab fa-whatsapp" aria-hidden="true"></i> WhatsApp support</button><button type="button" class="support-contact-button support-call-button" data-support-channel="call"><i class="fas fa-phone" aria-hidden="true"></i> Call support</button></div>
          <form class="support-contact-form" hidden><label for="support-customer-phone-payment">Your phone number (with country code)</label><div><input id="support-customer-phone-payment" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91 98765 43210" required><button type="submit" class="support-contact-button">Continue</button></div><input type="hidden" name="channel"><small>Your number will be saved with the support agent number you are connected to.</small></form><p class="support-contact-status" role="status" aria-live="polite"></p>
        </div>
        <div class="booking-proof-field">
          <label for="payment-proof">Upload payment proof</label>
          <input id="payment-proof" type="file" accept="image/*,.pdf">
          <span id="proof-file-name" class="form-hint">PNG, JPG, or PDF up to 5 MB</span>
        </div>
        <div class="booking-proof-field">
          <label for="payment-transaction-ref">Payment transaction reference (optional)</label>
          <input id="payment-transaction-ref" type="text" maxlength="100" autocomplete="off" placeholder="UPI transaction ID or reference">
        </div>
      </div>
      <div class="booking-footer">
        <button type="button" class="booking-cancel-btn" data-action="close">Cancel</button>
        <button type="button" class="booking-pay-btn" data-action="submit-proof" disabled>Submit Payment Proof</button>
      </div>
    </div>`;

  popup.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'submit-proof') submitPaymentProof();
    else if (el.dataset.action === 'change-payment-qr') changePaymentQr(el);
    else closeBookingPopup();
  });

  document.body.appendChild(popup);
  lockScroll(true);

  $('payment-proof')?.addEventListener('change', updatePaymentProof);
  loadPaymentQr(total);
}

async function loadPaymentQr(amount) {
  const status = $('payment-status');
  const image = $('payment-qr');
  if (!status || !image) return;
  try {
    const response = await fetch(apiUrl('/api/payments/qr'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount,
        trainNumber: currentBooking.number,
        classCode: currentBooking.classCode,
        journeyDate: selectedJourneyISO,
        mobile: $('contact-mobile')?.value.trim() || ''
      })
    });
    const session = await readTrainApiResponse(response, 'Payment service');
    if (!response.ok) throw new Error(session.message || 'Payment service unavailable');
    if (session.success !== true || !session.paymentId || !session.qrCode) throw new Error('Payment QR is unavailable');
    paymentSession = { id: session.paymentId, amount: Number.isFinite(amount) && amount > 0 ? amount : null, qrSlot: session.qrSlot, expiresAt: Date.parse(session.expiresAt) || Date.now() + 5 * 60 * 1000 };
    startPaymentCountdown(session.expiresAt);
    image.src = session.qrCode;
    image.onerror = () => {
      image.hidden = true;
      paymentSession = null;
      status.textContent = 'The payment QR could not be loaded. Please try again.';
      updatePaymentProof();
    };
    image.hidden = false;
    status.textContent = paymentSession.amount
      ? `Scan to pay ₹${paymentSession.amount}`
      : 'Scan the saved payment QR. Your UPI app will show the amount, if one is included in the QR.';
    updatePaymentProof();
  } catch (error) {
    paymentSession = null;
    status.textContent = error.message || 'Payment service is temporarily unavailable. Please try again later.';
  }
}

function startPaymentCountdown(expiresAt) {
  clearInterval(countdownTimer);
  const countdown = $('payment-countdown');
  const display = countdown?.querySelector('span');
  if (!countdown || !display) return;
  const expiry = Number.isFinite(Date.parse(expiresAt)) ? Date.parse(expiresAt) : Date.now() + 5 * 60 * 1000;
  countdown.hidden = false;
  const update = () => {
    const secondsLeft = Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
    display.textContent = `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`;
    if (secondsLeft === 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      paymentSession = null;
      const status = $('payment-status');
      if (status) status.textContent = 'Payment time expired. Close checkout and start again to get a new QR code.';
      updatePaymentProof();
    }
  };
  update();
  if (expiry > Date.now()) countdownTimer = setInterval(update, 1000);
}

async function changePaymentQr(button) {
  if (!paymentSession?.id || button.disabled) return;
  const status = $('payment-status');
  const image = $('payment-qr');
  button.disabled = true;
  if (status) status.textContent = 'Switching payment account…';
  try {
    const response = await fetch(apiUrl('/api/payments/change-qr'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentId: paymentSession.id }) });
    const result = await response.json();
    if (!response.ok || !result.success || !result.qrCode) throw new Error(result.message || 'No alternate payment account is available.');
    image.src = result.qrCode;
    image.hidden = false;
    paymentSession.qrSlot = result.qrSlot;
    if (status) status.textContent = `Pay ₹${Number(result.amount || 0).toLocaleString('en-IN')} using this alternate payment account.`;
  } catch (error) {
    if (status) status.textContent = error.message || 'Could not switch payment account.';
  } finally { button.disabled = false; }
}

function updatePaymentProof() {
  const input = $('payment-proof');
  const button = document.querySelector('[data-action="submit-proof"]');
  const label = $('proof-file-name');
  if (!input || !button) return;
  const file = input.files?.[0];
  const valid = file && file.size <= 5 * 1024 * 1024 &&
    (file.type.startsWith('image/') || file.type === 'application/pdf');
  if (label) {
    label.classList.remove('proof-file-error');
    label.textContent = file && !valid
      ? (file.size > 5 * 1024 * 1024 ? 'File is too large. Choose a file under 5 MB.' : 'Choose an image or PDF file.')
      : file?.name || 'PNG, JPG, or PDF up to 5 MB';
    if (file && !valid) label.classList.add('proof-file-error');
  }
  button.disabled = !paymentSession || (paymentSession.expiresAt && Date.now() >= paymentSession.expiresAt);
}

async function submitPaymentProof(fileOverride = null) {
  if (!currentBooking || !isJourneyDateAllowed(currentBooking.journeyDate) ||
      !isDepartureAvailable(currentBooking.journeyDate, currentBooking.departure)) {
    showToast('This journey date or train departure is no longer available for booking.', 'error');
    return;
  }
  const file = fileOverride || $('payment-proof')?.files?.[0];
  const button = document.querySelector('[data-action="submit-proof"]');
  const label = $('proof-file-name');
  if (!file) {
    if (label) {
      label.textContent = 'Upload your payment screenshot before submitting.';
      label.classList.add('proof-file-error');
    }
    $('payment-proof')?.focus();
    showToast('Please upload your payment proof first.', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024 ||
      (!file.type.startsWith('image/') && file.type !== 'application/pdf')) {
    if (label) {
      label.textContent = file.size > 5 * 1024 * 1024
        ? 'File is too large. Choose a file under 5 MB.'
        : 'Choose an image or PDF file.';
      label.classList.add('proof-file-error');
    }
    showToast('Choose a valid payment screenshot or PDF before submitting.', 'error');
    return;
  }
  if (!paymentSession) {
    showToast('Payment could not be verified. Please try again.', 'error');
    return;
  }

  if (button) {
    button.disabled = true;
    button.textContent = 'Uploading...';
  }
  const mobile = $('contact-mobile')?.value.trim() || '';
  const email = $('contact-email')?.value.trim() || '';
  const data = new FormData();
  data.append('proof', file);
  data.append('paymentId', paymentSession.id);
  data.append('amount', paymentSession.amount == null ? '' : String(paymentSession.amount));
  data.append('trainNumber', currentBooking.number);
  data.append('trainName', currentBooking.name);
  data.append('classCode', currentBooking.classCode);
  data.append('journeyDate', selectedJourneyISO);
  data.append('fromStation', currentBooking.from || '');
  data.append('toStation', currentBooking.to || '');
  data.append('departure', currentBooking.departure || '');
  data.append('arrival', currentBooking.arrival || '');
  data.append('quota', currentBooking.quota || $('train-quota')?.value || 'GN');
  data.append('distance', currentBooking.distance || '');
  data.append('transactionRef', $('payment-transaction-ref')?.value.trim() || '');
  data.append('travellers', JSON.stringify(travellers));
  data.append('mobile', mobile);
  data.append('email', email);

  showProofUploadingStatus({ mobile, email });
  const uploadStartedAt = Date.now();
  const controller = new AbortController();
  activeProofUpload = { controller, cancelled: false };
  const uploadTimeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(apiUrl('/api/bookings/payment-proof'), { method: 'POST', body: data, signal: controller.signal });
    const result = await readTrainApiResponse(response, 'Payment proof service');
    if (!response.ok || result.success !== true) throw new Error(result.message || 'Payment proof could not be uploaded');
    const minimumProgressTime = 1400 - (Date.now() - uploadStartedAt);
    if (minimumProgressTime > 0) await new Promise(resolve => setTimeout(resolve, minimumProgressTime));
    clearTimeout(uploadTimeout);
    activeProofUpload = null;
    showBookingInProcess(result, { mobile, email });
  } catch (error) {
    clearTimeout(uploadTimeout);
    activeProofUpload = null;
    showProofUploadError(file, error.message);
  }
}

function showProofUploadingPopup(contact = {}) {
  closeBookingPopup(true);
  const popup = document.createElement('div');
  popup.className = 'booking-popup booking-success';
  popup.innerHTML = `
    <div class="booking-popup-overlay"></div>
    <div class="booking-popup-content booking-success-content">
      <div class="ticket-progress-spinner"><i class="fas fa-spinner" aria-hidden="true"></i></div>
      <h2>Ticket Request Is Processing</h2>
      <p class="success-detail">Your ticket request is processing. Kindly wait a few minutes. We will send your ticket update to the mobile number and email shown below.</p>
      <div class="ticket-contact-list">
        <p><i class="fab fa-whatsapp" aria-hidden="true"></i><strong>Mobile:</strong> ${escapeHtml(contact.mobile || 'Not provided')}</p>
        <p><i class="fas fa-envelope" aria-hidden="true"></i><strong>Email:</strong> ${escapeHtml(contact.email || 'Not provided')}</p>
      </div>
      <p class="success-detail" id="customer-payment-review-status">Payment request status: Processing payment.</p>
      <button type="button" class="ticket-download-link" id="approved-receipt-download" data-action="download-receipt" hidden>Download approved receipt</button>
      <iframe id="approved-receipt-preview" title="Approved payment receipt" hidden></iframe>
      <button type="button" class="booking-ok-btn" data-action="close">Close</button>
      <p class="success-detail processing-wait-message">Processing… please keep this window open.</p>
    </div>`;
  popup.addEventListener('click', event => {
    // Keep the processing dialog open through unrelated clicks; only its Close
    // button is allowed to dismiss it.
    if (event.target.closest('[data-action="close"]')) {
      event.preventDefault();
      closeBookingPopup(true);
    }
  });
  document.body.appendChild(popup);
  bookingResultLocked = true;
  lockScroll(true);
}

function showProofUploadingStatus(contact = {}) {
  closeBookingPopup();
  const status = $('proof-submit-status');
  if (status) {
    status.hidden = false;
    status.innerHTML = `<strong>Processing your ticket request…</strong><p>Kindly wait a few minutes. We will send the update to ${escapeHtml(contact.mobile || 'your mobile number')} and ${escapeHtml(contact.email || 'your email')}.</p>`;
  }
}

function showProofUploadError(file, errorMessage = '') {
  const status = $('proof-submit-status');
  if (status) {
    status.hidden = false;
    status.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = 'Payment proof not submitted';
    const message = document.createElement('p');
    message.textContent = errorMessage || 'Please check your connection and try again.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'proof-retry-btn';
    retry.textContent = 'Try Again';
    retry.addEventListener('click', () => submitPaymentProof(file));
    status.append(heading, message, retry);
  }
  return;
  /* Legacy modal code retained below for older integrations. */
  let popup = document.querySelector('.booking-popup');
  if (!popup) popup = document.createElement('div');
  popup.className = 'booking-popup';
  popup.innerHTML = `
    <div class="booking-popup-overlay" data-action="close"></div>
    <div class="booking-popup-content booking-success-content">
      <div class="success-icon proof-file-error"><i class="fas fa-circle-exclamation" aria-hidden="true"></i></div>
      <h2>Payment Proof Not Submitted</h2>
      <p class="success-detail">${escapeHtml(errorMessage || 'We could not submit your payment screenshot. Check your connection and try again.')}</p>
      <button type="button" class="proof-retry-btn" data-action="retry-upload">Try Again</button>
      <button type="button" class="proof-cancel-btn" data-action="close">Close</button>
    </div>`;
  popup.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'retry-upload') submitPaymentProof(file);
    else if (action === 'close') closeBookingPopup();
  });
  document.body.appendChild(popup);
  lockScroll(true);
}

function closeBookingPopup(force = false) {
  if ((bookingResultLocked || activeProofUpload) && !force) return;
  if (force) bookingResultLocked = false;
  clearInterval(countdownTimer);
  clearTimeout(successTimer);
  clearInterval(paymentStatusTimer);
  countdownTimer = null;
  successTimer = null;
  paymentStatusTimer = null;
  const existing = document.querySelectorAll('.booking-popup');
  if (!existing.length) return;
  existing.forEach(p => p.remove());
  lockScroll(false);
}

function showBookingInProcess(result = {}, contact = {}) {
  const inlineStatus = $('proof-submit-status');
  if (inlineStatus) {
    inlineStatus.hidden = false;
    inlineStatus.innerHTML = `<strong>Processing payment</strong><p>Kindly wait a few minutes. We will send the ticket update to ${escapeHtml(contact.mobile || 'your mobile number')} and ${escapeHtml(contact.email || 'your email')}.</p>`;
  }
  showProofUploadingPopup(contact);
  const processingPopup = document.querySelector('.booking-popup');
  const heading = processingPopup?.querySelector('h2');
  const message = processingPopup?.querySelector('.success-detail:not(#customer-payment-review-status)');
  if (heading) heading.textContent = 'Processing Payment';
  if (message) message.textContent = `Your payment proof has been submitted. Kindly wait a few minutes while we process your request. If approved, we will send your ticket to ${contact.mobile || 'your mobile number'} and ${contact.email || 'your email'}.`;
  const waitMessage = processingPopup?.querySelector('.processing-wait-message');
  if (waitMessage) waitMessage.remove();
  if (!processingPopup) return;
  const downloadLink = $('ticket-download-link');
  if (downloadLink && typeof result.ticketUrl === 'string' && /^https?:\/\//i.test(result.ticketUrl)) {
    downloadLink.href = result.ticketUrl;
    downloadLink.hidden = false;
  }
  const whatsappLink = $('ticket-whatsapp-link');
  if (whatsappLink && typeof result.whatsappUrl === 'string' && /^https:\/\//i.test(result.whatsappUrl)) {
    whatsappLink.href = result.whatsappUrl;
    whatsappLink.hidden = false;
  }
  if (result.referenceId) {
    const requestStatus = processingPopup?.querySelector('#customer-payment-review-status');
    let approvedReceipt = null;
    const poll = async () => {
      try {
        const response = await fetch(apiUrl(`/api/customer/payment-status?referenceId=${encodeURIComponent(result.referenceId)}`));
        const status = await response.json();
        if (!response.ok || !status.success || !requestStatus) return;
        if (status.status === 'APPROVED') {
          requestStatus.textContent = 'Payment processed successfully. Your receipt is ready.';
          approvedReceipt = status.receipt;
          const downloadButton = processingPopup?.querySelector('#approved-receipt-download');
          if (downloadButton && approvedReceipt) downloadButton.hidden = false;
          const preview = processingPopup?.querySelector('#approved-receipt-preview');
          if (preview && approvedReceipt) {
            preview.src = URL.createObjectURL(new Blob([buildApprovedReceiptHtml(approvedReceipt)], { type: 'text/html;charset=utf-8' }));
            preview.hidden = false;
          }
          clearInterval(timer);
        }
        else if (status.status === 'DECLINED') { requestStatus.textContent = 'Payment proof was declined. If money was deducted, contact customer support with your payment reference.'; clearInterval(timer); }
      } catch { /* Leave the pending status visible and retry on the next interval. */ }
    };
    const timer = paymentStatusTimer = setInterval(poll, 15000);
    poll();
    popup.addEventListener('click', event => {
      if (event.target.closest('[data-action="download-receipt"]') && approvedReceipt) downloadApprovedReceipt(approvedReceipt);
    });
  }
}

async function downloadApprovedReceipt(receipt) {
  const html = buildApprovedReceiptHtml(receipt);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sheet = doc.querySelector('.sheet');
  if (sheet && await loadReceiptPdfExporter()) {
    const exportSheet = document.createElement('div');
    exportSheet.innerHTML = sheet.outerHTML;
    exportSheet.style.cssText = 'position:fixed;left:-10000px;top:0;width:780px;background:#fff';
    document.body.appendChild(exportSheet);
    try {
      await window.html2pdf().set({
        margin: 8,
        filename: `Bharatrail-receipt-${String(receipt.referenceId || 'approved').slice(0, 8)}.pdf`,
        image: { type: 'jpeg', quality: 0.96 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      }).from(exportSheet.firstElementChild).save();
      exportSheet.remove();
      return;
    } catch { exportSheet.remove(); }
  }
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Bharatrail-receipt-${String(receipt.referenceId || 'approved').slice(0, 8)}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

let receiptPdfExporterPromise;
function loadReceiptPdfExporter() {
  if (typeof window.html2pdf === 'function') return Promise.resolve(true);
  if (!receiptPdfExporterPromise) {
    receiptPdfExporterPromise = new Promise(resolve => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      script.onload = () => resolve(typeof window.html2pdf === 'function');
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }
  return receiptPdfExporterPromise;
}

function buildApprovedReceiptHtml(receipt) {
  const escape = value => escapeHtml(String(value ?? ''));
  let passengers = [];
  try { passengers = Array.isArray(receipt.travellers) ? receipt.travellers : JSON.parse(receipt.travellers || '[]'); } catch { /* Keep passenger list empty if submitted data is invalid. */ }
  const rows = passengers.map((person, index) => `<tr><td>${index + 1}</td><td>${escape(person.name || 'Not provided')}</td><td>${escape(person.age || 'Not provided')}</td><td>${escape(person.gender || 'Not provided')}</td><td>${escape(person.nationality || 'Not provided')}</td><td>${escape(person.birthPref || 'Not specified')}</td></tr>`).join('') || '<tr><td colspan="6">No passenger details recorded</td></tr>';
  const amount = Number.isFinite(Number(receipt.amount)) ? `₹${Number(receipt.amount).toFixed(2)}` : 'Not recorded';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bharatrail approved payment receipt</title><style>body{font:15px Arial,sans-serif;color:#193449;margin:24px}.sheet{max-width:780px;margin:auto;border:1px solid #ccd8e0;padding:28px}.brand{font-size:26px;color:#126c62;font-weight:bold}.notice{padding:12px;background:#fff3df;border-left:4px solid #d99020;margin:18px 0;font-weight:bold}h2{font-size:17px;margin-top:26px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #dce4e9}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:20px 0}.label{display:block;color:#65798a;font-size:11px;text-transform:uppercase;margin-bottom:4px}.value{font-weight:600}.footer{font-size:12px;color:#526677;margin-top:24px}</style><article class="sheet"><div class="brand">Bharatrail</div><div>Payment and journey receipt</div><div class="notice">PAYMENT APPROVED · THIS IS NOT A RAILWAY TICKET OR CONFIRMED RESERVATION</div><div class="grid"><div><span class="label">Receipt reference</span><span class="value">${escape(receipt.referenceId)}</span></div><div><span class="label">Journey date</span><span class="value">${escape(receipt.journeyDate || 'Not provided')}</span></div><div><span class="label">Train and class</span><span class="value">${escape(receipt.trainNumber)} ${escape(receipt.trainName)} · ${escape(receipt.classCode || 'Class not provided')}</span></div><div><span class="label">Quota</span><span class="value">${escape(receipt.quota || 'GN')}</span></div><div><span class="label">Distance</span><span class="value">${escape(receipt.distance || 'Not recorded')} km</span></div><div><span class="label">Amount recorded</span><span class="value">${amount}</span></div><div><span class="label">From</span><span class="value">${escape(receipt.fromStation)} · ${escape(receipt.departure || '')}</span></div><div><span class="label">To</span><span class="value">${escape(receipt.toStation)} · ${escape(receipt.arrival || '')}</span></div><div><span class="label">Customer mobile</span><span class="value">${escape(receipt.mobile || 'Not provided')}</span></div><div><span class="label">Email</span><span class="value">${escape(receipt.email || 'Not provided')}</span></div><div><span class="label">Payment transaction reference</span><span class="value">${escape(receipt.transactionRef || 'Not provided')}</span></div><div><span class="label">Approved at</span><span class="value">${escape(receipt.reviewedAt ? new Date(receipt.reviewedAt).toLocaleString() : 'Not provided')}</span></div></div><h2>Passenger details</h2><table><thead><tr><th>#</th><th>Name</th><th>Age</th><th>Gender</th><th>Nationality</th><th>Birth preference</th></tr></thead><tbody>${rows}</tbody></table><p class="footer">This Bharatrail receipt records payment review and journey details only. It does not provide a railway PNR, confirmed seat, or authorization to travel. A railway ticket must be issued by an authorized ticketing provider.</p></article></html>`;
}

// ================= Train status and PNR =================
function renderProviderRouteBackup(resultDiv, data, number, dateIso, message) {
  const stops = Array.isArray(data?.stops) ? data.stops : [];
  if (!stops.length) return false;
  const rows = stops.map(stop => {
    const station = stop.station || {};
    const arrival = stop.scheduledArrival || '—';
    const departure = stop.scheduledDeparture || '—';
    return `<li><span>${escapeHtml(station.name || station.code || 'Station')} (${escapeHtml(station.code || '—')})</span><span>${escapeHtml(String(arrival).slice(0, 5))} / ${escapeHtml(String(departure).slice(0, 5))}</span></li>`;
  }).join('');
  resultDiv.innerHTML = `
    <div class="status-header">
      <h3>${escapeHtml(data.trainName || `Train ${number}`)} · Live position unavailable</h3>
      <p>Train ${escapeHtml(data.trainNumber || number)} · ${escapeHtml(dateLabel(parseISODate(dateIso)))}</p>
    </div>
    <div class="status-body">
      <p class="status-error" role="status">${escapeHtml(message)} No live location is available. Showing the provider timetable route.</p>
      <p class="form-hint">Scheduled route data is not a live position. Actual station times appear only when the provider reports them.</p>
      <ol class="snapshot-route-list">${rows}</ol>
    </div>`;
  return true;
}

async function searchTrainByNumber(number, dateIso) {
  const resultDiv = $('train-status-result');
  if (!resultDiv) return;

  if (!/^\d{5}$/.test(number)) {
    showToast('Please enter a valid 5-digit train number', 'error');
    return;
  }
  if (!dateIso) {
    showToast('Please choose a journey date', 'error');
    return;
  }
  if (!railwayDataReady) await loadRailwayBackup();

  resultDiv.style.display = 'block';
  resultDiv.innerHTML = '<div class="status-body" role="status"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Fetching train running status…</div>';
  resultDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const submitButton = $('train-status-form')?.querySelector('[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const query = new URLSearchParams({ type: 'status', number, date: dateIso });
    const response = await fetch(apiUrl(`/api/trains.php?${query}`), {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    const result = await response.json();
    const data = result?.data;
    if (!response.ok || !data || !['SUCCESS', 'STALE_DATA'].includes(result.status)) {
      throw new Error(result?.error?.message || 'Live running status is unavailable right now.');
    }

    const freshness = data.freshness || {};
    const position = data.position || {};
    const delay = data.delay || {};
    const progress = data.routeProgress || {};
    const location = data.currentStation?.name || data.currentStation?.code ||
      (Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
        ? `${position.latitude.toFixed(4)}, ${position.longitude.toFixed(4)}`
        : 'Location not reported by provider');
    const observedAt = freshness.observedAt || position.observedAt;
    const observedLabel = observedAt && !Number.isNaN(Date.parse(observedAt))
      ? new Date(observedAt).toLocaleString()
      : 'Observation time unavailable';
    const freshnessLabel = freshness.state || (result.status === 'STALE_DATA' ? 'STALE' : 'UNKNOWN');
    const sourceText = data.source || position.source || 'Provider';

    resultDiv.innerHTML = `
      <div class="status-header">
        <h3>${escapeHtml(data.trainName || `Train ${number}`)}</h3>
        <p>Train ${escapeHtml(data.trainNumber || number)} · ${escapeHtml(dateLabel(parseISODate(dateIso)))}</p>
      </div>
      <div class="status-body">
        <div class="status-grid">
          <div class="status-item"><div class="status-label">Running status</div><div class="status-value">${escapeHtml(data.status || 'Status unavailable')}</div></div>
          <div class="status-item"><div class="status-label">Reported position</div><div class="status-value">${escapeHtml(location)}</div></div>
          <div class="status-item"><div class="status-label">Previous station</div><div class="status-value">${escapeHtml(data.previousStation?.name || data.previousStation?.code || 'Not reported')}</div></div>
          <div class="status-item"><div class="status-label">Next station</div><div class="status-value">${escapeHtml(data.nextStation?.name || data.nextStation?.code || 'Not reported')}</div></div>
          <div class="status-item"><div class="status-label">Delay</div><div class="status-value">${Number.isFinite(delay.minutes) ? `${delay.minutes} min` : 'Not reported'}</div></div>
          <div class="status-item"><div class="status-label">Route progress</div><div class="status-value">${Number.isFinite(progress.percent) ? `${progress.percent}%` : 'Not reported'}</div></div>
        </div>
        <p class="form-hint">${escapeHtml(freshnessLabel)} · Observed ${escapeHtml(observedLabel)} · Source: ${escapeHtml(sourceText)}${data.confidence ? ` · Confidence: ${escapeHtml(data.confidence)}` : ''}</p>
      </div>`;
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'The live status request timed out. Please try again.'
      : error.message || 'Live running status is unavailable right now.';
    if (!/not configured|missing the PHP cURL/i.test(message)) {
      const routeController = new AbortController();
      const routeTimeout = setTimeout(() => routeController.abort(), 7000);
      try {
        const routeQuery = new URLSearchParams({ type: 'route', number, date: dateIso });
        const routeResponse = await fetch(apiUrl(`/api/trains.php?${routeQuery}`), {
          headers: { Accept: 'application/json' }, signal: routeController.signal
        });
        const routeResult = await readTrainApiResponse(routeResponse, 'Train route service');
        if (routeResponse.ok && ['SUCCESS', 'STALE_DATA'].includes(routeResult?.status) &&
            renderProviderRouteBackup(resultDiv, routeResult.data, number, dateIso, message)) return;
      } catch (_) {
        // Fall through to the bundled timetable when the provider route is also unavailable.
      } finally {
        clearTimeout(routeTimeout);
      }
    }
    const backupTrain = BACKUP_TRAIN_RECORDS.find(record => record[0] === number);
    if (backupTrain) {
      const stops = backupTrain[7].map(stop => `
        <li><span>${escapeHtml(stop[1] || stop[0])} (${escapeHtml(stop[0])})</span>
        <span>${escapeHtml((stop[2] || '—').slice(0, 5))} / ${escapeHtml((stop[3] || '—').slice(0, 5))}</span></li>`).join('');
      resultDiv.innerHTML = `
        <div class="status-header">
          <h3>${escapeHtml(backupTrain[1] || `Train ${number}`)} · Live position unavailable</h3>
          <p>Train ${escapeHtml(number)} · ${escapeHtml(dateLabel(parseISODate(dateIso)))}</p>
        </div>
        <div class="status-body">
          <p class="status-error" role="status">${escapeHtml(message)} No live location is available. Showing the stored timetable below.</p>
          <p class="form-hint">Community snapshot schedule; may be outdated and is not a live position or official railway feed.</p>
          <ol class="snapshot-route-list">${stops}</ol>
        </div>`;
    } else {
      resultDiv.innerHTML = `<div class="status-body status-error" role="alert">${escapeHtml(message)}</div>`;
    }
  } finally {
    clearTimeout(timeout);
    if (submitButton) submitButton.disabled = false;
  }
}

function handlePnrSearch(e) {
  e.preventDefault();
  const pnr = $('pnr-number').value.trim();
  const resultDiv = $('pnr-result');
  if (!resultDiv) return;

  if (!/^\d{10}$/.test(pnr)) {
    showToast('Please enter a valid 10-digit PNR', 'error');
    return;
  }
  resultDiv.innerHTML = `
    <div class="pnr-header">
      <h3>PNR Status</h3>
      <p>PNR: ${escapeHtml(pnr)}</p>
    </div>
    <div class="pnr-body">
      <p class="pnr-notice"><i class="fas fa-info-circle"></i>
        PNR details are temporarily unavailable. Please try again later.</p>
    </div>`;
  resultDiv.style.display = 'block';
  resultDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ================= Stations page =================
function renderStations(filter = '') {
  const list = $('stations-list');
  if (!list) return;
  if (!filter.trim()) {
    list.innerHTML = '<p class="no-results">Search by station name or code to browse the nationwide list.</p>';
    return;
  }
  const stations = filterStations(filter);
  if (!stations.length) {
    list.innerHTML = '<p class="no-results">No stations match your search</p>';
    return;
  }
  list.innerHTML = stations.slice(0, 100).map(station => `
    <div class="station-card">
      <div class="station-card-header">
        <div class="station-card-name">${escapeHtml(station.name)}</div>
        <span class="station-card-code">${escapeHtml(station.code)}</span>
      </div>
      <div class="station-card-city">${escapeHtml(station.city)}</div>
      <span class="station-card-zone">${escapeHtml(station.zone)} Zone</span>
    </div>`).join('') + (stations.length > 100
      ? '<p class="no-results">Showing the first 100 matches. Add more letters to narrow the list.</p>'
      : '');
}

// ================= Global events =================
function setupForms() {
  $('train-search-form')?.addEventListener('submit', handleTrainSearch);
  $('train-status-form')?.addEventListener('submit', e => {
    e.preventDefault();
    searchTrainByNumber($('train-number').value.trim(), $('status-date').value);
  });
  $('pnr-form')?.addEventListener('submit', handlePnrSearch);
  $('station-search')?.addEventListener('input', e => renderStations(e.target.value));
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (activeProofUpload || bookingResultLocked || document.querySelector('.booking-popup.booking-success')) return;
    closeBirthPreferenceMenus();
    closeFilterMenus();
    closeStationModal();
    closeBookingPopup();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initDate();
  railwayDataPromise = loadRailwayBackup();
  buildDateBar(new Date());
  window.setInterval(updateDepartureAvailability, 30000);
  renderStations();
  setupNavigation();
  setupMobileMenu();
  setupNavbarShadow();
  setupStationFields();
  setupStationModal();
  setupForms();
  setupFilters();
  setupTravellers();
  $('contact-mobile')?.addEventListener('change', identifyVisitorMobile);
  $('global-back')?.addEventListener('click', goBack);
  const termsDialog = $('terms-dialog');
  $('terms-open')?.addEventListener('click', () => termsDialog?.showModal());
  ['terms-close', 'terms-done'].forEach(id => $(id)?.addEventListener('click', () => termsDialog?.close()));
  termsDialog?.addEventListener('click', event => {
    if (event.target === termsDialog) termsDialog.close();
  });
  $('train-class')?.addEventListener('change', refreshCardFareEstimates);
  updateBackButton();
  setupLanguageToggle();
  $('train-list')?.addEventListener('click', e => {
    const startBooking = e.target.closest('.train-book-now');
    if (startBooking) {
      startTravellerBooking(startBooking);
      return;
    }
    const fareButton = e.target.closest('.fare-lookup-btn');
    if (fareButton) {
      loadTrainFares(fareButton);
      return;
    }
    const schedule = e.target.closest('.schedule-link');
    if (schedule) {
      $('train-number').value = schedule.dataset.number;
      navigateTo('train-status');
      searchTrainByNumber(schedule.dataset.number, $('status-date').value);
      return;
    }
    const book = e.target.closest('.book-quick-btn');
    if (book) {
      bookTrain(book.dataset.number, book.dataset.class, Number(book.dataset.price));
      return;
    }
    const availability = e.target.closest('.check-quick-btn');
    if (availability) checkTrainAvailability(availability.closest('.class-card'));
  });
  document.addEventListener('click', e => {
    const supportButton = e.target.closest('.support-contact-button');
    if (!supportButton) return;
    const form = supportButton.closest('.no-trains, .customer-support-card')?.querySelector('.support-contact-form');
    if (!form) return;
    form.querySelector('[name="channel"]').value = supportButton.dataset.supportChannel || 'whatsapp';
    form.hidden = false;
    form.querySelector('input[type="tel"]').focus();
  });
  document.addEventListener('submit', e => {
    if (!e.target.matches('.support-contact-form')) return;
    e.preventDefault();
    requestSupportContact(e.target);
  });
});

async function identifyVisitorMobile() {
  const mobile = $('contact-mobile')?.value.trim() || '';
  if (!/^\d{10,15}$/.test(mobile.replace(/\D/g, ''))) return;
  try {
    const response = await fetch(apiUrl('/api/visitor/identify'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile })
    });
    if (!response.ok) {
      const result = await response.json();
      showToast(result.message || 'This phone number cannot be used for booking.', 'error');
    }
  } catch { /* The booking API records the number again before creating a payment session. */ }
}

async function requestSupportContact(form) {
  const status = form.closest('.no-trains, .customer-support-card, .qr-code-section')?.querySelector('.support-contact-status');
  const button = form.querySelector('[type="submit"]');
  if (!status || !button || button.disabled) return;
  button.disabled = true;
  status.textContent = 'Connecting you to customer support…';
  try {
    const channel = form.querySelector('[name="channel"]').value;
    const customerPhone = form.querySelector('input[type="tel"]').value;
    const response = await fetch(apiUrl('/api/support/next'), { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, customerPhone }) });
    const result = await response.json();
    if (!response.ok || !result.success || !/^\d{8,15}$/.test(result.number || '')) throw new Error(result.message || 'Support contact is unavailable.');
    if (channel === 'whatsapp') {
      window.location.href = `https://wa.me/${result.number}?text=${encodeURIComponent('Hi, I need help finding a train between two stations.')}`;
    } else {
      window.location.href = `tel:+${result.number}`;
    }
  } catch (error) {
    status.textContent = error.message || 'Could not connect to customer support.';
    button.disabled = false;
  }
}
