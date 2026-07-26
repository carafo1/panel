<?php
/**
 * Apsamo Panel — phpMyAdmin SSO entry point
 * =========================================
 *
 * Served from the phpMyAdmin container's web root. The panel redirects the
 * customer here with a single-use token:
 *
 *     https://pma.<domain>/signon.php?token=<token>
 *
 * The panel has already staged a ticket file for that token inside THIS
 * container (written over the docker socket, never over the network). We read
 * it, delete it immediately so it can only be used once, verify it has not
 * expired, then put the tenant's NON-ROOT credentials into the signon session
 * phpMyAdmin reads and bounce to their own database.
 *
 * The customer never sees credentials and never sees a database login form.
 */

declare(strict_types=1);

const SIGNON_SESSION = 'SignonSession';
const SPOOL_DIR      = '/tmp/pma-signon';

function fail(string $message, int $status = 400): never
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    $safe  = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
    $panel = htmlspecialchars(getenv('PANEL_URL') ?: 'https://panel.apsamo.com', ENT_QUOTES, 'UTF-8');
    echo <<<HTML
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session error</title>
<style>
  body{font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#1E1A47;color:#fff;
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
  .card{max-width:32rem;background:rgba(255,255,255,.06);border:1px solid rgba(136,136,255,.35);
        border-radius:14px;padding:28px;text-align:center}
  h1{font-size:1.15rem;margin:0 0 .5rem}
  p{margin:.4rem 0;color:#d7d6f0}
  a{display:inline-block;margin-top:.75rem;background:#706FD3;color:#fff;padding:.5rem 1rem;
    border-radius:8px;text-decoration:none;font-weight:600}
  a:hover{background:#8888FF}
</style>
<div class="card">
  <h1>Could not open phpMyAdmin</h1>
  <p>{$safe}</p>
  <p>Please return to the panel and click <strong>Open phpMyAdmin</strong> again.</p>
  <a href="{$panel}">Back to Apsamo Panel</a>
</div>
HTML;
    exit;
}

// ── Validate the token shape before touching the filesystem ────────────────
$token = $_GET['token'] ?? '';
if (!is_string($token) || preg_match('/^[a-f0-9]{64}$/', $token) !== 1) {
    fail('This link is missing a valid session token.', 400);
}

$path = SPOOL_DIR . '/' . $token . '.json';
if (!is_file($path)) {
    fail('This session link has expired or was already used.', 401);
}

$raw = @file_get_contents($path);

// Single use: burn the ticket immediately, whatever happens next.
//
// This delete is a security control, not housekeeping: if it fails the token
// stays valid for the rest of its TTL and could be replayed from browser
// history, a referrer header, or a proxy log. So we verify it actually went and
// refuse the sign-on otherwise (a misconfigured spool directory must fail
// closed, never open).
$unlinked = @unlink($path);
clearstatcache(true, $path);
if (!$unlinked && is_file($path)) {
    fail('This session could not be secured (the one-time ticket could not be consumed).', 500);
}

if ($raw === false || $raw === '') {
    fail('The session ticket could not be read.', 500);
}

try {
    $ticket = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
} catch (JsonException) {
    fail('The session ticket was malformed.', 500);
}

if (!is_array($ticket) || !isset($ticket['user'], $ticket['password'], $ticket['host'])) {
    fail('The session ticket was incomplete.', 500);
}

$expiresAt = (int) ($ticket['expiresAt'] ?? 0);
if ($expiresAt > 0 && $expiresAt < (int) (microtime(true) * 1000)) {
    fail('This session link has expired. Links are valid for 60 seconds.', 401);
}

// ── Hand the credentials to phpMyAdmin via its signon session ─────────────
session_name(SIGNON_SESSION);
session_start([
    'cookie_httponly' => true,
    'cookie_samesite' => 'Lax',
    'cookie_secure'   => !empty($_SERVER['HTTPS'])
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https',
    'use_strict_mode' => true,
]);
// Fresh session id per hand-off — prevents session fixation.
session_regenerate_id(true);

$_SESSION['PMA_single_signon_user']     = (string) $ticket['user'];
$_SESSION['PMA_single_signon_password'] = (string) $ticket['password'];
$_SESSION['PMA_single_signon_host']     = (string) $ticket['host'];
$_SESSION['PMA_single_signon_port']     = (string) ($ticket['port'] ?? 3306);
$_SESSION['PMA_single_signon_db']       = (string) ($ticket['database'] ?? '');

session_write_close();

$db = rawurlencode((string) ($ticket['database'] ?? ''));
header('Cache-Control: no-store');
header('Location: index.php' . ($db !== '' ? '?db=' . $db : ''));
exit;
