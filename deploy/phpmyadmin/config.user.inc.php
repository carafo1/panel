<?php
/**
 * Apsamo Panel — phpMyAdmin server configuration (signon SSO)
 * ===========================================================
 *
 * Mounted into the official phpmyadmin image at
 * /etc/phpmyadmin/config.user.inc.php.
 *
 * The single server entry uses `auth_type = 'signon'`, so phpMyAdmin takes its
 * credentials from the PHP session written by signon.php instead of showing a
 * login form. Because that session carries the tenant's own NON-ROOT database
 * user, MySQL itself limits what can be seen — no system databases, no other
 * tenants, no root.
 */

declare(strict_types=1);

/* Session-based single sign-on (see signon.php). */
$cfg['Servers'][1]['auth_type']         = 'signon';
$cfg['Servers'][1]['SignonSession']     = 'SignonSession';
$cfg['Servers'][1]['SignonURL']         = '/signon.php';
/* Where to send someone whose session expired: back to the panel. */
$cfg['Servers'][1]['LogoutURL']         = getenv('PANEL_URL') ?: 'https://panel.apsamo.com';

/* The host is supplied per-session by signon.php (the tenant's DB container),
 * so no fixed host/user/password is configured here — and never any root. */
$cfg['Servers'][1]['host']              = '';
$cfg['Servers'][1]['port']              = '';
$cfg['Servers'][1]['connect_type']      = 'tcp';
$cfg['Servers'][1]['compress']          = false;
$cfg['Servers'][1]['AllowNoPassword']   = false;
/* Customers must never point phpMyAdmin at an arbitrary server. */
$cfg['AllowArbitraryServer']            = false;

/* Hide everything that isn't the customer's own data. */
$cfg['Servers'][1]['hide_db']           = '^(information_schema|performance_schema|mysql|sys)$';
/* No server-level administration surface for customers. */
$cfg['ShowServerInfo']                  = false;
$cfg['ShowDbStructureCharset']          = true;
$cfg['ShowChgPassword']                 = false;
$cfg['ShowCreateDb']                    = false;
$cfg['UserprefsDisallow']               = ['Showservers'];

/* Sessions expire on their own; keep them short for a hosting panel. */
$cfg['LoginCookieValidity']             = 3600;
$cfg['LoginCookieStore']                = 0;

/* Import/export ergonomics for hosting customers. */
$cfg['ExecTimeLimit']                   = 0;      // no PHP-side cap on long imports
$cfg['MemoryLimit']                     = '512M';
$cfg['ZipDump']                         = true;
$cfg['GZipDump']                        = true;
$cfg['BZipDump']                        = false;
$cfg['Export']['compression']           = 'gzip';

/* Apsamo branding — Primary #1E1A47, Secondary #706FD3, Accent #8888FF.
 * ThemeDefault stays configurable via env so a custom theme can be dropped in. */
$cfg['ThemeDefault']                    = getenv('PMA_THEME') ?: 'pmahomme';
$cfg['ShowPhpInfo']                     = false;
$cfg['VersionCheck']                    = false;   // no outbound calls from a tenant tool
$cfg['SendErrorReports']                = 'never';

/* The blowfish secret only matters for cookie auth, but phpMyAdmin warns
 * without one; take it from the environment the container is started with. */
$cfg['blowfish_secret']                 = getenv('PMA_BLOWFISH_SECRET') ?: '';
