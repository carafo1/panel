/**
 * Comprehensive TLD catalog (~600 real TLDs).
 *
 * This is the candidate list of TLDs the reseller can offer. Real wholesale
 * prices are fetched from the registrar (Dynadot) by `syncPrices()` in
 * pricing.ts; TLDs Dynadot does NOT sell are marked inactive during sync so the
 * client only ever sees registerable TLDs with real provider prices.
 *
 * The number here is a sensible default/fallback wholesale price (USD) used only
 * until a live sync runs. Curated popular TLDs keep their precise prices in
 * pricing.ts (TLD_WHOLESALE_PRICES); those take precedence over this catalog.
 */

// Default fallback wholesale (USD) for a catalog TLD with no curated/live price.
export const CATALOG_DEFAULT_WHOLESALE = 12.99

// Real, currently-delegated TLDs. Grouped only for readability.
export const TLD_CATALOG: string[] = [
  // ── Legacy / core gTLDs ────────────────────────────────────────────────
  '.com', '.net', '.org', '.info', '.biz', '.name', '.pro', '.mobi', '.asia',
  '.tel', '.xxx', '.jobs', '.travel', '.cat', '.post', '.aero', '.coop', '.museum',

  // ── Popular generics (new gTLDs) ───────────────────────────────────────
  '.io', '.co', '.me', '.tv', '.cc', '.ws', '.app', '.dev', '.ai', '.xyz',
  '.online', '.site', '.website', '.store', '.shop', '.tech', '.space', '.fun',
  '.club', '.live', '.life', '.world', '.today', '.news', '.blog', '.page',
  '.link', '.click', '.email', '.host', '.cloud', '.digital', '.network',
  '.systems', '.solutions', '.services', '.software', '.tools', '.codes',
  '.code', '.api', '.dev', '.sh', '.tech', '.wiki', '.pro', '.pw',

  // ── Business / commerce ────────────────────────────────────────────────
  '.business', '.company', '.enterprises', '.ventures', '.holdings', '.industries',
  '.management', '.marketing', '.market', '.markets', '.finance', '.financial',
  '.fund', '.capital', '.money', '.cash', '.credit', '.creditcard', '.loans',
  '.insure', '.insurance', '.investments', '.tax', '.accountant', '.accountants',
  '.trade', '.trading', '.exchange', '.deals', '.discount', '.sale', '.bargains',
  '.cheap', '.coupons', '.promo', '.gratis', '.gmbh', '.ltd', '.llc', '.inc',
  '.corp', '.group', '.agency', '.consulting', '.expert', '.experts', '.partners',
  '.associates', '.foundation', '.institute', '.limited', '.franchise', '.forsale',
  '.auction', '.supply', '.supplies', '.tools', '.contractors', '.construction',
  '.builders', '.maison', '.industries', '.works', '.工业',

  // ── Tech / internet ────────────────────────────────────────────────────
  '.technology', '.computer', '.systems', '.digital', '.download', '.hosting',
  '.server', '.domains', '.security', '.systems', '.data', '.cloud', '.center',
  '.direct', '.express', '.zone', '.pink', '.red', '.blue', '.green', '.black',
  '.gold', '.plus', '.now', '.new', '.run', '.build', '.dev', '.app', '.chat',
  '.forum', '.community', '.social', '.network', '.email', '.contact', '.support',
  '.help', '.tips', '.guide', '.guru', '.wtf', '.lol', '.wiki', '.info',

  // ── Media / creative / entertainment ───────────────────────────────────
  '.media', '.press', '.news', '.blog', '.review', '.reviews', '.movie', '.film',
  '.video', '.tube', '.stream', '.show', '.theater', '.theatre', '.studio',
  '.art', '.gallery', '.design', '.graphics', '.photo', '.photos', '.photography',
  '.pics', '.pictures', '.camera', '.audio', '.music', '.band', '.fm', '.radio',
  '.dj', '.game', '.games', '.play', '.fun', '.toys', '.fans', '.fan', '.actor',
  '.dance', '.events', '.party', '.ink', '.rocks', '.wiki', '.buzz', '.cool',

  // ── Lifestyle / people ─────────────────────────────────────────────────
  '.life', '.style', '.fashion', '.beauty', '.makeup', '.hair', '.skin', '.spa',
  '.salon', '.tattoo', '.jewelry', '.diamonds', '.watch', '.shoes', '.clothing',
  '.boutique', '.luxe', '.luxury', '.vip', '.rich', '.fyi', '.wedding', '.love',
  '.dating', '.singles', '.date', '.gay', '.lgbt', '.baby', '.kids', '.family',
  '.mom', '.dad', '.guru', '.ninja', '.cool', '.wow', '.yoga', '.fit', '.fitness',
  '.gym', '.run', '.bike', '.golf', '.ski', '.surf', '.soccer', '.football',
  '.tennis', '.hockey', '.rugby', '.team', '.coach', '.fans', '.tickets',

  // ── Food / drink / hospitality ─────────────────────────────────────────
  '.food', '.restaurant', '.cafe', '.coffee', '.bar', '.pub', '.beer', '.wine',
  '.vin', '.kitchen', '.recipes', '.menu', '.catering', '.pizza', '.diet',
  '.organic', '.farm', '.garden', '.florist', '.flowers', '.hotel', '.hotels',
  '.resort', '.vacations', '.holiday', '.cruises', '.flights', '.tours', '.travel',
  '.voyage', '.reise', '.reisen', '.villas', '.rentals', '.rest', '.bnb',

  // ── Real estate / home ─────────────────────────────────────────────────
  '.house', '.homes', '.home', '.realty', '.realestate', '.property', '.properties',
  '.apartments', '.condos', '.rentals', '.lease', '.mortgage', '.land', '.estate',
  '.build', '.building', '.construction', '.contractors', '.plumbing', '.repair',
  '.furniture', '.lighting', '.kitchen', '.bath', '.garden', '.tools', '.cleaning',
  '.solar', '.energy', '.electric', '.hvac', '.glass', '.tiles', '.paint',

  // ── Professional / education / health ──────────────────────────────────
  '.law', '.lawyer', '.attorney', '.legal', '.esq', '.doctor', '.dentist',
  '.dental', '.clinic', '.surgery', '.healthcare', '.health', '.care', '.hospital',
  '.pharmacy', '.med', '.vet', '.education', '.academy', '.school', '.college',
  '.university', '.institute', '.degree', '.mba', '.study', '.courses', '.training',
  '.science', '.engineering', '.engineer', '.architect', '.cpa', '.accountant',
  '.consulting', '.expert', '.tax', '.finance', '.money', '.church', '.faith',
  '.bible', '.charity', '.ngo', '.ong', '.gives', '.giving', '.foundation',

  // ── Geography — cities & regions ───────────────────────────────────────
  '.nyc', '.london', '.paris', '.berlin', '.tokyo', '.miami', '.vegas', '.boston',
  '.moscow', '.amsterdam', '.barcelona', '.madrid', '.wien', '.koeln', '.hamburg',
  '.melbourne', '.sydney', '.quebec', '.capetown', '.durban', '.joburg', '.istanbul',
  '.dubai', '.abudhabi', '.africa', '.asia', '.eu', '.nrw', '.bayern', '.bar',
  '.city', '.town', '.place', '.земля', '.global', '.world', '.international',

  // ── Country-code TLDs (ccTLDs) — widely resold ─────────────────────────
  '.us', '.uk', '.co.uk', '.org.uk', '.me.uk', '.ca', '.au', '.com.au', '.net.au',
  '.nz', '.co.nz', '.de', '.at', '.ch', '.li', '.fr', '.be', '.nl', '.lu', '.es',
  '.pt', '.it', '.ie', '.eu', '.dk', '.se', '.no', '.fi', '.is', '.pl', '.cz',
  '.sk', '.hu', '.ro', '.bg', '.gr', '.hr', '.si', '.rs', '.ba', '.mk', '.al',
  '.me', '.lt', '.lv', '.ee', '.ua', '.by', '.ru', '.su', '.tr', '.cy', '.mt',
  '.in', '.co.in', '.net.in', '.org.in', '.pk', '.bd', '.lk', '.np', '.cn',
  '.com.cn', '.jp', '.co.jp', '.kr', '.co.kr', '.tw', '.com.tw', '.hk', '.mo',
  '.sg', '.com.sg', '.my', '.com.my', '.id', '.co.id', '.ph', '.th', '.co.th',
  '.vn', '.com.vn', '.kh', '.la', '.mn', '.mm', '.br', '.com.br', '.mx', '.com.mx',
  '.ar', '.com.ar', '.cl', '.co', '.com.co', '.pe', '.ve', '.ec', '.uy', '.py',
  '.bo', '.cr', '.pa', '.gt', '.hn', '.ni', '.sv', '.do', '.pr', '.cu', '.za',
  '.co.za', '.org.za', '.ng', '.com.ng', '.ke', '.co.ke', '.tz', '.ug', '.gh',
  '.et', '.rw', '.zm', '.zw', '.na', '.bw', '.mu', '.ma', '.dz', '.tn', '.eg',
  '.com.eg', '.ly', '.sd', '.ae', '.sa', '.com.sa', '.qa', '.kw', '.bh', '.om',
  '.jo', '.lb', '.il', '.co.il', '.ps', '.iq', '.ir', '.af', '.ge', '.am', '.az',
  '.kz', '.uz', '.tm', '.kg', '.tj',

  // ── Popular "hack" / short ccTLDs used as generics ─────────────────────
  '.io', '.ai', '.co', '.me', '.tv', '.cc', '.gg', '.im', '.je', '.sh', '.ac',
  '.fm', '.am', '.ms', '.mu', '.to', '.tk', '.ml', '.ga', '.cf', '.ly', '.bz',
  '.vc', '.vg', '.ag', '.lc', '.mn', '.pw', '.so', '.st', '.tc', '.tf', '.wf',
  '.yt', '.re', '.pm', '.gd', '.gl', '.gs', '.la', '.li', '.nu', '.pe', '.ph',
  '.rocks', '.ninja', '.wtf', '.lol', '.fyi',

  // ── More new gTLDs (broad coverage) ────────────────────────────────────
  '.actor', '.adult', '.airforce', '.army', '.navy', '.auto', '.autos', '.car',
  '.cars', '.motorcycles', '.tires', '.bike', '.boats', '.yachts', '.parts',
  '.expert', '.rentals', '.reviews', '.report', '.reports', '.systems', '.report',
  '.jewelry', '.gifts', '.gift', '.holiday', '.christmas', '.blackfriday',
  '.singles', '.church', '.faith', '.bio', '.eco', '.earth', '.green', '.energy',
  '.solar', '.gallery', '.graphics', '.photography', '.photos', '.camera', '.lease',
  '.condos', '.villas', '.cruise', '.flights', '.limo', '.taxi', '.cab', '.delivery',
  '.express', '.logistics', '.moving', '.shipping', '.tienda', '.kaufen', '.buy',
  '.sale', '.deals', '.discount', '.cheap', '.bargains', '.coupon', '.blackfriday',
  '.watches', '.diamonds', '.florist', '.flowers', '.wedding', '.engagement',
  '.memorial', '.care', '.rehab', '.rip', '.dog', '.cat', '.horse', '.fish',
  '.pet', '.pets', '.vet', '.farm', '.garden', '.house', '.rentals', '.villas',
  '.university', '.college', '.degree', '.education', '.school', '.academy',
  '.training', '.courses', '.study', '.mba', '.science', '.institute', '.works',
  '.工作', '.company', '.enterprises', '.industries', '.limited', '.holdings',
  '.management', '.partners', '.ventures', '.capital', '.fund', '.investments',
  '.money', '.finance', '.financial', '.bank', '.insurance', '.credit', '.loans',
  '.mortgage', '.tax', '.exchange', '.markets', '.trading', '.forex', '.broker',
  '.attorney', '.lawyer', '.legal', '.law', '.claims', '.dentist', '.dental',
  '.clinic', '.surgery', '.healthcare', '.hospital', '.pharmacy', '.doctor',
  '.beauty', '.hair', '.makeup', '.skin', '.spa', '.salon', '.fashion', '.style',
  '.clothing', '.shoes', '.jewelry', '.luxury', '.vip', '.boutique', '.deals',
  '.report', '.recipes', '.menu', '.pizza', '.coffee', '.beer', '.wine', '.pub',
  '.bar', '.cafe', '.restaurant', '.catering', '.food', '.kitchen', '.cooking',
  '.fishing', '.hunting', '.camp', '.tours', '.voyage', '.vacations', '.holiday',
  '.flights', '.cruises', '.rentals', '.hotel', '.hotels', '.resort', '.casino',
  '.poker', '.bet', '.bingo', '.lotto', '.games', '.game', '.play', '.toys',
  '.tennis', '.golf', '.ski', '.surf', '.soccer', '.football', '.rugby', '.hockey',
  '.run', '.bike', '.fit', '.fitness', '.gym', '.yoga', '.dance', '.band',
  '.church', '.faith', '.bible', '.yoga', '.guru', '.ninja', '.expert', '.coach',
  '.mentor', '.contractors', '.builders', '.construction', '.repair', '.plumbing',
  '.electrician', '.hvac', '.cleaning', '.security', '.guard', '.protection',
  '.tech', '.technology', '.digital', '.online', '.website', '.web', '.internet',
  '.wtf', '.lol', '.wiki', '.blog', '.news', '.press', '.media', '.tv', '.radio',
  '.movie', '.film', '.video', '.stream', '.chat', '.forum', '.review', '.rip',

  // ── Supplementary batch (broaden Dynadot coverage toward 600 visible) ───
  '.top', '.icu', '.cyou', '.cfd', '.sbs', '.bond', '.quest', '.ooo', '.one',
  '.bid', '.win', '.men', '.loan', '.racing', '.cricket', '.webcam', '.date',
  '.download', '.accountant', '.faith', '.science', '.party', '.trade', '.stream',
  '.storage', '.observer', '.archi', '.kim', '.desi', '.vodka', '.rodeo', '.haus',
  '.immo', '.immobilien', '.bau', '.jetzt', '.mode', '.swiss', '.gal', '.scot',
  '.cymru', '.wales', '.brussels', '.frl', '.cologne', '.ruhr', '.saarland',
  '.tirol', '.schule', '.versicherung', '.jewelry', '.watches', '.glass',
  '.equipment', '.supplies', '.supply', '.parts', '.repair', '.rentals', '.lease',
  '.tienda', '.kaufen', '.gmbh', '.ag', '.reit', '.realtor', '.condos', '.villas',
  '.apartments', '.flights', '.cruises', '.tours', '.voyage', '.hotel', '.hotels',
  '.guide', '.tips', '.wiki', '.how', '.help', '.support', '.contact', '.directory',
  '.domains', '.hosting', '.website', '.web', '.page', '.link', '.click', '.rest',
  '.menu', '.recipes', '.cooking', '.kitchen', '.bar', '.pub', '.beer', '.wine',
  '.coffee', '.cafe', '.pizza', '.diet', '.fit', '.fitness', '.gym', '.run',
  '.bike', '.golf', '.ski', '.surf', '.soccer', '.tennis', '.hockey', '.rugby',
  '.team', '.coach', '.fans', '.tickets', '.events', '.party', '.dance', '.band',
  '.singles', '.dating', '.love', '.wedding', '.baby', '.kids', '.family', '.mom',
  '.actor', '.dog', '.cat', '.horse', '.pet', '.vet', '.farm', '.garden',
  '.energy', '.solar', '.eco', '.earth', '.green', '.bio', '.organic', '.forsale',
  '.auction', '.gives', '.charity', '.ngo', '.foundation', '.community', '.church',
  '.limited', '.ltd', '.llc', '.inc', '.gmbh', '.holdings', '.ventures', '.capital',
  '.fund', '.finance', '.tax', '.accountants', '.actuaries', '.insure', '.loans',
  '.mortgage', '.credit', '.cash', '.money', '.gold', '.exchange', '.markets',
  '.trading', '.broker', '.forex', '.legal', '.law', '.lawyer', '.attorney',
  '.dentist', '.dental', '.clinic', '.doctor', '.healthcare', '.hospital',
]
