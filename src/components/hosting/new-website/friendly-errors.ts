/**
 * Plain-language explanations for the errors an import or deployment can end
 * with. The raw message is still shown under "Technical details"; this is the
 * sentence a small-business owner reads first.
 */

export interface Explanation {
  title: string
  body: string
  /** Whether trying again is likely to help. */
  retryHelps: boolean
}

const RULES: Array<{ test: RegExp; explain: Explanation }> = [
  {
    test: /restart|interrupted|server (was )?(stopped|shut)|ECONNRESET|socket hang up/i,
    explain: {
      title: 'The import was interrupted',
      body: 'Our server restarted while your import was running. Your backup is still stored here, so nothing needs uploading again — press Retry to pick it back up.',
      retryHelps: true,
    },
  },
  {
    test: /ENOSPC|no space|disk (is )?full|quota/i,
    explain: {
      title: 'Not enough storage space',
      body: 'Your site is larger than the space left on your plan or on the server. Free up space or upgrade your plan, then try again.',
      retryHelps: false,
    },
  },
  {
    test: /upload (was )?not found|upload .*expired|staged .*missing|not found on panel/i,
    explain: {
      title: 'The uploaded file is no longer here',
      body: 'Uploaded backups are kept for a limited time. Upload the file again to start a new import.',
      retryHelps: false,
    },
  },
  {
    test: /\.crypt|encrypted/i,
    explain: {
      title: 'The backup is encrypted',
      body: 'Encrypted backups cannot be read. Decrypt it in the plugin that made it, then upload it again.',
      retryHelps: false,
    },
  },
  {
    test: /no (sql|database)|sql (dump|file) (was )?not found|missing .*\.sql/i,
    explain: {
      title: 'No database was found in the backup',
      body: 'Export your database (phpMyAdmin → Export → SQL) and add the .sql file as the separate database file, then start the import again.',
      retryHelps: false,
    },
  },
  {
    test: /sql|mysql|mariadb|database/i,
    explain: {
      title: 'Your database could not be restored',
      body: 'The database file was found but could not be imported. This is often an incomplete export. Try exporting it again; if it keeps failing, our support team can look at it.',
      retryHelps: true,
    },
  },
  {
    test: /unsafe|symlink|outside|path traversal/i,
    explain: {
      title: 'The archive contains unsafe paths',
      body: 'Some files in the archive point outside the website folder, so it was refused for your safety. Re-create the archive from the site folder and upload it again.',
      retryHelps: false,
    },
  },
  {
    test: /extract|unzip|tar|corrupt|unexpected end|invalid (zip|archive)|not a valid/i,
    explain: {
      title: 'The backup file could not be opened',
      body: 'The archive looks damaged or incomplete — usually because the download from your old host did not finish. Download it again and upload the new copy.',
      retryHelps: false,
    },
  },
  {
    test: /download|fetch|ENOTFOUND|EAI_AGAIN|timed? ?out|403|404|unreachable|cannot be reached/i,
    explain: {
      title: 'We could not get your files',
      body: 'The link or repository could not be reached. Check that it is public (or the access token is correct) and try again.',
      retryHelps: true,
    },
  },
  {
    test: /build|npm|composer|pip|docker/i,
    explain: {
      title: 'Your site did not build',
      body: 'The build step reported an error. The technical details below show the exact output.',
      retryHelps: true,
    },
  },
  {
    test: /verify|health|did not respond|502|503/i,
    explain: {
      title: 'The site started but did not answer',
      body: 'Everything was set up, but the site did not respond to our check. Trying again often fixes a slow first start.',
      retryHelps: true,
    },
  },
]

export function explainFailure(raw: string | null | undefined, kind: 'import' | 'deploy'): Explanation {
  const text = raw || ''
  for (const r of RULES) if (r.test.test(text)) return r.explain
  return kind === 'import'
    ? {
        title: 'The import stopped',
        body: 'Something went wrong while moving your site. Your site at your old host is not affected. Try again, or contact support and we will look at it with you.',
        retryHelps: true,
      }
    : {
        title: 'Your site could not be set up',
        body: 'Something went wrong while setting up your site. Try again, or contact support and we will look at it with you.',
        retryHelps: true,
      }
}
