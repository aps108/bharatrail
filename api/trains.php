<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    header('Allow: GET');
    respond(405, ['status' => 'ERROR', 'error' => ['message' => 'Only GET requests are supported.']]);
}

$number = $_GET['number'] ?? '';
$date = $_GET['date'] ?? '';
$type = $_GET['type'] ?? 'status';
$source = $_GET['source'] ?? '';
$destination = $_GET['destination'] ?? '';
$class = $_GET['class'] ?? '';
$quota = $_GET['quota'] ?? 'GN';
if (!is_string($number) || !preg_match('/^\d{5}$/', $number)) {
    respond(400, ['status' => 'ERROR', 'error' => ['message' => 'Enter a valid 5-digit train number.']]);
}
if (!is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
    respond(400, ['status' => 'ERROR', 'error' => ['message' => 'Enter a valid journey date.']]);
}
if (!in_array($type, ['status', 'schedule', 'route', 'coaches', 'fare'], true)) {
    respond(400, ['status' => 'ERROR', 'error' => ['message' => 'Unsupported train data request.']]);
}
if ($type === 'fare') {
    if (!is_string($source) || !preg_match('/^[A-Z0-9]{2,6}$/i', $source) ||
        !is_string($destination) || !preg_match('/^[A-Z0-9]{2,6}$/i', $destination) ||
        !is_string($class) || !preg_match('/^[A-Z0-9]{1,4}$/i', $class) ||
        !is_string($quota) || !preg_match('/^[A-Z0-9]{1,4}$/i', $quota)) {
        respond(400, ['status' => 'ERROR', 'error' => ['message' => 'A valid route, class, and quota are required for a fare quote.']]);
    }
}

$apiKey = getenv('BHARATRAIL_RAILWAY_ENGINE_API_KEY');
if (!$apiKey) {
    respond(503, ['status' => 'ERROR', 'error' => ['message' => 'Live train data is not configured on this server yet.']]);
}
if (!function_exists('curl_init')) {
    respond(503, ['status' => 'ERROR', 'error' => ['message' => 'The server is missing the PHP cURL extension required for live train data.']]);
}

$upstreamUrl = 'https://railway-engine.apkscope.workers.dev/v1/train/'
    . rawurlencode($number) . '/' . $type;
$upstreamQuery = [];
if (in_array($type, ['status', 'schedule', 'route'], true)) $upstreamQuery['date'] = $date;
if ($type === 'coaches') {
    $upstreamQuery = ['blueprints' => 'false', 'stationVariations' => 'false'];
}
if ($type === 'fare') {
    $upstreamQuery = [
        'source' => strtoupper($source),
        'destination' => strtoupper($destination),
        'class' => strtoupper($class),
        'quota' => strtoupper($quota),
        'date' => $date,
    ];
}
if ($upstreamQuery) $upstreamUrl .= '?' . http_build_query($upstreamQuery, '', '&', PHP_QUERY_RFC3986);
$curl = curl_init($upstreamUrl);
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 12,
    CURLOPT_HTTPHEADER => ['Accept: application/json', 'x-api-key: ' . $apiKey],
]);
$response = curl_exec($curl);
$httpStatus = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
$curlError = curl_error($curl);
curl_close($curl);

if (!is_string($response) || $response === '') {
    error_log('Railway data provider request failed: ' . $curlError);
    respond(502, ['status' => 'ERROR', 'error' => ['message' => 'The train data provider did not respond. Please try again shortly.']]);
}

$decoded = json_decode($response, true);
if (!is_array($decoded)) {
    error_log('Railway data provider returned invalid JSON (HTTP ' . $httpStatus . ').');
    respond(502, ['status' => 'ERROR', 'error' => ['message' => 'The train data provider returned an unreadable response.']]);
}

http_response_code($httpStatus >= 400 ? $httpStatus : 200);
echo json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
